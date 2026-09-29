import { describe, expect, it } from 'vitest';
import { classifyRisk, floorMatches, policyFloorChangeClaims, policyFloorChangeClaims as floors, promotionTargets } from '../../src/kernel/risk.js';
import { defaultPolicy } from '../../src/kernel/policy.js';

/**
 * **The thing that decides how deep a review goes must itself be reviewed.**
 *
 * The risk floor is data, and a data table that decides gate depth is exactly the back door someone widens when a change
 * is inconvenient: set `src/quality/**` to `low` and the deep tier never runs. So changing a floor produces a claim of
 * class `privilege`, which goes through the same review it gates. The classifier is deterministic for the same reason —
 * a scorer that can be argued into a low reading is not a control.
 */
describe('risk classification and its floor table', () => {
    it('matches a directory pattern and a bare path, and nothing else', () => {
        expect(floorMatches('src/quality/**', 'src/quality/adversarial.ts')).toBe(true);
        expect(floorMatches('src/quality/**', 'src/quality')).toBe(true);
        expect(floorMatches('src/quality/**', 'src/other/a.ts')).toBe(false);
        expect(floorMatches('src/cli/ops.ts', 'src/cli/ops.ts')).toBe(true);
        expect(floorMatches('src/cli/ops.ts', 'src/cli/ops.test.ts')).toBe(false);
    });

    it('picks the highest floor a change touches, and reports why', () => {
        const policy = defaultPolicy();
        const sensitive = classifyRisk({ paths: ['src/quality/adversarial.ts'], policy });
        expect(sensitive.tier).toBe('strict');
        expect(sensitive.matched[0]?.pattern).toBe('src/quality/**');

        const plain = classifyRisk({ paths: ['docs/readme.md'], policy });
        expect(plain.tier).toBe('standard');
        expect(plain.reason).toContain('narrow');
    });

    it('raises a wide change to the middle tier even when no floor matches', () => {
        const policy = defaultPolicy();
        const paths = Array.from({ length: 30 }, (_value, index) => `docs/file-${index}.md`);
        const wide = classifyRisk({ paths, policy });
        expect(wide.tier).toBe('strict');
        expect(wide.wideChange).toBe(true);
        expect(wide.reason).toContain('30 paths');
    });

    it('turns a floor change into a privilege claim when the audit rule is on', () => {
        // The entry carries both answers now, so a floor move and a re-description of what a pattern is about are the
        // same kind of change — and the guard fires on either.
        const previous = { 'src/quality/**': { floor: 'medium' as const, riskClasses: ['consistency' as const] } };
        const next = {
            'src/quality/**': { floor: 'low' as const, riskClasses: ['consistency' as const] },
            'src/new/**': { floor: 'high' as const, riskClasses: ['boundary' as const] },
        };
        const claims = floors({ previous, next, at: '2026-09-27T00:00:00.000Z', requireReview: true });
        expect(claims.map((claim) => claim.id).sort()).toEqual(['policy-floor:src/new/**', 'policy-floor:src/quality/**']);
        for (const claim of claims) {
            expect(claim.riskClass).toBe('privilege');
            expect(claim.severity).toBe('major');
            expect(claim.status).toBe('open');
        }
        expect(claims.find((claim) => claim.id === 'policy-floor:src/quality/**')?.statement).toContain('medium');
        expect(claims.find((claim) => claim.id === 'policy-floor:src/quality/**')?.statement).toContain('low');
        // With the audit rule off there is nothing to review, and that is a policy decision rather than a silent skip.
        expect(policyFloorChangeClaims({ previous, next, at: '2026-09-27T00:00:00.000Z', requireReview: false })).toEqual([]);
    });

    it('draws a sample reproducibly, so an audit can be re-run', () => {
        const items = Array.from({ length: 50 }, (_value, index) => `change-${index}`);
        const first = promotionTargets({ seed: 'week-40', items, rate: 0.2 });
        const second = promotionTargets({ seed: 'week-40', items, rate: 0.2 });
        const other = promotionTargets({ seed: 'week-41', items, rate: 0.2 });
        expect(first).toEqual(second);
        expect(first.length).toBeGreaterThan(0);
        expect(first.length).toBeLessThan(items.length);
        expect(other).not.toEqual(first);
        expect(promotionTargets({ seed: 'week-40', items, rate: 0 })).toEqual([]);
        expect(promotionTargets({ seed: 'week-40', items: [], rate: 1 })).toEqual([]);
    });
});
