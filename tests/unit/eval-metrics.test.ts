import { describe, expect, it } from 'vitest';
import { computeMetrics, type EvaluationRun } from '../../src/eval/metrics.js';
import { checkReleaseGates } from '../../src/eval/release-gates.js';
import { runEvaluation, type EvaluationManifest } from '../../src/eval/runner.js';

describe('Evaluation metrics', () => {
  it('computes acceptance pass rate from runs', () => {
    const runs: EvaluationRun[] = [
      { id: 'run-1', taskId: 'task-1', acceptances: 2, acceptancesPassed: 2, acceptancesFailed: 0, repairCount: 0, escalationCount: 0, tokensUsed: 100, costCredits: 0.01, latencyMs: 500, wikiRejected: 0, wikiPromoted: 1 },
      { id: 'run-2', taskId: 'task-2', acceptances: 2, acceptancesPassed: 1, acceptancesFailed: 1, repairCount: 1, escalationCount: 0, tokensUsed: 200, costCredits: 0.02, latencyMs: 800, wikiRejected: 0, wikiPromoted: 0 },
    ];

    const metrics = computeMetrics(runs);

    expect(metrics.totalTasks).toBe(2);
    expect(metrics.totalAcceptances).toBe(4);
    expect(metrics.totalPassed).toBe(3);
    expect(metrics.acceptancePassRate).toBe(0.75);
    expect(metrics.repairRate).toBe(0.5);
    expect(metrics.avgLatencyMs).toBe(650);
  });

  it('handles empty runs', () => {
    const metrics = computeMetrics([]);
    expect(metrics.totalTasks).toBe(0);
    expect(metrics.acceptancePassRate).toBe(0);
    expect(metrics.repairRate).toBe(0);
    expect(metrics.avgCostPerTask).toBe(0);
  });

  it('includes wiki rejection rate', () => {
    const runs: EvaluationRun[] = [
      { id: 'run-1', taskId: 'task-1', acceptances: 1, acceptancesPassed: 1, acceptancesFailed: 0, repairCount: 0, escalationCount: 0, tokensUsed: 0, costCredits: 0, latencyMs: 0, wikiRejected: 1, wikiPromoted: 1 },
    ];

    const metrics = computeMetrics(runs);
    expect(metrics.wikiRejectionRate).toBe(0.5);
  });
});

describe('Release gates', () => {
  it('passes when all gates meet thresholds', async () => {
    const metrics = {
      acceptancePassRate: 0.95, repairRate: 0.2, escalationRate: 0.1,
      avgCostPerTask: 0.01, avgLatencyMs: 500, wikiRejectionRate: 0,
      totalTasks: 10, totalAcceptances: 20, totalPassed: 19, totalFailed: 1,
      totalRepairs: 2, totalEscalations: 1, totalTokens: 1000, totalCost: 0.1,
      totalLatencyMs: 5000, totalWikiRejected: 0, totalWikiPromoted: 5,
    };

    const { writeFile, mkdir, mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = await mkdtemp(join(tmpdir(), 'kata-release-'));
    await mkdir(join(root, '.kata/wiki'), { recursive: true });
    await writeFile(join(root, '.kata/wiki/test-record.json'), JSON.stringify({ id: 'test', status: 'verified', statement: 'test', scope: ['test'], kind: 'test', sourceRefs: ['test.ts'], sourceHashes: {}, validationTaskId: 'task', evidenceIds: ['e1'], lastVerifiedAt: '2026-01-01', createdAt: '2026-01-01', updatedAt: '2026-01-01' }), 'utf8');

    const result = await checkReleaseGates(root, metrics);
    expect(result.allPass).toBe(true);
  });

  it('fails when acceptance pass rate is below threshold', async () => {
    const metrics = {
      acceptancePassRate: 0.5, repairRate: 0, escalationRate: 0,
      avgCostPerTask: 0, avgLatencyMs: 0, wikiRejectionRate: 0,
      totalTasks: 2, totalAcceptances: 4, totalPassed: 2, totalFailed: 2,
      totalRepairs: 0, totalEscalations: 0, totalTokens: 0, totalCost: 0,
      totalLatencyMs: 0, totalWikiRejected: 0, totalWikiPromoted: 0,
    };

    const { mkdir, mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = await mkdtemp(join(tmpdir(), 'kata-release-fail-'));
    await mkdir(join(root, '.kata/wiki'), { recursive: true });

    const result = await checkReleaseGates(root, metrics, { minAcceptancePassRate: 0.8 });
    expect(result.allPass).toBe(false);
    expect(result.gates.find((g) => g.name === 'acceptance-pass-rate')?.pass).toBe(false);
  });
});

describe('Evaluation runner', () => {
  it('produces a report from a manifest', async () => {
    const manifest: EvaluationManifest = {
      taskFixtures: [
        { id: 'open', description: 'Open task', expectedAcceptances: 2, expectedRepairs: 0, expectedEscalations: 0 },
        { id: 'verify', description: 'Verify task', expectedAcceptances: 2, expectedRepairs: 0, expectedEscalations: 0 },
      ],
    };

    const { mkdtemp } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const root = await mkdtemp(join(tmpdir(), 'kata-eval-run-'));
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(root, '.kata/wiki'), { recursive: true });

    const report = await runEvaluation(manifest, root);
    expect(report.runs).toHaveLength(2);
    expect(report.metrics.totalTasks).toBe(2);
    expect(report.releaseGates.allPass).toBe(true);
    expect(report.timestamp).toBeTruthy();
  });
});
