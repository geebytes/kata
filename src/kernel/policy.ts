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
    READABLE_ASSURANCE_LEVELS,
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
    /** The weakest assurance this tier accepts; old policy records may retain a legacy floor. */
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
    /**
     * Per path pattern: the floor it raises the change to, **and the risk classes reaching it makes the change about**.
     *
     * **One entry carries both answers on purpose.** The alternative — a second table from pattern to risk class — would
     * be two lists that must agree about which patterns exist, which is the "one fact, two sources" defect this
     * repository removes everywhere else; deriving the classes from `riskFloors` instead of from a copy of it means a
     * pattern cannot be floored without also saying what it is about.
     */
    riskFloors: Record<string, { floor: Floor; riskClasses: RiskClass[] }>;
    riskFloorAudit: { changesRequireReview: boolean };
    /**
     * The weakest tier the ledger route accepts, whatever the classification says.
     *
     * The classification is a floor derived from paths, and a floor is only as good as its patterns: a change to the
     * admission rule itself sits under `src/**`, which the standard patterns do not look inside, so a change that alters
     * what evidence is accepted could be approved on auto-evidence alone. Raising a floor is cheap and lowering one needs
     * a review, so the bound is a **ceiling on the tier** and it is data like every other rule here.
     */
    ledgerTierCeiling: TierName;
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
    'ledgerTierCeiling': 'store/verdict',
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
                // Kata observes the round in the host-provided execution environment.
                // Network, filesystem and credential isolation are platform deployment policy,
                // not a local Kata assurance claim.
                assuranceFloor: 'observed',
                requiredRiskClasses: ['consistency', 'boundary', 'failure_mode', 'privilege', 'provenance'],
                humanBudgetMin: 30,
            },
        },
        riskFloors: {
            'src/quality/**': { floor: 'medium', riskClasses: ['consistency'] },
            'src/workflow/**': { floor: 'medium', riskClasses: ['consistency', 'state_transition'] },
            'src/store/**': { floor: 'medium', riskClasses: ['consistency', 'provenance'] },
            'src/cli/**': { floor: 'medium', riskClasses: ['boundary'] },
            // **`high` has to exist or the security tier is reachable.** The classification is the maximum floor over the
            // paths a change touches, so without a high rule the stricter quorum and privilege risk class are inert.
            // The policy, decision and risk classifier are the gate itself, so touching them
            // remains a security change even though execution isolation is platform-owned.
            'src/kernel/policy.ts': { floor: 'high', riskClasses: ['consistency', 'privilege'] },
            'src/kernel/decide.ts': { floor: 'high', riskClasses: ['consistency', 'privilege'] },
            'src/kernel/risk.ts': { floor: 'high', riskClasses: ['consistency', 'privilege'] },
        },
        riskFloorAudit: { changesRequireReview: true },
        ledgerTierCeiling: 'strict',
        diversity: { requiredOn: ['quorum'], kinds: ['model_family', 'prompt_strategy', 'tool_profile'] },
        sampling: { rate: 0.2 },
        // **The wall clock is the measured envelope's own number, not an illustrative one** (`the two-budget finding`,
        // §16.2). The policy is the single source — `DEFAULT_REVIEW_BUDGET` reads this value rather than deriving a second
        // one — so the figure here has to be the calibrated one: the slowest pass this repository has recorded is 43.8
        // minutes, and a limit of 30 minutes would refuse honest work instead of stopping a runaway. The 65-minute value
        // is that measurement times the headroom the calibration test asserts. The three resource limits moved to the
        // policy as a unit (tokens, wall clock, tool calls); `maxOutputBytes` is not a policy field because nothing
        // enforces it here.
        budgets: { maxTokensPerChange: '0.6*C0', maxWallMs: 3_940_500, deadlineToolCalls: null },
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
    // A scalar section is named by itself: the enumerator walks the object's fields, and a tier name would otherwise look
    // like a missing consumer — which is exactly how the ceiling was refused the first time it was added.
    keys.add('ledgerTierCeiling');
    for (const field of Object.keys(policy.deadline)) keys.add(`deadline.${field}`);
    return [...keys].sort();
}

