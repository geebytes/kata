import { describe, expect, it } from 'vitest';
import { classRecurrence, type ReviewRound } from '../../src/quality/repair.js';

/**
 * **Recurrence counted by defect class, and split by whether it came back inside a repair.**
 *
 * The id-based view could not see this loop's actual shape. Measured on one change: seven rounds, ten findings, and **seven of
 * those ten were defects in the previous round's repair** (rounds 4, 6 and 7 each found one in the round before them) — while
 * no finding id repeated, so nothing reported as recurring and the flat blocking series (3→1→1→1→1→0→3) went unremarked.
 *
 * The refinement is deliberate: a `judgment` class recurring is the instrument working (two rounds, two distinct omissions),
 * and a mechanizable class recurring purely in the original code is a class worth mechanizing but not a stop signal. Only
 * "mechanizable **and** it came back inside a repair" is the recycling shape — and it is *reported*, never enforced.
 */
function round(at: string, findings: ReviewRound['findings']): ReviewRound {
    return { at, blockingIds: findings?.map((finding) => finding.id) ?? [], blockingCount: findings?.length ?? 0, findings };
}

describe('a recurring class is named as a class', () => {
    it('reports a mechanizable class that came back inside a repair, with the rounds and the instances', () => {
        const recurrence = classRecurrence([
            round('2026-10-10T00:00:00.000Z', [{ id: 'R1-F1', severity: 'major', class: 'instrument-unsound', origin: 'original' }]),
            round('2026-10-10T01:00:00.000Z', [{ id: 'R2-F2', severity: 'minor', class: 'instrument-unsound', origin: 'repair' }]),
        ]);
        expect(recurrence).toHaveLength(1);
        expect(recurrence[0]).toMatchObject({
            class: 'instrument-unsound',
            oracle: 'mechanizable',
            rounds: ['2026-10-10T00:00:00.000Z', '2026-10-10T01:00:00.000Z'],
            findings: ['R1-F1', 'R2-F2'],
            repairOrigin: 1,
            stopLineCandidate: true,
        });
    });

    it('does not call a recurring judgment class a stop-line candidate', () => {
        const recurrence = classRecurrence([
            round('2026-10-10T00:00:00.000Z', [{ id: 'R1-F1', severity: 'minor', class: 'intent-omission', origin: 'original' }]),
            round('2026-10-10T01:00:00.000Z', [{ id: 'R2-F1', severity: 'minor', class: 'intent-omission', origin: 'original' }]),
        ]);
        expect(recurrence[0]).toMatchObject({ class: 'intent-omission', oracle: 'judgment', stopLineCandidate: false, repairOrigin: 0 });
    });

    it('does not stop for a judgment class even when it came back inside a repair', () => {
        // **The case that makes the oracle half load-bearing.** Without it, "only mechanizable classes stop" was asserted by a
        // fixture whose judgment class had no repair origin — so ignoring the oracle type entirely stayed green (measured by a
        // reproduction in this change's own mutation audit), and the refinement would have been unguarded.
        const recurrence = classRecurrence([
            round('2026-10-10T00:00:00.000Z', [{ id: 'R1-F1', severity: 'minor', class: 'contract-semantics', origin: 'repair' }]),
            round('2026-10-10T01:00:00.000Z', [{ id: 'R2-F1', severity: 'minor', class: 'contract-semantics', origin: 'repair' }]),
        ]);
        expect(recurrence[0]).toMatchObject({ class: 'contract-semantics', oracle: 'judgment', repairOrigin: 2, stopLineCandidate: false });
    });

    it('does not stop for a mechanizable class that recurring only in the original code', () => {
        // The refinement the operator chose: the cost signal is "we are fixing our own fixes", not "the same class exists
        // twice". Recurrence in the original code is what mechanization is *for*, and treating it as a stop would refuse the
        // round that finds a different defect of that class.
        const recurrence = classRecurrence([
            round('2026-10-10T00:00:00.000Z', [{ id: 'R1-F1', severity: 'major', class: 'comparison-unnamed', origin: 'original' }]),
            round('2026-10-10T01:00:00.000Z', [{ id: 'R2-F1', severity: 'minor', class: 'comparison-unnamed', origin: 'original' }]),
        ]);
        expect(recurrence[0]).toMatchObject({ class: 'comparison-unnamed', stopLineCandidate: false, repairOrigin: 0 });
    });

    it('says nothing about a class that appeared in one round only', () => {
        expect(classRecurrence([round('2026-10-10T00:00:00.000Z', [{ id: 'R1-F1', severity: 'major', class: 'instrument-unsound', origin: 'repair' }])])).toEqual([]);
    });

    it('stays quiet about legacy rows that carry no classes, and orders the candidates first', () => {
        const recurrence = classRecurrence([
            // A row written before findings travelled with the round: nothing to classify, and nothing invented.
            { at: '2026-10-01T00:00:00.000Z', blockingIds: ['R0-F1'], blockingCount: 1 },
            round('2026-10-10T00:00:00.000Z', [{ id: 'R1-F1', severity: 'minor', class: 'intent-omission', origin: 'original' }]),
            round('2026-10-10T01:00:00.000Z', [{ id: 'R2-F1', severity: 'minor', class: 'intent-omission', origin: 'original' }]),
            round('2026-10-10T02:00:00.000Z', [
                { id: 'R3-F1', severity: 'major', class: 'corrupt-read-as-absent', origin: 'repair' },
                { id: 'R3-F2', severity: 'minor', class: 'declaration-covers-other', origin: 'repair' },
            ]),
            round('2026-10-10T03:00:00.000Z', [
                { id: 'R4-F1', severity: 'blocking', class: 'corrupt-read-as-absent', origin: 'repair' },
                { id: 'R4-F2', severity: 'minor', class: 'declaration-covers-other', origin: 'repair' },
            ]),
        ]);
        expect(recurrence.map((entry) => entry.class)).toEqual(['corrupt-read-as-absent', 'declaration-covers-other', 'intent-omission']);
        expect(recurrence.filter((entry) => entry.stopLineCandidate).map((entry) => entry.class)).toEqual(['corrupt-read-as-absent', 'declaration-covers-other']);
    });
});
