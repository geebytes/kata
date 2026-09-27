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
import { meetsAssuranceFloor, tierPolicy, type Policy } from './policy.js';
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
    /** How many independent reviewers the tier asked for. Absent means the tier asked for none. */
    requiredReviewers?: number;
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
    /**
     * What independently challenged this change, and what actually ran.
     *
     * `independentChallenges` alone was satisfiable by a challenge whose command was `exit 0`: the count included every
     * non-open challenge and every probe answer, so a challenge that never failed on anything counted as one, and a probe
     * answer was a string with no expected value to compare against. `verifiedChallenges` is the half that can be
     * checked — a challenge withdrawn with a recorded failure observation, or a probe answer whose recorded observation
     * contains the digest prefix the probe asked about — and the decision refuses when it is zero at a tier that
     * requires one, so the floor cannot be met by doing nothing.
     */
    discovery: { independentChallenges: number; /** Required, not optional: a caller must decide what it verified, or the floor is met by declaring. */ verifiedChallenges: number };
    quorum?: QuorumReport;
    previous?: { subject: Subject; claims: readonly Claim[] };
    /**
     * Who is asking for this decision, when it is known.
     *
     * Checked against the verdicts' producers: an approval asked for by a party that also produced the evidence is not
     * independent of it. Optional because the pure kernel must decide from its input alone — a caller that does not
     * know who it is gets the decision it would have got before, not a refusal it cannot act on.
     */
    actor?: string;
};

function reason(code: Reason['code'], detail: string, claimId?: string): Reason {
    return { code, detail, ...(claimId === undefined ? {} : { claimId }) };
}

/** One value per claim, derived from what was measured — never from the claim's own `status` field, which is a declaration. */
export type ClaimState =
    | 'supported'
    | 'waived'
    | 'unsupported'
    | 'refuted'
    | 'missing'
    | 'inconclusive'
    | 'stale'
    | 'below_strength'
    | 'challenged';

export type ClaimEvaluation = {
    claimId: string;
    state: ClaimState;
    /** Every problem this claim has, in the order they were found. Empty means the claim holds. */
    reasons: Reason[];
    deficits: Deficit[];
    strongestSupported: number;
};

/**
 * Evaluate one claim.
 *
 * Extracted so that "is this claim supported" has exactly one implementation: the decision calls it, and the cost report
 * calls it, which is what stops an operator reading six claims marked open next to a decision that says pass. The claim's
 * own `status` field is a declaration and is not consulted here, except for `waived`, which is a decision someone made.
 */
