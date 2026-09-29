/**
 * Risk — how deep a change is reviewed, and two rules that keep the depth honest.
 *
 * The classifier is deterministic and its floors are data (policy), because a learned scorer that can be talked into
 * calling a sensitive path low risk is a way around the gate. The floor table therefore has its own audit rule: changing a
 * floor produces a claim of class `privilege`, which goes through the same review it gates.
 */
import type { Claim, RiskClass, TierName } from './types.js';
import type { Floor, Policy } from './policy.js';

export const FLOOR_TIER: Record<Floor, TierName> = { low: 'standard', medium: 'strict', high: 'security' };
export const TIER_FLOOR: Record<TierName, Floor> = { standard: 'low', strict: 'medium', security: 'high' };

/** Tier order, so "at least" can be expressed once. */
export const TIER_RANK: Record<TierName, number> = { standard: 0, strict: 1, security: 2 };

export function floorRank(floor: Floor): number {
    return floor === 'high' ? 2 : floor === 'medium' ? 1 : 0;
}


/** `src/quality/**` matches the directory and everything under it; a bare path matches itself. */
export function floorMatches(pattern: string, path: string): boolean {
    if (pattern.endsWith('/**')) {
        const base = pattern.slice(0, -3);
        return path === base || path.startsWith(`${base}/`);
    }
    if (pattern.endsWith('*')) return path.startsWith(pattern.slice(0, -1));
    return path === pattern;
}

export type RiskClassification = {
    tier: TierName;
    floor: Floor;
    matched: Array<{ pattern: string; path: string; floor: Floor }>;
    /**
     * The risk classes this change reaches, from the same walk that produced the floor.
     *
     * The tier's `requiredRiskClasses` used to be demanded in full whatever the change touched, so a consistency-only
     * repair had to carry a `failure_mode` claim or sit permanently `insufficient` — and the refusal listed no deficit to
     * close. This field is what makes the demand proportional: `required ∩ riskClasses` is the set that must be claimed.
     */
    riskClasses: RiskClass[];
    /** Which pattern produced which class, so a refusal can name the path that made it necessary. */
    riskClassSources: Array<{ pattern: string; classes: RiskClass[] }>;
    wideChange: boolean;
    /** Reported so an operator can see the classification was decided, not guessed. */
    reason: string;
};

/**
 * **The tier a change is reviewed at — the one derivation, so no two commands disagree about it.**
 *
 * It was derived twice and the two answers differed on a real change: `ledger plan` reported the *classification* tier
 * (`standard`) while `ledger decide` reported the policy ceiling (`strict`). The ceiling is not decoration — it exists
 * because a floor is only as good as its patterns, and a change to what evidence is accepted sits under a pattern no rule
 * names — so the command that ignored it was computing the plan's required evidence and risk classes for a weaker tier than
 * the one the decision would enforce. A plan weaker than its gate is worse than no plan: it looks like a specification.
 *
 * An explicit override still wins: naming a tier is the operator making the decision the ceiling exists to keep honest.
 */
export function resolveTier(input: {
    classification: RiskClassification;
    policy: Policy;
    override?: TierName;
}): TierName {
    if (input.override !== undefined) return input.override;
    const ceiling = input.policy.ledgerTierCeiling;
    return TIER_RANK[input.classification.tier] >= TIER_RANK[ceiling] ? input.classification.tier : ceiling;
}

export function classifyRisk(input: {
    paths: readonly string[];
    policy: Policy;
    wideChangeThreshold?: number;
}): RiskClassification {
    const matched: Array<{ pattern: string; path: string; floor: Floor }> = [];
    /** Which class each matched pattern made the change about, kept with the pattern so the refusal can name it. */
    const byPattern = new Map<string, RiskClass[]>();
    let highest: Floor = 'low';
    for (const path of input.paths) {
        for (const [pattern, entry] of Object.entries(input.policy.riskFloors)) {
            if (!floorMatches(pattern, path)) continue;
            matched.push({ pattern, path, floor: entry.floor });
            byPattern.set(pattern, entry.riskClasses);
            if (floorRank(entry.floor) > floorRank(highest)) highest = entry.floor;
        }
    }
    // **The classes the change reaches, read off the same walk as the floor.** One pass over one table, so a pattern
    // cannot raise a floor without also saying what it is about.
    const riskClasses = [...new Set([...byPattern.values()].flat())].sort() as RiskClass[];
    const riskClassSources = [...byPattern.entries()].map(([pattern, classes]) => ({ pattern, classes }));
    const threshold = input.wideChangeThreshold ?? 25;
    const wideChange = input.paths.length >= threshold;
    if (highest === 'low' && wideChange) {
        return {
            tier: FLOOR_TIER.medium,
            floor: 'medium',
            matched,
            riskClasses,
            riskClassSources,
            wideChange,
            reason: `no floor matched and the change touches ${input.paths.length} paths (>= ${threshold})`,
        };
    }
    return {
        tier: FLOOR_TIER[highest],
        floor: highest,
        matched,
        riskClasses,
        riskClassSources,
        wideChange,
        reason: matched.length > 0
            ? `floor ${highest} from ${matched.length} matched path(s)`
            : `no floor matched and the change is narrow (${input.paths.length} paths)`,
    };
}

