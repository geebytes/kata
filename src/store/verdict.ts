/**
 * One place that turns a ledger into a decision.
 *
 * Two consumers need it — the CLI's `decide` verb and the ladder's next-action suggestion — and computing it twice would
 * be the defect this subsystem exists to remove: one fact derived in two places, one updated and the other missed. So the
 * assembly lives here and both callers ask.
 *
 * `absent` is a state rather than an error. A change with no ledger is judged by whatever path it had before, and the
 * caller can see which one answered — which is what keeps the old route visible while it is being retired, instead of
 * silently deciding by whichever code path happened to run. `unreadable` is separate from `absent` on purpose: a ledger
 * that exists and cannot be parsed must not be indistinguishable from one that was never written.
 */
import { readLedger, declaredPaths, readProbeAnswers, type Ledger } from './ledger.js';
import { decide, evaluateClaim, type ClaimEvaluation, type QuorumReport } from '../kernel/decide.js';
import { aggregateQuorum, groupByProducer, type QuorumRecord } from '../kernel/quorum.js';
import { classifyRisk, resolveTier } from '../kernel/risk.js';
import type { AssuranceLevel, Decision, EvidenceVerdict, Severity, TierName } from '../kernel/types.js';
import type { Challenge } from '../kernel/types.js';
import type { ProbeAnswer } from '../kernel/discovery.js';

/**
 * How many of the recorded challenges actually ran.
 *
 * The count that feeds the discovery floor used to be "every challenge that is not open, plus every probe answer", and
 * both halves were satisfiable by doing nothing: a challenge whose command is `exit 0` is withdrawn by one check, and an
 * answer was a string nobody compared against the question. So the floor is computed from evidence of a measurement:
 *
 *   - a **withdrawn** challenge counts only when it records the failure it was drawn from (`resolution.observed` names
 *     an exit code other than 0) — that is the observation that a counterexample was real and the fix removed it;
 *   - a **probe answer** counts only when the recorded observation carries the fact the probe asked about — the digest
 *     prefix for `digest-prefix`, or the path for the existence questions. An empty `observed` (the default) cannot
 *     answer anything, and treating it as an answer is how a plain `ledger answer --probe X` satisfied a strict floor.
 */
export function verifiedChallengeCount(challenges: readonly Challenge[], answers: readonly ProbeAnswer[]): number {
    let verified = 0;
    for (const challenge of challenges) {
        // **A challenge counts only if it ever reproduced.** `challenge add --command 'exit 0'` followed by one check
        // leaves the state `withdrawn` (the command exits 0), and counting that as an independent challenge is how the
        // strict discovery floor was satisfied by doing nothing. A counterexample that never failed on anything has not
        // challenged anything, whatever its state says.
        if (challenge.reproduced !== true) continue;
        if (challenge.state !== 'withdrawn' && challenge.state !== 'resolved') continue;
        verified += 1;
    }
    // **Distinct questions, not distinct answer records.** Counting answers let the same question answered twice satisfy
    // the floor twice — and the generator could produce such duplicates, which is how it was found: a real change asked six
    // probes of which three pairs were identical, and the floor read six. Identity is the question itself (its kind and the
    // path it is about), so the count is of independent readings whatever produced the list.
    const askedQuestion = new Set<string>();
    for (const answer of answers) {
        // The answer carries the command it ran and what it saw. Both have to be present, and the observation has to be
        // more than whitespace, for the answer to count as having looked at something.
        if (!answer.command.trim() || !answer.observed.trim()) continue;
        // **The command *is* the question.** A probe's identity is the command it asks, so two answers to one command are
        // one reading however they were recorded — the answer type carries no kind or path, and inventing one from the
        // stored probe list would make the count depend on a lookup that can be absent.
        const identity = answer.command.trim();
        if (askedQuestion.has(identity)) continue;
        askedQuestion.add(identity);
        verified += 1;
    }
    return verified;
}

/**
 * **One place that assembles a claim's decision, and the reason this module owns it.**
 *
 * `evaluateClaim` needs six inputs, and five consumers — the ladder's open-problem list, its closure verdict, the change
 * record, the archive gate and the review request — each built that input themselves. They agreed only because they copied
 * the same six lines; a sixth consumer that got one of them wrong would have produced a second answer to "is this claim
 * supported", which is the defect class (`one-concept-several-derivations`) this line has spent the most rounds on. Found
 * by looking for the class rather than for an instance: the count of `evaluateClaim(` call sites outside the kernel was
 * five.
 */
