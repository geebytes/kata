/**
 * Quorum — the arithmetic over *independent observations*, kept in the kernel because it is pure.
 *
 * **Why this moved back into the kernel.** `producers/quorum.ts` aggregated verdicts, and it was handed the ledger's
 * entire verdict list for *every* producer: `byEvidence` therefore saw one verdict per evidence item, so `disputed` was
 * always empty and `reviewers` was a count of producers rather than of independent readings. Measured on this
 * repository, `security.reviewers: 2` was unenforceable — a single producer reached `security`.
 *
 * So the aggregation is defined here over one input per producer, and three facts are enforced that a count cannot
 * express:
 *
 *   1. **A producer is identified by its run, not its name.** Two runs of one producer are two observations; one run
 *      reported twice is one. Grouping by `producer.runId` is what stops "submit the same reading twice" from being a
 *      quorum.
 *   2. **Disagreement is about the same evidence item.** Two reviewers are only disagreeing if they decided the *same*
 *      item; comparing across items is how a difference in coverage reads as a conflict.
 *   3. **Reaching the required count is a condition, not a report.** `decide` refuses `quorum_missing` when the number of
 *      independent producers is below what the tier asked for, which is what makes `reviewers: 2` a gate rather than a
 *      comment.
 */
import type { EvidenceVerdict } from './types.js';

/** One independent reading pass. `verdicts` are the items it decided; `diversity` is how it differs from the others. */
export type QuorumRecord = {
    id: string;
    /** How this reviewer differs from the others: model family, prompt strategy, tool profile. */
    diversity: string;
    verdicts: readonly EvidenceVerdict[];
};

export type QuorumOutcome = {
    /** The independent readings that submitted, counted by run rather than by name. */
    reviewers: number;
    /** Evidence the reviewers disagree about. */
    disputedEvidenceIds: string[];
    /** The claims whose evidence is disputed. */
    disputedClaimIds: string[];
    /** True when the reviewers were not diverse enough for the count to mean independence. */
    undiversified: boolean;
    /** Whether this change reached a risk class no earlier change did. Absent from a producer means not known to hold. */
    reachedNewRiskClass: boolean;
    /** Whether the classifier could not place this change at all, likewise not known to hold when unreported. */
    unclassifiedTier: boolean;
    /** Every verdict, with refutations preserved regardless of how many reviewers disagreed. */
    merged: EvidenceVerdict[];
    /** Plain-language statement of the rule actually applied, so a reader can see it was applied. */
    rule: string;
    /**
     * How many verdicts carried no producer, and were therefore counted as one reading.
     *
     * Reported rather than absorbed: a quorum that fell short because the provenance was never recorded is a different
     * fact from one that fell short because only one reviewer ran, and only one of them is fixed by re-running.
     */
    unattributed: number;
};

/**
 * Compare the readings rather than counting the votes.
 *
 * Two rules, both load-bearing. A quorum must be *diverse* to count, because two reviewers drawn from one family share
 * their blind spots, so paying twice for them buys two correlated errors. And a reproducible finding is never voted
 * away: a `refuted` verdict from any reviewer stays in the merged set, so a majority cannot silence a counterexample.
 * Disagreement is *reported*, and the decision refuses on it.
 */
/**
 * **Which conditions actually demand the tier's reviewer count.**
 *
 * `tiers.<tier>.quorumOn` is the tier's own statement of when a second independent reading is required, and it has to be
 * read by something or it is a declaration dressed as a rule — measured: the field carried a consumer entry, and the only
 * thing that decided the demand was `diversity.requiredOn`, so `quorumOn: ['always']` on the `security` tier enforced
 * nothing of its own.
 *
 * The vocabulary is the conditions a decision can already observe, and an unrecognised entry is **refused rather than
 * ignored**: a condition nobody can evaluate would silently read as "not demanded", which is the failure this replaces.
 */
