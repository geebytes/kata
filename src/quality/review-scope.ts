import type { AcceptanceMatrix } from '../core/task.js';

/**
 * Whether a later change stayed inside what a review actually read (F5 of the finding-lifecycle design).
 *
 * The design marks this as its **lowest-confidence** item and asks the hard question first: *if a repair changes a file
 * the review never read, and the defect is there, who finds it?* Nothing does — so this is not a mechanism for letting a
 * repair bypass review. It is a mechanism for **stating the scope of what was reviewed**, and it defaults to the
 * conservative reading:
 *
 *   - a review that recorded no `reviewedPaths` is treated as having covered the whole owned set, so any change
 *     invalidates it (exactly today's behaviour, and the safe direction);
 *   - a review that recorded paths is invalidated by any change **outside** them, which is the honest answer to the
 *     design's question: the defect would be in a file nobody reviewed, so the review must not stand.
 *
 * What it buys is the case the design is actually after: a repair that produces review findings on the very files the
 * reviewer just read, with nothing else touched, does not have to be re-reviewed from scratch — because it *was* read.
 */

export interface ReviewScopeVerdict {
    /** True when the change stayed inside the paths the review recorded. */
    withinScope: boolean;
    /** The changed paths the review did not cover; empty when within scope. */
    outside: string[];
    /** Why the verdict is what it is, in one sentence, for the surface that prints it. */
    reason: string;
    /** True when the review declared no scope at all, so nothing could be narrowed. */
    conservative: boolean;
}

export function reviewScopeVerdict(input: {
    reviewedPaths: string[] | undefined;
    changedPaths: string[];
}): ReviewScopeVerdict {
    const { reviewedPaths, changedPaths } = input;
    if (!reviewedPaths) {
        return {
            withinScope: false,
            outside: changedPaths,
            reason: 'the review recorded no reviewedPaths, so it is read as covering the whole revision and any change invalidates it',
            conservative: true,
        };
    }
    if (changedPaths.length === 0) {
        return { withinScope: true, outside: [], reason: 'nothing changed since the review', conservative: false };
    }
    const declared = new Set(reviewedPaths);
    const outside = changedPaths.filter((path) => !declared.has(path) && !reviewedPaths.some((scope) => scope.endsWith('/') && path.startsWith(scope)));
    return outside.length === 0
        ? { withinScope: true, outside: [], reason: 'every changed path is one the review recorded reading', conservative: false }
        : { withinScope: false, outside, reason: `the change touches ${outside.length} path(s) the review did not read: ${outside.join(', ')}`, conservative: false };
}

/**
 * The reviewed paths a review implies when it declared none, from the acceptance rows under review.
 *
 * Used by `kata-cli review --record-scope` to give a reviewer a defensible default: the paths the acceptance criteria it
 * reviewed are implemented and tested in. It is a suggestion in the result, never written behind the reviewer's back —
 * the design's F5 rests on the reviewer's honesty, and the platform cannot verify it.
 */
export function suggestedReviewedPaths(matrix: AcceptanceMatrix | undefined, acceptanceIds: string[] | undefined): string[] {
    if (!matrix) return [];
    const wanted = new Set(acceptanceIds ?? matrix.rows.map((row) => row.acceptanceId));
    const paths = new Set<string>();
    for (const row of matrix.rows) {
        if (!wanted.has(row.acceptanceId)) continue;
        for (const path of [...row.implementationPaths, ...row.testPaths]) paths.add(path);
    }
    return [...paths].sort();
}
