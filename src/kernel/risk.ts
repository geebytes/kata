/**
 * Risk — how deep a change is reviewed, and two rules that keep the depth honest.
 *
 * The classifier is deterministic and its floors are data (policy), because a learned scorer that can be talked into
 * calling a sensitive path low risk is a way around the gate. The floor table therefore has its own audit rule: changing a
 * floor produces a claim of class `privilege`, which goes through the same review it gates.
 */
import type { Claim, TierName } from './types.js';
import type { Floor, Policy } from './policy.js';

export const FLOOR_TIER: Record<Floor, TierName> = { low: 'standard', medium: 'strict', high: 'security' };
export const TIER_FLOOR: Record<TierName, Floor> = { standard: 'low', strict: 'medium', security: 'high' };

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
    wideChange: boolean;
    /** Reported so an operator can see the classification was decided, not guessed. */
    reason: string;
};

export function classifyRisk(input: {
    paths: readonly string[];
    policy: Policy;
    wideChangeThreshold?: number;
}): RiskClassification {
    const matched: Array<{ pattern: string; path: string; floor: Floor }> = [];
    let highest: Floor = 'low';
    for (const path of input.paths) {
        for (const [pattern, floor] of Object.entries(input.policy.riskFloors)) {
            if (!floorMatches(pattern, path)) continue;
            matched.push({ pattern, path, floor });
            if (floorRank(floor) > floorRank(highest)) highest = floor;
        }
    }
    const threshold = input.wideChangeThreshold ?? 25;
    const wideChange = input.paths.length >= threshold;
    if (highest === 'low' && wideChange) {
        return {
            tier: FLOOR_TIER.medium,
            floor: 'medium',
            matched,
            wideChange,
            reason: `no floor matched and the change touches ${input.paths.length} paths (>= ${threshold})`,
        };
    }
    return {
        tier: FLOOR_TIER[highest],
        floor: highest,
        matched,
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
    previous: Record<string, Floor>;
    next: Record<string, Floor>;
    at: string;
    requireReview: boolean;
}): Claim[] {
    if (!input.requireReview) return [];
    const patterns = new Set([...Object.keys(input.previous), ...Object.keys(input.next)]);
    const claims: Claim[] = [];
    for (const pattern of [...patterns].sort()) {
        const before = input.previous[pattern];
        const after = input.next[pattern];
        if (before === after) continue;
        const statement = before === undefined
            ? `risk floor added for ${pattern}: ${String(after)}`
            : after === undefined
                ? `risk floor removed for ${pattern} (was ${before})`
                : `risk floor for ${pattern} moved from ${before} to ${after}`;
        claims.push({
            id: `policy-floor:${pattern}`,
            statement,
            riskClass: 'privilege',
            severity: 'major',
            dependsOn: [],
            evidenceIds: [],
            challengeIds: [],
            status: 'open',
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
