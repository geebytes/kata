import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runEvaluation, unmeasuredMetrics, type EvaluationManifest } from '../../src/eval/runner.js';

describe('Evaluation harness observations', () => {
    const roots: string[] = [];

    afterEach(async () => {
        await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });

    async function reportRoot(): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-eval-report-'));
        roots.push(root);
        return root;
    }

    it('reports what the fixture produced next to what the manifest expected', async () => {
        const manifest: EvaluationManifest = {
            taskFixtures: [
                { id: 'eval-pass', description: 'Passing fixture', expectedAcceptances: 2, expectedRepairs: 0, expectedEscalations: 0 },
            ],
        };

        const report = await runEvaluation(manifest, await reportRoot(), { minAcceptancePassRate: 0.5 });

        const [run] = report.runs;
        expect(run?.steps).toEqual(['open', 'design', 'build', 'judge']);
        expect(run?.acceptances).toBe(2);
        expect(run?.acceptancesPassed).toBe(2);
        expect(run?.acceptancesFailed).toBe(0);
        expect(run?.repairCount).toBe(0);
        expect(run?.latencyMs).toBeGreaterThan(0);
        expect(run?.expected).toEqual({ acceptances: 2, repairs: 0, escalations: 0 });
        expect(report.unmeasured).toEqual([...unmeasuredMetrics]);
        expect(report.metrics.totalAcceptances).toBe(2);
        expect(report.metrics.acceptancePassRate).toBe(1);
    }, 120_000);

    it('counts the repair round the product recorded, not the manifest expectation', async () => {
        const manifest: EvaluationManifest = {
            taskFixtures: [
                { id: 'eval-repair', description: 'Repair fixture', expectedAcceptances: 1, expectedRepairs: 1, expectedEscalations: 0 },
            ],
        };

        const report = await runEvaluation(manifest, await reportRoot(), { minAcceptancePassRate: 0.5 });

        const [run] = report.runs;
        expect(run?.steps).toContain('repair');
        expect(run?.repairCount).toBe(1);
        expect(run?.acceptancesPassed).toBe(1);
        expect(report.metrics.totalRepairs).toBe(1);
        expect(report.metrics.repairRate).toBe(1);
    }, 120_000);

    it('fails a run whose fixture cannot be sealed instead of inventing a result', async () => {
        const manifest: EvaluationManifest = {
            taskFixtures: [
                { id: 'not a valid task id', description: 'Broken fixture', expectedAcceptances: 1, expectedRepairs: 0, expectedEscalations: 0 },
            ],
        };

        await expect(runEvaluation(manifest, await reportRoot())).rejects.toThrow();
    }, 120_000);
});