export const QUORUM_CONDITIONS = [
    // Unconditional, which is what the `security` tier means: a gate-changing change always wants two readings.
    'always',
    // The round produced a disagreement. A dispute is the strongest reason to want another reading.
    'disagreement',
    // The runs recorded so far are not independent enough to count (one producer, or one unattributed batch).
    'undiversified',
    // Someone refuted something and the refutation stands: a counterexample invites a second look.
    'refutation',
    // The evidence is weaker than the claim's severity asked for: more readings, or better evidence.
    'weak_evidence',
    // A change that reaches a risk class no earlier change in this repository reached.
    'new_class',
    // A change whose tier could not be classified confidently (no pattern matched its paths).
    'uncertainty',
    // A change at or above the policy's elevated-risk floor.
    'high_risk',
] as const;
export type QuorumCondition = (typeof QUORUM_CONDITIONS)[number];

export function unknownQuorumCondition(conditions: readonly string[]): string | null {
    return conditions.find((condition) => !(QUORUM_CONDITIONS as readonly string[]).includes(condition)) ?? null;
}


/**
 * The two conditions a pure decision cannot observe for itself, supplied by the producer that computed them.
 *
 * They arrive on the quorum report rather than being guessed inside `decide`: whether this change reached a risk class no
 * earlier change reached is a fact about the repository's history, and whether the classifier could place the change at
 * all is a fact about the path table. Absent means **not known to hold**, which leaves the condition unsatisfied instead of
 * quietly satisfied — the same direction every other unmeasurable quantity in this repository takes.
 */
export type QuorumObservation = {
    disputedClaims: number;
    undiversified: boolean;
    refutedEvidence: boolean;
    belowStrengthEvidence: boolean;
    reachedNewRiskClass: boolean;
    unclassifiedTier: boolean;
    highRisk: boolean;
};

export function quorumOnHolds(conditions: readonly string[], observed: QuorumObservation): boolean {
    for (const condition of conditions) {
        switch (condition) {
            case 'always':
                return true;
            case 'disagreement':
                if (observed.disputedClaims > 0) return true;
                break;
            case 'undiversified':
                if (observed.undiversified) return true;
                break;
            case 'refutation':
                if (observed.refutedEvidence) return true;
                break;
            case 'weak_evidence':
                if (observed.belowStrengthEvidence) return true;
                break;
            case 'new_class':
                if (observed.reachedNewRiskClass) return true;
                break;
            case 'uncertainty':
                if (observed.unclassifiedTier) return true;
                break;
            case 'high_risk':
                if (observed.highRisk) return true;
                break;
            default:
                // Unreachable through `loadPolicy` (which refuses an unknown entry by name); reaching it means a policy
                // was constructed in code without validation, and counting it as "not demanded" is how a gate quietens.
                throw new Error(`unknown quorumOn condition: ${condition}`);
        }
    }
    return false;
}