/**
 * A change to the floor table is itself a change. Each added, removed or altered floor becomes a claim of class
 * `privilege`, so the table cannot be quietly widened to make a gate easier.
 */
export function policyFloorChangeClaims(input: {
    previous: Record<string, { floor: Floor; riskClasses: readonly RiskClass[] }>;
    next: Record<string, { floor: Floor; riskClasses: readonly RiskClass[] }>;
    at: string;
    requireReview: boolean;
}): Claim[] {
    if (!input.requireReview) return [];
    const patterns = new Set([...Object.keys(input.previous), ...Object.keys(input.next)]);
    const claims: Claim[] = [];
    for (const pattern of [...patterns].sort()) {
        const before = input.previous[pattern];
        const after = input.next[pattern];
        // **By value, because the entries are objects.** The guard used to compare the floors themselves, where identity
        // and equality were the same question; a freshly parsed policy builds new objects, so a reference comparison would
        // claim every pattern changed on every write — a guard that fires always is read as noise and then ignored.
        const sameFloor = before?.floor === after?.floor;
        const sameClasses = JSON.stringify([...(before?.riskClasses ?? [])].sort()) === JSON.stringify([...(after?.riskClasses ?? [])].sort());
        if (before !== undefined && after !== undefined && sameFloor && sameClasses) continue;
        // The statement names which of the two answers moved, because the remedies differ: a floor is about how deep the
        // review goes, a class is about what the change is asserted to be about.
        const describe = (entry: { floor: Floor; riskClasses: readonly RiskClass[] } | undefined): string =>
            entry === undefined ? 'nothing' : `${entry.floor} / [${[...entry.riskClasses].sort().join(', ')}]`;
        const moved = before !== undefined && after !== undefined && !sameFloor && !sameClasses
            ? 'floor and risk classes'
            : before !== undefined && after !== undefined && !sameFloor
                ? 'floor'
                : 'risk classes';
        const statement = before === undefined
            ? `risk floor added for ${pattern}: ${describe(after)}`
            : after === undefined
                ? `risk floor removed for ${pattern} (was ${describe(before)})`
                : `risk ${moved} for ${pattern} moved from ${describe(before)} to ${describe(after)}`;
        claims.push({
            id: `policy-floor:${pattern}`,
            statement,
            riskClass: 'privilege',
            severity: 'major',
            dependsOn: [],
            evidenceIds: [],
            challengeIds: [],
            status: 'open',
            // Stamped by the store: a claim constructed here has no clock, and the store is the only writer that knows one.
            at: '',
            reopens: 0,
        });
    }
    return claims;
}

function seedValue(seed: string): number {
    let value = 0x811c9dc5;
    for (let index = 0; index < seed.length; index += 1) {
        value ^= seed.charCodeAt(index);
        value = Math.imul(value, 0x01000193) >>> 0;
    }
    return value === 0 ? 0x9e3779b9 : value;
}

/**
 * Deterministic sampling: the same seed and the same item list promote the same items, so an audit can be re-run and a
 * reviewer cannot be chosen because they are convenient. No `Math.random` — a drawn sample must be reproducible.
 */
export function promotionTargets(input: { seed: string; items: readonly string[]; rate: number }): string[] {
    if (input.items.length === 0) return [];
    const rate = Math.min(Math.max(input.rate, 0), 1);
    if (rate <= 0) return [];
    let state = seedValue(input.seed);
    const promoted: string[] = [];
    for (const item of input.items) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        const draw = state / 0x1_0000_0000;
        if (draw < rate) promoted.push(item);
    }
    return promoted;
}