export type PolicyLoad =
    | { ok: true; policy: Policy; /** Top-level sections this reader filled because the stored document predates them. */ filled: string[] }
    | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate a parsed document. Refusals name the offending key, because "policy is invalid" is not actionable. */
/**
 * A stored policy read the way it was written, for the sections it predates.
 *
 * **Measured before this existed**: `ledgerTierCeiling` was added as a required top-level section, and the three ledgers
 * written before it became `unreadable` — `ledger decide` refused with "the stored policy was refused … so nothing here
 * decides". A required field that silently invalidates every document written before it is the same defect one layer down
 * from the one this repository keeps removing: a declaration that outlives what it declares. And on a store of record it
 * is worse than elsewhere, because the ledger is the only place the evidence lives — a reader that cannot read it has
 * destroyed the record rather than reported a gap.
 *
 * The rule is the one the evidence reader already follows (`passed ?? exitCode === 0`): a **missing** section takes the
 * value its absence implied, and which sections were filled is **reported** (`filled`), so a substituted rule is visible
 * rather than silent. An **unknown** section still refuses — that is a field nothing reads, which is a different fact and
 * still a defect. The distinction is deliberate: absence is history, an extra key is a declaration with no consumer.
 */
export function loadPolicy(value: unknown): PolicyLoad {
    if (!isRecord(value)) return { ok: false, error: 'policy must be a JSON object' };
    if (typeof value.version !== 'number') return { ok: false, error: 'version must be a number' };
    // Only for version 1, and only for known sections: an unknown key is still refused by the enumeration below.
    if (value.version === 1) {
        // **Fills compose, and the filled document is what is returned.** The first version of this step patched the
        // sections a stored policy predates and returned the *patched* document — while patching only the floors fell
        // through to the original, so the conversion was computed and then discarded. One accumulator, one return.
        const defaults: Record<string, unknown> = { ...defaultPolicy() };
        const stored: Record<string, unknown> = { ...value };
        const filled: string[] = [];
        for (const section of ['tiers', 'riskFloors', 'riskFloorAudit', 'ledgerTierCeiling', 'diversity', 'sampling', 'budgets', 'evidenceStrength', 'deadline']) {
            if (stored[section] === undefined) {
                stored[section] = defaults[section];
                filled.push(section);
            }
        }
        // **A `riskFloors` entry stored as a bare floor predates the risk classes it now carries, and it is filled rather
        // than refused.** Measured, by running a governed change through the installed CLI and then reading its policy with
        // this build: `{"src/quality/**": "medium"}` — the shape every policy written before this change has — was rejected
        // with `riskFloors["src/quality/**"] must be an object carrying floor and riskClasses`, which would have made every
        // existing ledger unreadable and every review undecidable. A reader that cannot read a store of record has destroyed
        // the record.
        //
        // The classes an old entry is about come from the defaults for that pattern; a pattern the defaults do not name is
        // filled with every tier's required classes, which is the conservative direction — the demand stays at least as wide
        // as it was when the table was written — and the substitution is named in `filled`.
        const storedFloors = stored.riskFloors;
        if (isRecord(storedFloors)) {
            const defaultFloors = defaults.riskFloors as Record<string, { floor: string; riskClasses: string[] }>;
            const required = [...new Set(Object.values(defaults.tiers as Record<string, { requiredRiskClasses: string[] }>).flatMap((tier) => tier.requiredRiskClasses))];
            let convertedAny = false;
            const converted: Record<string, unknown> = {};
            for (const [pattern, entry] of Object.entries(storedFloors)) {
                if (typeof entry !== 'string') {
                    converted[pattern] = entry;
                    continue;
                }
                converted[pattern] = { floor: entry, riskClasses: defaultFloors[pattern]?.riskClasses ?? required };
                convertedAny = true;
            }
            if (convertedAny) {
                stored.riskFloors = converted;
                if (!filled.includes('riskFloors')) filled.push('riskFloors');
            }
        }
        if (filled.length > 0) {
            const result = loadFilled(stored);
            return result.ok ? { ...result, filled } : result;
        }
    }
    return loadFilled(value);
}

