/**
 * Policy — everything the gate judges by, as data.
 *
 * Today these values are spread across code, a rendered brief and a table of gate conditions, which is how a pass ends up
 * judged by a condition no brief ever stated. Here they live in one document, and `POLICY_CONSUMERS` names the module that
 * reads each one: the kernel test asserts the two sets are equal, so a field with no consumer (a declaration that does
 * nothing) and a consumer with no field (a rule nobody can see) are both refused.
 */
import type { RiskClass } from './types.js';
import {
    ASSURANCE_LEVELS,
    assuranceAtLeast,
    EVIDENCE_TYPES,
    RISK_CLASSES,
    SEVERITIES,
    TIER_NAMES,
    type AssuranceLevel,
    type EvidenceType,
    type Severity,
    type TierName,
} from './types.js';

export type Floor = 'low' | 'medium' | 'high';

export type TierPolicy = {
    /** Evidence types the tier requires automatically, before any reviewer runs. */
    autoEvidence: EvidenceType[];
    /** How many independent reviewers the tier expects. */
    reviewers: number;
    /** Conditions under which the mesh escalates to a further reviewer. */
    quorumOn: string[];
    /**
     * The weakest process assurance this tier accepts.
     *
     * A floor rather than an allowed set, and that distinction is load-bearing: with a set, a round that is *better*
     * observed than the tier asked for fails the check, which is how `observed` came to be refused by the standard tier in
     * a test of my own making.
     */
    assuranceFloor: AssuranceLevel;
    /**
     * The risk classes every change at this tier must have a claim for.
     *
     * Without this the coverage check cannot fail. If the required set were derived from the claims themselves — the union
     * of whatever they happen to be about — then every change would be covered by construction, which is the defect class
     * where a check stays green whatever happens. The contract is over the tier's fixed risk space: a class with no claim
     * is a hole somebody has to close, and the decision names it.
     */
    requiredRiskClasses: RiskClass[];
    /** Budget for human attention, in minutes. Zero means the tier expects none. */
    humanBudgetMin: number;
};

export type Policy = {
    version: number;
    tiers: Record<TierName, TierPolicy>;
    riskFloors: Record<string, Floor>;
    riskFloorAudit: { changesRequireReview: boolean };
    diversity: { requiredOn: string[]; kinds: string[] };
    /** How much of the low-risk work is promoted to the deep tier afterwards, so the classifier can be measured. */
    sampling: { rate: number };
    budgets: {
        /** A number, or an expression against the recorded baseline such as `0.6*C0`. */
        maxTokensPerChange: number | string;
        maxWallMs: number;
        deadlineToolCalls: number | null;
    };
    evidenceStrength: Partial<Record<Severity, EvidenceType[] | 'any'>>;
    deadline: { emitFirstRecordByToolCall: number | 'auto' };
};

/** Each declared field, and the module that reads it. Equality between this and the policy's own keys is asserted. */
export const POLICY_CONSUMERS: Record<string, string> = {
    'version': 'kernel/policy',
    'tiers.*.autoEvidence': 'producers/planner',
    'tiers.*.reviewers': 'producers/quorum',
    'tiers.*.quorumOn': 'producers/quorum',
    'tiers.*.assuranceFloor': 'kernel/decide',
    'tiers.*.requiredRiskClasses': 'kernel/decide',
    'tiers.*.humanBudgetMin': 'producers/planner',
    'riskFloors': 'kernel/risk',
    'riskFloorAudit.changesRequireReview': 'kernel/risk',
    'diversity.requiredOn': 'producers/quorum',
    'diversity.kinds': 'producers/quorum',
    'sampling.rate': 'producers/planner',
    'budgets.maxTokensPerChange': 'kernel/budget',
    'budgets.maxWallMs': 'kernel/budget',
    'budgets.deadlineToolCalls': 'producers/planner',
    'evidenceStrength': 'kernel/evidence',
    'deadline.emitFirstRecordByToolCall': 'producers/planner',
};

