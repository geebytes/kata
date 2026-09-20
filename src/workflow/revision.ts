import { createHash, randomUUID, type Hash } from 'node:crypto';
import { isIgnoredRepositoryPath, walkRepositoryEntries, walkRepositoryFiles } from '../core/repository-identity.js';
import { hashContent } from '../core/hash.js';
import { changedGitPaths } from '../core/git.js';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { resolveTerminalTask } from '../core/relations.js';
import { createContentHasher } from '../core/hash.js';
import { revisionsDir, currentRevisionPath, revisionPath, tasksDir } from '../core/layout.js';

export interface TaskRevision {
  id: string;
  taskId: string;
  ownedPaths: string[];
  manifestHash: string;
  /**
   * Per-path content digests of the owned set (F2.1 of the finding-lifecycle design).
   *
   * `manifestHash` stays what it was — a single rolling digest, so every historical binding keeps working (I4). This is
   * added *beside* it because a rolling digest cannot answer the question re-verification actually asks: **which files
   * changed since the last pass**. Absent on revisions sealed before the field existed; readers must report that honestly
   * rather than guess a diff.
   */
  pathDigests?: Record<string, string>;
  createdAt: string;
  ownershipConflicts?: Array<{ taskId: string; path: string }>;
  ownershipConflictsAcknowledged?: boolean;
}

export type RevisionStatus =
  | { status: 'current' }
  | { status: 'superseded'; expectedManifestHash: string; revisionManifestHash: string };

/**
 * Mints the revision that identifies this seal, or returns the one that already identifies it.
 *
 * A revision is content-addressed: its id derives from the task, the owned-path manifest hash and the resolved check
 * set, and a seal over byte-identical content resolves to the existing revision instead of minting a new id and
 * silently demoting the previous one — which used to invalidate any review or judge verdict bound to it even though
 * nothing had changed.
 */
export async function createTaskRevision(input: CreateTaskRevisionInput): Promise<TaskRevision> {
  return (await createTaskRevisionIfChanged(input)).revision;
}

