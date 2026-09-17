import { createHash, randomUUID, type Hash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import type { TaskRevision } from '../workflow/revision.js';
import { repositoryTreeHash, walkRepositoryFiles } from '../core/repository-identity.js';
import { createContentHasher } from '../core/hash.js';
import { runProcess } from '../process/run.js';
import { evidenceDir as layoutEvidenceDir } from '../core/layout.js';

export type CheckProgressState = 'started' | 'passed' | 'failed' | 'timed_out' | 'cancelled';

export interface CheckProgressEvent {
  type: 'quality_check_progress';
  check: string;
  state: CheckProgressState;
  timeoutMs: number;
  exitCode?: number | null;
}

export const evidenceKinds = ['lint', 'typecheck', 'test', 'ci', 'review', 'judge', 'security', 'integration', 'entrypoint'] as const;

export type EvidenceKind = (typeof evidenceKinds)[number];

export type CheckSource = 'configured' | 'discovered' | 'fallback' | 'matrix' | 'explicit';

export interface ImportedCheckResult {
  exitCode: number;
  log?: string;
  environment?: string;
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
}

export interface EvidenceCollectionOptions {
  scopePaths?: string[];
  revision?: TaskRevision;
  signal?: AbortSignal;
  onProgress?: (event: CheckProgressEvent) => void;
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

const maxLogLength = 20_000;

/**
 * How many checks may run at once. **Serial by default.**
 *
 * Concurrency is tempting — the checks are I/O-bound and one suite can take ten minutes — but the seal cannot know what
 * the checks share. Measured in this workspace: the project's integration checks drop and recreate rows in one
 * PostgreSQL database, so running them alongside each other (or alongside the full suite) makes them fail for reasons
 * that have nothing to do with the change under test. A seal that reports failures it caused itself is worse than a slow
 * one, so the concurrency is opt-in: set `KATA_CHECK_CONCURRENCY` for checks known to be independent.
 */
export function checkConcurrency(): number {
  const configured = Number.parseInt(process.env.KATA_CHECK_CONCURRENCY ?? '', 10);
  if (Number.isFinite(configured) && configured > 0) return configured;
  return 1;
}

/** Runs a mapper over items with at most `limit` in flight, preserving nothing but the results' own indexing. */
async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await worker(items[index]!, index);
    }
  });
  await Promise.all(runners);
}

export async function collectEvidence(
  taskId: string,
  commands: CheckCommand[],
  options: EvidenceCollectionOptions = {},
): Promise<EvidenceEnvelope[]> {
  const evidence: EvidenceEnvelope[] = [];
  const cwd = commands[0]?.cwd ?? process.cwd();

  if (commands.some((check) => (check.cwd ?? process.cwd()) !== cwd)) {
    throw new Error('All evidence checks in one collection must use the same cwd');
  }

  // Independent checks run concurrently under a bounded pool: they are separate child processes, and a seal that runs
  // nine of them one at a time spends the sum of their durations rather than the longest. Results are reassembled in
  // declaration order so a caller's view of the set does not depend on scheduling.
  const results = new Array<EvidenceEnvelope | undefined>(commands.length);
  await runWithConcurrency(commands, checkConcurrency(), async (check, index) => {
    if (options.signal?.aborted) return;
    const checkName = check.name ?? check.command;
    const timeoutMs = check.timeoutMs ?? 600_000;
    options.onProgress?.({ type: 'quality_check_progress', check: checkName, state: 'started', timeoutMs });

    const startedAt = new Date().toISOString();
    const redactions = collectRedactions(check);
    const command = redact(renderCommand(check.command, check.args ?? []), redactions);
    const result = check.importResult ?? (await runBoundedCommand(check, { onProgress: options.onProgress, signal: options.signal }));
    const finishedAt = new Date().toISOString();

    const finalState: CheckProgressState = options.signal?.aborted
      ? 'cancelled'
      : result.exitCode === 0
        ? 'passed'
        : result.exitCode === 124
          ? 'timed_out'
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
      startedAt,
      finishedAt,
      diffHash: '',
      ...(result.log ? { log: redact(truncate(result.log), redactions) } : {}),
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
  options?: { onProgress?: (event: CheckProgressEvent) => void; signal?: AbortSignal },
): Promise<ImportedCheckResult> {
  const cwd = check.cwd ?? process.cwd();
  const result = await runProcess(check.command, check.args ?? [], {
    cwd,
    env: { ...process.env, ...(check.env ?? {}) },
    ...(check.timeoutMs !== undefined ? { timeoutMs: check.timeoutMs } : {}),
    ...(options?.signal ? { signal: options.signal } : {}),
  });

  const note = result.failure === 'timeout'
    ? `TIMEOUT after ${check.timeoutMs ?? 600_000}ms`
    : result.failure === 'aborted'
      ? 'CANCELLED'
      : undefined;
  const log = [result.stdout, result.stderr].filter(Boolean).join('');

  return {
    exitCode: result.exitCode,
    log: note ? `${truncate(log)}\n[${note}]` : truncate(log),
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

function renderCommand(command: string, args: string[]): string {
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