export function defaultPolicy(): Policy {
    return {
        version: 1,
        tiers: {
            standard: {
                autoEvidence: ['static_witness'],
                reviewers: 0,
                quorumOn: ['uncertainty', 'new_class', 'weak_evidence'],
                assuranceFloor: 'none',
                requiredRiskClasses: ['consistency'],
                humanBudgetMin: 0,
            },
            strict: {
                autoEvidence: ['static_witness', 'executable_falsifier'],
                reviewers: 1,
                quorumOn: ['disagreement', 'high_risk'],
                // Strict requires that kata itself observed the evidence: an approval on this route is held by the ledger,
                // and the ledger's credibility rests on the round having been run rather than reported.
                assuranceFloor: 'observed',
                requiredRiskClasses: ['consistency', 'boundary', 'failure_mode'],
                humanBudgetMin: 10,
            },
            security: {
                autoEvidence: ['static_witness', 'executable_falsifier', 'cross_artifact_contradiction'],
                reviewers: 2,
                quorumOn: ['always'],
                assuranceFloor: 'sandboxed',
                requiredRiskClasses: ['consistency', 'boundary', 'failure_mode', 'privilege', 'provenance'],
                humanBudgetMin: 30,
            },
        },
        riskFloors: {
            'src/quality/**': 'medium',
            'src/workflow/**': 'medium',
        },
        riskFloorAudit: { changesRequireReview: true },
        diversity: { requiredOn: ['quorum'], kinds: ['model_family', 'prompt_strategy', 'tool_profile'] },
        sampling: { rate: 0.2 },
        budgets: { maxTokensPerChange: '0.6*C0', maxWallMs: 1_800_000, deadlineToolCalls: null },
        evidenceStrength: {
            blocking: ['executable_falsifier'],
            major: ['static_witness', 'cross_artifact_contradiction', 'executable_falsifier'],
            minor: 'any',
            nit: 'any',
        },
        deadline: { emitFirstRecordByToolCall: 'auto' },
    };
}

/** The field paths a policy instance actually carries, with tier names collapsed so the set is comparable. */
export function policyKeyPaths(policy: Policy): string[] {
    const keys = new Set<string>(['version']);
    for (const tier of TIER_NAMES) {
        for (const field of Object.keys(policy.tiers[tier])) keys.add(`tiers.*.${field}`);
    }
    for (const field of Object.keys(policy.riskFloors)) keys.add(`riskFloors`);
    for (const field of Object.keys(policy.riskFloorAudit)) keys.add(`riskFloorAudit.${field}`);
    for (const field of Object.keys(policy.diversity)) keys.add(`diversity.${field}`);
    for (const field of Object.keys(policy.sampling)) keys.add(`sampling.${field}`);
    for (const field of Object.keys(policy.budgets)) keys.add(`budgets.${field}`);
    if (Object.keys(policy.evidenceStrength).length > 0) keys.add('evidenceStrength');
    for (const field of Object.keys(policy.deadline)) keys.add(`deadline.${field}`);
    return [...keys].sort();
}

