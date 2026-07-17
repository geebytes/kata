import { describe, expect, it } from 'vitest';
import { loadEvaluationManifest } from '../../src/eval/runner.js';
import { runEvaluation } from '../../src/eval/runner.js';

describe('Dogfood evaluation', () => {
  it('loads the dogfood manifest with valid structure', async () => {
    const manifest = await loadEvaluationManifest('evals/dogfood-app.json');

    expect(manifest.taskFixtures).toBeDefined();
    expect(manifest.taskFixtures.length).toBeGreaterThanOrEqual(1);

    for (const fixture of manifest.taskFixtures) {
      expect(fixture.id).toMatch(/^[a-z0-9-]+$/);
      expect(fixture.expectedAcceptances).toBeGreaterThan(0);
      expect(fixture.expectedRepairs).toBeGreaterThanOrEqual(0);
      expect(fixture.expectedEscalations).toBeGreaterThanOrEqual(0);
    }
  });

  it('runs evaluation from the manifest against kata project', async () => {
    const manifest = await loadEvaluationManifest('evals/dogfood-app.json');

    const { mkdtemp, mkdir } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = await mkdtemp(join(tmpdir(), 'kata-dogfood-'));
    await mkdir(join(root, '.kata/wiki'), { recursive: true });

    const report = await runEvaluation(manifest, root, {
      minAcceptancePassRate: 0.7,
      maxRepairRate: 1.0,
      maxEscalationRate: 1.0,
    });

    expect(report.runs).toHaveLength(manifest.taskFixtures.length);
    expect(report.metrics.totalTasks).toBe(manifest.taskFixtures.length);
    expect(report.timestamp).toBeTruthy();
    expect(report.releaseGates.gates.length).toBeGreaterThanOrEqual(4);

    // Print summary for dogfood report
    const summary = [
      `Dogfood evaluation: ${report.metrics.totalTasks} fixtures`,
      `  Acceptance pass rate: ${(report.metrics.acceptancePassRate * 100).toFixed(1)}%`,
      `  Repair rate: ${report.metrics.repairRate.toFixed(2)}`,
      `  Escalation rate: ${report.metrics.escalationRate.toFixed(2)}`,
      `  Release gates: ${report.releaseGates.allPass ? 'PASS' : 'FAIL'}`,
      `  ${report.releaseGates.summary}`,
      ];
      process.stdout.write(summary.join('\n') + '\n');
  });
});