/** The same call, reporting whether the revision already existed — the caller may then reuse what it recorded. */
export async function createTaskRevisionIfChanged(input: CreateTaskRevisionInput): Promise<{ revision: TaskRevision; reused: boolean }> {
  const ownedPaths = normalizeOwnedPaths(input.root, input.ownedPaths);
  if (ownedPaths.length === 0) throw new Error('A revision requires at least one declared owned path');
  // One traversal for both digests (L1-02). The id still derives from the manifest hash and the check set only:
  // the per-path table is *added* by this seal (F2.1) and never participates in the identity (I4).
  const { manifestHash, pathDigests } = await computeBothOwnedDigests(input.root, ownedPaths);
  const id = revisionIdFor(input.taskId, manifestHash, input.checkIds ?? []);

  const existing = await readTaskRevision(input.root, input.taskId, id).catch(() => null);
  if (existing) {
    // Identical content: the same revision, with any newly acknowledged conflicts folded in.
    const revision: TaskRevision = {
      ...existing,
      // A revision sealed before the field existed gains it here, without being renumbered.
      ...(existing.pathDigests ? {} : { pathDigests }),
      ...(input.ownershipConflicts?.length ? { ownershipConflicts: input.ownershipConflicts } : {}),
      ...(input.ownershipConflictsAcknowledged ? { ownershipConflictsAcknowledged: true } : {}),
    };
    await writeFile(currentRevisionPath(input.root, input.taskId), `${JSON.stringify(revision, null, 2)}\n`, 'utf8');
    return { revision, reused: true };
  }

  const revision: TaskRevision = {
    id,
    taskId: input.taskId,
    ownedPaths,
    manifestHash,
    pathDigests,
    createdAt: new Date().toISOString(),
    ...(input.ownershipConflicts?.length ? { ownershipConflicts: input.ownershipConflicts } : {}),
    ...(input.ownershipConflictsAcknowledged ? { ownershipConflictsAcknowledged: true } : {}),
  };
  const directory = revisionsDir(input.root, input.taskId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${revision.id}.json`), `${JSON.stringify(revision, null, 2)}\n`, 'utf8');
  await writeFile(currentRevisionPath(input.root, input.taskId), `${JSON.stringify(revision, null, 2)}\n`, 'utf8');
  return { revision, reused: false };
}

export interface CreateTaskRevisionInput {
  root: string;
  taskId: string;
  ownedPaths: string[];
  checkIds?: string[];
  ownershipConflicts?: Array<{ taskId: string; path: string }>;
  ownershipConflictsAcknowledged?: boolean;
}

/** The content-derived revision id: same task, same owned-path content, same check set, same revision. */
export function revisionIdFor(taskId: string, manifestHash: string, checkIds: string[]): string {
  const digest = hashContent(JSON.stringify({ taskId, manifestHash, checkIds: [...checkIds].sort() }));
  return `revision-${digest.slice(0, 16)}`;
}

export async function readTaskRevision(root: string, taskId: string, revisionId: string): Promise<TaskRevision> {
  return JSON.parse(await readFile(revisionPath(root, taskId, revisionId), 'utf8')) as TaskRevision;
}

export async function readCurrentTaskRevision(root: string, taskId: string): Promise<TaskRevision | null> {
  try {
    return JSON.parse(await readFile(currentRevisionPath(root, taskId), 'utf8')) as TaskRevision;
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

export async function revisionStatus(root: string, revision: TaskRevision): Promise<RevisionStatus> {
  const manifestHash = await computeManifestHash(root, revision.ownedPaths);
  return manifestHash === revision.manifestHash
    ? { status: 'current' }
    : { status: 'superseded', expectedManifestHash: manifestHash, revisionManifestHash: revision.manifestHash };
}

/**
 * Feeds one owned-path traversal into the rolling manifest digest and, when asked, the per-path table.
 *
 * `computeManifestHash` and `computePathDigests` each walked the same tree, so a seal read and hashed every owned
 * file twice before a single check started (L1-02). The traversal and the order are identical, so asking for both
 * costs one walk and produces byte-identical output for each. Callers that need only one of the two still pay for
 * only one.
 *
 * The walk is `walkRepositoryEntries` (one file at a time) rather than `walkRepositoryFiles`: the owned set used to be
 * materialised in full just to hash it. Same ignore policy, same size rule (owned-path hashing has no size cap), same
 * `localeCompare` order — so the digests do not move.
 */
async function feedOwnedTree(
  root: string,
  ownedPaths: string[],
  manifest: Hash,
  pathDigests: Record<string, string> | null,
): Promise<void> {
  for (const path of normalizeOwnedPaths(root, ownedPaths)) {
    manifest.update(path);
    manifest.update('\0');
    const fullPath = join(root, path);
    let entry: Awaited<ReturnType<typeof stat>> | null = null;
    try {
      entry = await stat(fullPath);
    } catch {
      entry = null;
    }

    if (entry?.isDirectory()) {
      const relativeDir = relative(root, fullPath).replaceAll('\\', '/');
      for await (const file of walkRepositoryEntries(root, relativeDir ? { under: relativeDir } : {})) {
        manifest.update(file.path);
        manifest.update('\0');
        manifest.update(file.content);
        manifest.update('\0');
        if (pathDigests) pathDigests[file.path] = hashContent(file.content);
      }
    } else if (entry?.isFile()) {
      const content = await readFile(fullPath);
      manifest.update(content);
      if (pathDigests) pathDigests[path] = hashContent(content);
    } else if (entry) {
      manifest.update('[unsupported]');
      if (pathDigests) pathDigests[path] = hashContent('[unsupported]');
    } else {
      manifest.update('[missing]');
      if (pathDigests) pathDigests[path] = hashContent('[missing]');
    }
    manifest.update('\0');
  }
}

/** Both owned-tree digests from one traversal — what a seal needs. */
export async function computeBothOwnedDigests(
  root: string,
  ownedPaths: string[],
): Promise<{ manifestHash: string; pathDigests: Record<string, string> }> {
  const pathDigests: Record<string, string> = {};
  const manifest = createContentHasher();
  await feedOwnedTree(root, ownedPaths, manifest, pathDigests);
  return { manifestHash: manifest.digest('hex'), pathDigests };
}

export async function computeManifestHash(root: string, ownedPaths: string[]): Promise<string> {
  const manifest = createContentHasher();
  await feedOwnedTree(root, ownedPaths, manifest, null);
  return manifest.digest('hex');
}

/**
 * The per-file digest of one owned path, or its whole tree when the path is a directory.
 *
 * Same ignore policy and same no-size-cap rule as `computeManifestHash`, so the two agree about what "the owned content"
 * is; the difference is only the granularity of the bookkeeping.
 */
export async function computePathDigest(root: string, path: string): Promise<string> {
  const hash = createContentHasher();
  try {
    const fullPath = join(root, path);
    const entry = await stat(fullPath);
    if (entry.isDirectory()) {
      await hashDirectoryRecursive(fullPath, root, hash);
    } else if (entry.isFile()) {
      hash.update(await readFile(fullPath));
    } else {
      hash.update('[unsupported]');
    }
  } catch {
    hash.update('[missing]');
  }
  return hash.digest('hex');
}

/**
 * The owned set as a path → digest map, ordered so the result is deterministic.
 *
 * A directory owned path is expanded to the files it contains: a single digest per directory would answer "something in
 * here changed" and nothing more, which is precisely the question this exists to answer precisely.
 */
export async function computePathDigests(root: string, ownedPaths: string[]): Promise<Record<string, string>> {
  const pathDigests: Record<string, string> = {};
  await feedOwnedTree(root, ownedPaths, createContentHasher(), pathDigests);
  return pathDigests;
}

/** Owned-path hashing shares the repository's ignore policy, and reads what it is responsible for (no size cap). */
async function hashDirectoryRecursive(dirPath: string, root: string, hash: ReturnType<typeof createHash>): Promise<void> {
  const relativeDir = relative(root, dirPath).replaceAll('\\', '/');
  for (const file of await walkRepositoryFiles(root, relativeDir ? { under: relativeDir } : {})) {
    hash.update(file.path);
    hash.update('\0');
    hash.update(file.content);
    hash.update('\0');
  }
}


export async function findOwnershipConflicts(
  root: string,
  taskId: string,
  ownedPaths: string[],
): Promise<Array<{ taskId: string; path: string }>> {
  const tasksRoot = tasksDir(root);
  let entries: string[] = [];
  try { entries = await readdir(tasksRoot); } catch { return []; }
  const normalized = normalizeOwnedPaths(root, ownedPaths);
  const conflicts: Array<{ taskId: string; path: string }> = [];
  for (const otherTaskId of entries.filter((id) => id !== taskId)) {
    try {
      const terminal = await resolveTerminalTask(root, otherTaskId);
      if (terminal.taskId === taskId) continue;
      if (terminal.redirects.length > 0) continue;
      try {
        const state = JSON.parse(await readFile(join(tasksRoot, terminal.taskId, 'current-state.json'), 'utf8')) as { phase?: string };
        if (state.phase === 'archive') continue;
      } catch { /* legacy task without state remains an active ownership claim */ }
      const task = JSON.parse(await readFile(join(tasksRoot, otherTaskId, 'task.json'), 'utf8')) as { ownedPaths?: string[] };
      for (const path of normalizeOwnedPaths(root, task.ownedPaths ?? [])) {
        // Directory-granularity overlap is the cheap test and the common case; when two claims do overlap, the conflict
        // is reported at the files both tasks actually own, so "tests/" against "tests/" does not read as a total
        // collision when the two tasks touch different files inside it.
        if (!normalized.some((owned) => pathsOverlap(owned, path))) continue;
        const shared = await sharedOwnedFiles(root, normalized, path);
        if (shared.length > 0) conflicts.push(...shared.map((file) => ({ taskId: otherTaskId, path: file })));
      }
    } catch { /* non-task directory */ }
  }
  return conflicts;
}

/** The files two ownership claims both cover, or the two claimed paths themselves when neither resolves to files. */
async function sharedOwnedFiles(root: string, mine: string[], theirs: string): Promise<string[]> {
  const [mineFiles, theirFiles] = await Promise.all([
    ownedFiles(root, mine),
    ownedFiles(root, [theirs]),
  ]);
  if (mineFiles.size === 0 || theirFiles.size === 0) {
    // A path that does not exist yet (a file the task will create) has no file set: report the claim itself.
    return [...mine, theirs].some((path) => path.length > 0) ? [theirs] : [];
  }
  return [...theirFiles].filter((file) => mineFiles.has(file)).sort();
}

async function ownedFiles(root: string, ownedPaths: string[]): Promise<Set<string>> {
  const files = new Set<string>();
  for (const ownedPath of ownedPaths) {
    try {
      const info = await stat(join(root, ownedPath));
      if (info.isFile()) {
        files.add(ownedPath);
        continue;
      }
      if (!info.isDirectory()) continue;
      for (const file of await walkRepositoryFiles(root, { under: ownedPath })) files.add(file.path);
    } catch {
      // A declared path that does not exist yet contributes no files.
    }
  }
  return files;
}

export async function workspaceDrift(root: string, ownedPaths: string[]): Promise<string[]> {
  const owned = normalizeOwnedPaths(root, ownedPaths);
  return changedRepositoryPaths(root)
    .filter((path) => !isIgnoredWorkspacePath(path))
    .filter((path) => !owned.some((ownedPath) => pathsOverlap(ownedPath, path)))
    .sort();
}

export async function inferOwnedPathsFromWorkspace(root: string): Promise<string[]> {
  return changedRepositoryPaths(root)
    .filter((path) => !isIgnoredWorkspacePath(path))
    .sort();
}

/** @see core/git.ts — the one reader of repository state. */
function changedRepositoryPaths(root: string): string[] {
  return changedGitPaths(root);
}

/** Drift and ownership inference exclude exactly what the tree hash excludes: one policy, one answer. */
function isIgnoredWorkspacePath(path: string): boolean {
  return isIgnoredRepositoryPath(path);
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function normalizeOwnedPaths(root: string, paths: string[]): string[] {
  return [...new Set(paths.map((path) => {
    const normalized = relative(root, resolve(root, path)).replaceAll('\\', '/');
    if (!normalized || normalized === '..' || normalized.startsWith('../')) {
      throw new Error(`Task-owned path must be inside the repository: ${path}`);
    }
    return normalized;
  }))].sort();
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