export type ClaimDecision = ClaimEvaluation & { severity: Severity; statement: string };

/**
 * The quorum, assembled from independent readings — or absent when the tier asks for none.
 *
 * Kept here rather than inline because two facts have to be decided together: whether the tier's reviewer count
 * requires a report at all, and which readings count as independent. A report is produced whenever the tier asks for
 * more than one reviewer, even from zero readings, so "nobody submitted" is a *count of zero* rather than a missing
 * field — the difference between a failed quorum and no quorum question asked.
 */
function chainQuorum(input: {
    records: QuorumRecord[];
    unattributed: number;
    evidenceToClaim: Record<string, string>;
    requiredReviewers: number;
    demandDiversity: boolean;
}): QuorumReport | undefined {
    if (input.records.length === 0 && input.requiredReviewers <= 1) return undefined;
    const outcome = aggregateQuorum({
        records: input.records,
        evidenceToClaim: input.evidenceToClaim,
        requiredReviewers: input.requiredReviewers,
        demandDiversity: input.demandDiversity,
        unattributed: input.unattributed,
    });
    return {
        disputedClaimIds: outcome.disputedClaimIds,
        undiversified: outcome.undiversified,
        reviewers: outcome.reviewers,
        requiredReviewers: input.requiredReviewers,
        unattributed: outcome.unattributed,
    };
}

/** Every claim's decision, from the ledger, with the input assembled once. */
export function claimDecisions(ledger: Ledger): ClaimDecision[] {
    return ledger.claims.map((claim) => ({
        ...evaluateClaim(claim, {
            evidence: ledger.evidence,
            verdicts: ledger.verdicts,
            reusedEvidence: new Set(),
            policy: ledger.policy,
            challenges: ledger.challenges,
            subjectRevision: ledger.subject?.revision ?? '',
        }),
        severity: claim.severity,
        statement: claim.statement,
    }));
}

/** The claims nothing supports and nobody waived: the one answer every consumer of "what is still open" needs. */
export function unsupportedClaims(ledger: Ledger): ClaimDecision[] {
    return claimDecisions(ledger).filter((decision) => decision.state !== 'supported' && decision.state !== 'waived');
}

export type LedgerVerdict =
    | { kind: 'absent'; detail: string }
    | { kind: 'unreadable'; detail: string }
    | { kind: 'decided'; tier: TierName; claims: number; assurance: AssuranceLevel; subjectRevision: string; decision: Decision };

