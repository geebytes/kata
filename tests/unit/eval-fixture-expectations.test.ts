import { describe, expect, it } from 'vitest';
import { compareExpectation } from '../../src/eval/runner.js';
import { checkReleaseGates } from '../../src/eval/release-gates.js';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * L5-02: a fixture's declared expectation is an executable release input, not documentation.
 *
 * Before this, `expectedAcceptances`/`expectedRepairs`/`expectedEscalations` were recorded next to the observation and
 * never compared, so a fixture whose expectation was semantically wrong still produced a passing aggregate.
 */
describe('fixture expectations', () => {
    it('matches when the observation equals the declaration', () => {
        const verdict = compareExpectation({ acceptances: 2, repairs: 0, escalations: 0 }, { acceptances: 2, repairs: 0, escalations: null });

        expect(verdict.matched).toBe(true);
        expect(verdict.mismatches).toEqual([]);
    });

    it('mismatches when the observed repair count differs', () => {
        const verdict = compareExpectation({ acceptances: 2, repairs: 0, escalations: 0 }, { acceptances: 2, repairs: 1, escalations: null });

        expect(verdict.matched).toBe(false);
        expect(verdict.mismatches).toEqual(['repairs: declared 0, observed 1']);
    });

    it('treats a declared-but-unobservable escalation count as a mismatch', () => {
        // The harness cannot observe escalations, so declaring none is a claim it can agree with; declaring two is a
        // claim no run can confirm, and a fixture may not pass on an unconfirmable claim.
        expect(compareExpectation({ acceptances: 1, repairs: 0, escalations: 0 }, { acceptances: 1, repairs: 0, escalations: null }).matched).toBe(true);
        expect(compareExpectation({ acceptances: 1, repairs: 0, escalations: 2 }, { acceptances: 1, repairs: 0, escalations: null }).mismatches)
            .toEqual(['escalations: declared 2, unobservable in this harness']);
    });

    it('fails the release gate when a fixture mismatched, and skips the gate when nothing was evaluated', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-expectation-gate-'));
        await mkdir(join(root, '.kata/wiki'), { recursive: true });
        const metrics = {
            acceptancePassRate: 1, repairRate: 0, escalationRate: null,
            avgCostPerTask: null, avgLatencyMs: 0, wikiRejectionRate: 0,
            totalTasks: 1, totalAcceptances: 1, totalPassed: 1, totalFailed: 0,
            totalRepairs: 0, totalEscalations: null, totalTokens: null, totalCost: null,
            totalLatencyMs: 0, totalWikiRejected: 0, totalWikiPromoted: 0,
            metricCoverage: { tokens: 0, cost: 0, escalations: 0 },
        };

        const mismatched = await checkReleaseGates(root, metrics, {
            expectations: [{ id: 'verify', matched: false, mismatches: ['repairs: declared 0, observed 1'] }],
        });
        const gate = mismatched.gates.find((entry) => entry.name === 'fixture-expectations');
        expect(gate?.pass).toBe(false);
        // Not skipped: something *was* evaluated, so the gate has an answer rather than an abstention.
        expect(gate?.skipped).toBeUndefined();
        expect(mismatched.allPass).toBe(false);

        const nothingEvaluated = await checkReleaseGates(root, metrics);
        expect(nothingEvaluated.gates.find((gate) => gate.name === 'fixture-expectations')).toMatchObject({ skipped: true });
    });
});
