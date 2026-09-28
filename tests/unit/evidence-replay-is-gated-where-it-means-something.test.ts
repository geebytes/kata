import { describe, expect, it } from 'vitest';
import { checkReleaseGates } from '../../src/eval/release-gates.js';
import { computeMetrics } from '../../src/eval/metrics.js';

/**
 * **The replay criterion, split into the part that is a requirement either way and the part that is not.**
 *
 * The original item — "≥95% of blocking/major evidence is replayable" — was recorded as satisfied because every evidence
 * item carries a `{before, mutated, after}` triple, which is the *record* of a measurement. Run for real the repository's 17
 * recorded verdicts come back 6 reproduced · **0 contradicted** · 11 that could no longer be evaluated, because the test
 * files they cite were deleted with the retired route.
 *
 * Reading that as a quality failure would be wrong in one direction and reading it as a pass would be wrong in the other, so
 * the gate separates two requirements:
 *
 * - a **contradiction** is a false record at any rate, for any ledger, archived or not — it always fails;
 * - the **rate floor** applies only where the content the ledger is about still exists, because a ledger over moved content
 *   cannot be replayed at all, and requiring it would demand that nothing ever be refactored.
 *
 * The metrics below are the minimum a metrics object needs; the gates under test read the replay input, not these.
 */
// Built by the real function rather than hand-shaped, so a field added to the metrics type cannot leave this fixture
// silently incomplete — which is how the first version of this file failed (`metricCoverage` was missing).
const metrics = computeMetrics([
    { id: 'run-1', taskId: 'task-1', acceptances: 1, acceptancesPassed: 1, acceptancesFailed: 0, repairCount: 0, escalationCount: 0, tokensUsed: 100, costCredits: 0.01, latencyMs: 500, wikiRejected: 0, wikiPromoted: 0 },
]);

async function gateFor(evidenceReplay: Parameters<typeof checkReleaseGates>[2] extends infer O ? O extends { evidenceReplay?: infer R } ? R : never : never) {
    const result = await checkReleaseGates('.', metrics, evidenceReplay === undefined ? {} : { evidenceReplay });
    return result.gates.find((gate) => gate.name === 'evidence-replayable')!;
}

describe('evidence replay is gated where it means something', () => {
    it('passes when nothing was contradicted, even with decay, and says what it could not evaluate', async () => {
        const gate = await gateFor([
            { changeId: 'a', replayed: 5, agrees: 2, disagreements: [], decayed: ['E3: cannot run', 'E4: cannot run', 'E5: cannot run'], contentMoved: true },
        ]);
        expect(gate.pass).toBe(true);
        expect(gate.details).toContain('3 verdict(s) could not be evaluated');
        // The exclusion is named rather than silent: a reader must be able to see that the rate was not applied here.
        expect(gate.details).toContain('excluded from the rate because the content they are about has moved');
        expect(gate.details).toContain('no recorded verdict was contradicted');
    });

    it('fails on a contradiction at any rate, including a rate that clears the floor', async () => {
        const gate = await gateFor([
            { changeId: 'b', replayed: 20, agrees: 19, disagreements: ['E1: recorded supported, replayed refuted'], decayed: [], contentMoved: false },
        ]);
        expect(gate.pass, '19/20 clears the floor and must still fail: the record is false').toBe(false);
        expect(gate.details).toContain('CONTRADICTED');
        expect(gate.details).toContain('E1: recorded supported, replayed refuted');
    });

    it('applies the floor only to content that still exists', async () => {
        const held = await gateFor([{ changeId: 'c', replayed: 20, agrees: 19, disagreements: [], decayed: [], contentMoved: false }]);
        expect(held.pass, '19/20 = 0.95 meets the floor').toBe(true);

        const below = await gateFor([{ changeId: 'd', replayed: 10, agrees: 8, disagreements: [], decayed: [], contentMoved: false }]);
        expect(below.pass, '0.80 is below the floor for content that still exists').toBe(false);

        // The same numbers over moved content are excluded, so the gate has no rate to judge and says so.
        const moved = await gateFor([{ changeId: 'e', replayed: 10, agrees: 8, disagreements: [], decayed: [], contentMoved: true }]);
        expect(moved.pass).toBe(true);
        expect(moved.details).toContain('nothing replayable to score, so no rate');
    });

    it('is a required gate, so a release that never replayed anything is not release-ready', async () => {
        const never = await checkReleaseGates('.', metrics, {});
        const gate = never.gates.find((entry) => entry.name === 'evidence-replayable')!;
        expect(gate.skipped, 'nothing was replayed, so the gate reports that it does not know').toBe(true);
        expect(never.releaseReady, 'a required gate that was never measured cannot certify a release').toBe(false);
        expect(never.unmeasuredRequiredGates.map((entry) => entry.name)).toContain('evidence-replayable');
    });
});
