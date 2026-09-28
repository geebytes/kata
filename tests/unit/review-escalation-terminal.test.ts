import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import {
    NO_PROGRESS_ROUNDS,
    appendReviewRound,
    readReviewRounds,
    reviewProgress,
    type ReviewRound,
} from '../../src/quality/repair.js';
import { suggestCandidateAction, type UpstreamSummary } from '../../src/workflow/navigation.js';

/**
 * The review loop had no terminal state that could stop it.
 *
 * `repair.json` is written once per repair and overwritten by the next one, so the loop's history was not recorded
 * anywhere: nothing could ask whether the last three repairs had reduced the problems they were opened for, and nothing
 * stopped `/kata-build` from being re-dispatched forever. A change could therefore sit in review → repair → review
 * indefinitely, each round paying full price and each round justified on its own terms — the open-ended termination
 * condition the design calls out, with no upper bound in sight.
 *
 * These tests pin the terminal state and the record it is derived from. Two things are load-bearing: the count comes from
 * recorded rounds rather than from prose, and a round whose blocking count could not be measured records `null` — never
 * `0`, which would read as "this round reduced the problems to none".
 */
describe('the review loop has a terminal state', () => {
    const round = (blockingCount: number | null, ids: string[] = []): ReviewRound => ({
        at: '2026-09-28T00:00:00.000Z',
        blockingIds: ids,
        blockingCount,
    });

    it(`escalates after ${NO_PROGRESS_ROUNDS} rounds that did not reduce the blocking count`, () => {
        const progress = reviewProgress([
            round(5, ['C-1', 'C-2', 'C-3', 'C-4', 'C-5']),
            round(5, ['C-1', 'C-2', 'C-3', 'C-4', 'C-5']),
            round(6, ['C-1', 'C-2', 'C-3', 'C-4', 'C-5', 'C-6']),
            round(6, ['C-1', 'C-2', 'C-3', 'C-4', 'C-5', 'C-6']),
        ]);
        expect(progress.escalating).toBe(true);
        expect(progress.noProgressRounds).toBe(NO_PROGRESS_ROUNDS);
        // The escalation names what is still open, taken from the newest round that measured it.
        expect(progress.blockingIds).toEqual(['C-1', 'C-2', 'C-3', 'C-4', 'C-5', 'C-6']);
    });

    it('does not escalate while a round is still reducing the count', () => {
        const progress = reviewProgress([round(6), round(5), round(5), round(5), round(4)]).escalating;
        expect(progress).toBe(false);
        const decreasing = reviewProgress([round(6), round(5), round(4), round(3), round(2)]);
        expect(decreasing.escalating).toBe(false);
        expect(decreasing.noProgressRounds).toBe(0);
        // A higher count than the round before it is not progress either, and the run keeps counting.
        expect(reviewProgress([round(2), round(3), round(4), round(5)]).escalating).toBe(true);
    });

    it('needs more than one round before it will call a loop stuck', () => {
        expect(reviewProgress([]).escalating).toBe(false);
        expect(reviewProgress([round(7)]).escalating).toBe(false);
        expect(reviewProgress([round(7), round(7)]).escalating).toBe(false);
        expect(reviewProgress([round(7), round(7), round(7)]).escalating).toBe(false);
    });

    it('records an unmeasured round as null rather than as zero', () => {
        const progress = reviewProgress([round(4), round(null), round(4), round(4), round(4)]);
        expect(progress.escalating).toBe(true);
        // The unmeasured round is reported, not silently dropped, and it is never read as a reduction to nothing.
        expect(progress.unmeasuredRounds).toBe(1);
        expect(progress.blockingIds).toEqual([]);
        const onlyUnmeasured = reviewProgress([round(null), round(null), round(null), round(null)]);
        expect(onlyUnmeasured.escalating).toBe(false);
        expect(onlyUnmeasured.noProgressRounds).toBe(0);
        expect(onlyUnmeasured.unmeasuredRounds).toBe(4);
    });

    it('round-trips the rounds through the task directory', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-review-rounds-'));
        roots.push(root);
        await initLayout(root);

        await appendReviewRound(root, 'rounds-task', { at: '2026-09-28T01:00:00.000Z', blockingIds: ['C-1'], blockingCount: 1 });
        await appendReviewRound(root, 'rounds-task', { at: '2026-09-28T02:00:00.000Z', blockingIds: ['C-1'], blockingCount: 1 });
        const rounds = await readReviewRounds(root, 'rounds-task');
        expect(rounds.map((entry) => entry.blockingCount)).toEqual([1, 1]);

        // An absent file is an empty history, not a failure: a change under its first repair has no rounds yet.
        expect(await readReviewRounds(root, 'some-other-task')).toEqual([]);
    });

    it('sends a stuck loop to a human instead of back to build', () => {
        const upstream = (escalation?: UpstreamSummary['reviewEscalation']): UpstreamSummary => ({
            reviewFindings: 5,
            blockingFindings: 5,
            majorFindings: 0,
            reviewMode: 'strict',
            failedAcceptance: 0,
            failedVerifyAcceptance: 0,
            repairScopes: [],
            verifyRepairScopes: [],
            wikiClosureValid: true,
            evidenceFiles: [],
            failingEvidence: 0,
            ...(escalation ? { reviewEscalation: escalation } : {}),
        });

        const stuck = suggestCandidateAction('review', upstream({ rounds: 4, noProgressRounds: 3, blockingIds: ['C-1', 'C-2'] }));
        expect(stuck?.reason).toBe('escalate_review_without_progress');
        expect(stuck?.nextSkill).not.toBe('/kata-build');

        // A loop that is still moving carries no escalation at all — the reader only sets the field when the trailing run
        // reached the threshold — and keeps the repair route it always had.
        const moving = suggestCandidateAction('review', upstream());
        expect(moving?.reason).toBe('repair_blocking_review_findings');
    });

    const roots: string[] = [];
    afterEach(async () => {
        await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });
});
