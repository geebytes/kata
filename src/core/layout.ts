import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
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
  'handoff-receipt.schema.json': handoffReceiptSchema,};

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

/**
 * **Derived from `schemaContents`, not restated beside it.**
 *
 * These were two hand-written lists of one fact — which schemas exist — and adding the protocol's schema to the install list alone produced a
 * `hashContent(undefined)` in `installSchemaCopies`: `schemaFiles` named a file the contents map did not carry (`rpr7-f7`'s other half, found
 * by the case that builds a workspace). A list derived from its source cannot disagree with it, which is the same rule this change's class
 * table applies to every other duplicated vocabulary.
 */
const schemaFiles: readonly string[] = Object.keys(schemaContents);

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
 * The checkout a command's *code* work belongs to — where it edits, builds and tests.
 *
 * **A path decision, not a record lookup.** A caller standing inside `.kata/worktrees/<id>` is working on that linked
 * checkout, and that is true whether or not the worktree carries any `.kata/` file of its own. Deriving this from the
 * presence of a record is what forced `createWorktree` to copy the task state in: the worktree could only be a "root"
 * by also holding a copy of the records, and `archive` then deleted it.
 *
 * The record root answers the other question (`recordsRoot`) and is allowed to be a different checkout.
 */
export function resolveCodeRoot(from?: string): string {
  const start = resolve(from ?? cwd());
  // The nearest linked worktree at or above the caller owns its code. Nothing else is consulted — no file, no task id.
  let directory = start;
  let linked: string | undefined;
  while (true) {
    if (isLinkedWorktreeRoot(directory)) linked = directory;
    const parent = resolve(directory, '..');
    if (parent === directory) break;
    directory = parent;
  }
  if (linked !== undefined) {
    // The innermost worktree wins, which is the nearest one to the caller.
    const inner = nearestLinkedWorktree(start);
    return inner ?? linked;
  }
  return resolveWorkspaceRoot(start);
}

