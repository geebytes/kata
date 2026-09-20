import { createHash, randomUUID, type Hash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import type { TaskRevision } from '../workflow/revision.js';
import { repositoryTreeHash, walkRepositoryFiles } from '../core/repository-identity.js';
import { createContentHasher, hashContent } from '../core/hash.js';
import { runProcess } from '../process/run.js';
import { evidenceDir as layoutEvidenceDir } from '../core/layout.js';

export type CheckProgressState = 'started' | 'passed' | 'failed' | 'timed_out' | 'cancelled' | 'covered' | 'skipped';

export interface CheckProgressEvent {
  type: 'quality_check_progress';
  check: string;
  state: CheckProgressState;
  timeoutMs: number;
  exitCode?: number | null;
  /** Set when the state is `covered`: the check that stands in for this one, which is not executed. */
  coveredBy?: string;
  /** Set when the state is `skipped`: why (currently only `frozen_tier` — the project runs it when freezing). */
  reason?: string;
}

export const evidenceKinds = ['lint', 'typecheck', 'test', 'ci', 'review', 'judge', 'security', 'integration', 'entrypoint', 'claim'] as const;

export type EvidenceKind = (typeof evidenceKinds)[number];

export type CheckSource = 'configured' | 'discovered' | 'fallback' | 'matrix' | 'explicit';

export interface ImportedCheckResult {
  exitCode: number;
  log?: string;
  environment?: string;
  /** Bytes the check produced, whether or not the log below holds all of them. */
  logBytes?: number;
  /** True when the log is a head/tail excerpt rather than the whole output. */
  logTruncated?: boolean;
  /** The complete output, as a path. Present only when the capture dropped something. */
  logArtifact?: string;
  /** Why the captured log could not be written, when it could not be. */
  logArtifactFailure?: string;
}

export interface CheckCommand {
  /** Stable identity of the check, so recorded evidence can name it structurally instead of by command text. */
  id?: string;
  /** Where the resolved check came from: the project's declaration, discovery, an explicit call, or the fallback set. */
  source?: CheckSource;
  name?: string;
  kind: EvidenceKind;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  redact?: string[];
  importResult?: ImportedCheckResult;
  /**
   * Another check's id that covers this one. A covered check is **not executed**: the covering check runs, and the
   * declaration is credited with its evidence (`quality/acceptance-matrix.ts` matches the pointer). Recorded in the
   * artefact and reported by the seal, so "not run because something else covers it" is visible rather than silent.
   */
  coveredBy?: string;
  /**
   * When this check runs: `seal` (the default, and what every check does unless a project says otherwise) or `frozen`,
   * for verification a project wants when the artefact is frozen rather than on every seal. A deferred check is named in
   * the seal's report, so "declared but not run" is never silent.
   */
  tier?: 'seal' | 'frozen';
  /**
   * The exit code this check must produce for the claim attached to it to be true (C3).
   *
   * Absent for every ordinary check, whose outcome is whatever the project's command does. Present on a claim's check,
   * where "it ran" is not the question — "the sentence holds" is.
   */
  expectExitCode?: number;
  /**
   * The test selector this check runs, when it is a test check that names one.
   *
   * Recorded rather than left inside `args` because two things need it structurally: the input fingerprint (which must
   * change when the selector does, or a reuse would credit the wrong test) and the rule that Verify and Review may
   * only execute declared selectors (L0-04/L2-04).
   */
  testSelector?: string;
  /**
   * How many slots this check occupies when checks run concurrently. Default **1**.
   *
   * The reason this exists came from another session's report, and it is now measured rather than asserted: a project
   * whose checks are *themselves* parallel (`pytest -n auto`) sizes each one for a whole machine, so running N of them at
   * once multiplies the load by N — `4 x -n auto` oversubscribes 48 cores and makes the checks slower *and* flakier than
   * serial. A check like that declares a weight above the concurrency limit (`"weight": 8`) and runs alone, without the
   * project having to give up concurrency for its cheap checks.
   */
  weight?: number;
  /**
   * The envelope this check's outcome was carried forward from, when a seal reused it instead of running it.
   *
   * On `CheckCommand` rather than only on the envelope because `planCheckReuse` expresses a reuse by setting
   * `importResult` on the *check*; the collector then needs somewhere to read the provenance from when it stamps the
   * new envelope. An unknown field here is a compile error, which is the point.
   */
  reusedFrom?: string;
}

export interface EvidenceCollectionOptions {
  scopePaths?: string[];
  revision?: TaskRevision;
  signal?: AbortSignal;
  onProgress?: (event: CheckProgressEvent) => void;
  /**
   * Run the checks a project marked `tier: 'frozen'` as well. Default false: those are the expensive whole-project
   * verifications a project wants at the point the artefact is frozen, and a seal that deferred them names them.
   */
  includeFrozen?: boolean;
  /**
   * Where a check's complete output is written when its capture exceeded the in-memory bound.
   *
   * Absent means "keep only what the bounded capture holds" — which is what a caller with no task-scoped place to put
   * the file should pass. The orchestrator passes `evidenceDir(root)` so the record survives beside the envelope.
   */
  checkLogDir?: string;
  /**
   * The acceptance criteria each declared check id proves, built from the task's acceptance matrix.
   *
   * Passed in rather than read here: the collector knows checks, the matrix belongs to the task, and the mapping is
   * what lets a reused envelope stay answerable for the rows it was declared against.
   */
  acceptanceByCheckId?: Record<string, string[]>;
}

export interface EvidenceEnvelope {
  id: string;
  taskId: string;
  /** The resolved check that produced this evidence, and where that check came from. */
  checkId?: string;
  checkSource?: CheckSource;
  name?: string;
  kind: EvidenceKind;
  command: string;
  environment?: string;
  exitCode: number;
  startedAt: string;
  finishedAt: string;
  diffHash: string;
  revisionId?: string;
  scope?: EvidenceScope;
  log?: string;
  /** Bytes the check produced before any cap applied. */
  logBytes?: number;
  /** True when `log` is an excerpt. A reader must never mistake a truncated log for a silent check. */
  logTruncated?: boolean;
  /**
   * Where the complete log **was written**, when the capture was bounded.
   *
   * Present only when the file exists. The field is a pointer a reader follows, so an artifact that could not be
   * written is reported through `logArtifactFailure` instead of being named here — the difference between "the
   * transcript is here" and "the transcript should have been here" is the difference between a diagnostic and a trap.
   */
  logArtifact?: string;
  /** Why the bounded capture could not be written beside the envelope, when it could not be. */
  logArtifactFailure?: string;
  /**
   * The exit code this check declared it must produce (claims only). Absent for an ordinary check.
   *
   * Recorded on the envelope rather than only on the declaration, because the envelope is what a later reader has: a
   * bare `exitCode: 1` cannot be told from a failure without it.
   */
  expectExitCode?: number;
  /**
   * Whether the check produced the outcome it declared: `exitCode === (expectExitCode ?? 0)`.
   *
   * This exists because the collector and the claim evaluator disagreed: a claim declaring `expectExitCode: 1` passed on
   * exit 1 in `evaluateClaims` while the seal's own predicate (`exitCode === 0`) called it a failure. One field, one
   * answer. Optional on disk so envelopes written before it still validate; read it through `isPassing()`.
   */
  passed?: boolean;
  /** sha256 over the inputs that decide what this check executes. Absent means "cannot be reused", never "unchanged". */
  checkInput?: string;
  /** The acceptance criteria this check was declared to prove, from the matrix. */
  coveredAcceptanceIds?: string[];
  /** The envelope this one was carried forward from, when the check was not re-run. */
  reusedFrom?: string;
}

/** A passing envelope under the outcome contract, tolerating envelopes written before the field existed. */
export function isPassing(evidence: EvidenceEnvelope): boolean {
  return evidence.passed ?? evidence.exitCode === 0;
}

/**
 * What decides what a check executes.
 *
 * Environment *keys* only, never values: a value is a secret far more often than it is a predictor of behaviour, and
 * the key set is what actually changes a command's behaviour. `importResult` is excluded on purpose — it is how a reuse
 * is expressed, not part of the input.
 */
export function checkInputFingerprint(check: CheckCommand): string {
  return hashContent(JSON.stringify({
    command: check.command,
    args: check.args ?? [],
    cwd: check.cwd ?? '',
    envKeys: Object.keys(check.env ?? {}).sort(),
    ...(check.testSelector ? { testSelector: check.testSelector } : {}),
  }));
}

export interface EvidenceScope {
  paths: string[];
  hash: string;
}

export type FreshnessResult =
  | { fresh: true }
  | {
      fresh: false;
      reason: 'diff_hash_mismatch';
      expectedDiffHash: string;
      evidenceDiffHash: string;
    }
  | {
      fresh: false;
      reason: 'scope_hash_mismatch';
      expectedScopeHash: string;
      evidenceScopeHash: string;
    };

/**
 * The checks a run will **not** execute, because a frozen-tier check waits for the artefact to be frozen.
 *
 * Exported because the seal preflight has to reason about the evidence a run will produce, and a check the run defers
 * produces none. Counting a deferred check as planned evidence let the preflight call an obligation answerable that the
 * resolver then could not resolve — the seal passing while the obligation stayed open, reported by nothing.
 */
export function deferredChecks(commands: CheckCommand[], includeFrozen: boolean): CheckCommand[] {
    return includeFrozen ? [] : commands.filter((check) => check.tier === 'frozen' && !check.coveredBy);
}

/** Characters of a check's output kept inline in the envelope. Enough for the failure, not for a megabyte of noise. */
const maxLogLength = 20_000;

/**
 * The bound the process facility is given for a check's capture (L4-02).
 *
 * Larger than `maxLogLength` on purpose: the inline log is what a reader sees first, and the capture bound only exists
 * so a check that prints for ten minutes cannot make the *seal* hold the whole transcript while it waits. The complete
 * text still lands in the artifact file below.
 */
const maxCaptureBytes = 2_000_000;

/**
 * A check's artifact filename stem: its id, or a slash-free slug of its name or command.
 *
 * The name used to be `${check.id ?? checkName}` straight, and `checkName` falls back to `check.command` — so a check
 * declared without an id produced a path built from its command, which for the realistic case is absolute
 * (`<logDir>/<task>-/usr/bin/node.log`). The write failed, the envelope reported the failure honestly (the guard below
 * is what made it visible rather than silent), and the reason was a misleading ENOENT rather than "this check has no
 * usable artifact name". A project's own `.kata-config.json` declares checks with `name` and no `id`, so this was the
 * common shape, not a corner.
 *
 * The slug keeps the diagnostic property that mattered — the file is recognisable — while never introducing a
 * separator that turns the name into a path.
 */
/** Whether a path names a readable file, for the one field whose contract is that it does. */
async function fileExists(path: string): Promise<boolean> {
    return stat(path).then((info) => info.isFile()).catch(() => false);
}

function artifactSlugFor(check: CheckCommand): string {
    const raw = check.id ?? check.name ?? check.command;
    const slug = raw.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
    // A name that is nothing but separators (a bare path, a check with no name at all) still needs a stem, and every
    // such check gets the same one — which is correct: they are indistinguishable to a reader anyway.
    return slug || 'check';
}

// Which envelope a reused check was carried forward from, so the new evidence names its provenance.
function reuseSourceMap(commands: CheckCommand[]): Map<CheckCommand, string> {
  const reuseSource = new Map<CheckCommand, string>();
  for (const check of commands) {
    if (check.reusedFrom) reuseSource.set(check, check.reusedFrom);
  }
  return reuseSource;
}

/**
 * How many checks may run at once. **Serial by default.**
 *
 * Concurrency is tempting — the checks are I/O-bound and one suite can take ten minutes — but the seal cannot know what
 * the checks share. Measured in this workspace: the project's integration checks drop and recreate rows in one
 * PostgreSQL database, so running them alongside each other (or alongside the full suite) makes them fail for reasons
 * that have nothing to do with the change under test. A seal that reports failures it caused itself is worse than a slow
 * one, so the concurrency is opt-in: set `KATA_CHECK_CONCURRENCY` for checks known to be independent.
 *
 * A check's own `weight` is the finer instrument, and the one a project should reach for: a check that is itself parallel
 * (`pytest -n auto`) declares a weight above the limit and runs alone, while the cheap checks beside it still share slots.
 */
export function checkConcurrency(): number {
  const configured = Number.parseInt(process.env.KATA_CHECK_CONCURRENCY ?? '', 10);
  if (Number.isFinite(configured) && configured > 0) return configured;
  return 1;
}

/** The slots a check occupies: its declared weight, or one. */
export function checkWeight(check: CheckCommand): number {
  const weight = check.weight;
  return Number.isFinite(weight) && (weight as number) > 0 ? (weight as number) : 1;
}

/**
 * Runs a mapper over items with at most `limit` slots in flight, where each item may occupy more than one slot.
 *
 * Weighted rather than uniform because the thing being bounded is machine capacity, not check count: one check that runs
 * `-n auto` is already a whole machine's worth of work, and starting a second beside it is how a seal ends up reporting
 * failures it caused itself.
 *
 * Exported because it is the one bounded scheduler in the codebase: the seal preflight and the CodeGraph fan-out both
 * need "bounded fan-out, declaration order preserved", and a second implementation of that is how the two drift.
 */
export async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  weightOf: (item: T) => number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const workers = Math.max(1, Math.min(limit, items.length));
  const inFlight: number[] = [];
  let next = 0;
  // A release wakes every waiter; each re-checks capacity and either takes a slot or waits again. Simpler than a
  // semaphore and it cannot spin: a waiter only runs when something changed.
  let release: (() => void) | null = null;
  const wake = (): void => {
    const pending = release;
    release = null;
    pending?.();
  };
  const waitForSlot = (): Promise<void> =>
    new Promise((resolve) => {
      const previous = release;
      release = () => {
        previous?.();
        resolve();
      };
    });
  const free = (): number => limit - inFlight.reduce((sum, weight) => sum + weight, 0);

  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (;;) {
        const index = next;
        if (index >= items.length) return;
        // A check may ask for more slots than the limit; it then occupies the whole budget and runs alone, which is what a
        // `pytest -n auto` check needs rather than an error.
        const weight = Math.max(1, Math.min(weightOf(items[index]!), limit));
        if (weight > free()) {
          await waitForSlot();
          continue;
        }
        next += 1;
        inFlight.push(weight);
        try {
          await worker(items[index]!, index);
        } finally {
          inFlight.splice(inFlight.indexOf(weight), 1);
          wake();
        }
      }
    }),
  );
}

