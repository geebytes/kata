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
  // An absolute path outside the author root is not a repository reference; a relative path is resolved against the author
  // root, which is what a `cwd` means. Both questions reduce to the same one — is this value the root, or under it as a path
  // segment — which is why the executed arguments and `cwd` now ask one predicate instead of two rules.
  if (path.startsWith('/') && path !== authorRoot && !path.startsWith(authorRoot.endsWith('/') ? authorRoot : `${authorRoot}/`)) return null;
  const relativePath = relative(authorRoot, resolve(authorRoot, path));
  if (relativePath === '' || relativePath === '..' || relativePath.startsWith('../')) return relativePath === '' ? sandboxRoot : null;
  return join(sandboxRoot, relativePath);
}

/**
 * Map a value the declaration wrote into the snapshot, rewriting **occurrences of the author root that are path segments**.
 *
 * This used to be `value.replaceAll(authorRoot, sandboxRoot)`, which rewrote every occurrence including ones that are part of
 * a longer name: with the author root `/app` the argument `tests/application` reached the command as
 * `tests/tmp/kata-seal-execution-XXXXlication`, so the argument the check declared was not the argument the sandbox ran, and
 * the corruption was visible only in the log
 * (`docs/superpowers/reports/2026-10-10-workspace-root-substitution-corrupts-check-arguments.md`).
 *
 * The rule is the **path segment**, not the whole value and not the substring: an occurrence counts as a reference when it is
 * followed by a path separator or by the end of the value, and never when it is followed by another character. So
 * `/app/tests/support` is mapped, a path embedded inside a script argument (`…file='/app/second-started'…`) is mapped because
 * the working tree it points into has a snapshot copy, and `tests/application` is left exactly as written because `application`
 * is not `app`. Both halves are load-bearing: dropping the first breaks the isolation the earlier tests rely on, dropping the
 * second is the defect the report measured.
 */
function rewriteAuthorReference(value: string, authorRoot: string, sandboxRoot: string): string {
  if (!value.includes(authorRoot)) return value;
  let result = '';
  let scanFrom = 0;
  while (scanFrom < value.length) {
    const at = value.indexOf(authorRoot, scanFrom);
    if (at === -1) { result += value.slice(scanFrom); break; }
    const after = at + authorRoot.length;
    const isSegment = after === value.length || value[after] === '/';
    result += value.slice(scanFrom, at) + (isSegment ? sandboxRoot : authorRoot);
    scanFrom = after;
  }
  return result;
}

