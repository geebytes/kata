import { describe, expect, it } from 'vitest';
import { reviewScopeVerdict, suggestedReviewedPaths } from '../../src/quality/review-scope.js';
import type { AcceptanceMatrix } from '../../src/core/task.js';

/**
 * A review can state what it read, and the statement is read conservatively (F5).
 *
 * The design's own hard question — "if a repair changes a file the review never read, and the defect is there, who finds
 * it?" — is why this defaults to the whole revision. The mechanism does not let a repair bypass review; it lets a repair
 * that stayed inside what was reviewed avoid being re-reviewed from scratch.
 */
describe('the scope a review declares', () => {
    it('treats a review that declared nothing as covering everything, so any change invalidates it', () => {
        const verdict = reviewScopeVerdict({ reviewedPaths: undefined, changedPaths: ['src/a.ts'] });

        expect(verdict).toMatchObject({ withinScope: false, conservative: true, outside: ['src/a.ts'] });
        expect(verdict.reason).toMatch(/read as covering the whole revision/);
    });

    it('accepts a change that stayed inside the recorded paths', () => {
        const verdict = reviewScopeVerdict({ reviewedPaths: ['src/a.ts', 'tests/a.test.ts'], changedPaths: ['src/a.ts'] });

        expect(verdict).toMatchObject({ withinScope: true, outside: [], conservative: false });
    });

    it('refuses when the change touches a path the review did not read', () => {
        const verdict = reviewScopeVerdict({
            reviewedPaths: ['src/a.ts'],
            changedPaths: ['src/a.ts', 'src/b.ts'],
        });

        expect(verdict).toMatchObject({ withinScope: false, outside: ['src/b.ts'] });
        expect(verdict.reason).toMatch(/src\/b\.ts/);
    });

    it('treats a declared directory as covering what is under it', () => {
        expect(reviewScopeVerdict({ reviewedPaths: ['src/'], changedPaths: ['src/deep/thing.ts'] }).withinScope).toBe(true);
    });

    it('suggests the reviewed paths from the acceptance rows, as a starting point rather than a decision', () => {
        const matrix: AcceptanceMatrix = {
            version: 1,
            rows: [
                { acceptanceId: 'AC-1', implementationPaths: ['src/alpha.ts'], testPaths: ['tests/alpha.test.ts'], evidence: [], verificationLevel: 'unit' },
                { acceptanceId: 'AC-2', implementationPaths: ['src/beta.ts'], testPaths: [], evidence: [], verificationLevel: 'unit' },
            ],
        };

        expect(suggestedReviewedPaths(matrix, ['AC-1'])).toEqual(['src/alpha.ts', 'tests/alpha.test.ts']);
        expect(suggestedReviewedPaths(matrix, undefined)).toEqual(['src/alpha.ts', 'src/beta.ts', 'tests/alpha.test.ts']);
        expect(suggestedReviewedPaths(undefined, ['AC-1'])).toEqual([]);
    });
});

describe('the review-scope verdict is what a later change is judged against', () => {
    it('keeps a review valid when the repair stayed inside what it read, and refuses when it did not', () => {
        const reviewed = { reviewedPaths: ['src/alpha.ts'], changedPaths: ['src/alpha.ts'] };
        expect(reviewScopeVerdict(reviewed)).toMatchObject({ withinScope: true });

        const drifted = { reviewedPaths: ['src/alpha.ts'], changedPaths: ['src/beta.ts'] };
        expect(reviewScopeVerdict(drifted)).toMatchObject({ withinScope: false, outside: ['src/beta.ts'] });

        // The conservative default matters more than the narrowing: a review that said nothing covers everything.
        expect(reviewScopeVerdict({ reviewedPaths: undefined, changedPaths: ['src/beta.ts'] })).toMatchObject({ conservative: true, withinScope: false });
    });
});