export async function collectEvidence(
  taskId: string,
  commands: CheckCommand[],
  options: EvidenceCollectionOptions = {},
): Promise<EvidenceEnvelope[]> {
  const evidence: EvidenceEnvelope[] = [];
  // A declaration covered by another check is not executed; the covering check runs and the row is credited with its
  // evidence. Keeping the skip here (rather than dropping the check upstream) means every consumer still sees the check
  // — in `--list-checks`, in the artefact and in the seal's report — and only its execution is elided.
  const covered = commands.filter((check) => check.coveredBy);
  const deferred = deferredChecks(commands, options.includeFrozen === true);
  const toRun = commands.filter((check) => !check.coveredBy && !deferred.includes(check));
  const cwd = toRun[0]?.cwd ?? commands[0]?.cwd ?? process.cwd();

  if (commands.some((check) => (check.cwd ?? process.cwd()) !== cwd)) {
    throw new Error('All evidence checks in one collection must use the same cwd');
  }

  // Independent checks run concurrently under a bounded pool: they are separate child processes, and a seal that runs
  // nine of them one at a time spends the sum of their durations rather than the longest. Results are reassembled in
  // declaration order so a caller's view of the set does not depend on scheduling.
  const results = new Array<EvidenceEnvelope | undefined>(commands.length);
  const reuseSource = reuseSourceMap(commands);
  // Covered checks report themselves so a monitoring reader sees why they produced nothing, then are skipped.
  for (const [index, check] of commands.entries()) {
    if (!check.coveredBy) continue;
    options.onProgress?.({
      type: 'quality_check_progress',
      check: check.name ?? check.command,
      state: 'covered',
      timeoutMs: check.timeoutMs ?? 0,
      coveredBy: check.coveredBy,
    });
    results[index] = undefined;
  }
  // Deferred checks say why they are not running, in the same stream as everything else about the seal.
  for (const check of deferred) {
    options.onProgress?.({
      type: 'quality_check_progress',
      check: check.name ?? check.command,
      state: 'skipped',
      timeoutMs: check.timeoutMs ?? 0,
      reason: 'frozen_tier',
    });
  }
  // A check whose weight fills the budget runs alone: the scheduler cannot fit anything beside it, which is exactly what
  // a `pytest -n auto` check needs — it is already using every core it was going to get.
  await runWithConcurrency(toRun, checkConcurrency(), checkWeight, async (check) => {
    const index = commands.indexOf(check);
    if (options.signal?.aborted) return;
    const checkName = check.name ?? check.command;
    const timeoutMs = check.timeoutMs ?? 600_000;
    options.onProgress?.({ type: 'quality_check_progress', check: checkName, state: 'started', timeoutMs });

    const startedAt = new Date().toISOString();
    const redactions = collectRedactions(check);
    const declaredCheckId = check.id;
    const checkInput = checkInputFingerprint(check);
    const expected = check.expectExitCode ?? 0;
    // A reused check never reaches `runBoundedCommand`: `importResult` short-circuits it, which is the existing seam for
    // "this outcome is already known". Stamping happens after, so a reused envelope is indistinguishable in shape from a
    // fresh one — except for `reusedFrom`, which says so.
    const command = redact(renderCommand(check.command, check.args ?? []), redactions);
    const result = check.importResult ?? (await runBoundedCommand(check, {
      onProgress: options.onProgress,
      signal: options.signal,
      ...(options.checkLogDir
        ? { logArtifactPath: join(options.checkLogDir, `${taskId}-${artifactSlugFor(check)}.log`) }
        : {}),
    }));
    const finishedAt = new Date().toISOString();

    const finalState: CheckProgressState = options.signal?.aborted
      ? 'cancelled'
      : result.exitCode === 124
        ? 'timed_out'
        : result.exitCode === expected
          ? 'passed'
          : 'failed';
    options.onProgress?.({ type: 'quality_check_progress', check: checkName, state: finalState, timeoutMs, exitCode: result.exitCode });

    results[index] = {
      id: `evidence-${randomUUID()}`,
      taskId,
      ...(check.id ? { checkId: check.id } : {}),
      ...(check.source ? { checkSource: check.source } : {}),
      ...(check.name ? { name: check.name } : {}),
      kind: check.kind,
      command,
      environment: redact(result.environment ?? environmentSummary(cwd), redactions),
      exitCode: result.exitCode,
      // The outcome contract, stated once, where the exit code is known.
      ...(check.expectExitCode !== undefined ? { expectExitCode: check.expectExitCode } : {}),
      passed: result.exitCode === expected,
      checkInput,
      ...(declaredCheckId && options.acceptanceByCheckId?.[declaredCheckId]
        ? { coveredAcceptanceIds: [...options.acceptanceByCheckId[declaredCheckId]!].sort() }
        : {}),
      ...(reuseSource.get(check) ? { reusedFrom: reuseSource.get(check)! } : {}),
      startedAt,
      finishedAt,
      diffHash: '',
      ...(result.log ? { log: redact(truncate(result.log), redactions) } : {}),
      ...(result.logBytes !== undefined ? { logBytes: result.logBytes } : {}),
      ...(result.logTruncated || (result.log?.length ?? 0) > maxLogLength ? { logTruncated: true } : {}),
      // The guard is applied to whatever produced the result, imported or spawned: `logArtifact` names a file that
      // exists. For the spawned path `runBoundedCommand` already dropped a failed write, and for an imported result the
      // file is checked here — a reused envelope carrying a stale path would otherwise be re-stamped as if it were live,
      // which is the one way this field could still lie.
      ...(result.logArtifact && (await fileExists(result.logArtifact))
        ? { logArtifact: result.logArtifact }
        : {}),
      ...(result.logArtifactFailure ? { logArtifactFailure: result.logArtifactFailure } : {}),
    };
  });
  evidence.push(...results.filter((item): item is EvidenceEnvelope => item !== undefined));

  if (evidence.length === 0) return evidence;

  const finalDiffHash = await computeDiffHash(cwd);
  const scopePaths = options.revision?.ownedPaths ?? options.scopePaths;
  const scope = options.revision
    ? { paths: options.revision.ownedPaths, hash: options.revision.manifestHash }
    : scopePaths?.length
    ? { paths: [...new Set(scopePaths.map((path) => normalizeScopePath(cwd, path)))].sort(), hash: await computeScopeHash(cwd, scopePaths) }
    : undefined;
  return evidence.map((item) => ({
    ...item,
    diffHash: finalDiffHash,
    ...(options.revision ? { revisionId: options.revision.id } : {}),
    ...(scope ? { scope } : {}),
  }));
}