export async function ledgerVerdict(input: {
    root: string;
    changeId: string;
    /** The recorded baseline, so a `0.6*C0` budget can be resolved. `null` leaves it unknown rather than satisfied. */
    c0Tokens?: number | null;
    /** An explicit tier overrides the classification; the classification is what a caller normally wants. */
    tier?: TierName;
    /** An explicit assurance override, for the case where the operator knows what the round's provenance was. */
    assurance?: AssuranceLevel;
    /**
     * The party asking for this decision, when it is known.
     *
     * Recorded so the decision can refuse an approval made by one of the parties that produced the evidence. That is the
     * one independence property a single-machine ledger can check: it cannot prove a context was fresh, but it can see
     * that the same actor wrote the claim, verified it, and approved it.
     */
    actor?: string;
}): Promise<LedgerVerdict> {
    let ledger;
    try {
        ledger = await readLedger(input.root, input.changeId);
    } catch (error) {
        return { kind: 'unreadable', detail: `the ledger could not be read: ${(error as Error).message}` };
    }

    if (ledger.malformedFiles.length > 0) {
        // A file that exists and cannot be parsed decides nothing, and it must not read as "nothing recorded": the two are
        // different facts, and only one of them is somebody's mistake.
        return {
            kind: 'unreadable',
            detail: `the ledger holds ${ledger.malformedFiles.join(', ')}, which cannot be parsed, so it decides nothing`,
        };
    }
    if (ledger.policyRejected !== null) {
        // The rule that would have been applied is not the one on disk, so the decision would be about a policy nobody
        // wrote.
        return { kind: 'unreadable', detail: `the stored policy was refused (${ledger.policyRejected}), so nothing here decides` };
    }
    if (ledger.claims.length === 0) {
        return {
            kind: 'absent',
            detail: ledger.recordedFiles.length === 0
                ? 'no ledger has been recorded for this change, so nothing here decides it'
                : `the ledger holds ${ledger.recordedFiles.join(', ')} but no claims, so there is nothing to decide`,
        };
    }
    if (!ledger.subject) {
        return { kind: 'unreadable', detail: 'the ledger holds claims but no frozen subject, so no verdict can be about anything' };
    }

    // The quorum is assembled from the runs, compared over evidence rather than counted as votes; a single producer is not
    // a quorum and gets no report at all rather than a report claiming agreement.
    const producers = [...new Set(ledger.runs.map((run) => run.producer))];
    const evidenceToClaim: Record<string, string> = {};
    for (const claim of ledger.claims) for (const evidenceId of claim.evidenceIds) evidenceToClaim[evidenceId] = claim.id;
    // **The ceiling, applied at the boundary rather than left to the classification.** A floor is only as good as its
    // patterns, and the classification reads paths; a change to what evidence is accepted can sit under a pattern no rule
    // names. So the ledger route never decides below the policy's declared floor — an explicit `--tier` still wins,
    // because an operator who names a tier is making the decision this bound exists to keep honest.
    const classification = classifyRisk({
        paths: await declaredPaths(input.root, input.changeId),
        policy: ledger.policy,
    });
    // One derivation for the tier, shared with `ledger plan`: the ceiling is a rule about the tier, and a command that
    // ignored it reported a weaker tier than the one being enforced.
    const tier: TierName = resolveTier({ classification, policy: ledger.policy, ...(input.tier === undefined ? {} : { override: input.tier }) });
    // **The quorum is assembled from independent readings, not from reviewer names.** `groupByProducer` groups verdicts by
    // the run that decided them, so two runs are two observations and one run reported twice is one. The old shape handed
    // every producer the ledger's whole verdict list, which made `disputed` unreachable (one verdict per item) and made
    // `reviewers` a count of names rather than of readings — so `security.reviewers: 2` was unenforceable.
    const requiredReviewers = ledger.policy.tiers[tier].reviewers;
    // **Old verdicts are one reading, not one each.** A ledger written before `producer` existed groups every verdict under
    // one unattributed run: counting them individually would make a single run's readings look like a quorum, and the
    // count is reported so a shortfall caused by missing provenance is distinguishable from one caused by one reviewer.
    const { records, unattributed } = groupByProducer(ledger.verdicts);
    const quorum: QuorumReport | undefined = chainQuorum({
        records,
        unattributed,
        evidenceToClaim,
        requiredReviewers,
        demandDiversity: ledger.policy.diversity.requiredOn.includes('quorum'),
    });

    const decision = decide({
        subject: ledger.subject,
        claims: ledger.claims,
        evidence: ledger.evidence,
        verdicts: ledger.verdicts,
        challenges: ledger.challenges,
        policy: ledger.policy,
        tier,
        // The tier's contract, not the union of what the claims happen to say: a set derived from the claims makes the
        // coverage check unfailable, which is the one thing a gate must never be. The touched set comes from the path
        // table for the same reason — it is what the change reaches, not what its author asserted about it.
        declaredRiskClasses: ledger.policy.tiers[tier].requiredRiskClasses,
        touchedRiskClasses: classification.riskClasses,
        riskClassSources: classification.riskClassSources,
        assurance: input.assurance ?? (ledger.assurance as AssuranceLevel),
        usage: ledger.usage,
        c0Tokens: input.c0Tokens ?? null,
        // **Discovery counts what was observed, not what was declared.** Both signals are independent challenges — a
        // counterexample is a challenge the author must answer, a probe is a question asked of the reviewer after the
        // fact — but the *count* alone was satisfiable without anything running: `challenge add --command 'exit 0'`
        // followed by one check withdraws it (the command exits 0) and increments the count, and a probe answer was a
        // free-text string with nothing to compare against. `verifiedChallenges` is derived from what was recorded:
        // a challenge withdrawn with a failure observation, or a probe answer whose `observed` carries the digest prefix
        // the probe asked for. Measured before this: a ledger with four answered probes of empty `observed` satisfied the
        // strict floor.
        discovery: {
            independentChallenges:
                ledger.challenges.filter((challenge) => challenge.state !== 'open').length
                + (await readProbeAnswers(input.root, input.changeId)).length,
            verifiedChallenges:
                verifiedChallengeCount(ledger.challenges, await readProbeAnswers(input.root, input.changeId)),
        },
        ...(quorum === undefined ? {} : { quorum }),
        ...(input.actor === undefined ? {} : { actor: input.actor }),
    });

    return {
        kind: 'decided',
        tier,
        claims: ledger.claims.length,
        assurance: input.assurance ?? (ledger.assurance as AssuranceLevel),
        subjectRevision: ledger.subject.revision,
        decision,
    };
}

