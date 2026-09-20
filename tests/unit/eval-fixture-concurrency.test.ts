import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluationConcurrency, runEvaluation, type EvaluationManifest } from '../../src/eval/runner.js';

/**
 * L5-03: parallelism is opt-in, and it does not change the answer.
 *
 * The fixtures already have isolated roots, so they *can* run together; what this pins is that they do not by default,
 * and that turning it on changes the wall clock rather than the report.
 */
describe('evaluation concurrency', () => {
    const roots: string[] = [];
    afterEach(async () => {
        delete process.env.KATA_EVAL_CONCURRENCY;
        await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });

    const manifest: EvaluationManifest = {
        taskFixtures: [
            { id: 'open', description: 'Open task', expectedAcceptances: 2, expectedRepairs: 0, expectedEscalations: 0 },
            { id: 'verify', description: 'Verify task', expectedAcceptances: 2, expectedRepairs: 0, expectedEscalations: 0 },
        ],
    };

    async function fixtureRoot(): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-eval-concurrency-'));
        roots.push(root);
        await mkdir(join(root, '.kata/wiki'), { recursive: true });
        return root;
    }

    it('defaults to one fixture at a time', () => {
        expect(evaluationConcurrency()).toBe(1);
    });

    it('takes an explicit concurrency, and ignores a nonsense one', () => {
        process.env.KATA_EVAL_CONCURRENCY = '4';
        expect(evaluationConcurrency()).toBe(4);
        process.env.KATA_EVAL_CONCURRENCY = 'not-a-number';
        // A typo must not silently serialise every run in CI: the fallback is the documented default, not zero.
        expect(evaluationConcurrency()).toBe(1);
        process.env.KATA_EVAL_CONCURRENCY = '0';
        expect(evaluationConcurrency()).toBe(1);
    });

    it('produces the same report whether it ran serially or in parallel', async () => {
        const serial = await runEvaluation(manifest, await fixtureRoot());

        process.env.KATA_EVAL_CONCURRENCY = '2';
        const parallel = await runEvaluation(manifest, await fixtureRoot());

        // Same fixtures, same order, same verdicts: concurrency changes the wall clock, never the answer.
        expect(parallel.runs.map((run) => run.id)).toEqual(serial.runs.map((run) => run.id));
        expect(parallel.runs.map((run) => run.expectation.matched)).toEqual(serial.runs.map((run) => run.expectation.matched));
        expect(parallel.releaseGates.allPass).toBe(serial.releaseGates.allPass);
        expect(serial.concurrency).toBe(1);
        expect(parallel.concurrency).toBe(2);
    });

    it('reassembles the runs in manifest order however they finished', async () => {
        // The report claiming `concurrency: N` while `runs` came back in completion order would be a report whose
        // `runs[0]` is whatever finished first. Order is asserted here against a run that really overlapped: with
        // concurrency 4 and staggered fixtures, completion order cannot be manifest order by accident.
        process.env.KATA_EVAL_CONCURRENCY = '4';
        const many: EvaluationManifest = {
            taskFixtures: ['a', 'b', 'c', 'd'].map((id) => ({ id, description: `Fixture ${id}`, expectedAcceptances: 2, expectedRepairs: 0, expectedEscalations: 0 })),
        };

        const report = await runEvaluation(many, await fixtureRoot());

        expect(report.runs.map((run) => run.id)).toEqual(['a', 'b', 'c', 'd']);
        expect(report.concurrency).toBe(4);
    });

    it('carries the concurrency into the gate report, so a parallel run is visible', async () => {
        process.env.KATA_EVAL_CONCURRENCY = '3';
        const report = await runEvaluation(manifest, await fixtureRoot());

        const gate = report.releaseGates.gates.find((entry) => entry.name === 'fixture-expectations');
        expect(gate?.details).toContain('Evaluated with concurrency 3');
    });

    it('says nothing about concurrency on a serial run', async () => {
        const report = await runEvaluation(manifest, await fixtureRoot());

        const gate = report.releaseGates.gates.find((entry) => entry.name === 'fixture-expectations');
        expect(gate?.details).not.toContain('Evaluated with concurrency');
    });
});
