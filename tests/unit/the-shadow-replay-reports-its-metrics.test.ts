import { describe, expect, it } from 'vitest';
import { IDENTIFIABLE_ROUNDS, replayLoop } from '../../src/quality/loop-replay.js';
import type { ReviewRound } from '../../src/quality/repair.js';

/**
 * **The replay reports what the loop paid for, and refuses to fit a rate it cannot identify.**
 *
 * This is the measurement the whole change exists to make possible. Before it, a round record kept ids and a count and
 * `review.json` was overwritten each round, so the repository's 102 rounds survive as 56 findings and "which class keeps
 * coming back, and did it come back inside a repair" was unanswerable. Two properties matter beyond the arithmetic:
 *
 * - the shares are computed over **classified** findings, so a legacy row contributes to `unavailable` rather than to a
 *   denominator (a row with no findings is not a row with none);
 * - the discovery rate is reported **only when identifiable**, with the reason given otherwise — a figure fitted to six rounds
 *   reads as evidence for a stopping rule, and there is none.
 */
function round(at: string, findings: ReviewRound['findings'], blockingCount?: number): ReviewRound {
    return { at, blockingIds: findings?.map((finding) => finding.id) ?? [], blockingCount: blockingCount ?? findings?.length ?? 0, findings };
}

describe('the shadow replay reports its metrics', () => {
    it('measures the mechanizable share, the recycling share and the stop-line classes', () => {
        const replay = replayLoop([
            // A legacy row: no findings, and no reason recorded — it cannot be counted as a round that found nothing.
            { at: '2026-10-01T00:00:00.000Z', blockingIds: ['R0-F1'], blockingCount: 1 },
            round('2026-10-02T00:00:00.000Z', [{ id: 'R1-F1', severity: 'major', class: 'one-fact-derived-twice', origin: 'original' }]),
            round('2026-10-03T00:00:00.000Z', [
                { id: 'R2-F1', severity: 'major', class: 'one-fact-derived-twice', origin: 'repair' },
                { id: 'R2-F2', severity: 'minor', class: 'intent-omission', origin: 'original' },
            ]),
            // One finding with no class, in a row that has classified ones: `classified` must be smaller than `findings`, or
            // "the shares are computed over classified findings" is asserted by a fixture where the two are equal.
            round('2026-10-04T00:00:00.000Z', [
                { id: 'R3-F1', severity: 'note', class: 'instrument-unsound', origin: 'original' },
                { id: 'R3-F2', severity: 'note' },
            ]),
            // A round with no findings and a reason: it is a measurement, not a hole.
            { at: '2026-10-05T00:00:00.000Z', blockingIds: [], blockingCount: 0, noFindings: 'the approval cleared a review that recorded no findings' },
        ]);

        expect(replay.rounds).toBe(5);
        expect(replay.findings).toBe(5);
        expect(replay.classified).toBe(4);
        // Of the three rounds that recorded findings, only the first was entirely mechanizable classes: the second holds a
        // judgment class, the third a finding with no class at all.
        expect(replay.mechanizableRoundShare).toBe(0.3333);
        // One of the four classified findings came back inside a repair — asymmetric on purpose, so counting the other side
        // (the original-code share) is a different number.
        expect(replay.repairOriginShare).toBe(0.25);
        // One of the four is a class no generator can decide.
        expect(replay.judgmentShare).toBe(0.25);
        expect(replay.stopLineCandidates).toEqual(['one-fact-derived-twice']);
        expect(replay.unavailable).toEqual(['2026-10-01T00:00:00.000Z']);
    });

    it('refuses to fit a discovery rate to a history that cannot identify one', () => {
        const replay = replayLoop([
            round('2026-10-02T00:00:00.000Z', [{ id: 'R1-F1', severity: 'major', class: 'instrument-unsound', origin: 'original' }]),
            round('2026-10-03T00:00:00.000Z', [{ id: 'R2-F1', severity: 'minor', class: 'instrument-unsound', origin: 'repair' }]),
        ]);
        expect(replay.discovery.identified).toBe(false);
        if (replay.discovery.identified) return;
        expect(replay.discovery.reason).toContain('not identifiable');
        expect(replay.discovery.reason).toContain('2 round(s)');
    });

    it('reports the rate once the history is long enough', () => {
        const rounds = Array.from({ length: IDENTIFIABLE_ROUNDS }, (_, index) =>
            round(`2026-10-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`, [{ id: `R${index}-F1`, severity: 'minor', class: 'instrument-unsound', origin: 'original' }], 1),
        );
        const replay = replayLoop(rounds);
        expect(replay.discovery.identified).toBe(true);
        if (!replay.discovery.identified) return;
        expect(replay.discovery.findingsPerRound).toBe(1);
        expect(replay.discovery.blockingPerRound).toBe(1);
        expect(replay.discovery.roundsForHalfRate).toBeGreaterThan(0);
    });

    it('does not average a round that could not be measured as a round with no blocking findings', () => {
        // **`0` cleared and `null` nothing to measure are two facts the round row distinguishes on purpose** (R1-F3). A rate
        // that folds them together reports a loop that measured nothing as a loop that found nothing.
        const rounds = [
            ...Array.from({ length: IDENTIFIABLE_ROUNDS }, (_, index) =>
                round(`2026-11-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`, [{ id: `R${index}-F1`, severity: 'minor', class: 'instrument-unsound', origin: 'original' }], 2),
            ),
            { at: '2026-12-01T00:00:00.000Z', blockingIds: ['R-9'], blockingCount: null, findings: [{ id: 'R-9', severity: 'minor', class: 'intent-omission', origin: 'original' }] },
        ];
        const replay = replayLoop(rounds);
        expect(replay.unmeasuredRounds).toEqual(['2026-12-01T00:00:00.000Z']);
        expect(replay.discovery.identified).toBe(true);
        if (!replay.discovery.identified) return;
        // Twelve measured rounds at two apiece: the unmeasurable one is excluded, not averaged in as zero.
        expect(replay.discovery.blockingPerRound).toBe(2);
    });

    it('reports no findings rate either when every row could not be read', () => {
        // **The same fold, two fields further on** (R3-F3): `findingsPerRound` divided by *every* round even when the rows'
        // findings could not be read (the rows are named in `unavailable`), so an unreadable history reported a rate of
        // zero; and `roundsForHalfRate` published `0`, which reads as "stop now" — a stopping signal from a history that
        // measured nothing.
        const rounds = Array.from({ length: IDENTIFIABLE_ROUNDS }, (_, index) => ({
            at: `2026-12-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
            blockingIds: [] as string[],
            blockingCount: 0,
        }));
        const replay = replayLoop(rounds);
        expect(replay.unavailable).toHaveLength(IDENTIFIABLE_ROUNDS);
        expect(replay.discovery.identified).toBe(true);
        if (!replay.discovery.identified) return;
        expect(replay.discovery.findingsPerRound).toBeNull();
        expect(replay.discovery.roundsForHalfRate).toBeNull();
        expect(replay.discovery.blockingPerRound).toBe(0);
    });

    it('reports no blocking rate at all when nothing could be measured', () => {
        // **An empty measured set is not a zero rate** (R2-F4). `share` answers 0 for a 0/0 denominator, so a history where
        // every round was unmeasurable reported the same number as a history that measured zero blocking findings — the fold
        // R1-F3 closed for the mixed case and left open for this one.
        const rounds = Array.from({ length: IDENTIFIABLE_ROUNDS }, (_, index) => ({
            at: `2026-12-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
            blockingIds: [] as string[],
            blockingCount: null,
            findings: [{ id: `R${index}-F1`, severity: 'minor', class: 'instrument-unsound', origin: 'original' }],
        }));
        const replay = replayLoop(rounds);
        expect(replay.discovery.identified).toBe(true);
        if (!replay.discovery.identified) return;
        expect(replay.unmeasuredRounds).toHaveLength(IDENTIFIABLE_ROUNDS);
        expect(replay.discovery.blockingPerRound).toBeNull();
        // The findings rate is still a real measurement: findings were recorded.
        expect(replay.discovery.findingsPerRound).toBe(1);
    });

    it('says nothing rather than zero for an empty history', () => {
        const replay = replayLoop([]);
        expect(replay).toMatchObject({ rounds: 0, findings: 0, classified: 0, mechanizableRoundShare: 0, repairOriginShare: 0, judgmentShare: 0 });
        expect(replay.discovery.identified).toBe(false);
    });
});
