import { describe, expect, it } from 'vitest';
import { reviewProgress, readReviewRoundsState, type ReviewRound } from '../../src/quality/repair.js';

/**
 * **An approval is a round of the loop, and it measured zero.**
 *
 * `review-rounds.jsonl` only gained a line when a *repair* was entered, and only a repair backed by review findings carried a
 * count — so an approval recorded nothing, and the loop's judgement saw the blocking count rise (2 → 4 → 6) and never fall.
 * That is how `escalate_review_without_progress` fired on this change at the very moment its review passed with no findings:
 * nine rounds, the measured ones 2, 2, 4, 6, and the five `null` lines being approvals and superseded entries that the reader
 * could not tell apart.
 *
 * The two facts `null` was carrying are now separate: `0` is "the loop cleared" and `null` is "nothing to measure". The
 * judgement below is unchanged in its rule — a run of rounds that left work behind escalates — and the fix is that the
 * approval now participates.
 */
/**
 * **Scope.** These cases exercise the judgement as a pure function; they do *not* drive an approval (measured: deleting the
 * write in `orchestrator.ts` leaves them green). The case that pins the write is in
 * `ledger-can-approve-a-review.test.ts` — "records the approval as a cleared round" — and it is the one that goes red when
 * the write is removed. Two cases with the same name and only one of them load-bearing is the shape this change has spent
 * the session removing.
 */
describe('the loop judgement reads a cleared round as cleared', () => {
    const round = (at: string, blockingCount: number | null, blockingIds: string[] = []): ReviewRound => ({ at, blockingIds, blockingCount });

    it('reads a rising-then-cleared loop as progress, not as a stall', () => {
        // The real history for this change, with its approvals recorded as zero instead of unmeasurable.
        const rounds = [round('1', 2), round('2', null), round('3', 2), round('4', 4), round('5', null), round('6', null), round('7', 6), round('8', 0), round('9', 0)];
        const progress = reviewProgress(rounds);
        expect(progress.escalating).toBe(false);
        expect(progress.noProgressRounds).toBe(0);
    });

    it('still escalates a loop whose blocking count only rises', () => {
        const rounds = [round('1', 2), round('2', 2), round('3', 4), round('4', 6)];
        expect(reviewProgress(rounds).escalating).toBe(true);
    });

    it('keeps an unmeasurable round neutral and reported', () => {
        const rounds = [round('1', 4), round('2', null), round('3', 4), round('4', 4)];
        const progress = reviewProgress(rounds);
        expect(progress.unmeasuredRounds).toBe(1);
        expect(progress.noProgressRounds).toBe(2);
        expect(progress.escalating).toBe(false);
    });
});
