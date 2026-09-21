import { describe, expect, it } from 'vitest';
import { computeMetrics, type EvaluationRun } from '../../src/eval/metrics.js';
import { checkReleaseGates } from '../../src/eval/release-gates.js';
import { runEvaluation, type EvaluationManifest } from '../../src/eval/runner.js';

describe('Evaluation metrics', () => {
  it('computes acceptance pass rate from runs', () => {
    const runs: EvaluationRun[] = [
      { id: 'run-1', taskId: 'task-1', acceptances: 2, acceptancesPassed: 2, acceptancesFailed: 0, repairCount: 0, escalationCount: null, tokensUsed: 100, costCredits: 0.01, latencyMs: 500, wikiRejected: 0, wikiPromoted: 1 },
      { id: 'run-2', taskId: 'task-2', acceptances: 2, acceptancesPassed: 1, acceptancesFailed: 1, repairCount: 1, escalationCount: null, tokensUsed: 200, costCredits: 0.02, latencyMs: 800, wikiRejected: 0, wikiPromoted: 0 },
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
    // Not 0: nothing was measured, and a measured zero is a different statement.
    expect(metrics.avgCostPerTask).toBeNull();
    expect(metrics.metricCoverage).toEqual({ tokens: 0, cost: 0, escalations: 0 });
  });

  it('reports an unmeasured metric as null rather than zero, with its coverage', () => {
    const runs: EvaluationRun[] = [
      { id: 'run-1', taskId: 'task-1', acceptances: 1, acceptancesPassed: 1, acceptancesFailed: 0, repairCount: 0, escalationCount: null, tokensUsed: null, costCredits: null, latencyMs: 10, wikiRejected: 0, wikiPromoted: 0 },
      { id: 'run-2', taskId: 'task-2', acceptances: 1, acceptancesPassed: 1, acceptancesFailed: 0, repairCount: 0, escalationCount: null, tokensUsed: 250, costCredits: null, latencyMs: 20, wikiRejected: 0, wikiPromoted: 0 },
    ];

    const metrics = computeMetrics(runs);

    // One run carried a token count, none carried a cost or an escalation. A `0` here would be indistinguishable
    // from a measured zero — which is exactly the reading the harness must not invite.
    expect(metrics.totalTokens).toBe(250);
    expect(metrics.totalCost).toBeNull();
    expect(metrics.totalEscalations).toBeNull();
    expect(metrics.avgCostPerTask).toBeNull();
    expect(metrics.escalationRate).toBeNull();
    expect(metrics.metricCoverage).toEqual({ tokens: 1, cost: 0, escalations: 0 });
  });

  it('measures defect recall and false-pass rate over the admissibility corpus', async () => {
    // The corpus is the referee for every later phase: `docs/verfify.md` states the objective as
    // minimise(tokens, latency) subject to criticalRecall >= baseline and falsePassRate <= baseline, and a benchmark
    // that does not exist cannot referee anything. It must contain planted defects (so recall is measurable), clean
    // revisions (so false-pass and false-positive are measurable), and guard-harms-honest-reporting cases (because a
    // guard that refuses an accurate citation is invisible to a corpus that only plants defects).
    const { admissibilityCorpus, scoreCorpus } = await import('../../src/eval/admissibility-corpus.js');

    const corpus = admissibilityCorpus();
    expect(corpus.length).toBeGreaterThan(0);

    // Every case declares which kinds it covers, and the corpus must cover the three classes that matter.
    const kinds = new Set(corpus.flatMap((entry) => entry.kinds));
    expect(kinds).toContain('planted-defect');
    expect(kinds).toContain('clean-revision');
    expect(kinds).toContain('guard-false-negative');

    // Each case carries a revision fixture and the verdict a correct verifier must reach.
    for (const entry of corpus) {
      expect(entry.id).toBeTruthy();
      expect(entry.expectedVerdict).toMatch(/^(no_defect_found|defects_found|inconclusive|budget_exhausted)$/);
      expect(entry.expectedFindings.length > 0 || entry.expectedVerdict !== 'defects_found').toBe(true);
    }

    // A perfect verifier scores 1.0 recall and 0.0 false-pass; a verifier that reports nothing scores 0.0 recall.
    const perfect = scoreCorpus(corpus, corpus.map((entry) => ({ caseId: entry.id, verdict: entry.expectedVerdict, findingIds: entry.expectedFindings })));
    expect(perfect.criticalRecall).toBe(1);
    expect(perfect.falsePassRate).toBe(0);

    const blind = scoreCorpus(corpus, corpus.map((entry) => ({ caseId: entry.id, verdict: 'no_defect_found', findingIds: [] })));
    expect(blind.criticalRecall).toBeLessThan(1);
    expect(blind.falsePassRate).toBeGreaterThan(0);

    // And a verifier that reports a defect on a clean revision is a false positive, counted separately from a false pass.
    const overEager = scoreCorpus(corpus, corpus.map((entry) => ({ caseId: entry.id, verdict: 'defects_found', findingIds: ['invented'] })));
    expect(overEager.falsePositiveRate).toBeGreaterThan(0);
  });

  it('includes wiki rejection rate', () => {
    const runs: EvaluationRun[] = [
      { id: 'run-1', taskId: 'task-1', acceptances: 1, acceptancesPassed: 1, acceptancesFailed: 0, repairCount: 0, escalationCount: null, tokensUsed: 0, costCredits: 0, latencyMs: 0, wikiRejected: 1, wikiPromoted: 1 },
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
      metricCoverage: { tokens: 10, cost: 10, escalations: 10 },
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
      metricCoverage: { tokens: 0, cost: 0, escalations: 0 },
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

  it('skips a gate whose metric was never measured instead of passing it on a fabricated zero', async () => {
    const metrics = {
      acceptancePassRate: 1, repairRate: 0, escalationRate: null,
      avgCostPerTask: null, avgLatencyMs: 10, wikiRejectionRate: 0,
      totalTasks: 1, totalAcceptances: 1, totalPassed: 1, totalFailed: 0,
      totalRepairs: 0, totalEscalations: null, totalTokens: null, totalCost: null,
      totalLatencyMs: 10, totalWikiRejected: 0, totalWikiPromoted: 0,
      metricCoverage: { tokens: 0, cost: 0, escalations: 0 },
    };

    const { mkdir, mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = await mkdtemp(join(tmpdir(), 'kata-release-skip-'));
    await mkdir(join(root, '.kata/wiki'), { recursive: true });

    const result = await checkReleaseGates(root, metrics);

    expect(result.gates.find((g) => g.name === 'escalation-rate')).toMatchObject({ skipped: true });
    expect(result.allPass).toBe(true);
    expect(result.summary).toMatch(/skipped as unmeasured/);
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
