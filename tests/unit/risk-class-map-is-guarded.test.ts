import { describe, expect, it } from 'vitest';
import { policyFloorChangeClaims } from '../../src/kernel/risk.js';
import { defaultPolicy, loadPolicy } from '../../src/kernel/policy.js';

/**
 * **The path table carries two answers, so both of them are guarded the same way.**
 *
 * The floor guard existed and the risk classes did not: a pattern's floor could not be lowered quietly, but what the
 * change is *asserted to be about* could be — and that is the half that decides whether a class is demanded at all, so
 * quietly narrowing it is the cheaper way around the deep tier. Measured: with the classes carried on the same entry, a
 * class-only edit left the guard silent, because it compared the entries by reference and the entries were strings.
 *
 * The comparison is now by value, which is also what keeps the guard from firing on every write: a parsed policy builds
 * new objects, so identity and equality stopped being the same question.
 */
const at = '2026-09-29T00:00:00.000Z';

function floors(previous: Record<string, { floor: 'low' | 'medium' | 'high'; riskClasses: string[] }>, next: typeof previous) {
    return policyFloorChangeClaims({ previous: previous as never, next: next as never, at, requireReview: true });
}

describe('a change to what a pattern is about is a change', () => {
    it('claims when a risk class is added to a pattern whose floor did not move', () => {
        const claims = floors(
            { 'src/quality/**': { floor: 'medium', riskClasses: ['consistency'] } },
            { 'src/quality/**': { floor: 'medium', riskClasses: ['consistency', 'failure_mode'] } },
        );
        expect(claims.map((claim) => claim.id)).toEqual(['policy-floor:src/quality/**']);
        expect(claims[0]?.riskClass).toBe('privilege');
        expect(claims[0]?.statement).toContain('risk classes');
        expect(claims[0]?.statement).toContain('failure_mode');
    });

    it('claims when a class is removed, which is the direction that makes a gate easier', () => {
        const claims = floors(
            { 'src/kernel/**': { floor: 'high', riskClasses: ['consistency', 'privilege'] } },
            { 'src/kernel/**': { floor: 'high', riskClasses: ['consistency'] } },
        );
        expect(claims).toHaveLength(1);
        expect(claims[0]?.statement).toContain('privilege');
    });

    it('claims once when both answers move on the same pattern, and says so', () => {
        const claims = floors(
            { 'src/store/**': { floor: 'medium', riskClasses: ['consistency', 'provenance'] } },
            { 'src/store/**': { floor: 'low', riskClasses: ['consistency'] } },
        );
        expect(claims).toHaveLength(1);
        expect(claims[0]?.statement).toContain('floor and risk classes');
    });

    it('says nothing when the table is the same content in new objects', () => {
        // The regression the by-value comparison exists for: a freshly parsed policy produces a new object per entry, so a
        // reference comparison would claim every pattern changed on every write — a guard that fires always is read as
        // noise and then ignored, which is worse than no guard.
        const stored = loadPolicy(JSON.parse(JSON.stringify(defaultPolicy())));
        expect(stored.ok).toBe(true);
        if (!stored.ok) return;
        const reparsed = loadPolicy(JSON.parse(JSON.stringify(stored.policy)));
        expect(reparsed.ok).toBe(true);
        if (!reparsed.ok) return;
        expect(policyFloorChangeClaims({
            previous: stored.policy.riskFloors,
            next: reparsed.policy.riskFloors,
            at,
            requireReview: true,
        })).toEqual([]);
    });

    it('claims nothing when the audit rule is off, because that is a policy decision rather than a skip', () => {
        expect(policyFloorChangeClaims({
            previous: { 'src/**': { floor: 'medium', riskClasses: ['consistency'] } } as never,
            next: { 'src/**': { floor: 'low', riskClasses: ['consistency'] } } as never,
            at,
            requireReview: false,
        })).toEqual([]);
    });
});