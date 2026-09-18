import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { cwd } from 'node:process';
import { accessSync, readdirSync, type Dirent } from 'node:fs';
import { loadConfig } from './config.js';
import taskSchema from 'kata-asset:schemas/task.schema.json';
import workflowStateRecordSchema from 'kata-asset:schemas/workflow-state-record.schema.json';
import workflowStateEventSchema from 'kata-asset:schemas/workflow-state-event.schema.json';
import evidenceSchema from 'kata-asset:schemas/evidence.schema.json';
import reviewFindingSchema from 'kata-asset:schemas/review-finding.schema.json';
import judgeResultSchema from 'kata-asset:schemas/judge-result.schema.json';
import wikiRecordSchema from 'kata-asset:schemas/wiki-record.schema.json';
import handoffPacketSchema from 'kata-asset:schemas/handoff-packet.schema.json';
import handoffReceiptSchema from 'kata-asset:schemas/handoff-receipt.schema.json';
import { hashContent } from './hash.js';

const schemaContents: Record<string, string> = {
  'task.schema.json': taskSchema,
  'workflow-state-record.schema.json': workflowStateRecordSchema,
  'workflow-state-event.schema.json': workflowStateEventSchema,
  'evidence.schema.json': evidenceSchema,
  'review-finding.schema.json': reviewFindingSchema,
  'judge-result.schema.json': judgeResultSchema,
  'wiki-record.schema.json': wikiRecordSchema,
  'handoff-packet.schema.json': handoffPacketSchema,
  'handoff-receipt.schema.json': handoffReceiptSchema,
};

export type LayoutResult = {
  created: string[];
  existing: string[];
  conflicts: string[];
};

const layoutDirectories = [
  '.kata',
  '.kata/rules',
  '.kata/wiki',
  '.kata/tasks',
  '.kata/evidence',
  '.kata/schemas',
  '.kata/runtime',
] as const;

const schemaFiles = [
  'task.schema.json',
  'workflow-state-record.schema.json',
  'workflow-state-event.schema.json',
  'evidence.schema.json',
  'review-finding.schema.json',
  'judge-result.schema.json',
  'wiki-record.schema.json',
  'handoff-packet.schema.json',
  'handoff-receipt.schema.json',
] as const;

const schemaManifestFile = '.generated-schemas.json';

type SchemaManifest = {
  version: 1;
  files: Record<string, { sha256: string }>;
};

function hasFileOrDir(dir: string, name: string): boolean {
  try {
    accessSync(join(dir, name));
    return true;
  } catch {
    return false;
  }
}

const workspaceMarkers = ['.git', '.opencode', 'opencode.json', 'package.json', 'Cargo.toml', 'go.mod'];

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'target',
  'dist',
  'build',
  '.kata',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  '.env',
  '.opencode',
]);

export function resolveWorkspaceRoot(from?: string): string {
  let dir = resolve(from ?? cwd());
  while (true) {
    for (const marker of workspaceMarkers) {
      if (hasFileOrDir(dir, marker)) return dir;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) return from ?? cwd();
    dir = parent;
  }
}

/**
 * Resolve the repository that owns an explicitly named Kata task.
 *
 * A generic workspace marker (especially a nested `.git`) is insufficient for
 * workflow mutation: it can silently select a different `.kata` state tree.
 * Task-addressed commands therefore search ancestor directories for the task
 * itself and reject ambiguous ownership rather than guessing.
 *
 * Resolution order:
 * 1. Search ancestor directories from the starting path upward; the nearest
 *    owner wins (a linked worktree nested in its primary checkout owns the task
 *    itself, and a command run there means that worktree).
 * 2. If no ancestor owns the task, search descendant directories beneath the
 *    workspace root, skipping dependency, metadata, and Kata-internal dirs.
 * 3. A single descendant wins; multiple descendants fail closed, because nothing
 *    in the invocation says which of those sibling worktrees was meant.
 */
export function resolveWorkspaceRootForTask(taskId: string, from?: string): string {
  const start = resolve(from ?? cwd());
  const candidates: string[] = [];
  let directory = start;
  while (true) {
    if (hasFileOrDir(directory, join('.kata', 'tasks', taskId, 'current-state.json'))) {
      candidates.push(directory);
    }
    const parent = resolve(directory, '..');
    if (parent === directory) break;
    directory = parent;
  }
  // The nearest owner wins. `candidates` is built from the starting directory upward, so the first entry is the
  // directory the user is standing in. A nested worktree and its primary checkout both own the same task (task state is
  // tracked), and running a command inside the worktree means the worktree — not the primary checkout it is nested in.
  if (candidates.length > 0) return candidates[0]!;

  const workspaceRoot = resolveWorkspaceRoot(start);
  const descendants = findDescendantTaskRoots(taskId, workspaceRoot);

  if (descendants.length === 1) return descendants[0]!;
  if (descendants.length > 1) {
    throw new Error(
      `Multiple descendant worktrees own task ${taskId}: ${descendants.join(', ')}. Pass --root explicitly to select one.`,
    );
  }

  throw new Error(
    `No Kata workspace owns task ${taskId}. Neither the current/ancestor workspace nor any eligible nested worktree contains this task. Pass --root explicitly or run the command from that workspace.`,
  );
}

