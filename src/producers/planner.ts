/**
 * The planner — what to look at, how deep, and with how much budget.
 *
 * Two things here exist because of measurements rather than taste. First, **reading sets**: a round cost 350K–660K tokens
 * of which the brief was 3–6 percent, so the cost is context discovery; bounding what a claim needs to be read against is
 * the only way to make a review cheaper per review rather than merely rarer. Second, the **deadline**: the one lever that
 * measurably turned record-less rounds into records (0/4 → 6/6) was a number in the brief, so it is derived here from the
 * recorded baseline instead of being a constant someone types.
 */
import { pathDepsOf } from '../kernel/delta.js';
import { admissibleFor, MIN_STRENGTH_BY_SEVERITY, strengthOf } from '../kernel/evidence.js';
import type { Policy } from '../kernel/policy.js';
import { tierPolicy } from '../kernel/policy.js';
import { classifyRisk, promotionTargets, type RiskClassification } from '../kernel/risk.js';
import type { Claim, EvidenceType, Subject, TierName } from '../kernel/types.js';

/** A claim that needs more than this many files read is a claim that is too wide to review, not one to read harder. */
export const MAX_READING_PATHS_PER_CLAIM = 8;

export type ClaimReadingSet = { claimId: string; paths: string[]; truncated: boolean };

export type ReviewPlan = {
    tier: TierName;
    risk: RiskClassification;
    requiredEvidence: Array<{ claimId: string; types: EvidenceType[]; minimumStrength: number }>;
    readingSets: ClaimReadingSet[];
    discovery: {
        required: boolean;
        deadlineToolCalls: number | null;
        instruction: string;
    };
    /** Which of the changed paths are promoted to the deep tier afterwards, drawn reproducibly from the policy rate. */
    sampling: { seed: string; rate: number; promoted: string[] };
    humanBudgetMin: number;
    reviewers: number;
    diversityRequired: boolean;
};

/** What one claim must be read against: the paths it declares, capped and reported when capped. */
export function readingSetFor(claim: Claim, cap: number = MAX_READING_PATHS_PER_CLAIM): ClaimReadingSet {
    const all = [...new Set(pathDepsOf(claim))].sort();
    return {
        claimId: claim.id,
        paths: all.slice(0, cap),
        truncated: all.length > cap,
    };
}

/**
 * The deadline is a number, not a sentiment: derived from the recorded baseline when policy leaves it to `auto`, and
 * `null` when there is no baseline — because a deadline nobody can compute must be reported as absent, not invented.
 */
export function deriveDeadline(input: { policy: Policy; c0Tokens: number | null }): number | null {
    const configured = input.policy.budgets.deadlineToolCalls;
    if (typeof configured === 'number') return configured;
    if (input.c0Tokens === null || input.c0Tokens <= 0) return null;
    return Math.max(10, Math.floor(input.c0Tokens / 3000));
}

export function planReview(input: {
    subject: Subject;
    claims: readonly Claim[];
    policy: Policy;
    tier: TierName;
    changedPaths: readonly string[];
    /**
     * **The declared path set, which the sampling seed is derived from.** `changedPaths` is the diff against the frozen
     * snapshot, so deriving the seed from it made the plan a function of the frozen snapshot as well as of the content: a
     * partial content change wrote a seed over the subset while the next plan on an unchanged ledger wrote one over every
     * path — the plan moved, the declared subject moved with it, and a recorded round that answered the current question was
     * released by a bare re-plan (measured by an independent round, with the guard blind to it because it declared one path).
     * The seed is about the content the sampling is over, so it is derived from the path set and never from the diff.
     */
    contentPaths?: readonly string[];
    /**
     * **The classification the resolver derived from the complete declared surface.** A plan publishes one classification
     * of a change, so a caller that already asked `ledgerTierForDeclaredPaths` passes its answer rather than classifying
     * again from the diff. Measured by an independent round (R2-F1): a re-plan whose diff omitted an unchanged declared
     * high-floor path published `plan.risk.tier: standard` beside `plan.tier: security`, and `plan.risk` is the field the
     * lane rule points the operator at (`kata-design`), so the lane could be chosen against the weaker number. A caller
     * with no resolver falls back to the path set it declared.
     */
    classification?: RiskClassification;
    c0Tokens?: number | null;
}): ReviewPlan {
    const tierInfo = tierPolicy(input.policy, input.tier);
    const risk = input.classification ?? classifyRisk({ paths: input.contentPaths ?? input.changedPaths, policy: input.policy });
    const deadline = deriveDeadline({ policy: input.policy, c0Tokens: input.c0Tokens ?? null });

    const requiredEvidence = input.claims.map((claim) => {
        const minimumStrength = MIN_STRENGTH_BY_SEVERITY[claim.severity];
        const policyTypes = input.policy.evidenceStrength[claim.severity];
        const allowed = Array.isArray(policyTypes) ? policyTypes : undefined;
        const candidates = new Set<EvidenceType>([...tierInfo.autoEvidence, ...(allowed ?? [])]);
        const types = [...candidates]
            .filter((type) => admissibleFor(type, claim.severity).ok)
            .sort((left, right) => strengthOf(right) - strengthOf(left));
        return { claimId: claim.id, types, minimumStrength };
    });

    const discoveryRequired = input.tier !== 'standard';
    const instructions: string[] = [];
    if (discoveryRequired) {
        instructions.push(
            deadline === null
                ? 'No baseline is recorded, so no deadline could be derived: report the cost you spent and expect the budget to be unenforced.'
                : `Emit a first complete record by tool call ${deadline}; the deadline is when the record must exist, not when reading stops.`,
        );
        instructions.push('Every claim you take must be read against its reading set, and a claim you do not take must be left open rather than claimed.');
    } else {
        instructions.push('Automatic evidence is expected to decide this change; record only what the automatic evidence could not.');
    }

    // The sampled audit: a fraction of the low-risk work is promoted afterwards, drawn from the subject and the path set
    // so the same change draws the same sample and the classifier's own error rate can be measured rather than assumed.
    // **The seed comes from the content, not from the identity the plan helps define.** It used to embed
    // `subject.revision`, while the subject hashes the plan — a fixed-point equation with no solution: `ledger plan` was
    // never idempotent and re-running it released a recorded round that answered the current question (both measured by an
    // independent round). The changed paths are what the sampling is over, so they are what the seed is derived from.
    const seedPaths = [...(input.contentPaths ?? input.changedPaths)].sort();
    const samplingSeed = `${seedPaths.join(',')}:${seedPaths.length}`;
    const sampling = {
        seed: samplingSeed,
        rate: input.policy.sampling.rate,
        promoted: promotionTargets({ seed: samplingSeed, items: [...input.changedPaths].sort(), rate: input.policy.sampling.rate }),
    };
    return {
        tier: input.tier,
        risk,
        requiredEvidence,
        sampling,
        readingSets: input.claims.map((claim) => readingSetFor(claim)),
        discovery: {
            required: discoveryRequired,
            deadlineToolCalls: deadline,
            instruction: instructions.join(' '),
        },
        humanBudgetMin: tierInfo.humanBudgetMin,
        reviewers: tierInfo.reviewers,
        diversityRequired: tierInfo.reviewers > 1 && input.policy.diversity.requiredOn.includes('quorum'),
    };
}