export function aggregateQuorum(input: {
    records: readonly QuorumRecord[];
    evidenceToClaim: Record<string, string>;
    /** The number of reviewers the tier asked for. */
    requiredReviewers: number;
    /** Whether the tier demands diversity among them. */
    demandDiversity: boolean;
    /** How many verdicts carried no producer. Counted as one reading; passed through so the report can say so. */
    unattributed?: number;
    /**
     * The two conditions `decide` cannot observe, when a producer computed them.
     *
     * Absent means not known to hold, so the condition stays unsatisfied rather than being silently treated as true.
     */
    observation?: Pick<QuorumObservation, 'reachedNewRiskClass' | 'unclassifiedTier'>;
}): QuorumOutcome {
    const merged: EvidenceVerdict[] = [];
    const byEvidence = new Map<string, Set<EvidenceVerdict['verdict']>>();
    for (const record of input.records) {
        for (const verdict of record.verdicts) {
            merged.push(verdict);
            const seen = byEvidence.get(verdict.evidenceId) ?? new Set<EvidenceVerdict['verdict']>();
            seen.add(verdict.verdict);
            byEvidence.set(verdict.evidenceId, seen);
        }
    }

    const disputedEvidenceIds = [...byEvidence.entries()]
        .filter(([, verdicts]) => verdicts.size > 1)
        .map(([evidenceId]) => evidenceId)
        .sort();
    const disputedClaimIds = [
        ...new Set(disputedEvidenceIds.map((evidenceId) => input.evidenceToClaim[evidenceId]).filter((id): id is string => Boolean(id))),
    ].sort();

    const distinctDiversity = new Set(input.records.map((record) => record.diversity).filter((value) => value !== 'none'));
    const undiversified = input.demandDiversity && input.records.length >= 2 && distinctDiversity.size < 2;

    const parts: string[] = [
        `${input.records.length} of ${input.requiredReviewers} required reviewer(s) submitted`,
        disputedEvidenceIds.length === 0 ? 'no disagreement' : `${disputedEvidenceIds.length} disputed evidence item(s)`,
        undiversified ? 'reviewers were not diverse, so the count adds no independent signal' : 'reviewers were diverse',
        'a refuted verdict is preserved: a reproducible finding is not voted away',
    ];
    if ((input.unattributed ?? 0) > 0) {
        parts.push(`${input.unattributed} verdict(s) named no producer and were counted as one reading`);
    }

    return {
        reviewers: input.records.length,
        disputedEvidenceIds,
        disputedClaimIds,
        undiversified,
        merged,
        rule: parts.join('; '),
        unattributed: input.unattributed ?? 0,
        reachedNewRiskClass: input.observation?.reachedNewRiskClass ?? false,
        unclassifiedTier: input.observation?.unclassifiedTier ?? false,
    };
}

/**
 * The run id a verdict with no producer is grouped under.
 *
 * One group, not one per verdict. The first version of this used `unattributed:<evidenceId>:<index>`, which made every
 * verdict of a pre-`producer` ledger into its own *reviewer* — so a single run's six readings counted as six independent
 * ones, and a `security`-tier change whose contract asks for two reviewers would have been satisfied by one run that had
 * simply been recorded before the field existed. That is exactly the failure this module exists to prevent, reintroduced
 * by the fallback written to tolerate old data.
 */
export const UNATTRIBUTED_RUN = 'unattributed';

/**
 * Group a verdict list into independent readings.
 *
 * The grouping key is the run, because that is what makes two verdicts two observations. Verdicts with no run — every
 * verdict recorded before the field existed — form **one** group, because their provenance is unknown and the
 * conservative reading of unknown provenance is a single reading, not a quorum. `unattributed` on the outcome reports how
 * many verdicts that was, so the limitation is visible rather than silently costing every old ledger its quorum.
 */
export function groupByProducer(verdicts: readonly EvidenceVerdict[]): { records: QuorumRecord[]; unattributed: number } {
    const byRun = new Map<string, EvidenceVerdict[]>();
    let unattributed = 0;
    for (const verdict of verdicts) {
        const runId = verdict.producer?.runId;
        if (runId === undefined || runId.trim() === '') {
            unattributed += 1;
            byRun.set(UNATTRIBUTED_RUN, [...(byRun.get(UNATTRIBUTED_RUN) ?? []), verdict]);
            continue;
        }
        byRun.set(runId, [...(byRun.get(runId) ?? []), verdict]);
    }
    const records = [...byRun.entries()].map(([runId, items]) => ({
        id: runId,
        // The actor is the diversity signal a ledger actually holds: two runs by one actor are not independent, and two
        // actors are the minimum evidence of independence this record can carry. A group with no actor is `none`, which
        // is what stops two anonymous readings from counting as diverse.
        diversity: items[0]?.producer?.actor ?? 'none',
        verdicts: items,
    }));
    return { records, unattributed };
}