/** The validation proper, for a document that carries every section. */
function loadFilled(value: Record<string, unknown>): PolicyLoad {
    // The top level is enumerated too, and against the same list the consumers name: a section this build does not read
    // is a field nothing reads, which is how a policy key becomes a rule nobody can see.
    const knownSections = ['version', 'tiers', 'riskFloors', 'riskFloorAudit', 'ledgerTierCeiling', 'diversity', 'sampling', 'budgets', 'evidenceStrength', 'deadline'];
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
        if (!READABLE_ASSURANCE_LEVELS.includes(entry.assuranceFloor as AssuranceLevel)) {
            return { ok: false, error: `tiers.${tier}.assuranceFloor must be one of ${READABLE_ASSURANCE_LEVELS.join(', ')}` };
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
    for (const [pattern, entry] of Object.entries(value.riskFloors)) {
        if (!isRecord(entry)) return { ok: false, error: `riskFloors["${pattern}"] must be an object carrying floor and riskClasses` };
        if (entry.floor !== 'low' && entry.floor !== 'medium' && entry.floor !== 'high') {
            return { ok: false, error: `riskFloors["${pattern}"].floor must be low, medium or high` };
        }
        if (!Array.isArray(entry.riskClasses) || entry.riskClasses.length === 0) {
            // A pattern that reaches nothing about the change would be a floor with no subject, which is the reading this
            // field exists to prevent.
            return { ok: false, error: `riskFloors["${pattern}"].riskClasses must name at least one risk class` };
        }
        for (const riskClass of entry.riskClasses) {
            if (!RISK_CLASSES.includes(riskClass as RiskClass)) {
                return { ok: false, error: `riskFloors["${pattern}"].riskClasses names an unknown class: ${String(riskClass)}` };
            }
        }
    }
    if (!isRecord(value.riskFloorAudit) || typeof value.riskFloorAudit.changesRequireReview !== 'boolean') {
        return { ok: false, error: 'riskFloorAudit.changesRequireReview must be a boolean' };
    }
    if (!isRecord(value.diversity) || !Array.isArray(value.diversity.requiredOn) || !Array.isArray(value.diversity.kinds)) {
        return { ok: false, error: 'diversity.requiredOn and diversity.kinds must be lists' };
    }
    if (!TIER_NAMES.includes(value.ledgerTierCeiling as TierName)) {
        return { ok: false, error: `ledgerTierCeiling must be one of ${TIER_NAMES.join(', ')}` };
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

    // A named assertion at the end of the validation above, not an escape: every field it reads has been checked, and the
    // type says which shape the checks established.
    const policy = value as Policy;
    const declared = new Set(policyKeyPaths(policy));
    const known = new Set(Object.keys(POLICY_CONSUMERS));
    for (const key of declared) {
        if (!known.has(key)) return { ok: false, error: `policy field "${key}" has no consumer, so nothing reads it` };
    }
    for (const key of known) {
        if (!declared.has(key)) return { ok: false, error: `POLICY_CONSUMERS names "${key}" but the policy does not carry it` };
    }
    return { ok: true, policy, filled: [] };
}

export function tierPolicy(policy: Policy, tier: TierName): TierPolicy {
    return policy.tiers[tier];
}

/** A recorded assurance satisfies a tier when it is at least as strong as the tier's floor. */
export function meetsAssuranceFloor(policy: Policy, tier: TierName, assurance: AssuranceLevel): boolean {
    return assuranceAtLeast(assurance, tierPolicy(policy, tier).assuranceFloor);
}
