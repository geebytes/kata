import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { resolveTerminalTask } from '../core/relations.js';

export interface TaskRevision {
  id: string;
  taskId: string;
  ownedPaths: string[];
  manifestHash: string;
  createdAt: string;
}

export type RevisionStatus =
  | { status: 'current' }
  | { status: 'superseded'; expectedManifestHash: string; revisionManifestHash: string };

export async function createTaskRevision(input: {
  root: string;
  taskId: string;
  ownedPaths: string[];
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
  const hash = createHash('sha256');
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

async function hashDirectoryRecursive(dirPath: string, root: string, hash: ReturnType<typeof createHash>): Promise<void> {
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (shouldIgnore(entry.name)) continue;
    const absolutePath = join(dirPath, entry.name);
    const relativePath = relative(root, absolutePath).replaceAll('\\', '/');
    if (shouldIgnorePath(relativePath)) continue;
    if (entry.isDirectory()) {
      await hashDirectoryRecursive(absolutePath, root, hash);
      continue;
    }
    if (!entry.isFile()) continue;
    hash.update(relativePath);
    hash.update('\0');
    try {
      hash.update(await readFile(absolutePath));
    } catch {
      hash.update('[missing]');
    }
    hash.update('\0');
  }
}

function shouldIgnore(name: string): boolean {
  return name === '.git'
    || name === '.kata'
    || name === '.llmwiki'
    || name === '.pytest_cache'
    || name === '.mypy_cache'
    || name === '.ruff_cache'
    || name === '.coverage'
    || name === '__pycache__'
    || name === 'node_modules'
    || name === 'dist'
    || name === '.codex'
    || name === '.claude'
    || name === '.opencode';
}

function shouldIgnorePath(path: string): boolean {
  return path === '.github/hooks'
    || path.startsWith('.github/hooks/')
    || path === '.github/skills'
    || path.startsWith('.github/skills/')
    || path === '.github/instructions'
    || path.startsWith('.github/instructions/');
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

function changedRepositoryPaths(root: string): string[] {
  let output: string;
  try {
    output = execFileSync('git', ['status', '--porcelain=v1', '-z'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return [];
  }
  const tokens = output.split('\0').filter(Boolean);
  const paths: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? '';
    const status = token.slice(0, 2);
    const path = token.slice(3);
    if (path) paths.push(path.replaceAll('\\', '/'));
    if (status.includes('R') || status.includes('C')) {
      index += 1;
      const originalPath = tokens[index];
      if (originalPath) paths.push(originalPath.replaceAll('\\', '/'));
    }
  }
  return [...new Set(paths)];
}

function isIgnoredWorkspacePath(path: string): boolean {
  return path === '.kata'
    || path.startsWith('.kata/')
    || path === '.llmwiki'
    || path.startsWith('.llmwiki/')
    || path === '.codex'
    || path.startsWith('.codex/')
    || path === '.claude'
    || path.startsWith('.claude/')
    || path === '.opencode'
    || path.startsWith('.opencode/')
    || path === '.github/hooks'
    || path.startsWith('.github/hooks/')
    || path === '.github/skills'
    || path.startsWith('.github/skills/')
    || path === '.github/instructions'
    || path.startsWith('.github/instructions/')
    || path === 'node_modules'
    || path.startsWith('node_modules/')
    || path === 'dist'
    || path.startsWith('dist/');
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