export function evaluateClaim(
    claim: Claim,
    input: {
        evidence: readonly Evidence[];
        verdicts: readonly EvidenceVerdict[];
        reusedEvidence: ReadonlySet<string>;
        policy: Policy;
        challenges: readonly Challenge[];
        subjectRevision: string;
    },
): ClaimEvaluation {
    const reasons: Reason[] = [];
    const deficits: Deficit[] = [];

    if (claim.status === 'waived') {
        if (!claim.waiver?.reason?.trim()) {
            reasons.push(reason('waived_without_reason', REASON_MESSAGES.waived_without_reason.message, claim.id));
            return { claimId: claim.id, state: 'unsupported', reasons, deficits, strongestSupported: 0 };
        }
        return { claimId: claim.id, state: 'waived', reasons, deficits, strongestSupported: 0 };
    }

    const evidenceById = new Map(input.evidence.map((item) => [item.id, item]));
    const items = claim.evidenceIds.map((id) => evidenceById.get(id)).filter((item): item is Evidence => item !== undefined);
    if (items.length === 0) {
        reasons.push(reason('claim_unsupported', REASON_MESSAGES.claim_unsupported.message, claim.id));
        deficits.push({ claimId: claim.id, need: 'at least one evidence item' });
        return { claimId: claim.id, state: 'unsupported', reasons, deficits, strongestSupported: 0 };
    }

    const supportedStrengths: number[] = [];
    const problems = new Set<ClaimState>();
    for (const item of items) {
        const verdict = verdictFor(item.id, input.verdicts);
        if (!verdict) {
            reasons.push(reason('evidence_missing', `${item.id} has no verdict yet`, claim.id));
            deficits.push({ claimId: claim.id, need: `a verdict for ${item.id}` });
            problems.add('missing');
            continue;
        }
        if (verdict.verdict === 'refuted') {
            reasons.push(reason('evidence_refuted', `${item.id}: ${verdict.observed}`, claim.id));
            problems.add('refuted');
            continue;
        }
        if (verdict.verdict === 'inconclusive') {
            reasons.push(reason('evidence_inconclusive', `${item.id}: ${verdict.observed}`, claim.id));
            problems.add('inconclusive');
            continue;
        }
        // A verdict about another revision carries over only when the delta says the claim's dependencies are identical.
        if (verdict.subjectRevision !== input.subjectRevision && !input.reusedEvidence.has(item.id)) {
            reasons.push(reason(
                'evidence_stale_subject',
                `${item.id} was decided against ${verdict.subjectRevision}, and the claim it supports changed with the subject`,
                claim.id,
            ));
            problems.add('stale');
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
        problems.add('below_strength');
    }

    const openChallenges = input.challenges.filter((challenge) => challenge.claimId === claim.id && challenge.state === 'open');
    if (openChallenges.length > 0) {
        reasons.push(reason(
            'challenge_open',
            `${openChallenges.length} open counterexample(s): ${openChallenges.map((challenge) => challenge.id).join(', ')}`,
            claim.id,
        ));
        problems.add('challenged');
    }

    // The single state an operator reads. `supported` only when nothing was found, and the problems are reported in a
    // fixed precedence so the same ledger always reads the same way.
    const order: ClaimState[] = ['refuted', 'stale', 'missing', 'inconclusive', 'below_strength', 'challenged'];
    const state = order.find((candidate) => problems.has(candidate)) ?? 'supported';
    return { claimId: claim.id, state, reasons, deficits, strongestSupported };
}

export function decide(input: DecideInput): Decision {
    const reasons: Reason[] = [];
    const deficits: Deficit[] = [];

    // 1. Budget first: a spent budget can only ever be `insufficient`.
    const budget = budgetStatus({ policy: input.policy, usage: input.usage, c0Tokens: input.c0Tokens ?? null });
    if (budget.exhausted) reasons.push(reason('budget_exhausted', budgetDetail(budget)));

    // 2. Process assurance is a separate axis, judged against the tier's threat model.
    if (!meetsAssuranceFloor(input.policy, input.tier, input.assurance)) {
        reasons.push(reason(
            'assurance_below_tier',
            `assurance ${input.assurance} is below the ${input.tier} floor of ${tierPolicy(input.policy, input.tier).assuranceFloor}`,
        ));
    }

    // 3. What the change forces back open, and which verdicts survive it.
    const delta = computeDelta({
        ...(input.previous === undefined ? {} : { previous: input.previous }),
        next: { subject: input.subject, claims: input.claims },
        verdicts: input.verdicts,
    });
    const reused = new Set(delta.reusedEvidence);

    // **A dependency that cannot be resolved is a reason, not only a reuse decision.** The delta's  flag was
    // computed and read by nobody in the decision: measured by the corpus scorer, a claim resting on a path absent from
    // the subject was certified because the resolvability check and this report were in different places — and the check
    // itself ran on one of two paths (repaired in ). Two repairs to one fact is this repository's oldest shape;
    // the fact is now one, and the decision carries it as a reason a reader can see.
    if (delta.underivable) {
        reasons.push(reason('dependency_unresolvable', `these dependencies cannot be resolved against the subject: ${delta.underivableRefs.join(', ')}`));
    }

    // 4. Every claim, for itself — through the one implementation of that question.
    for (const claim of input.claims) {
        const evaluation = evaluateClaim(claim, {
            evidence: input.evidence,
            verdicts: input.verdicts,
            reusedEvidence: reused,
            policy: input.policy,
            challenges: input.challenges,
            subjectRevision: input.subject.revision,
        });
        reasons.push(...evaluation.reasons);
        deficits.push(...evaluation.deficits);
    }

    // 4b. **Independence, as far as one machine can check it.** A ledger cannot prove a context was fresh — that is the
    // assurance axis and why the receipt exists — but it does record who produced each verdict, and when a decision is
    // asked for by an actor that is also one of those producers the approval is not independent of its own claims. The
    // check is deliberately narrow: it refuses only when the *approving* actor is among the producers, because that is
    // the one combination a single-actor workflow actually creates, and refusing more would need identities this
    // platform does not issue.
    if (input.actor !== undefined && input.actor.trim() !== '') {
        const producers = new Set(input.verdicts.map((verdict) => verdict.producer?.actor).filter((actor): actor is string => Boolean(actor)));
        if (producers.has(input.actor)) {
            reasons.push(reason(
                'same_actor',
                `the decision was asked for by ${input.actor}, who also produced ${input.verdicts.filter((verdict) => verdict.producer?.actor === input.actor).length} of its verdict(s)`,
            ));
        }
    }

    // 5. Coverage is over the finite risk space, not over every path.
    const claimed = new Set(input.claims.map((claim) => claim.riskClass));
    const uncovered = input.declaredRiskClasses.filter((riskClass) => !claimed.has(riskClass));
    if (uncovered.length > 0) {
        reasons.push(reason('uncovered_risk_class', `no claim covers: ${uncovered.join(', ')}`));
    }

    // 6. Discovery floor: a tier at or above medium must have had at least one independent challenge — and the challenge
    //    must be one that actually ran. The count alone was satisfiable by `challenge add --command 'exit 0'` followed by
    //    one check (the command exits 0, the state becomes `withdrawn`, the count increments), so a change could satisfy
    //    the floor without anything having been challenged. `verifiedChallenges` counts the ones with a recorded
    //    observation, which is the difference between a challenge and a declaration of one.
    if (input.tier !== 'standard' && input.discovery.independentChallenges === 0) {
        reasons.push(reason('discovery_floor', REASON_MESSAGES.discovery_floor.message));
    }
    if (input.tier !== 'standard'
        && input.discovery.independentChallenges > 0
        && (input.discovery.verifiedChallenges ?? 0) === 0) {
        // Named separately from `discovery_floor` because the remediation differs: the first says "nothing challenged
        // this", the second says "something claims to have, and no observation supports it".
        reasons.push(reason('discovery_unverified', REASON_MESSAGES.discovery_unverified.message));
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

    // **The reviewer count is a condition, not a report.** `tiers.<tier>.reviewers` is a number the tier's contract
    // states, and nothing compared it: a single producer reached `security`, whose contract asks for two independent
    // readings. The count is of *independent runs*, not of reviewer names, so replaying one reading twice does not form
    // a quorum. `requiredReviewers` travels on the report so this stays a pure function of its input.
    const requiredReviewers = quorum?.requiredReviewers ?? tierPolicy(input.policy, input.tier).reviewers;
    if (requiredReviewers > 1 && (quorum?.reviewers ?? 0) < requiredReviewers) {
        reasons.push(reason(
            'quorum_missing',
            `${requiredReviewers} independent reviewer(s) are required by the ${input.tier} contract and ${quorum?.reviewers ?? 0} submitted`
            + (quorum === undefined ? '; no run recorded a verdict, so there is nothing to count' : ''),
        ));
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
        // **Said rather than implied.** With no previous subject the delta's answer is an empty reuse list, which is the
        // conservative result and indistinguishable from a comparison that found nothing reusable. The flag is what lets a
        // reader tell the two apart — the rule this subsystem applies to every other unmeasurable quantity.
        deltaEvaluated: input.previous !== undefined,
        deficits,
        undiversified: quorum?.undiversified ?? false,
    };
}

/** Every reason a decision can carry, so a caller can render them without its own table of wordings. */
export function reasonMessage(reason: Reason): string {
    return REASON_MESSAGES[reason.code].message;
}
