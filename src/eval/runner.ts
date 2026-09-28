import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readStateEvents, type Actor } from '../core/state.js';
import { readCurrentTaskRevision } from '../workflow/revision.js';
import { collectEvidence, runWithConcurrency, type CheckCommand, type EvidenceEnvelope } from '../quality/evidence.js';
import { judge } from '../quality/judge.js';
import { readWikiRecords } from '../wiki/store.js';
import { runCommand } from '../workflow/orchestrator.js';
import { computeMetrics, type EvaluationRun, type EvaluationMetrics } from './metrics.js';
import { checkReleaseGates, type ReleaseGateResult } from './release-gates.js';
import { admissibilityCorpus, scoreCorpus, shadowCorpusReport, type CorpusObservation, type CorpusScore, type ShadowCaseReport } from './admissibility-corpus.js';
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
  /**
   * The verifier scored against the admissibility corpus, before and after the change (AC-5).
   *
   * Declared here because the *observation* has to come from somewhere real: an execution control change is scored by
   * running both shapes over the corpus and reporting what each concluded. Absent means unmeasured, which the gate
   * reports as `skipped` — never as a pass.
   */
  /**
   * The verifier scored against the corpus, before and after the change (AC-5) — **one observation per case**, because
   * that is what `scoreCorpus` measures. It was one observation per *side*, which made the measurement inexpressible:
   * measured, a perfect verifier scored `1/21 = 0.0476` and a blind one scored the same, so two runs of that shape
   * compared equal and the gate passed without measuring anything.
   */
  verifier?: { baseline: CorpusObservation[]; current: CorpusObservation[] };
}

/**
 * What a fixture declared, what the run produced, and every place they disagree (L5-02).
 *
 * `expectedEscalations` used to be recorded and never compared, so a fixture could assert anything and still
 * contribute a passing aggregate. The comparison is deliberately literal: an expectation that is not observed is not
 * a pass.
 */
export interface FixtureExpectationVerdict {
  expected: { acceptances: number; repairs: number; escalations: number };
  observed: { acceptances: number; repairs: number; escalations: number | null };
  mismatches: string[];
  matched: boolean;
}

export function compareExpectation(
  declared: { acceptances: number; repairs: number; escalations: number },
  observed: { acceptances: number; repairs: number; escalations: number | null },
): FixtureExpectationVerdict {
  const mismatches: string[] = [];
  if (observed.acceptances !== declared.acceptances) {
    mismatches.push(`acceptances: declared ${declared.acceptances}, observed ${observed.acceptances}`);
  }
  if (observed.repairs !== declared.repairs) {
    mismatches.push(`repairs: declared ${declared.repairs}, observed ${observed.repairs}`);
  }
  if (observed.escalations === null) {
    // The harness cannot observe escalations. Declaring none is a claim it agrees with; declaring some is a claim
    // no run can confirm, and *that* is the mismatch worth failing on.
    if (declared.escalations !== 0) {
      mismatches.push(`escalations: declared ${declared.escalations}, unobservable in this harness`);
    }
  } else if (observed.escalations !== declared.escalations) {
    mismatches.push(`escalations: declared ${declared.escalations}, observed ${observed.escalations}`);
  }
  return { expected: { ...declared }, observed: { ...observed }, mismatches, matched: mismatches.length === 0 };
}

