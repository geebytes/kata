import { describe, expect, it } from 'vitest';
import { freezeCandidate } from '../../src/quality/recertification.js';

/**
 * §7: independent certification belongs to a frozen change candidate. These tests ensure a new revision id alone
 * does not spend another cold pass, while an unprovable or semantic change still fails closed into a full review.
 */

/**
 * §7.4: the freeze must anchor on the reviewed content and the semantic contract — not on the platform's own check
 * configuration. Measured on a real task: sealing identical bytes under a different check set produced a new revision id
 * and a *different* freeze, because `reviewIrHash` was hashed whole and the IR carries `evidenceIds`. A completed
 * certification was therefore expired by an edit to how the platform checks things, which is exactly the cost the anchor
 * was supposed to remove.
 */
describe('the freeze anchors on what was reviewed', () => {
    it('does not move when only the check/evidence configuration moves', () => {
        const base = freezeCandidate({
            contentDigests: { 'src/a.ts': 'h1' },
            acceptanceHash: 'acc', instrumentHash: 'inst', reviewPolicyHash: 'pol', executorBoundaryHash: 'exe',
            reviewIrHash: 'ir-with-unit-check',
            reviewedPaths: ['src/a.ts'], criterionPaths: { 'AC-1': ['src/a.ts'] }, evidenceByCriterion: { 'AC-1': 'e1' },
        });
        // The same reviewed content, with one more check in the platform's configuration.
        const moreChecks = freezeCandidate({ ...base, reviewIrHash: 'ir-with-unit-and-lint' });

        expect(moreChecks.hash).toBe(base.hash);
    });
});