/**
 * The ledger's open problems: claims that are neither supported nor waived, with the severity the tier contract gave them.
 *
 * **It lives beside `unsupportedClaims` because that is what it is**: a projection of the same decision, and the module
 * that owns the decision is the one that can promise every reader gets the same answer. It used to live in
 * `workflow/navigation.ts`, which meant the review gate and the repair entry imported a *router* to read the ledger — a
 * quality gate depending on the thing that decides where to go next. One derivation, in the module that derives it.
 *
 * **An unreadable ledger is a refusal, not a crash** (`kind: 'unreadable'`). It used to throw, and two call sites —
 * `cmdVerify` and `cmdJudge` — call it bare, so a malformed `claims.json` turned those commands into stack traces while
 * the same call behind `review-read.ts` was already being wrapped and reported. A reader whose two callers disagree about
 * how to fail is the defect this change exists to remove, so the failure is a value here too and every caller decides
 * with it.
 */
export type LedgerProblemsRead =
    | { kind: 'read'; problems: Array<{ id: string; severity: string; statement: string }> }
    | { kind: 'unreadable'; detail: string };

// **The projection with no consumer is gone.** `openProblemsForReport` mapped the read to a `{problems, unreadable}`
// pair that only its own test used, while the envelope shape both commands publish comes from `openProblemsReportFields`
// below. Two producers for one shape is how the surfaces drift, and this file deletes that pattern everywhere else.
/**
 * The fields a command envelope publishes for the ledger read: the count, or the reason there is no count.
 *
 * **Spread from one function, because it was copied onto two surfaces and only one copy was asserted.** Measured:
 * restoring an unconditional `openProblems` on the judge path left the whole suite green, so the two report surfaces could
 * disagree about whether a `0` means "no problems" or "nobody looked" without any case noticing. The invariant is one
 * line of shape — *`openProblems` and `openProblemsUnreadable` are never both present* — and it is now produced in one
 * place, so the two commands cannot drift.
 */
export function openProblemsReportFields(read: LedgerProblemsRead): { openProblems?: number; openProblemsUnreadable?: string } {
    return read.kind === 'read' ? { openProblems: read.problems.length } : { openProblemsUnreadable: read.detail };
}

/**
 * The problems a ledger holds, **or the verdict's own reason for refusing it.**
 *
 * **This used to re-derive the readability predicate, and the two answers had already diverged.** The reader tested
 * `malformedFiles.length > 0 || policyRejected !== null`; `ledgerVerdict` tests the same two facts *and* a third — a
 * ledger that holds claims but no frozen subject decides nothing either. Measured on one fixture with `subject.json`
 * removed: this reader answered `read` (and published the claims as problems) while `ledgerVerdict` answered `unreadable`
 * — so `navigation.ts` refused the closure and routed to a repair while `readBlockingProblems`, which the approval, the
 * archive gate and the repair entry all share, published the counts. One file, two answers, in the module whose own
 * heading says "One derivation, in the module that derives it".
 *
 * So the predicate is not restated here: `unreadable` and `absent` are the verdict's answers, and this reader asks for
 * them. The only thing it owns is the mapping from "the ledger decides nothing" to the problems list.
 */
export async function openLedgerProblems(root: string, changeId: string): Promise<LedgerProblemsRead> {
    // **The verdict answers this question, and this reader asks it rather than restating it.**
    //
    // Two earlier versions of this fix restated the predicate locally, and each disagreed with the verdict in a state the
    // other had not thought of: first `malformedFiles || policyRejected` (missing `!subject`), then the same three
    // conditions re-derived *and* asked `nothingRecorded` as a fourth — which turned "the ledger holds evidence but no
    // claims", a state the verdict calls `absent`, into a refusal. Measured: a change with `evidence.json` and no claims
    // was refused at its own repair entry (`authorized: false`) where HEAD allowed it, so the second version introduced a
    // false refusal. The sentence was borrowed correctly both times; the *decision* is what has to be borrowed, because
    // anything short of that is a second derivation waiting to differ.
    const verdict = await ledgerVerdict({ root, changeId });
    if (verdict.kind === 'unreadable') {
        return { kind: 'unreadable', detail: verdict.detail };
    }
    // Readable by the verdict's account: the problems are what the ledger records as unsupported. The ledger is read here
    // rather than in the verdict because the verdict returns a decision, not the claims it read.
    const ledger = await readLedger(root, changeId);
    return {
        kind: 'read',
        problems: unsupportedClaims(ledger).map((claim) => ({ id: claim.claimId, severity: claim.severity, statement: claim.statement })),
    };
}
