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
import { readLedger, declaredPaths } from './ledger.js';
import { decide, type QuorumReport } from '../kernel/decide.js';
import { aggregateQuorum } from '../producers/quorum.js';
import { classifyRisk, TIER_RANK } from '../kernel/risk.js';
import type { AssuranceLevel, Decision, EvidenceVerdict, TierName } from '../kernel/types.js';

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
    const ceiling = ledger.policy.ledgerTierCeiling;
    const tier: TierName = input.tier
        ?? (TIER_RANK[classification.tier] >= TIER_RANK[ceiling] ? classification.tier : ceiling);
    const quorum: QuorumReport | undefined = producers.length > 1
        ? (() => {
            const outcome = aggregateQuorum({
                records: producers.map((producer) => ({
                    id: producer,
                    diversity: ledger.runs.find((run) => run.producer === producer)?.diversity ?? 'none',
                    verdicts: ledger.verdicts as EvidenceVerdict[],
                })),
                evidenceToClaim,
                requiredReviewers: ledger.policy.tiers[tier].reviewers,
                demandDiversity: ledger.policy.diversity.requiredOn.includes('quorum'),
            });
            return {
                disputedClaimIds: outcome.disputedClaimIds,
                undiversified: outcome.undiversified,
                reviewers: outcome.reviewers,
            };
        })()
        : undefined;

    const decision = decide({
        subject: ledger.subject,
        claims: ledger.claims,
        evidence: ledger.evidence,
        verdicts: ledger.verdicts,
        challenges: ledger.challenges,
        policy: ledger.policy,
        tier,
        // The tier's contract, not the union of what the claims happen to say: a set derived from the claims makes the
        // coverage check unfailable, which is the one thing a gate must never be.
        declaredRiskClasses: ledger.policy.tiers[tier].requiredRiskClasses,
        assurance: input.assurance ?? (ledger.assurance as AssuranceLevel),
        usage: ledger.usage,
        c0Tokens: input.c0Tokens ?? null,
        discovery: { independentChallenges: ledger.challenges.filter((challenge) => challenge.state !== 'open').length },
        ...(quorum === undefined ? {} : { quorum }),
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
