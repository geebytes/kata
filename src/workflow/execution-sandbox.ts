import { chmod, copyFile, cp, mkdir, mkdtemp, readdir, readlink, rm, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { CheckCommand } from '../quality/evidence.js';
import { isGitRepository, runGit } from '../core/git.js';
import { listRepositoryFiles } from '../core/repository-identity.js';
import { computeContentDigests } from './revision.js';

/**
 * A materialized, pre-check author snapshot used only to execute a seal's checks.
 *
 * The author worktree remains read-only from the check process's point of view:
 * every check runs in this detached, disposable worktree.  The content digest is
 * calculated from the materialized copy, so the revision and the code checks saw
 * are the same bytes even if a check writes build output or a marker file.
 */
export interface ExecutionSandbox {
  root: string;
  contentDigests: Record<string, string>;
  dispose(): Promise<void>;
}

/**
 * Materialize the current author content in a detached worktree before checks run.
 *
 * `git worktree add` provides a real `.git` for project checks that query Git;
 * current uncommitted and untracked repository content is then overlaid on it.
 * Dependencies are copied, never linked, so a check cannot mutate the author's
 * `node_modules` through the sandbox.
 */
export async function createExecutionSandbox(authorRoot: string): Promise<ExecutionSandbox> {
  const root = await mkdtemp(join(tmpdir(), 'kata-seal-execution-'));
  const hasGit = isGitRepository(authorRoot);
  let registeredWorktree = false;
  if (hasGit) {
    const created = runGit(authorRoot, ['worktree', 'add', '--detach', root, 'HEAD']);
    if (!created.ok) {
      await rm(root, { recursive: true, force: true });
      const detail = created.stderr || created.stdout || 'unknown error';
      throw new Error(`Seal requires an isolated execution worktree: ${detail}`);
    }
    registeredWorktree = true;
  }
  const dispose = async (): Promise<void> => {
    // The directory was created with mkdtemp above. When Git registered it,
    // force only discards this invocation's check side effects, never author data.
    if (registeredWorktree) {
      runGit(authorRoot, ['worktree', 'remove', '--force', root]);
      runGit(authorRoot, ['worktree', 'prune']);
    }
    await rm(root, { recursive: true, force: true });
  };
  try {
    // A non-Git fixture receives the same private copy. A check that needs Git
    // then fails as check evidence, but it can never write back to the author tree.
    await synchronizeRepositoryContent(authorRoot, root);
    await copyRuntimeDependencies(authorRoot, root);
    const contentDigests = await computeContentDigests(root);
    return { root, contentDigests, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

/** Map every repository-local check reference from the author tree into the snapshot. */
export function checksForExecutionSandbox(
  checks: CheckCommand[],
  authorRoot: string,
  sandboxRoot: string,
): CheckCommand[] {
  return checks.map((check) => {
    const cwd = mapRepositoryPath(check.cwd ?? authorRoot, authorRoot, sandboxRoot);
    if (!cwd) throw new Error(`Seal check cwd must be inside the repository for isolated execution: ${check.cwd ?? authorRoot}`);
    return {
      ...check,
      execution: {
        command: rewriteAuthorReference(check.command, authorRoot, sandboxRoot),
        args: (check.args ?? []).map((arg) => rewriteAuthorReference(arg, authorRoot, sandboxRoot)),
        cwd,
        ...(check.env
          ? { env: Object.fromEntries(Object.entries(check.env).map(([key, value]) => [key, rewriteAuthorReference(value, authorRoot, sandboxRoot)])) }
          : {}),
      },
    };
  });
}

async function synchronizeRepositoryContent(authorRoot: string, sandboxRoot: string): Promise<void> {
  const authorFiles = await listRepositoryFiles(authorRoot);
  const authorSet = new Set(authorFiles);
  const sandboxFiles = await listRepositoryFiles(sandboxRoot);

  // A file deleted by the author after HEAD must be absent from the execution
  // snapshot too; otherwise the check sees a hybrid of HEAD and author content.
  for (const path of sandboxFiles) {
    if (!authorSet.has(path)) await rm(join(sandboxRoot, path), { force: true });
  }
  for (const path of authorFiles) {
    const source = join(authorRoot, path);
    const target = join(sandboxRoot, path);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
    const sourceStat = await stat(source);
    await chmod(target, sourceStat.mode);
  }
}

async function copyRuntimeDependencies(authorRoot: string, sandboxRoot: string): Promise<void> {
  // A linked worktree can have a partial `node_modules`; Node then resolves
  // dependencies from an ancestor workspace. Copy every resolution candidate
  // (far to near so the author's closest dependency wins) into the private root.
  // Linking, or retaining symlinks to those candidates, would let a check mutate
  // dependencies outside the sandbox.
  const requireFromAuthor = createRequire(join(authorRoot, 'package.json'));
  const candidates = requireFromAuthor.resolve.paths('kata-execution-sandbox-runtime') ?? [];
  for (const source of [...candidates].reverse()) {
    try {
      if (!(await stat(source)).isDirectory()) continue;
    } catch {
      continue;
    }
    await cp(source, join(sandboxRoot, 'node_modules'), {
      recursive: true,
      force: true,
      dereference: false,
      verbatimSymlinks: true,
    });
  }
  await assertRuntimeLinksContained(join(sandboxRoot, 'node_modules'));
}

async function assertRuntimeLinksContained(directory: string, runtimeRoot = directory): Promise<void> {
  let entries: Array<Dirent<string>>;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await assertRuntimeLinksContained(path, runtimeRoot);
      continue;
    }
    if (!entry.isSymbolicLink()) continue;
    const target = resolve(dirname(path), await readlink(path));
    const rel = relative(runtimeRoot, target);
    if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
      throw new Error(`Refusing runtime dependency symlink outside the execution sandbox: ${path}`);
    }
  }
}

function mapRepositoryPath(path: string, authorRoot: string, sandboxRoot: string): string | null {
  const relativePath = relative(authorRoot, resolve(authorRoot, path));
  if (relativePath === '' || relativePath === '..' || relativePath.startsWith('../')) return relativePath === '' ? sandboxRoot : null;
  return join(sandboxRoot, relativePath);
}

function rewriteAuthorReference(value: string, authorRoot: string, sandboxRoot: string): string {
  return value.replaceAll(authorRoot, sandboxRoot);
}
