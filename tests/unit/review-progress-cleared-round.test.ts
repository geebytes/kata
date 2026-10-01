import { describe, expect, it } from 'vitest';
import { NO_PROGRESS_ROUNDS, reviewProgress, type ReviewRound } from '../../src/quality/repair.js';

const round = (at: string, blockingCount: number | null, blockingIds: string[] = []): ReviewRound => ({ at, blockingIds, blockingCount });

/**
 * **A round that cleared is not a round that stalled.**
 *
 * The loop's escalation compares each measured round against the best count so far, and counted "not a new low" as no
 * progress. Once a round reached zero — the goal state — every later round sat exactly on the best, so five legitimate
 * approvals were counted as a stuck loop and `escalate_review_without_progress` fired on a change whose review had just
 * passed with no findings (`review-rounds.jsonl` measured: nine rounds, five of them `blockingCount: 0`, and the
 * judgement read `noProgressRounds: 3`).
 *
 * The rule is therefore about *remaining* work: a round that measured zero has nothing left to reduce, so it neither
 * extends the run nor is evidence of one. `null` stays neutral for the same reason it always did — it measured nothing.
 */
describe('review progress counts remaining work, not the absence of a new low', () => {
    it('does not call a cleared loop stuck, however many rounds cleared', () => {
        const rounds = [round('1', 2), round('2', 0), round('3', 0), round('4', 0), round('5', 0), round('6', 0)];
        const progress = reviewProgress(rounds);
        expect(progress.noProgressRounds).toBe(0);
        expect(progress.escalating).toBe(false);
    });

    it('still escalates a loop that keeps blocking without reducing', () => {
        const rounds = [round('1', 5), round('2', 5), round('3', 5), round('4', 5)];
        const progress = reviewProgress(rounds);
        expect(progress.noProgressRounds).toBeGreaterThanOrEqual(NO_PROGRESS_ROUNDS);
        expect(progress.escalating).toBe(true);
    });

    it('still escalates an oscillating loop, because it never reaches a new low', () => {
        const rounds = [round('1', 5), round('2', 4), round('3', 5), round('4', 4), round('5', 5), round('6', 4)];
        expect(reviewProgress(rounds).escalating).toBe(true);
    });

    it('counts a run of rounds that stay above the best without reaching zero', () => {
        // Best is 2; rounds 3..5 sit above it, so each is a round that did not reduce the remaining work.
        const rounds = [round('1', 2), round('2', 3), round('3', 3), round('4', 3)];
        const progress = reviewProgress(rounds);
        expect(progress.noProgressRounds).toBeGreaterThanOrEqual(NO_PROGRESS_ROUNDS);
        expect(progress.escalating).toBe(true);
    });

    it('leaves a round that measured nothing neutral, and reports it', () => {
        const rounds = [round('1', 4), round('2', null), round('3', null), round('4', 4), round('5', 4)];
        const progress = reviewProgress(rounds);
        expect(progress.unmeasuredRounds).toBe(2);
        expect(progress.noProgressRounds).toBe(2);
        expect(progress.escalating).toBe(false);
    });

    it('escalates when nothing in the history could be measured', () => {
        const rounds = [round('1', null), round('2', null)];
        const progress = reviewProgress(rounds);
        expect(progress.unmeasurable).toBe(true);
        expect(progress.escalating).toBe(true);
    });
});