export type PolicyLoad = { ok: true; policy: Policy } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate a parsed document. Refusals name the offending key, because "policy is invalid" is not actionable. */
export function loadPolicy(value: unknown): PolicyLoad {
    if (!isRecord(value)) return { ok: false, error: 'policy must be a JSON object' };
    if (typeof value.version !== 'number') return { ok: false, error: 'version must be a number' };
    // The top level is enumerated too, and against the same list the consumers name: a section this build does not read
    // is a field nothing reads, which is how a policy key becomes a rule nobody can see.
    const knownSections = ['version', 'tiers', 'riskFloors', 'riskFloorAudit', 'diversity', 'sampling', 'budgets', 'evidenceStrength', 'deadline'];
    for (const key of Object.keys(value)) {
        if (!knownSections.includes(key)) return { ok: false, error: `policy carries an unknown field "${key}"; nothing reads it` };
    }
    if (value.version !== 1) return { ok: false, error: `unknown policy version ${String(value.version)}; this build reads version 1` };

    if (!isRecord(value.tiers)) return { ok: false, error: 'tiers is required' };
    for (const tier of TIER_NAMES) {
        const entry = value.tiers[tier];
        if (!isRecord(entry)) return { ok: false, error: `tiers.${tier} is required` };
        const knownFields = ['autoEvidence', 'reviewers', 'quorumOn', 'assuranceFloor', 'requiredRiskClasses', 'humanBudgetMin'];
        for (const field of knownFields) {
            if (entry[field] === undefined) return { ok: false, error: `tiers.${tier}.${field} is required` };
        }
        for (const field of Object.keys(entry)) {
            if (!knownFields.includes(field)) {
                return { ok: false, error: `tiers.${tier} carries an unknown field "${field}"; nothing reads it` };
            }
        }
        const autoEvidence = entry.autoEvidence;
        if (!Array.isArray(autoEvidence) || autoEvidence.some((item) => !EVIDENCE_TYPES.includes(item as EvidenceType))) {
            return { ok: false, error: `tiers.${tier}.autoEvidence must be a list of known evidence types` };
        }
        if (!ASSURANCE_LEVELS.includes(entry.assuranceFloor as AssuranceLevel)) {
            return { ok: false, error: `tiers.${tier}.assuranceFloor must be one of ${ASSURANCE_LEVELS.join(', ')}` };
        }
        const requiredClasses = entry.requiredRiskClasses;
        if (!Array.isArray(requiredClasses) || requiredClasses.length === 0
            || requiredClasses.some((item) => !RISK_CLASSES.includes(item as RiskClass))) {
            return { ok: false, error: `tiers.${tier}.requiredRiskClasses must be a non-empty list of known risk classes` };
        }
        if (typeof entry.reviewers !== 'number' || entry.reviewers < 0) {
            return { ok: false, error: `tiers.${tier}.reviewers must be a non-negative number` };
        }
        if (typeof entry.humanBudgetMin !== 'number' || entry.humanBudgetMin < 0) {
            return { ok: false, error: `tiers.${tier}.humanBudgetMin must be a non-negative number` };
        }
        if (!Array.isArray(entry.quorumOn)) return { ok: false, error: `tiers.${tier}.quorumOn must be a list` };
    }

    if (!isRecord(value.riskFloors)) return { ok: false, error: 'riskFloors is required' };
    for (const [pattern, floor] of Object.entries(value.riskFloors)) {
        if (floor !== 'low' && floor !== 'medium' && floor !== 'high') {
            return { ok: false, error: `riskFloors["${pattern}"] must be low, medium or high` };
        }
    }
    if (!isRecord(value.riskFloorAudit) || typeof value.riskFloorAudit.changesRequireReview !== 'boolean') {
        return { ok: false, error: 'riskFloorAudit.changesRequireReview must be a boolean' };
    }
    if (!isRecord(value.diversity) || !Array.isArray(value.diversity.requiredOn) || !Array.isArray(value.diversity.kinds)) {
        return { ok: false, error: 'diversity.requiredOn and diversity.kinds must be lists' };
    }
    if (!isRecord(value.sampling) || typeof value.sampling.rate !== 'number' || value.sampling.rate < 0 || value.sampling.rate > 1) {
        return { ok: false, error: 'sampling.rate must be a number between 0 and 1' };
    }
    if (!isRecord(value.budgets)) return { ok: false, error: 'budgets is required' };
    const maxTokens = value.budgets.maxTokensPerChange;
    if (typeof maxTokens !== 'number' && typeof maxTokens !== 'string') {
        return { ok: false, error: 'budgets.maxTokensPerChange must be a number or an expression such as "0.6*C0"' };
    }
    if (typeof value.budgets.maxWallMs !== 'number' || value.budgets.maxWallMs <= 0) {
        return { ok: false, error: 'budgets.maxWallMs must be a positive number' };
    }
    const deadlineToolCalls = value.budgets.deadlineToolCalls;
    if (deadlineToolCalls !== null && typeof deadlineToolCalls !== 'number') {
        return { ok: false, error: 'budgets.deadlineToolCalls must be a number or null' };
    }
    if (!isRecord(value.evidenceStrength)) return { ok: false, error: 'evidenceStrength is required' };
    for (const [severity, types] of Object.entries(value.evidenceStrength)) {
        if (!SEVERITIES.includes(severity as Severity)) {
            return { ok: false, error: `evidenceStrength carries an unknown severity "${severity}"` };
        }
        if (types === 'any') continue;
        if (!Array.isArray(types) || types.some((item) => !EVIDENCE_TYPES.includes(item as EvidenceType))) {
            return { ok: false, error: `evidenceStrength.${severity} must be "any" or a list of known evidence types` };
        }
    }
    if (!isRecord(value.deadline)) return { ok: false, error: 'deadline is required' };
    const emitBy = value.deadline.emitFirstRecordByToolCall;
    if (emitBy !== 'auto' && typeof emitBy !== 'number') {
        return { ok: false, error: 'deadline.emitFirstRecordByToolCall must be a number or "auto"' };
    }

    const policy = value as unknown as Policy;
    const declared = new Set(policyKeyPaths(policy));
    const known = new Set(Object.keys(POLICY_CONSUMERS));
    for (const key of declared) {
        if (!known.has(key)) return { ok: false, error: `policy field "${key}" has no consumer, so nothing reads it` };
    }
    for (const key of known) {
        if (!declared.has(key)) return { ok: false, error: `POLICY_CONSUMERS names "${key}" but the policy does not carry it` };
    }
    return { ok: true, policy };
}

export function tierPolicy(policy: Policy, tier: TierName): TierPolicy {
    return policy.tiers[tier];
}

/** A recorded assurance satisfies a tier when it is at least as strong as the tier's floor. */
export function meetsAssuranceFloor(policy: Policy, tier: TierName, assurance: AssuranceLevel): boolean {
    return assuranceAtLeast(assurance, tierPolicy(policy, tier).assuranceFloor);
}