/** A run records what the fixture actually produced, next to the expectation it was written against. */
export interface EvaluationRunObservation extends EvaluationRun {
  expected: { acceptances: number; repairs: number; escalations: number };
  expectation: FixtureExpectationVerdict;
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
  /** The concurrency the fixtures actually ran at, so a report cannot be mistaken for a serial one. */
  concurrency: number;
  /**
   * Declared verifier observations the corpus could not match (R6).
   *
   * Present only when the manifest named a case id no corpus entry carries: the gate then fails rather than scoring an
   * empty denominator, and this is where the reader sees which side was refused and why.
   */
  verifierObservationProblems?: string[];
  /**
   * The scored verifier, published rather than computed and discarded.
   *
   * The gate consumed these scores and the report did not carry them, so a reader could see that the gate refused without
   * seeing what it measured — and the measurement is the whole point of AC-5.
   */
  verifierBaseline?: CorpusScore;
  verifierCurrent?: CorpusScore;
  /**
   * The legacy rule against the derived rule, case by case, for the `current` side.
   *
   * Published rather than computed and discarded: Phase 4's acceptance is that every disagreement sample is visible, and
   * a comparison whose result is discarded cannot be audited.
   */
  verifierShadow?: ShadowCaseReport[];
  /** Set when there was nothing to compare, so an empty report never reads as "no disagreements". */
  verifierShadowNote?: string;
}

/**
 * How many fixtures run at once (L5-03). **Serial by default.**
 *
 * Each fixture already gets its own temporary root, so the isolation the parallel case needs is real rather than
 * assumed — but the default is still one at a time, because the boundary the review set for every fan-out in this plan
 * is that the conservative value is the default and the fast one is explicit.
 */