/**
 * The evidence set a task actually recorded: every `.kata/evidence/<taskId>-*.json` envelope, validated against the
 * evidence schema. A reader that instead parses one known filename sees a projection of this set, not the set itself.
 */
export async function readRecordedEvidence(root: string, taskId: string): Promise<EvidenceEnvelope[]> {
  const { readdir } = await import('node:fs/promises');
  const { readValidated } = await import('../core/schema.js');
  const evidenceDir = layoutEvidenceDir(root);
  let files: string[] = [];
  try {
    files = await readdir(evidenceDir);
  } catch {
    return [];
  }

  const evidence: EvidenceEnvelope[] = [];
  for (const file of files.filter((name) => name.startsWith(`${taskId}-`) && name.endsWith('.json'))) {
    const envelope = await readValidated<EvidenceEnvelope>('evidence', join(layoutEvidenceDir(root), file));
    if (envelope.taskId === taskId) evidence.push(envelope);
  }
  return evidence;
}

export function checkFreshness(
  evidence: EvidenceEnvelope,
  diffHash: string,
  scopeHash?: string,
): FreshnessResult {
  if (evidence.scope) {
    if (scopeHash === evidence.scope.hash) return { fresh: true };
    return {
      fresh: false,
      reason: 'scope_hash_mismatch',
      expectedScopeHash: scopeHash ?? '',
      evidenceScopeHash: evidence.scope.hash,
    };
  }
  if (evidence.diffHash === diffHash) return { fresh: true };
  return {
    fresh: false,
    reason: 'diff_hash_mismatch',
    expectedDiffHash: diffHash,
    evidenceDiffHash: evidence.diffHash,
  };
}

