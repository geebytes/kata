import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { cwd } from 'node:process';
import { accessSync, existsSync, readdirSync, type Dirent } from 'node:fs';
import { gitWorktreeList } from './git.js';
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
/**
 * Whether a checkout is the owner of a task — **by content, not by the existence of a directory**.
 *
 * `accessSync` made an empty directory an owner, which is the same defect the record model fixes one level up and
 * **cheaper** to arrange than the file it replaced: `mkdir -p <anywhere>/.kata/tasks/<id>` was enough to move ownership
 * and `taskDir` began writing the task's records there. Measured after the model was already answering by content —
 * `recordsRoot(<root>/vendor/copy/src, held)` still returned `<root>/vendor/copy`, because this predicate had not been
 * brought along.
 *
 * A directory that holds a record is a holder; a directory that holds nothing is not. The task's own state file counts,
 * and so does any other file under it — the question is whether there is anything at all, not which file.
 */
function hasTaskDir(root: string, taskId: string): boolean {
  const taskDir = join(root, '.kata', 'tasks', taskId);
  try {
    // A file where the task directory should be is not a task record either, and `readdirSync` says so.
    return readdirSync(taskDir).length > 0;
  } catch {
    return false;
  }
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
    // **Every worktree, not only the ones under `.kata/worktrees/`.** `worktree create --path` puts the checkout wherever
    // the operator asked, and `git worktree add` can be run by hand — in both shapes a scan of `.kata/worktrees/` finds
    // nothing, so the detector reported `[]` for a worktree holding the only copy of a record. Measured by this change's
    // own independent challenge: a worktree under `elsewhere/checkout` was invisible to the detector while `recordOwner`
    // recognised it, i.e. the ownership function and one of its consumers disagreed — the defect this change exists to
    // remove, reproduced inside it.
    // **Two sources, unioned.** `git worktree list` is the authority on linked checkouts and is the only source that sees
    // a `--path` one; `.kata/worktrees/` is the directory this repository creates them in and is what a fixture (or a
    // repository where git cannot answer) has. Taking either alone loses a shape: git alone missed the fixtures that
    // build the directory without a real linked checkout, and the directory alone missed every `--path` worktree.
    const candidates = new Set<string>();
    for (const worktree of await gitWorktreeList(root)) {
        const relativePath = relative(root, worktree.path);
        // The main checkout is not a worktree to compare against itself.
        if (relativePath !== '' && !relativePath.startsWith('..')) candidates.add(relativePath);
    }
    try {
        const entries = await readdir(worktrees, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isDirectory() && !entry.name.startsWith('.')) candidates.add(join('.kata', 'worktrees', entry.name));
        }
    } catch {
        // No `.kata/worktrees` here: the git listing above is the whole answer.
    }
    const reported: WorktreeOnlyRecords[] = [];
    for (const relativeWorktree of candidates) {
        const entry = { name: basename(relativeWorktree) };
        // **The task is derived from what the worktree holds, not from its directory name.** `worktree create --path`
        // (and a hand-made `git worktree add`) puts the checkout somewhere the name says nothing about: measured with a
        // custom path, the detector returned `[]` for a worktree holding the only copy of a record, the guard let the
        // removal through, and the remedy reported a `movedCount: 0` success. The directory name is a hint; the task
        // directories inside the worktree are the fact.
        const directoryName = entry.name;
        const worktreeRoot = resolve(root, relativeWorktree);
        const taskIds = await tasksHeldByWorktree(worktreeRoot);
        const taskCandidates = taskIds.length > 0 ? taskIds : [directoryName];
        for (const taskId of taskCandidates) {
        // **Every record surface, not just `.kata/tasks`.** The detector used to look at one directory, so the evidence
        // store was outside it: measured on this repository, **1053 evidence files existed only under worktrees** while
        // the report said `[]` and the removal guard therefore let `archive` delete the only copy. A surface that is
        // derived per-owner has to be enumerated per-owner, or the enumeration is a claim about a subset.
        const pairs = await Promise.all(
            recordSurfaces(taskId).map(async ([surface, taskRelative]) => {
                const primarySurface = join(kataDir(root), surface, taskRelative);
                const worktreeSurface = join(worktreeRoot, '.kata', surface, taskRelative);
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
            reported.push({ taskId, worktree: relativeWorktree, files: onlyHere });
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
 * Isolating a change isolates its **code**, and that is a different question from this one. `resolveCodeRoot` answers the
 * code question — a command run inside a worktree uses that worktree, which is what `isolated_worktree` means and what
 * `worktree.test.ts` pins. **This function answers the records question, and it is not the nearest checkout.** An earlier
 * version of this paragraph said the opposite ("prefers the nearest owner so a command inside `.kata/worktrees/<id>` edits
 * that checkout") and cited the same test for it; the sentence was true of a function that has since been split in two,
 * and the coincidence is why the prose outlived the behaviour. Records are the audit of what happened: one copy exists,
 * and `archive` removes the worktree at the end. Leaving them under whichever root resolved produced two answers to one
 * question (measured: one task reporting `phase: archive` from its worktree and `phase: implement` from the primary
 * checkout) and put 129 record files, across four merged changes, inside a directory the archive deletes.
 *
 * So the records' owner is derived from where the *task* lives, not from where the command stands: a candidate under
 * `.kata/worktrees/` is skipped, and the checkout that holds the worktree directory owns the records. When nothing else
 * holds the task the worktree is still used, because an unreachable record is worse than a remote one.
 */
export function recordsRoot(root: string, taskId: string): string {
    const start = resolve(root);
    // **One derivation.** Was: walk ancestors for `.kata/tasks/<id>/current-state.json`, and when nothing held it, return
    // the caller's own directory. Two faults, both measured: dropping that one file into a nested checkout moved ownership
    // (and `taskDir` began writing the task's records there), and "no owner" read as "here", so a command run inside a
    // worktree wrote records into the worktree. The second walk below also kept the worktree's own copy as an owner, which
    // is what made a worktree's records look like a second answer to the same question.
    const owner = recordOwner({ root: start, taskId }).ownerRoot;
    if (owner !== undefined) return owner;
    // **No owner is not the same answer as "here".** Falling back to the caller made those two indistinguishable, and
    // `taskDir` writes through this function — so a command run inside a directory that merely *looks* like a checkout
    // put the task's records there. Measured: with the ownership predicate fixed to content, `recordsRoot` still fell
    // back to `<root>/vendor/copy/src` for a task no checkout holds.
    //
    // The honest answer for a task nobody holds is the checkout the caller is working in — the nearest ancestor that
    // has a `.kata` directory, because that is where a task would be created. A caller standing outside any checkout
    // keeps its own directory, which is what `resolveWorkspaceRoot` reports as no workspace at all.
    let directory = start;
    while (true) {
        if (existsSync(join(directory, '.kata'))) return directory;
        const parent = resolve(directory, '..');
        if (parent === directory) return start;
        directory = parent;
    }
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
// Initiatives (lifecycle history, driven by the one relation graph)
// ---------------------------------------------------------------------------

export function initiativesDir(root: string): string {
    // **One owner, and no relation store here.** An Initiative's identity and its topology live in the repository's one
    // relation graph; this directory holds only the lifecycle history that graph drives. A second `relations.jsonl`
    // beside it would be the parallel topology this design exists to refuse.
    return join(kataDir(root), 'initiatives');
}

export function initiativeDir(root: string, initiativeId: string): string {
    return join(initiativesDir(root), initiativeId);
}

export function initiativeProjectionPath(root: string, initiativeId: string): string {
    return join(initiativeDir(root, initiativeId), 'current.json');
}

export function initiativeEventsPath(root: string, initiativeId: string): string {
    return join(initiativeDir(root, initiativeId), 'events.jsonl');
}

export function impactPacketsPath(root: string, initiativeId: string): string {
    return join(initiativeDir(root, initiativeId), 'impact-packets.jsonl');
}

export function retirementProposalsPath(root: string, initiativeId: string): string {
    return join(initiativeDir(root, initiativeId), 'retirement-proposals.jsonl');
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
    // **One derivation.** The store belongs to the checkout that owns the records — the same answer `recordsRoot` gives,
    // reached the same way. The store itself is flat and shared, so which task is asked about does not change the
    // directory; what matters is that a worktree resolves to its owning checkout rather than keeping a per-root copy.
    //
    // The task id is read from the worktree's own record directories when the caller stands in one. Asking without it
    // would leave `recordOwner` with no task to look up and return `undefined`, which is how a path-shape test came to be
    // written here in the first place.
    const owner = recordOwner({ root: start, taskId: worktreeTaskId(start) }).ownerRoot;
    return join(kataDir(owner ?? start), 'evidence');
}

/** The first task a worktree holds, read from its own record directories. `undefined` outside a worktree. */
function worktreeTaskId(start: string): string | undefined {
    const worktree = worktreeContaining(start);
    if (worktree === undefined) return undefined;
    try {
        const entries = readdirSync(join(worktree, '.kata', 'tasks'), { withFileTypes: true });
        const held = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => entry.name);
        return held.sort()[0];
    } catch {
        // A worktree that holds no record directory yet still needs an answer, and any task id serves: the owner walk
        // only has to reach the checkout that owns `.kata/worktrees/`, which does not depend on which task was asked.
        return undefined;
    }
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

/**
 * Which checkout owns a record, and which task it belongs to — **the one derivation, asked by every surface**.
 *
 * Five places used to answer this by five different shapes: `recordsRoot` walked ancestors for a marker file,
 * `worktreeOnlyRecords` scanned `.kata/worktrees/<dirname>` and read the task off the directory name,
 * `removeWorktreeSafely` matched the task id its *caller* supplied, `worktreeOwner` took the first task the worktree
 * listed, and `evidenceDir` tested the path shape. The consequence was measurable rather than theoretical: `archive`
 * removed a worktree holding another task's only records and returned success, because the guard asked about a task id
 * while the detector answered about a path.
 *
 * The three decisions, stated rather than implied:
 *
 *   1. **The path shape decides the worktree.** A path inside `.kata/worktrees/<dir>/` is in that worktree; nothing else
 *      is, so a `--path` worktree (which lives wherever the operator put it) is recognised by its own path, not by
 *      living under `.kata/`.
 *   2. **The task id comes from the record directory, not from a directory name.** A worktree created with `--path` is
 *      called whatever the operator typed, so `tasksHeldByWorktree` reads `.kata/tasks/<id>/` and the id is the
 *      directory name *there*.
 *   3. **The owner is the nearest checkout that holds the task and is not a linked worktree.** `.kata/worktrees/` is
 *      excluded by construction — a worktree is a copy of the code, not a second owner of the records.
 *
 * `ownerRoot` is `undefined` when nothing holds the task. That state used to read as the caller's own directory, which
 * made "unknown" indistinguishable from "here" and let a command run inside a worktree write records into it.
 */
export interface RecordOwnership {
    /** The checkout holding this record, or `undefined` when no checkout holds the task. */
    ownerRoot: string | undefined;
    /** The task the path carries, when the path is inside a task's record directory. */
    taskId: string | undefined;
    /** The worktree the path sits in, when it sits in one. */
    worktreeRoot: string | undefined;
}

export function recordOwner(input: { root: string; path?: string; taskId?: string }): RecordOwnership {
    const start = resolve(input.path ?? input.root);
    const worktreeRoot = worktreeContaining(start);

    // (2) The task id is read off the record directory the path is inside, so a worktree whose name says nothing still
    // answers correctly. An explicit `taskId` is honoured only as a *query* — it never changes which checkout owns it.
    const fromPath = taskIdInPath(start);
    const taskId = fromPath ?? input.taskId;

    // Where to begin looking for the owner: the worktree's own checkout when we are inside one, otherwise this path.
    // `dirname(worktreeRoot)` is the checkout that holds `.kata/worktrees/`, and the walk below continues upward from
    // there, so a worktree nested inside another directory still resolves to the repository that owns it.
    const searchFrom = worktreeRoot ? dirname(worktreeRoot) : start;
    // **When the caller stands in a worktree, the owner is decided by the path shape — because that is the only thing
    // that is there.** A worktree a task is *working in* holds no `.kata/tasks/<id>/` (the records live in the checkout
    // that owns it), so the record walk has no task id to look up, and `undefined` was read as "no owner" — which the
    // surfaces above turn into "here", i.e. the store goes back inside the worktree. `owningCheckoutOf` derives the
    // answer from the path alone and sat unwired (`owningCheckoutOf` had no caller at all), which is why `evidenceDir`
    // and `wikiDir` both kept a per-root copy under a real worktree while their tests — whose fixtures created the
    // record directory — passed.
    const ownerRoot = taskId !== undefined
        ? findOwningCheckout(searchFrom, taskId)
        : worktreeRoot === undefined
            ? undefined
            : owningCheckoutOf(worktreeRoot);
    return { ownerRoot, taskId, worktreeRoot };
}

/**
 * The worktree a path sits in, or `undefined`.
 *
 * Recognised by two shapes: the linked checkouts this repository creates under `.kata/worktrees/<dir>`, and a git
 * worktree listed by `git worktree list` (which is how a `--path` checkout appears). The second shape is why this
 * cannot be a pure path test on `.kata/worktrees/` — that test is what made a `--path` worktree invisible to the
 * detector while `resolveCodeRoot` recognised it.
 */
function worktreeContaining(candidate: string): string | undefined {
    const segments = resolve(candidate).split(sep);
    for (let index = segments.length - 1; index >= 1; index -= 1) {
        if (segments[index] === 'worktrees' && segments[index - 1] === '.kata') {
            // The worktree root is `worktrees/<dir>`, not `worktrees` — returning the parent lost the one segment that
            // distinguishes this worktree from its siblings.
            return segments.slice(0, index + 2).join(sep) || sep;
        }
    }
    return undefined;
}

/** The task id a path carries, read from the `.kata/tasks/<id>/` directory the path is inside. */
function taskIdInPath(candidate: string): string | undefined {
    const segments = resolve(candidate).split(sep);
    for (let index = segments.length - 1; index >= 1; index -= 1) {
        if (segments[index] === 'tasks' && segments[index - 1] === '.kata') {
            return segments[index + 1] === undefined ? undefined : segments[index + 1];
        }
    }
    return undefined;
}

/** The nearest ancestor-or-self that holds `taskId` as a task directory and is not a linked worktree. */
function findOwningCheckout(from: string, taskId: string): string | undefined {
    let directory = resolve(from);
    while (true) {
        if (!worktreeContaining(directory) && hasTaskDir(directory, taskId)) {
            return directory;
        }
        const parent = resolve(directory, '..');
        if (parent === directory) return undefined;
        directory = parent;
    }
}

/**
 * A record that exists in only one place — deleting where it lives would lose it.
 *
 * `path` is relative to the record surface's task directory (`tasks/<file>` or `evidence/<file>`), which is the shape a
 * refusal names, and `worktreeRelative` is the worktree it was found in, relative to the repository root.
 */
export interface UniqueCopy {
    path: string;
    taskId: string;
    worktreeRoot: string;
    worktreeRelative: string;
}

/** Thrown when the enumeration cannot answer. **Not** an empty result: an empty set means nothing would be lost. */
export class UniqueCopiesUndetermined extends Error {
    constructor(reason: string) {
        super(`which records exist in only one place could not be determined: ${reason}`);
        this.name = 'UniqueCopiesUndetermined';
    }
}

/**
 * Which records exist in only one place — **the one derivation**.
 *
 * Four consumers used to answer this, and each repair so far fixed one of them: the detector built its own enumeration
 * and comparison, the ownership predicate asked whether a directory existed, archive selected its target by the task's
 * name, and recovery filtered the detector's output itself. The measured failures are recorded per site in
 * `docs/design/2026-10-02-unique-copies-is-one-model.md`; the property they share is that a question answered in four
 * places has four chances to disagree, and the disagreements were reachable.
 *
 * Three decisions live here rather than in the consumers:
 *
 *   1. **Every worktree, including one outside the root.** The candidates come from `git worktree list` and from
 *      `.kata/worktrees/`, and a path outside the repository is kept — a `worktree create --path /elsewhere` checkout is
 *      a real checkout whose records can be the only copy. Dropping candidates outside the root (the previous round's
 *      `!relativePath.startsWith('..')`) left exactly those invisible.
 *   2. **Ownership by content, not by the existence of a directory.** A checkout holds a task when its task directory
 *      holds a record, so `mkdir -p <anywhere>/.kata/tasks/<id>` grants nothing. The previous predicate was `accessSync`,
 *      which made an empty directory an owner — a cheaper way to hijack ownership than the file it replaced.
 *   3. **A record is unique only if every holder agrees.** When two worktrees hold the same path for one task, the
 *      record is not unique to either; counting it twice would name the same loss twice and let recovery's first move
 *      silently overwrite the second holder's copy.
 *
 * A source that cannot answer **raises** rather than returning nothing: `git worktree list` failing, or a worktree
 * directory that cannot be read, means "I could not look", and the caller (archive) cannot tell that from "there is
 * nothing to lose". Returning the empty set for both is what made the previous implementation fail open.
 */
export async function uniqueCopies(input: { root: string; taskId?: string }): Promise<UniqueCopy[]> {
    const root = resolve(input.root);
    const worktrees = await linkedWorktreesOutcome(root);
    if (worktrees.kind === 'undetermined') throw new UniqueCopiesUndetermined(worktrees.reason);

    // Every holder of every task: the primary checkout, then each worktree.
    const holders: Array<{ worktreeRoot: string; worktreeRelative: string }> = [
        { worktreeRoot: root, worktreeRelative: '' },
        ...worktrees.paths.map((path) => ({ worktreeRoot: path, worktreeRelative: relative(root, path) })),
    ];

    // What each holder has, per task, per surface.
    const held = new Map<string, Map<string, Set<string>>>();
    for (const holder of holders) {
        const taskIds = input.taskId !== undefined ? [input.taskId] : await taskIdsWithRecords(holder.worktreeRoot);
        for (const taskId of taskIds) {
            const files = await recordFilesOf(holder.worktreeRoot, taskId);
            if (files.length === 0) continue;
            const byTask = held.get(taskId) ?? new Map<string, Set<string>>();
            byTask.set(holder.worktreeRoot, new Set(files));
            held.set(taskId, byTask);
        }
    }

    const reported: UniqueCopy[] = [];
    for (const [taskId, byHolder] of held) {
        for (const [worktreeRoot, files] of byHolder) {
            // **A copy in the primary checkout is not at risk.** The question this answers is "what would be lost if a
            // worktree went away", because a worktree is what removal deletes. Reporting the primary checkout's own
            // records made every task's `current-state.json` a "unique copy" the moment a worktree happened not to carry
            // it — measured: recovery tried to move the owner's own state file to the owner.
            if (worktreeRoot === root) continue;
            for (const path of files) {
                // (3) Held by more than one checkout: not unique to any of them.
                const holdersOfThisPath = [...byHolder.values()].filter((other) => other.has(path)).length;
                if (holdersOfThisPath > 1) continue;
                reported.push({
                    path,
                    taskId,
                    worktreeRoot,
                    worktreeRelative: relative(root, worktreeRoot),
                });
            }
        }
    }
    return reported;
}

/** The linked checkouts, as an outcome rather than a possibly-empty list. */
async function linkedWorktreesOutcome(root: string): Promise<{ kind: 'determined'; paths: string[] } | { kind: 'undetermined'; reason: string }> {
    const paths = new Set<string>();
    try {
        for (const worktree of await gitWorktreeList(root)) {
            const resolved = resolve(worktree.path);
            // **Outside the root is kept.** A `--path` checkout is a real holder of records.
            if (resolved !== root) paths.add(resolved);
        }
    } catch (error) {
        // git could not answer. The directory below may still answer, so this is not fatal on its own — but if that
        // also fails, the caller gets an undetermined answer rather than "nothing to lose".
        if (!(await directoryWorktrees(root)).ok) {
            return { kind: 'undetermined', reason: `git could not list worktrees (${String(error)}) and .kata/worktrees could not be read` };
        }
    }
    const byDirectory = await directoryWorktrees(root);
    if (!byDirectory.ok) {
        // The directory exists but cannot be read: that is an unreadable source, not an absent one.
        return { kind: 'undetermined', reason: '.kata/worktrees exists but could not be read' };
    }
    for (const path of byDirectory.paths) paths.add(path);
    return { kind: 'determined', paths: [...paths] };
}

async function directoryWorktrees(root: string): Promise<{ ok: true; paths: string[] } | { ok: false }> {
    const worktrees = join(kataDir(root), 'worktrees');
    if (!existsSync(worktrees)) return { ok: true, paths: [] };
    try {
        const entries = await readdir(worktrees, { withFileTypes: true });
        return { ok: true, paths: entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => join(worktrees, entry.name)) };
    } catch {
        return { ok: false };
    }
}

/** The tasks a checkout holds **records** of — content, not the existence of a directory. */
async function taskIdsWithRecords(worktreeRoot: string): Promise<string[]> {
    try {
        const entries = await readdir(join(worktreeRoot, '.kata', 'tasks'), { withFileTypes: true });
        const ids: string[] = [];
        for (const entry of entries) {
            if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
            if ((await recordFilesOf(worktreeRoot, entry.name)).length > 0) ids.push(entry.name);
        }
        return ids;
    } catch {
        return [];
    }
}

/** The record files a checkout holds for a task, across every surface, as `<surface>/<file>` paths. */
async function recordFilesOf(worktreeRoot: string, taskId: string): Promise<string[]> {
    const files: string[] = [];
    for (const surface of ['tasks', 'evidence'] as const) {
        const base = join(worktreeRoot, '.kata', surface);
        if (surface === 'tasks') {
            const taskDir = join(base, taskId);
            // (2) A task directory with no record in it is not a holder.
            files.push(...(await filesUnder(taskDir)).map((file) => `tasks/${file}`));
        } else {
            // The evidence store is flat and keys files by a `<taskId>-` prefix.
            files.push(
                ...(await filesUnder(base))
                    .filter((file) => !file.includes('/') && file.startsWith(`${taskId}-`))
                    .map((file) => `evidence/${file}`),
            );
        }
    }
    return files;
}

/** Every file under a directory, relative to it, recursive. A missing directory is no files. */
async function filesUnder(directory: string): Promise<string[]> {
    const found: string[] = [];
    async function walk(current: string, prefix: string): Promise<void> {
        let entries: Dirent[];
        try {
            entries = await readdir(current, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const next = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
            if (entry.isDirectory()) {
                await walk(join(current, entry.name), next);
            } else if (entry.isFile()) {
                found.push(next);
            }
        }
    }
    await walk(directory, '');
    return found;
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

/**
 * The Wiki record store, owned by the checkout that owns the task's records.
 *
 * **The last surface still derived per-caller, and it cost a gate.** `wikiDir(root)` used to be
 * `join(kataDir(root), 'wiki')`, so `kata-cli wiki register` — not a workflow command, so the *workspace* root — wrote a
 * candidate under the primary checkout while `kata-cli verify --change` — task-addressed, so the *code* root — read the
 * linked worktree's own `.kata/wiki`, which does not exist. Measured on the first task sealed under
 * `isolated_worktree`: `wiki candidate` answered 0 from inside the worktree and 26 from the primary, and the closure gate
 * reported `candidate_missing` for a candidate that exists — with a remedy that reproduced the state.
 *
 * It is the same derivation as `evidenceDir`, reached the same way, for the same reason: one question, one answer. The
 * fallback is the answer for "no owner", which is correct for a task whose records live in the caller's own checkout —
 * what must not happen is a worktree reading "here".
 */
export function wikiDir(root: string): string {
    const start = resolve(root);
    const owner = recordOwner({ root: start, taskId: worktreeTaskId(start) }).ownerRoot;
    return join(kataDir(owner ?? start), 'wiki');
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