export function evaluationConcurrency(): number {
  const configured = Number.parseInt(process.env.KATA_EVAL_CONCURRENCY ?? '', 10);
  return Number.isFinite(configured) && configured > 0 ? configured : 1;
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
  // Results are written by index, not appended, so the report is byte-identical whatever the concurrency: a reader must
  // not be able to tell from the output whether the run was parallel.
  const runs = new Array<EvaluationRunObservation>(manifest.taskFixtures.length);
  const concurrency = evaluationConcurrency();
  const order = manifest.taskFixtures.map((_, index) => index);
  await runWithConcurrency(order, concurrency, () => 1, async (index) => {
    runs[index] = await runFixture(manifest.taskFixtures[index]!, options);
  });

  const metrics = computeMetrics(runs);
  // AC-5: scored on the release path, not only in a unit test. Both sides are scored against the *same* corpus, so a
  // manifest that declares one observation per shape cannot accidentally compare two different referee sets.
  const corpus = admissibilityCorpus();
  // R6 (2026-09-22, measured by an adversarial pass): this scored each side with a ONE-element observation list and never
  // checked that the declared `caseId` names a corpus case. Measured with the test's own fixture — both sides declaring
  // caseId `a`, which matches no corpus id — both scores collapsed to recall 0 / false-pass 0, and the gate reported
  // `pass: true` because `0 >= 0` and `0 <= 0`. A recall regression therefore read as a pass, which is precisely the
  // reading AC-5 exists to refuse: a verifier that measured nothing must not be reported as having held the line.
  //
  // The observations are matched to the corpus by case id, and an id the corpus does not declare is refused rather than
  // silently dropped into a zero denominator.
  const criticalCases = corpus.filter((entry) => entry.critical === true);
  const verifyObservations = manifest.verifier
    ? ([['baseline', manifest.verifier.baseline], ['current', manifest.verifier.current]] as const).flatMap(([side, observations]) => {
        const problems = observations
            .filter((observation) => !corpus.some((entry) => entry.id === observation.caseId))
            .map((observation) => `${side} names caseId '${observation.caseId}', which is not a corpus case`);
        // An absent observation and a missed defect must not read alike. A set that does not cover every critical case is
        // refused with the missing ids named — never scored, because scoring it would report a recall the manifest did not
        // measure, which is the reading AC-5 exists to refuse.
        const covered = new Set(observations.map((observation) => observation.caseId));
        const missing = criticalCases.filter((entry) => !covered.has(entry.id)).map((entry) => entry.id);
        if (missing.length > 0) {
            problems.push(`${side} declares ${observations.length} observation(s) and does not cover ${missing.length} critical case(s): ${missing.join(', ')}`);
        }
        return problems;
    })
    : [];
  // A refused observation makes the gate **fail** rather than skip: the manifest claimed a measurement and named
  // something the corpus does not contain, so "we did not measure" would understate it. Fail-closed, and it names what
  // was wrong so the declaration can be fixed.
  const verifier = manifest.verifier && verifyObservations.length === 0
    ? { verifierBaseline: scoreCorpus(corpus, manifest.verifier.baseline), verifierCurrent: scoreCorpus(corpus, manifest.verifier.current) }
    : {};
  const verifierObservationProblems = verifyObservations.length > 0 ? verifyObservations : undefined;
  // **Measured here, not declared in the manifest.** The replay numbers come from running the recorded checks, so the gate
  // that reads them cannot be satisfied by writing better numbers into a file — the failure mode the plan names for the
  // verifier comparison, where both sides were author-written.
  const { replayAllLedgers } = await import('../store/replay.js');
  const evidenceReplay = await replayAllLedgers(root).catch(() => []);
  const releaseGates = await checkReleaseGates(root, metrics, {
    ...options,
    ...verifier,
    ...(evidenceReplay.length === 0 ? {} : { evidenceReplay }),
    ...(verifierObservationProblems ? { verifierObservationProblems } : {}),
    expectations: runs.map((run) => ({ id: run.id, matched: run.expectation.matched, mismatches: run.expectation.mismatches })),
    // Recorded rather than inferred: resource-related fixture failures are the reason the default is serial, so a report
    // that shows a parallel run must say so where the reader is already looking for what happened.
    concurrency,
  });

  const declaredVerifier = manifest.verifier;
  const shadow = declaredVerifier ? shadowCorpusReport(corpus, declaredVerifier.current) : undefined;
  return {
    manifest,
    runs,
    ...verifier,
    ...(shadow
        ? {
            verifierShadow: shadow,
            ...(declaredVerifier!.current.length === 0
                ? { verifierShadowNote: 'nothing compared: the declared observation set is empty, which is not the same as a comparison that found no disagreements' }
                : {}),
        }
        : {}),
    metrics,
    releaseGates,
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    unmeasured: [...unmeasuredMetrics],
    concurrency,
    // Reported rather than swallowed: a manifest whose verifier observations do not name corpus cases is a declaration
    // defect, and the reader has to be able to see which side was refused (R6).
    ...(verifierObservationProblems ? { verifierObservationProblems } : {}),
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
        currentDiffHash: evidence[0]?.diffHash ?? '',
      currentScopeHashes: scopeHashes,
    });
    steps.push('judge');

    const events = await readStateEvents(root, fixture.id).catch(() => []);
    const repairCount = events.filter(
      (event) => event.to === 'implement' && (event.from === 'hardVerify' || event.from === 'review' || event.from === 'judge'),
    ).length;
    const wikiRecords = await readWikiRecords(root).catch(() => []);

    const expectation = compareExpectation(
      { acceptances: fixture.expectedAcceptances, repairs: fixture.expectedRepairs, escalations: fixture.expectedEscalations },
      { acceptances: judgeResult.acceptance.length, repairs: repairCount, escalations: null },
    );

    return {
      id: fixture.id,
      taskId: fixture.id,
      acceptances: judgeResult.acceptance.length,
      acceptancesPassed: judgeResult.acceptance.filter((criterion) => criterion.result === 'PASS').length,
      acceptancesFailed: judgeResult.acceptance.filter((criterion) => criterion.result === 'FAIL').length,
      repairCount,
      // The host platform owns model choice, cost and retries, so this harness records that it did not observe
      // them rather than a zero a reader could mistake for a measurement (L5-01).
      escalationCount: null,
      tokensUsed: null,
      costCredits: null,
      latencyMs: Date.now() - startedAt,
      wikiRejected: wikiRecords.filter((record) => record.status === 'rejected').length,
      wikiPromoted: wikiRecords.filter((record) => record.status === 'verified').length,
      expected: expectation.expected,
      expectation,
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
