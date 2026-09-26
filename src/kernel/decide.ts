/**
 * The decision — one pure function over the ledger.
 *
 * Everything that decides anything lives here, and it takes data: subjects, claims, evidence, verdicts, challenges, a
 * policy, a budget reading and a quorum report. It never runs a command, never reads a file and never names a platform,
 * so the same ledger decides the same way wherever it is evaluated — which is what makes "the kernel is platform-neutral"
 * a checkable statement rather than a claim about our intentions.
 *
 * The order of the checks is deliberate: the budget is asked first and can only ever produce `insufficient`, so no later
 * branch can turn a spent budget into a pass.
 */
import { budgetDetail, budgetStatus, type BudgetUsage } from './budget.js';
import { computeDelta } from './delta.js';
import { MIN_STRENGTH_BY_SEVERITY, strengthOf, verdictFor } from './evidence.js';
import { acceptsAssurance, tierPolicy, type Policy } from './policy.js';
import {
    REASON_MESSAGES,
    type AssuranceLevel,
    type Challenge,
    type Claim,
    type Decision,
    type Deficit,
    type Evidence,
    type EvidenceVerdict,
    type Reason,
    type RiskClass,
    type Subject,
    type TierName,
} from './types.js';

export type QuorumReport = {
    /** Claims reviewers disagree about, with the disagreement unresolved. */
    disputedClaimIds: string[];
    /** True when the reviewers were not diverse enough to count as independent. */
    undiversified: boolean;
    reviewers: number;
};

export type DecideInput = {
    subject: Subject;
    claims: readonly Claim[];
    evidence: readonly Evidence[];
    verdicts: readonly EvidenceVerdict[];
    challenges: readonly Challenge[];
    policy: Policy;
    tier: TierName;
    /** The risk classes this change's review space declares. Every one of them must be claimed by some claim. */
    declaredRiskClasses: readonly RiskClass[];
    assurance: AssuranceLevel;
    usage: BudgetUsage;
    c0Tokens?: number | null;
    discovery: { independentChallenges: number };
    quorum?: QuorumReport;
    previous?: { subject: Subject; claims: readonly Claim[] };
};

function reason(code: Reason['code'], detail: string, claimId?: string): Reason {
    return { code, detail, ...(claimId === undefined ? {} : { claimId }) };
}

