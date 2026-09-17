import { createHash, randomUUID } from 'node:crypto';
import { isIgnoredRepositoryPath, walkRepositoryFiles } from '../core/repository-identity.js';
import { changedGitPaths } from '../core/git.js';
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { resolveTerminalTask } from '../core/relations.js';
import { createContentHasher } from '../core/hash.js';

export interface TaskRevision {
  id: string;
  taskId: string;
  ownedPaths: string[];
  manifestHash: string;
  createdAt: string;
  ownershipConflicts?: Array<{ taskId: string; path: string }>;
  ownershipConflictsAcknowledged?: boolean;
}

export type RevisionStatus =
  | { status: 'current' }
  | { status: 'superseded'; expectedManifestHash: string; revisionManifestHash: string };

export async function createTaskRevision(input: {
  root: string;
  taskId: string;
  ownedPaths: string[];
  ownershipConflicts?: Array<{ taskId: string; path: string }>;
  ownershipConflictsAcknowledged?: boolean;
}): Promise<TaskRevision> {
  const ownedPaths = normalizeOwnedPaths(input.root, input.ownedPaths);
  if (ownedPaths.length === 0) throw new Error('A revision requires at least one declared owned path');
  const manifestHash = await computeManifestHash(input.root, ownedPaths);
  const revision: TaskRevision = {
    id: `revision-${randomUUID()}`,
    taskId: input.taskId,
    ownedPaths,
    manifestHash,
    createdAt: new Date().toISOString(),
    ...(input.ownershipConflicts?.length ? { ownershipConflicts: input.ownershipConflicts } : {}),
    ...(input.ownershipConflictsAcknowledged ? { ownershipConflictsAcknowledged: true } : {}),
  };
  const directory = join(input.root, '.kata/tasks', input.taskId, 'revisions');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${revision.id}.json`), `${JSON.stringify(revision, null, 2)}\n`, 'utf8');
  await writeFile(join(input.root, '.kata/tasks', input.taskId, 'current-revision.json'), `${JSON.stringify(revision, null, 2)}\n`, 'utf8');
  return revision;
}

export async function readTaskRevision(root: string, taskId: string, revisionId: string): Promise<TaskRevision> {
  return JSON.parse(await readFile(join(root, '.kata/tasks', taskId, 'revisions', `${revisionId}.json`), 'utf8')) as TaskRevision;
}

export async function readCurrentTaskRevision(root: string, taskId: string): Promise<TaskRevision | null> {
  try {
    return JSON.parse(await readFile(join(root, '.kata/tasks', taskId, 'current-revision.json'), 'utf8')) as TaskRevision;
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

export async function computeManifestHash(root: string, ownedPaths: string[]): Promise<string> {
  const hash = createContentHasher();
  for (const path of normalizeOwnedPaths(root, ownedPaths)) {
    hash.update(path);
    hash.update('\0');
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
    hash.update('\0');
  }
  return hash.digest('hex');
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
  const tasksRoot = join(root, '.kata/tasks');
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
        if (normalized.some((owned) => pathsOverlap(owned, path))) conflicts.push({ taskId: otherTaskId, path });
      }
    } catch { /* non-task directory */ }
  }
  return conflicts;
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
