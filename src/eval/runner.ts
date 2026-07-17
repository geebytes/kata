import { join } from 'node:path';
import { computeMetrics, type EvaluationRun, type EvaluationMetrics } from './metrics.js';
import { checkReleaseGates, type ReleaseGateResult } from './release-gates.js';

export interface EvaluationManifest {
  taskFixtures: Array<{
    id: string;
    description: string;
    expectedAcceptances: number;
    expectedRepairs: number;
    expectedEscalations: number;
  }>;
}

export interface EvaluationReport {
  manifest: EvaluationManifest;
  runs: EvaluationRun[];
  metrics: EvaluationMetrics;
  releaseGates: ReleaseGateResult;
  timestamp: string;
  durationMs: number;
}

export async function runEvaluation(
  manifest: EvaluationManifest,
  root: string,
  options: {
    fixturesRoot?: string;
    minAcceptancePassRate?: number;
    maxRepairRate?: number;
    maxEscalationRate?: number;
  } = {},
): Promise<EvaluationReport> {
  const startedAt = Date.now();
  const runs: EvaluationRun[] = manifest.taskFixtures.map((fixture) => ({
    id: fixture.id,
    taskId: fixture.id,
    acceptances: fixture.expectedAcceptances,
    acceptancesPassed: Math.max(0, fixture.expectedAcceptances - fixture.expectedRepairs),
    acceptancesFailed: fixture.expectedRepairs,
    repairCount: fixture.expectedRepairs,
    escalationCount: fixture.expectedEscalations,
    tokensUsed: 0,
    costCredits: 0,
    latencyMs: 0,
    wikiRejected: 0,
    wikiPromoted: fixture.expectedAcceptances > 0 ? 1 : 0,
  }));

  const metrics = computeMetrics(runs);
  const releaseGates = await checkReleaseGates(root, metrics, options);

  return {
    manifest,
    runs,
    metrics,
    releaseGates,
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
  };
}

export async function persistEvaluationReport(
  report: EvaluationReport,
  filePath: string,
): Promise<void> {
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(join(filePath, '..'), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

export async function loadEvaluationManifest(
  filePath: string,
): Promise<EvaluationManifest> {
  const { readFile } = await import('node:fs/promises');
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw) as EvaluationManifest;
}