function findDescendantTaskRoots(taskId: string, root: string): string[] {
  const candidates: string[] = [];

  function scan(dir: string): void {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as unknown as Dirent[];
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      const fullPath = join(dir, entry.name);
      if (hasFileOrDir(fullPath, join('.kata', 'tasks', taskId, 'current-state.json'))) {
        candidates.push(fullPath);
      }
      scan(fullPath);
    }
  }

  scan(root);
  return candidates;
}

export async function initLayout(root: string): Promise<LayoutResult> {
  await loadConfig(root);

  const result: LayoutResult = { created: [], existing: [], conflicts: [] };

  for (const relativePath of layoutDirectories) {
    const absolutePath = join(root, relativePath);
    try {
      const entry = await stat(absolutePath);
      if (entry.isDirectory()) result.existing.push(relativePath);
      else result.conflicts.push(relativePath);
    } catch (error) {
      if (!isNodeError(error) || (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')) throw error;
      if (error.code === 'ENOTDIR') {
        result.conflicts.push(relativePath);
        continue;
      }
      await mkdir(absolutePath);
      result.created.push(relativePath);
    }
  }

  // Hygiene runs whether or not a path conflicted: a schema mismatch must not leave the runtime pointer unignored.
  const hygiene = await ensureWorkspaceHygiene(root);
  result.conflicts.push(...hygiene.conflicts);

  return result;
}

async function installSchemaCopies(root: string, result: LayoutResult): Promise<void> {
  const targetDirectory = join(root, '.kata/schemas');
  // The directory exists whenever schema copies are wanted; a caller asking for hygiene on an existing workspace must
  // not depend on initLayout having created it first.
  await mkdir(targetDirectory, { recursive: true });
  const manifest = await readSchemaManifest(targetDirectory, result);
  if (manifest === undefined) return;

  let manifestChanged = false;
  for (const schemaFile of schemaFiles) {
    const target = join(targetDirectory, schemaFile);
    const content = schemaContents[schemaFile];
    const generatedHash = hashContent(content);
    const recordedHash = manifest.files[schemaFile]?.sha256;

    try {
      const existingContent = await readFile(target, 'utf8');
      const existingHash = hashContent(existingContent);
      if (recordedHash === undefined) {
        result.conflicts.push(`.kata/schemas/${schemaFile}`);
        continue;
      }
      if (existingHash !== recordedHash && existingHash !== generatedHash) {
        result.conflicts.push(`.kata/schemas/${schemaFile}`);
        continue;
      }
      if (existingHash !== generatedHash) {
        await writeFileAtomic(target, content);
      }
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
      await writeFileAtomic(target, content);
    }

    if (recordedHash !== generatedHash) {
      manifest.files[schemaFile] = { sha256: generatedHash };
      manifestChanged = true;
    }
  }

  if (manifestChanged) {
    await writeFileAtomic(join(targetDirectory, schemaManifestFile), `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

async function readSchemaManifest(
  targetDirectory: string,
  result: LayoutResult,
): Promise<SchemaManifest | undefined> {
  const manifestPath = join(targetDirectory, schemaManifestFile);
  try {
    const content = await readFile(manifestPath, 'utf8');
    const parsed = JSON.parse(content) as unknown;
    if (!isSchemaManifest(parsed)) {
      result.conflicts.push(`.kata/schemas/${schemaManifestFile}`);
      return undefined;
    }
    return parsed;
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
    return { version: 1, files: {} };
  }
}

function isSchemaManifest(value: unknown): value is SchemaManifest {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { version?: unknown; files?: unknown };
  if (candidate.version !== 1 || typeof candidate.files !== 'object' || candidate.files === null) return false;
  return Object.values(candidate.files).every((entry) => {
    if (typeof entry !== 'object' || entry === null) return false;
    const candidateEntry = entry as { sha256?: unknown };
    return typeof candidateEntry.sha256 === 'string' && /^[a-f0-9]{64}$/.test(candidateEntry.sha256);
  });
}



/**
 * The workspace hygiene every kata workspace needs, idempotent and safe to re-run.
 *
 * Two things live here because both are easy to forget and expensive to miss:
 *
 * - **`.kata/runtime/` is ignored.** The active-task pointer is a session pointer, not project state. When it is not
 *   ignored it gets committed, and a worktree or a fresh clone checks it out — so the hook guard reads an "active task"
 *   nobody activated in that checkout, and enforces that task's phase and role against whoever is working there.
 * - **`.kata/worktrees/` is ignored.** A linked worktree nested in the repository shows up as untracked paths in the
 *   primary checkout unless it is ignored, which is exactly why hosts that nest worktrees keep them under an ignored
 *   directory.
 *
 * The schema copies are vendored for transparency and external tooling; a mismatch is reported rather than thrown.
 */
export async function ensureWorkspaceHygiene(root: string): Promise<{ gitignoreUpdated: boolean; conflicts: string[] }> {
  const conflicts: string[] = [];
  const layout: LayoutResult = { created: [], existing: [], conflicts };
  await installSchemaCopies(root, layout);
  const gitignoreUpdated = await ensureRuntimeGitignore(root);
  return { gitignoreUpdated, conflicts };
}

export async function ensureRuntimeGitignore(root: string): Promise<boolean> {
  const gitignorePath = join(root, '.gitignore');
  let content = '';
  try {
    content = await readFile(gitignorePath, 'utf8');
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
  }

  const lines = content.split(/\r?\n/);
  const missing = ignoredRuntimePaths.filter((entry) => !lines.includes(entry));
  if (missing.length === 0) return false;

  const separator = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
  await writeFileAtomic(gitignorePath, `${content}${separator}${missing.join('\n')}\n`);
  return true;
}

/** Machine-local paths under `.kata/`: session pointers and linked worktrees. */
export const ignoredRuntimePaths = ['.kata/runtime/', '.kata/worktrees/'];

async function writeFileAtomic(path: string, content: string): Promise<void> {
  const temporaryPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temporaryPath, content, 'utf8');
  await rename(temporaryPath, path);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export function kataDir(root: string): string {
    return join(root, '.kata');
}

export function tasksDir(root: string): string {
    return join(kataDir(root), 'tasks');
}

export function taskDir(root: string, taskId: string): string {
    return join(tasksDir(root), taskId);
}

export function taskPath(root: string, taskId: string): string {
    return join(taskDir(root, taskId), 'task.json');
}

export function currentStatePath(root: string, taskId: string): string {
    return join(taskDir(root, taskId), 'current-state.json');
}

export function stateEventsPath(root: string, taskId: string): string {
    return join(taskDir(root, taskId), 'state-events.jsonl');
}

export function transitionLockPath(root: string, taskId: string): string {
    return join(taskDir(root, taskId), '.transition.lock');
}

export function reviewPath(root: string, taskId: string): string {
    return join(taskDir(root, taskId), 'review.json');
}

export function judgePath(root: string, taskId: string): string {
    return join(taskDir(root, taskId), 'judge.json');
}

export function verifyPath(root: string, taskId: string): string {
    return join(taskDir(root, taskId), 'verify.json');
}

export function repairPath(root: string, taskId: string): string {
    return join(taskDir(root, taskId), 'repair.json');
}

/** The recorded outcome of one node's independent adversarial pass (or its explicit waiver). */
export function adversarialReviewPath(root: string, taskId: string, node: string): string {
    return join(taskDir(root, taskId), `adversarial-${node}.json`);
}

/**
 * Where the briefs kata has **issued** for a node are kept (D2, second fix).
 *
 * The gate used to validate a recorded pass by *re-deriving* the brief and comparing hashes, which made the record
 * depend on state a pass — or another node's round — can rewrite: the framing of the next round, the reading set
 * derived from the working tree, the findings `kata-cli review` resets. Recording a pass could therefore reject the very
 * brief it answered. The brief is now stored as it was issued, and the record binds to that copy.
 */
export function adversarialBriefsDir(root: string, taskId: string): string {
    return join(taskDir(root, taskId), 'adversarial-briefs');
}

/** One issued brief log, keyed by the revision the brief named — the binding the record has to match. */
export function adversarialBriefPath(root: string, taskId: string, node: string, revisionId: string): string {
    const safe = revisionId.replace(/[^A-Za-z0-9._-]/g, '_');
    return join(adversarialBriefsDir(root, taskId), `${node}-${safe}.json`);
}

/** Where a task's repair batches live (C1): findings opened together and closed together. */
export function repairBatchPath(root: string, taskId: string): string {
    return join(taskDir(root, taskId), 'repair-batch.json');
}

export function repairObligationsPath(root: string, taskId: string): string {
    return join(taskDir(root, taskId), 'repair-obligations.json');
}

export function wikiClosurePath(root: string, taskId: string): string {
    return join(taskDir(root, taskId), 'wiki-closure.json');
}

export function userChoiceGatePath(root: string, taskId: string, boundary: string): string {
    return join(taskDir(root, taskId), `user-choice-${boundary}.json`);
}

export function subagentProgressPath(root: string, taskId: string): string {
    return join(taskDir(root, taskId), 'subagent-progress.md');
}

export function waiversPath(root: string, taskId: string): string {
    return join(taskDir(root, taskId), 'waivers.json');
}

export function migrationsPath(root: string, taskId: string): string {
    return join(taskDir(root, taskId), 'migrations.json');
}

export function recoveryPath(root: string, taskId: string): string {
    return join(taskDir(root, taskId), 'recovery.json');
}

/** The seal's own progress log: what a monitoring agent needs instead of guessing from process tables. */
export function sealProgressPath(root: string, taskId: string): string {
    return join(taskDir(root, taskId), 'seal-progress.jsonl');
}

/**
 * The pass heartbeat (K1): one line per batch of an adversarial pass's work.
 *
 * Mirrors `sealProgressPath` on purpose — the seal has had a heartbeat since a long operation was found to be invisible
 * while it ran, and a pass is the same kind of operation with a single write point at the end, which is why a crash used to
 * take all of its work with it.
 */
export function adversarialProgressPath(root: string, taskId: string): string {
    return join(taskDir(root, taskId), 'adversarial-progress.jsonl');
}

export function taskProfilePath(root: string, taskId: string): string {
    return join(taskDir(root, taskId), 'workflow-profile.json');
}

// ---------------------------------------------------------------------------
// Revisions
// ---------------------------------------------------------------------------

export function revisionsDir(root: string, taskId: string): string {
    return join(taskDir(root, taskId), 'revisions');
}

export function revisionPath(root: string, taskId: string, revisionId: string): string {
    return join(revisionsDir(root, taskId), `${revisionId}.json`);
}

export function currentRevisionPath(root: string, taskId: string): string {
    return join(taskDir(root, taskId), 'current-revision.json');
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

export function evidenceDir(root: string): string {
    return join(kataDir(root), 'evidence');
}

/** Where a superseded revision's evidence is kept, so a seal never destroys what a previous one proved. */
export function evidenceArchiveDir(root: string, revisionId: string): string {
    return join(evidenceDir(root), 'superseded', revisionId);
}

export function evidenceFilePath(root: string, taskId: string, suffix: string): string {
    return join(evidenceDir(root), `${taskId}-${suffix}.json`);
}

// ---------------------------------------------------------------------------
// Relations, wiki, runtime
// ---------------------------------------------------------------------------

export function relationsPath(root: string): string {
    return join(kataDir(root), 'relations.json');
}

export function wikiDir(root: string): string {
    return join(kataDir(root), 'wiki');
}

export function wikiCandidatesDir(root: string): string {
    return join(wikiDir(root), 'candidates');
}

export function wikiVerifiedDir(root: string): string {
    return join(wikiDir(root), 'verified');
}

export function wikiRecordPath(root: string, id: string): string {
    return join(wikiDir(root), `${id}.json`);
}

export function runtimeDir(root: string): string {
    return join(kataDir(root), 'runtime');
}

/** The pointer the platform hook guard reads to know which task and role is active. */
export function activeTaskPath(root: string): string {
    return join(runtimeDir(root), 'active-task.json');
}

export function llmwikiDir(root: string): string {
    return join(root, '.llmwiki');
}

// ---------------------------------------------------------------------------
// Handoffs
// ---------------------------------------------------------------------------

export function handoffDir(root: string, taskId: string): string {
    return join(taskDir(root, taskId), 'handoffs');
}

export function handoffPacketPath(root: string, taskId: string, id: string): string {
    return join(handoffDir(root, taskId), `${id}.json`);
}

export function handoffReceiptPath(root: string, taskId: string, id: string): string {
    return join(handoffDir(root, taskId), `${id}.receipt.json`);
}

export function handoffBaselinePath(root: string, taskId: string): string {
    return join(handoffDir(root, taskId), 'baseline.json');
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export function projectConfigPath(root: string): string {
    return join(root, '.kata-config.json');
}

/** The adapter ownership manifest, and the two repository-relative names kata reports about itself. */
export function adaptersDir(root: string): string {
    return join(kataDir(root), 'adapters');
}

export function adaptersManifestPath(root: string): string {
    return join(adaptersDir(root), 'manifest.json');
}

export function rulesDir(root: string): string {
    return join(kataDir(root), 'rules');
}

/** Repository-relative names, for the reports and checks that describe kata's own files rather than build paths. */
export const skillsIndexRelativePath = '.kata/skills-index.md';
export const relationsRelativePath = '.kata/relations.json';

export function cometCompatOverridePath(root: string): string {
    return join(kataDir(root), 'comet-compat.yaml');
}