export async function computeScopeHash(root: string, paths: string[]): Promise<string> {
  const normalizedPaths = [...new Set(paths.map((path) => normalizeScopePath(root, path)))].sort();
  const hash = createContentHasher();
  for (const path of normalizedPaths) {
    hash.update(path);
    hash.update('\0');
    const fullPath = join(root, path);
    try {
      const entryStat = await stat(fullPath);
      if (entryStat.isDirectory()) {
        await hashDirectoryRecursive(fullPath, root, hash);
      } else {
        hash.update(await readFile(fullPath));
      }
    } catch {
      hash.update('[missing]');
    }
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** Directory hashing for a scope shares the repository's ignore policy; only the walk's size budget differs. */
async function hashDirectoryRecursive(dirPath: string, root: string, hash: Hash): Promise<void> {
  const relativeDir = relative(root, dirPath).replaceAll('\\', '/');
  for (const file of await walkRepositoryFiles(root, relativeDir ? { under: relativeDir } : {})) {
    hash.update(file.path);
    hash.update('\0');
    hash.update(file.content);
    hash.update('\0');
  }
}

function normalizeScopePath(root: string, path: string): string {
  const absolute = resolve(root, path);
  const normalized = relative(root, absolute).replaceAll('\\', '/');
  if (!normalized || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Evidence scope path must be inside the repository: ${path}`);
  }
  return normalized;
}

export async function computeDiffHash(root: string = process.cwd()): Promise<string> {
  // One identity definition: the walk and its ignore policy live in core/repository-identity.ts.
  return repositoryTreeHash(root);
}

const graceMs = 5_000;

/**
 * Runs one check through the subprocess facility, so a check gets the same bounded, captured, process-group-killed
 * treatment as every other child kata spawns. The log keeps the terminal note the evidence record has always carried.
 */
async function runBoundedCommand(
  check: CheckCommand,
  options?: { onProgress?: (event: CheckProgressEvent) => void; signal?: AbortSignal; logArtifactPath?: string },
): Promise<ImportedCheckResult> {
  const cwd = check.cwd ?? process.cwd();
  const result = await runProcess(check.command, check.args ?? [], {
    cwd,
    env: { ...process.env, ...(check.env ?? {}) },
    ...(check.timeoutMs !== undefined ? { timeoutMs: check.timeoutMs } : {}),
    ...(options?.signal ? { signal: options.signal } : {}),
    // L4-02: bound what the child can make us hold. The bound is upstream of the evidence cap, so a megabyte of test
    // noise is dropped while it is read rather than after it has been held — and the complete text goes to the
    // artifact beside the envelope, whose path (not payload) is what the evidence records.
    maxCaptureBytes,
    ...(options?.logArtifactPath ? { captureArtifact: options.logArtifactPath } : {}),
  });

  const note = result.failure === 'timeout'
    ? `TIMEOUT after ${check.timeoutMs ?? 600_000}ms`
    : result.failure === 'aborted'
      ? 'CANCELLED'
      : undefined;
  // The terminal note is appended before the cap so it survives truncation; the log itself is capped once, at the
  // envelope, which is where readers look.
  const log = [result.stdout, result.stderr].filter(Boolean).join('');
  const withNote = note ? `${log}\n[${note}]` : log;

  return {
    exitCode: result.exitCode,
    log: withNote,
    logBytes: result.capturedBytes,
    // `logArtifact` names a file that exists: it is only claimed when the tee reported no failure. A gone artifact is
    // reported as a failure rather than as a path, because a reader who follows the path must never get ENOENT.
    ...(result.captureTruncated || withNote.length > maxLogLength
      ? {
          logTruncated: true,
          ...(options?.logArtifactPath && !result.artifactFailure ? { logArtifact: options.logArtifactPath } : {}),
        }
      : {}),
    ...(result.artifactFailure ? { logArtifactFailure: result.artifactFailure } : {}),
    environment: result.environment,
  };
}

function collectRedactions(check: CheckCommand): string[] {
  return [
    ...(check.redact ?? []),
    ...sensitiveEnvironmentValues(process.env),
    ...Object.entries(check.env ?? {})
      .filter(([key]) => /secret|token|password|key/i.test(key))
      .map(([, value]) => value),
  ].filter((value) => value.length > 0);
}

function sensitiveEnvironmentValues(env: NodeJS.ProcessEnv | Record<string, string>): string[] {
  return Object.entries(env)
    .filter(([key]) => /secret|token|password|key/i.test(key))
    .map(([, value]) => value ?? '')
    .filter((value) => value.length > 0);
}

function environmentSummary(cwd: string): string {
  return `node=${process.version} platform=${process.platform} cwd=${cwd}`;
}

/** Exported so the seal preflight can describe a planned check's command the way its evidence will. */
export function renderCommand(command: string, args: string[]): string {
  return [command, ...args].join(' ');
}

function redact(value: string, secrets: string[]): string {
  let redacted = value;
  for (const secret of secrets) {
    redacted = redacted.split(secret).join('[REDACTED]');
  }
  return redacted;
}

function truncate(value: string): string {
  if (value.length <= maxLogLength) return value;
  return value.slice(0, maxLogLength);
}