export function decide(input: DecideInput): Decision {
    const reasons: Reason[] = [];
    const deficits: Deficit[] = [];

    // 1. Budget first: a spent budget can only ever be `insufficient`.
    const budget = budgetStatus({ policy: input.policy, usage: input.usage, c0Tokens: input.c0Tokens ?? null });
    if (budget.exhausted) reasons.push(reason('budget_exhausted', budgetDetail(budget)));

    // 2. Process assurance is a separate axis, judged against the tier's threat model.
    if (!acceptsAssurance(input.policy, input.tier, input.assurance)) {
        reasons.push(reason(
            'assurance_below_tier',
            `assurance ${input.assurance} is not accepted by ${input.tier} (accepts ${tierPolicy(input.policy, input.tier).assurance.join(', ')})`,
        ));
    }

    // 3. What the change forces back open, and which verdicts survive it.
    const delta = computeDelta({
        ...(input.previous === undefined ? {} : { previous: input.previous }),
        next: { subject: input.subject, claims: input.claims },
        verdicts: input.verdicts,
    });
    const reused = new Set(delta.reusedEvidence);
    const evidenceById = new Map(input.evidence.map((item) => [item.id, item]));

    // 4. Every claim, for itself.
    for (const claim of input.claims) {
        if (claim.status === 'waived') {
            if (!claim.waiver?.reason?.trim()) {
                reasons.push(reason('waived_without_reason', REASON_MESSAGES.waived_without_reason.message, claim.id));
            }
            continue;
        }

        const items = claim.evidenceIds
            .map((id) => evidenceById.get(id))
            .filter((item): item is Evidence => item !== undefined);
        if (items.length === 0) {
            reasons.push(reason('claim_unsupported', REASON_MESSAGES.claim_unsupported.message, claim.id));
            deficits.push({ claimId: claim.id, need: 'at least one evidence item' });
            continue;
        }

        const supportedStrengths: number[] = [];
        for (const item of items) {
            const verdict = verdictFor(item.id, input.verdicts);
            if (!verdict) {
                reasons.push(reason('evidence_missing', `${item.id} has no verdict yet`, claim.id));
                deficits.push({ claimId: claim.id, need: `a verdict for ${item.id}` });
                continue;
            }
            if (verdict.verdict === 'refuted') {
                reasons.push(reason('evidence_refuted', `${item.id}: ${verdict.observed}`, claim.id));
                continue;
            }
            if (verdict.verdict === 'inconclusive') {
                reasons.push(reason('evidence_inconclusive', `${item.id}: ${verdict.observed}`, claim.id));
                continue;
            }
            // A verdict about another revision carries over only when the delta says the claim's dependencies are identical.
            if (verdict.subjectRevision !== input.subject.revision && !reused.has(item.id)) {
                reasons.push(reason(
                    'evidence_stale_subject',
                    `${item.id} was decided against ${verdict.subjectRevision}, and the claim it supports changed with the subject`,
                    claim.id,
                ));
                continue;
            }
            supportedStrengths.push(strengthOf(item.type));
        }

        const required = MIN_STRENGTH_BY_SEVERITY[claim.severity];
        const policyTypes = input.policy.evidenceStrength[claim.severity];
        const allowed = Array.isArray(policyTypes) ? new Set(policyTypes) : undefined;
        const strongestSupported = supportedStrengths.length === 0 ? 0 : Math.max(...supportedStrengths);
        const allowedSatisfied = allowed === undefined
            || items.some((item) => allowed.has(item.type) && supportedStrengths.some((strength) => strength === strengthOf(item.type)));
        if (strongestSupported < required || !allowedSatisfied) {
            reasons.push(reason(
                'evidence_below_strength',
                `${claim.severity} requires strength ${required}${allowed === undefined ? '' : ` and one of ${[...allowed].join(', ')}`}; strongest supported is ${strongestSupported}`,
                claim.id,
            ));
            deficits.push({
                claimId: claim.id,
                need: `evidence of strength >= ${required}${allowed === undefined ? '' : ` from ${[...allowed].join('|')}`}`,
            });
        }

        const openChallenges = input.challenges.filter(
            (challenge) => challenge.claimId === claim.id && challenge.state === 'open',
        );
        if (openChallenges.length > 0) {
            reasons.push(reason(
                'challenge_open',
                `${openChallenges.length} open counterexample(s): ${openChallenges.map((challenge) => challenge.id).join(', ')}`,
                claim.id,
            ));
        }
    }

    // 5. Coverage is over the finite risk space, not over every path.
    const claimed = new Set(input.claims.map((claim) => claim.riskClass));
    const uncovered = input.declaredRiskClasses.filter((riskClass) => !claimed.has(riskClass));
    if (uncovered.length > 0) {
        reasons.push(reason('uncovered_risk_class', `no claim covers: ${uncovered.join(', ')}`));
    }

    // 6. Discovery floor: a tier at or above medium must have had at least one independent challenge.
    if (input.tier !== 'standard' && input.discovery.independentChallenges === 0) {
        reasons.push(reason('discovery_floor', REASON_MESSAGES.discovery_floor.message));
    }

    // 7. Quorum: a disagreement is reported, and a reproducible finding is never voted away (a refuted verdict above
    //    already produced `fail`; the quorum cannot cancel it).
    const quorum = input.quorum;
    if (quorum && quorum.disputedClaimIds.length > 0) {
        reasons.push(reason('quorum_disputed', `disputed: ${quorum.disputedClaimIds.join(', ')}`));
    }
    if (quorum?.undiversified && input.tier === 'security') {
        reasons.push(reason('quorum_undiversified', REASON_MESSAGES.quorum_undiversified.message));
    }

    const verdict: Decision['verdict'] = reasons.some((entry) => entry.code === 'evidence_refuted')
        ? 'fail'
        : reasons.length > 0
            ? 'insufficient'
            : 'pass';

    return {
        verdict,
        riskTier: input.tier,
        reasons,
        reusedEvidence: delta.reusedEvidence,
        revalidateClaims: delta.revalidate,
        deficits,
        undiversified: quorum?.undiversified ?? false,
    };
}

/** Every reason a decision can carry, so a caller can render them without its own table of wordings. */
export function reasonMessage(reason: Reason): string {
    return REASON_MESSAGES[reason.code].message;
}