/** The closest linked worktree at or above `from`, innermost first. */
function nearestLinkedWorktree(from: string): string | undefined {
  let directory = resolve(from);
  while (true) {
    if (isLinkedWorktreeRoot(directory)) return directory;
    const parent = resolve(directory, '..');
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/**
 * True when `dir` is a linked worktree root: a checkout that lives under `.kata/worktrees/`.
 *
 * The test is the path shape, deliberately — a linked checkout is recognisable from where it is, so recognising it does
 * not depend on `.git` being readable or on any record existing there.
 */
function isLinkedWorktreeRoot(dir: string): boolean {
  const segments = resolve(dir).split(sep);
  for (let index = 0; index + 2 < segments.length; index += 1) {
    if (segments[index] === '.kata' && segments[index + 1] === 'worktrees' && index + 2 === segments.length - 1) {
      return true;
    }
  }
  return false;
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
/**
 * The task's record root — the checkout that holds the task, resolved from anywhere.
 *
 * **One rule, one place.** This used to run its own ancestor walk and let the *nearest* holder win, which meant the
 * answer depended on `exists(<candidate>/.kata/tasks/<id>/current-state.json)` — ownership as a function of file
 * existence. Measured: with a linked worktree nested in its primary checkout, `recordsRoot` answered with the primary
 * (it skips `.kata/worktrees/`) while this function answered with the worktree, so one question had two answers and
 * which you got depended on which function the caller happened to import.
 *
 * It now delegates to `recordsRoot`, and the delegation is the point: a second derivation of "who owns this task" is a
 * second rule, and a second rule is a second answer waiting to diverge.
 *
 * If no checkout holds the task, the error names the roots that were searched rather than guessing one — a task-addressed
 * command must never act on a checkout that does not hold the task.
 */
export function resolveWorkspaceRootForTask(taskId: string, from?: string): string {
  const start = resolve(from ?? cwd());
  const owner = recordsRoot(start, taskId);
  if (hasTaskDir(owner, taskId)) return owner;

  // No ancestor holds it. A single descendant still wins, because that is how a sibling worktree is addressed; more
  // than one fails closed, because nothing in the invocation says which was meant.
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

/**
 * The task directory's presence, without its `current-state.json`.
 *
 * Ownership asks "does this checkout hold the task", which is a question about the directory. Keying it on a file inside
 * the directory is what made the answer move when that file did, so this checks the outermost fact and nothing more.
 */
function hasTaskDir(root: string, taskId: string): boolean {
  return hasFileOrDir(root, join('.kata', 'tasks', taskId));
}

function findDescendantTaskRoots(taskId: string, root: string): string[] {
  const candidates: string[] = [];

  function scan(dir: string): void {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      const fullPath = join(dir, entry.name);
      // **The same key as `recordsRoot`.** This scan carried its own copy of the ownership test and kept the old form,
      // so the two derivations of "who owns this task" still disagreed for the descendant shape — which is exactly the
      // one-answer-per-question rule the criterion exists for. It now asks `hasTaskDir`, the single derivation.
      if (hasTaskDir(fullPath, taskId)) {
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

/** One task's records that exist under a linked worktree and not in the primary checkout. */
export interface WorktreeOnlyRecords {
    taskId: string;
    /** The linked worktree that holds them, repository-relative to `root`. */
    worktree: string;
    /** The record file names, relative to the task directory, that the primary checkout does not have. */
    files: string[];
}

/**
 * **The records a linked worktree owns and the primary checkout cannot see.**
 *
 * Task state is written under whichever root a command resolved, and a command run inside `.kata/worktrees/<id>` writes
 * there — by design, because that is what isolating a change means for its code. The records are not code, though, and
 * nothing reconciled the two copies: measured on this repository, four merged changes have 129 record files that exist only
 * under their worktree (review records, judge verdicts, per-revision change records, gate choices), and `archive` deletes the
 * worktree those records live in.
 *
 * This reports names only; it moves nothing. What to do about the difference is the caller's, and each option costs
 * differently.
 */
export async function worktreeOnlyRecords(root: string): Promise<WorktreeOnlyRecords[]> {
    const worktrees = join(kataDir(root), 'worktrees');
    let entries: Dirent[] = [];
    try {
        entries = await readdir(worktrees, { withFileTypes: true });
    } catch {
        // No `.kata/worktrees` means no linked checkout, the ordinary state of a change that never isolated.
        return [];
    }
    const reported: WorktreeOnlyRecords[] = [];
    for (const entry of entries.filter((candidate) => candidate.isDirectory() && !candidate.name.startsWith('.'))) {
        // **The task is derived from what the worktree holds, not from its directory name.** `worktree create --path`
        // (and a hand-made `git worktree add`) puts the checkout somewhere the name says nothing about: measured with a
        // custom path, the detector returned `[]` for a worktree holding the only copy of a record, the guard let the
        // removal through, and the remedy reported a `movedCount: 0` success. The directory name is a hint; the task
        // directories inside the worktree are the fact.
        const directoryName = entry.name;
        const taskIds = await tasksHeldByWorktree(join(worktrees, directoryName));
        const candidates = taskIds.length > 0 ? taskIds : [directoryName];
        for (const taskId of candidates) {
        // **Every record surface, not just `.kata/tasks`.** The detector used to look at one directory, so the evidence
        // store was outside it: measured on this repository, **1053 evidence files existed only under worktrees** while
        // the report said `[]` and the removal guard therefore let `archive` delete the only copy. A surface that is
        // derived per-owner has to be enumerated per-owner, or the enumeration is a claim about a subset.
        const pairs = await Promise.all(
            recordSurfaces(taskId).map(async ([surface, taskRelative]) => {
                const primarySurface = join(kataDir(root), surface, taskRelative);
                const worktreeSurface = join(worktrees, directoryName, '.kata', surface, taskRelative);
                const primaryFiles = new Set(await relativeFilesUnder(primarySurface));
                const allWorktreeFiles = await relativeFilesUnder(worktreeSurface);
                // **The evidence store is shared and flat.** It keys its files by `<taskId>-`, and it belongs to the
                // checkout rather than to one worktree, so a file written there by *another* task must not be attributed
                // to this one — and it must not be counted twice when both worktrees hold a copy.
                const worktreeFiles =
                    surface === 'evidence' ? allWorktreeFiles.filter((file) => file.startsWith(`${taskId}-`)) : allWorktreeFiles;
                // **The path carries its surface.** A bare relative name would be ambiguous — `judge.json` under the
                // task directory and a same-named evidence file are different records — and the recovery needs to know
                // which store to write into.
                return worktreeFiles.filter((file) => !primaryFiles.has(file)).map((file) => `${surface}/${file}`);
            }),
        );
        const onlyHere = pairs.flat().sort();
        if (onlyHere.length > 0) {
            reported.push({ taskId, worktree: join('.kata', 'worktrees', directoryName), files: onlyHere });
        }
        }
    }
    return reported;
}

/** The task ids a linked worktree carries records for, by reading its own record directory. */
async function tasksHeldByWorktree(worktree: string): Promise<string[]> {
    try {
        const entries = await readdir(join(worktree, '.kata', 'tasks'), { withFileTypes: true });
        return entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => entry.name);
    } catch {
        // A worktree with no `.kata/tasks` holds no task records; the caller falls back to the directory name so a
        // leftover copy of something else is still reported rather than silently skipped.
        return [];
    }
}

/**
 * Where a task's records live, as `[surface, taskRelativePath]` pairs.
 *
 * `.kata/tasks/<id>/` is the task's own directory. `.kata/evidence/` is flat and keys its files by a `<id>-` prefix —
 * the second surface, and the one a per-caller derivation left behind on every worktree that ever verified anything.
 */
function recordSurfaces(taskId: string): Array<[string, string]> {
    return [
        ['tasks', taskId],
        ['evidence', ''],
    ];
}

/**
 * Every file under `dir`, as paths relative to it, recursively.
 *
 * The relative form is what makes the comparison meaningful across the two roots: `revisions/rev1.json` on one side and
 * `revisions/rev1.json` on the other are the same record, while a bare `revisions` on each side says nothing about what
 * is inside them.
 */
async function relativeFilesUnder(dir: string): Promise<string[]> {
    const found: string[] = [];
    async function walk(current: string, prefix: string): Promise<void> {
        let entries: Dirent[] = [];
        try {
            entries = await readdir(current, { withFileTypes: true });
        } catch {
            // A root without this directory has no records under it; an unreadable one is treated the same way because
            // this reports a difference and cannot resolve it.
            return;
        }
        for (const entry of entries) {
            const relative = prefix === '' ? entry.name : join(prefix, entry.name);
            if (entry.isDirectory()) {
                await walk(join(current, entry.name), relative);
            } else {
                found.push(relative);
            }
        }
    }
    await walk(dir, '');
    return found;
}

/** True when `dir` exists and is a directory, without throwing on a missing path. */
async function directoryExists(dir: string): Promise<boolean> {
    try {
        return (await stat(dir)).isDirectory();
    } catch {
        return false;
    }
}

/**
 * **The root that owns a task's records.**
 *
 * Isolating a change isolates its code: `resolveWorkspaceRootForTask` prefers the nearest owner so a command inside
 * `.kata/worktrees/<id>` edits that checkout and leaves the primary alone — `worktree.test.ts` pins that, and it is what
 * `isolated_worktree` means. Records are a different thing: they are the audit of what happened, one copy should exist, and
 * `archive` removes the worktree at the end. Leaving them under whichever root resolved produced two answers to one
 * question (measured: one task reporting `phase: archive` from its worktree and `phase: implement` from the primary
 * checkout) and put 129 record files, across four merged changes, inside a directory the archive deletes.
 *
 * So the records' owner is derived from where the *task* lives, not from where the command stands: a candidate under
 * `.kata/worktrees/` is skipped, and the checkout that holds the worktree directory owns the records. When nothing else
 * holds the task the worktree is still used, because an unreachable record is worse than a remote one.
 */
export function recordsRoot(root: string, taskId: string): string {
    const start = resolve(root);
    // **Ownership is decided by the task directory, not by a file inside it.** The key used to be
    // `.kata/tasks/<id>/current-state.json`, so dropping that one file into any nested checkout moved the answer: measured,
    // `recordsRoot` and `resolveWorkspaceRootForTask` both switched to the intruder and `taskDir` began writing the task's
    // records there. Ownership that a file can grant is not ownership — it is a race with whoever writes the file.
    const owning: string[] = [];
    let directory = start;
    while (true) {
        if (hasFileOrDir(directory, join('.kata', 'tasks', taskId)) && !isUnderLinkedWorktrees(directory)) {
            owning.push(directory);
        }
        const parent = resolve(directory, '..');
        if (parent === directory) break;
        directory = parent;
    }
    if (owning.length > 0) return owning[0]!;
    // No checkout outside `.kata/worktrees/` holds it: the worktree's copy is the only one, so it is the owner.
    let candidate = start;
    while (true) {
        if (hasFileOrDir(candidate, join('.kata', 'tasks', taskId))) return candidate;
        const parent = resolve(candidate, '..');
        if (parent === candidate) break;
        candidate = parent;
    }
    return start;
}

function isUnderLinkedWorktrees(candidate: string): boolean {
    const segments = candidate.split(sep);
    for (let index = 0; index + 1 < segments.length; index += 1) {
        if (segments[index] === '.kata' && segments[index + 1] === 'worktrees') return true;
    }
    return false;
}

export function taskDir(root: string, taskId: string): string {
    // **The records' owner, not the caller's root.** Every reader and writer of a task's records goes through here, so the
    // ownership decision is made once. `tasksDir(root)` remains the enumeration primitive for "which tasks exist here".
    return join(tasksDir(recordsRoot(root, taskId)), taskId);
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

/** Recorded scope changes (§21.3): what the audited surface grew by, and why. */
export function scopeChangesPath(root: string, taskId: string): string {
    return join(taskDir(root, taskId), 'scope-changes.json');
}

export function wikiClosurePath(root: string, taskId: string): string {
    return join(taskDir(root, taskId), 'wiki-closure.json');
}

export function userChoiceGatePath(root: string, taskId: string, boundary: string): string {
    return join(taskDir(root, taskId), `user-choice-${boundary}.json`);
}

export function waiversPath(root: string, taskId: string): string {
    return join(taskDir(root, taskId), 'waivers.json');
}

/** The seal's own progress log: what a monitoring agent needs instead of guessing from process tables. */
export function sealProgressPath(root: string, taskId: string): string {
    return join(taskDir(root, taskId), 'seal-progress.jsonl');
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

/**
 * Where a verification run's evidence lives — under the **record root**, not the caller's root.
 *
 * Evidence is a governed record: it is what a run proved, and it is named after the task that produced it. It therefore
 * follows the same owner rule as the rest of the trace, which means a caller standing inside a linked worktree writes and
 * reads it in the owning checkout. Keying it on `root` alone put evidence under a per-root directory, so a worktree wrote
 * its own copy and `archive` deleted it — the same fault as the state copy-in, one level down.
 *
 * The owner is derived from the path alone, so no file has to exist for the answer to be right. The store belongs to the
 * checkout rather than to a task — it is flat and keys its files by a `<taskId>-` prefix — so there is no task parameter:
 * the signature used to carry one that nothing read, while its docstring described a task the answer never depended on.
 */
export function evidenceDir(root: string): string {
    const start = resolve(root);
    if (!isUnderLinkedWorktrees(start)) return join(kataDir(start), 'evidence');
    // Standing inside a linked worktree: the checkout that contains it owns the store, which is the same answer for every
    // task under it.
    const owner = owningCheckoutOf(start);
    return join(kataDir(owner ?? start), 'evidence');
}

/**
 * The checkout that holds a path under `.kata/worktrees/<id>` — the repository that owns the worktree.
 *
 * Derived from the path shape: `.kata/worktrees/` is always the parent of the linked checkout, so the checkout above it is
 * the owner. Nothing is read from disk, because ownership must not depend on a file being present.
 */
function owningCheckoutOf(worktree: string): string | undefined {
    const segments = resolve(worktree).split(sep);
    for (let index = segments.length - 1; index >= 1; index -= 1) {
        if (segments[index] === 'worktrees' && segments[index - 1] === '.kata') {
            return segments.slice(0, index - 1).join(sep) || sep;
        }
    }
    return undefined;
}

/** Where a superseded revision's evidence is kept, so a seal never destroys what a previous one proved. */
export function evidenceArchiveDir(root: string, revisionId: string): string {
    return join(evidenceDir(root), 'superseded', revisionId);
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

/** The directory's name, exported so a consumer that only needs the name does not spell the string itself. */
export const llmwikiDirName = '.llmwiki';

/**
 * Where the wiki enrichment packet lives — **not in the governed task store.**
 *
 * The packet is a work order addressed to a person or an agent, not to the runtime: nothing reads it back, and it is
 * regenerated whenever the packet is wanted. It used to be written to `.kata/tasks/wiki-enrich/task-packet.json`, which
 * spent a directory in the store on something that is not a task — `kata-cli status --change wiki-enrich` answered "No
 * Kata workspace owns task wiki-enrich" while the directory sat in the store, and every tool that enumerates the store as
 * tasks had to special-case it.
 *
 * `runtimeDir` is the right home: it already holds the regenerable artefacts (the active-task pointer) that are neither
 * governed state nor evidence, and it is outside the store, so an enumeration of the store is an enumeration of tasks.
 */
export function wikiEnrichPacketPath(root: string): string {
    return join(runtimeDir(root), 'wiki-enrich-task-packet.json');
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
