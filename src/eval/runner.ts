import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readStateEvents, type Actor } from '../core/state.js';
import { readCurrentTaskRevision } from '../workflow/revision.js';
import { collectEvidence, type CheckCommand, type EvidenceEnvelope } from '../quality/evidence.js';
import { judge } from '../quality/judge.js';
import { readWikiRecords } from '../wiki/store.js';
import { runCommand } from '../workflow/orchestrator.js';
import { computeMetrics, type EvaluationRun, type EvaluationMetrics } from './metrics.js';
import { checkReleaseGates, type ReleaseGateResult } from './release-gates.js';
import { evidenceDir as layoutEvidenceDir } from '../core/layout.js';

/** Metrics this harness cannot observe in process: the host platform owns model choice, cost and retries. */
export const unmeasuredMetrics = ['tokensUsed', 'costCredits', 'escalationCount'] as const;

export interface EvaluationFixture {
  id: string;
  description: string;
  expectedAcceptances: number;
  expectedRepairs: number;
  expectedEscalations: number;
}

export interface EvaluationManifest {
  taskFixtures: EvaluationFixture[];
}

/** A run records what the fixture actually produced, next to the expectation it was written against. */
export interface EvaluationRunObservation extends EvaluationRun {
  expected: { acceptances: number; repairs: number; escalations: number };
  steps: string[];
}

export interface EvaluationReport {
  manifest: EvaluationManifest;
  runs: EvaluationRunObservation[];
  metrics: EvaluationMetrics;
  releaseGates: ReleaseGateResult;
  timestamp: string;
  durationMs: number;
  /** Recorded so a reader never mistakes an unmeasured `0` for a measurement. */
  unmeasured: string[];
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
  const runs: EvaluationRunObservation[] = [];

  for (const fixture of manifest.taskFixtures) {
    runs.push(await runFixture(fixture, options));
  }

  const metrics = computeMetrics(runs);
  const releaseGates = await checkReleaseGates(root, metrics, options);

  return {
    manifest,
    runs,
    metrics,
    releaseGates,
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    unmeasured: [...unmeasuredMetrics],
  };
}

const actor: Actor = { id: 'eval-agent', role: 'implementer' };
const sealedChecks: CheckCommand[] = [{ kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'] }];

/**
 * Runs one fixture through the product's own entry points and records what came out: the acceptance results the
 * Judge reaches for the sealed evidence, the repair rounds the state log recorded, wall-clock latency, and the Wiki
 * records the fixture root ended up with.
 */
async function runFixture(
  fixture: EvaluationFixture,
  options: { fixturesRoot?: string },
): Promise<EvaluationRunObservation> {
  const root = await mkdtemp(join(options.fixturesRoot ?? tmpdir(), `kata-eval-${fixture.id}-`));
  const startedAt = Date.now();
  const steps: string[] = [];
  const acceptance = Array.from(
    { length: Math.max(1, fixture.expectedAcceptances) },
    (_, index) => ({ id: `AC-${index + 1}`, statement: `Fixture ${fixture.id} acceptance ${index + 1}.` }),
  );
  const ownedPaths = ['fixture.txt'];

  try {
    const open = await runCommand('open', fixture.id, root, { title: fixture.description, acceptance });
    if (!open.success) throw new Error(open.error ?? 'fixture could not be opened');
    steps.push('open');

    const design = await runCommand('design', fixture.id, root);
    if (!design.success) throw new Error(design.error ?? 'fixture could not be designed');
    steps.push('design');

    await writeFile(join(root, 'fixture.txt'), 'sealed implementation\n', 'utf8');
    const sealed = await runCommand('build', fixture.id, root, { ownedPaths, checks: withCwd(sealedChecks, root) });
    if (!sealed.success) throw new Error(sealed.error ?? 'fixture could not be sealed');
    steps.push('build');

    if (fixture.expectedRepairs > 0) {
      // Move the workspace past the sealed revision so Verify fails on evidence that is no longer current, then take
      // the repair entry the product itself records. The repair round is then counted from the state log.
      await writeFile(join(root, 'fixture.txt'), 'repaired implementation\n', 'utf8');
      const staleVerify = await runCommand('verify', fixture.id, root);
      steps.push(`verify:${staleVerify.diagnostics?.verifyResult ?? 'unknown'}`);
      const repair = await runCommand('build', fixture.id, root, { ownedPaths, checks: withCwd(sealedChecks, root) });
      if (!repair.success) throw new Error(repair.error ?? 'fixture could not be repaired');
      steps.push('repair');
    }

    const evidence = await readRecordedEvidence(root, fixture.id);
    const revision = await readCurrentTaskRevision(root, fixture.id);
    const scopeHashes = new Map(evidence.map((item) => [item.id, revision?.manifestHash ?? item.scope?.hash ?? '']));
    const judgeResult = await judge({
      root,
      taskId: fixture.id,
      acceptance,
      evidence,
      findings: [],
      currentDiffHash: evidence[0]?.diffHash ?? '',
      currentScopeHashes: scopeHashes,
    });
    steps.push('judge');

    const events = await readStateEvents(root, fixture.id).catch(() => []);
    const repairCount = events.filter(
      (event) => event.to === 'implement' && (event.from === 'hardVerify' || event.from === 'review' || event.from === 'judge'),
    ).length;
    const wikiRecords = await readWikiRecords(root).catch(() => []);

    return {
      id: fixture.id,
      taskId: fixture.id,
      acceptances: judgeResult.acceptance.length,
      acceptancesPassed: judgeResult.acceptance.filter((criterion) => criterion.result === 'PASS').length,
      acceptancesFailed: judgeResult.acceptance.filter((criterion) => criterion.result === 'FAIL').length,
      repairCount,
      escalationCount: 0,
      tokensUsed: 0,
      costCredits: 0,
      latencyMs: Date.now() - startedAt,
      wikiRejected: wikiRecords.filter((record) => record.status === 'rejected').length,
      wikiPromoted: wikiRecords.filter((record) => record.status === 'verified').length,
      expected: {
        acceptances: fixture.expectedAcceptances,
        repairs: fixture.expectedRepairs,
        escalations: fixture.expectedEscalations,
      },
      steps,
    };
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

function withCwd(checks: CheckCommand[], root: string): CheckCommand[] {
  return checks.map((check) => ({ ...check, cwd: root }));
}

async function readRecordedEvidence(root: string, taskId: string): Promise<EvidenceEnvelope[]> {
  const { readdir, readFile } = await import('node:fs/promises');
  const directory = layoutEvidenceDir(root);
  const files = await readdir(directory).catch(() => [] as string[]);
  const envelopes: EvidenceEnvelope[] = [];
  for (const file of files.filter((name) => name.startsWith(`${taskId}-`) && name.endsWith('.json'))) {
    try {
      envelopes.push(JSON.parse(await readFile(join(directory, file), 'utf8')) as EvidenceEnvelope);
    } catch {
      // evidence written by a failed run is not part of the observation
    }
  }
  return envelopes;
}

export async function persistEvaluationReport(
  report: EvaluationReport,
  filePath: string,
): Promise<void> {
  const { mkdir, writeFile: writeReport } = await import('node:fs/promises');
  await mkdir(join(filePath, '..'), { recursive: true });
  await writeReport(filePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

export async function loadEvaluationManifest(
  filePath: string,
): Promise<EvaluationManifest> {
  const { readFile } = await import('node:fs/promises');
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw) as EvaluationManifest;
}
