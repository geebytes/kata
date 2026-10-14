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
  // `--root` is accepted as a filesystem path, while string declarations carry
  // canonical absolute references. Normalize once so a trailing separator cannot
  // make cwd and command/args/env answer different questions.
  const canonicalAuthorRoot = resolve(authorRoot);
  const canonicalSandboxRoot = resolve(sandboxRoot);
  return checks.map((check) => {
    const cwd = mapRepositoryPath(check.cwd ?? canonicalAuthorRoot, canonicalAuthorRoot, canonicalSandboxRoot);
    if (!cwd) throw new Error(`Seal check cwd must be inside the repository for isolated execution: ${check.cwd ?? authorRoot}`);
    return {
      ...check,
      execution: {
        command: rewriteAuthorReference(check.command, canonicalAuthorRoot, canonicalSandboxRoot),
        args: (check.args ?? []).map((arg) => rewriteAuthorReference(arg, canonicalAuthorRoot, canonicalSandboxRoot)),
        cwd,
        ...(check.env
          ? { env: Object.fromEntries(Object.entries(check.env).map(([key, value]) => [key, rewriteAuthorReference(value, canonicalAuthorRoot, canonicalSandboxRoot)])) }
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
  const candidate = resolve(authorRoot, path);
  const relativePath = relative(authorRoot, candidate);
  if (relativePath === '' || relativePath === '..' || relativePath.startsWith('../')) return relativePath === '' ? sandboxRoot : null;
  return join(sandboxRoot, relativePath);
}

/**
 * Map path-segment occurrences of the author root into the snapshot.
 * Map path-segment occurrences of the author root into the snapshot.
 *
 * A declaration value may contain more than one root-like substring. Each real
 * root reference is mapped independently; a longer name and a genuine author
 * path can coexist in a shell argument, and leaving the genuine path behind
 * would make the sandbox read the author checkout. A preceding slash is not a
 * boundary: `//<root>` is nested under another path, not a reference beginning
 * at the filesystem root.
 */
/**
 * **What continues a name: letters, marks and digits in any script, plus the punctuation file names carry.**
 *
 * The three classes are not a taste: they are the characters that make the occurrence part of a longer *name* rather than
 * a value of its own. An independent round measured what happens when this is written as an ASCII class
 * (`/[A-Za-z0-9._-]/u`): it answers `false` for `é` and `据`, so `é<root>/x` was judged to begin a path segment and a
 * longer name was rewritten into the sandbox — the value the check declared was not the value the sandbox ran, which is
 * the whole subject of this file. `M` (combining marks) is in the class because a decomposed name is still one name.
 */
const NAME_CHARACTER = /[\p{L}\p{M}\p{N}._-]/u;

/**
 * The **code point** that ends just before `at` — not the single UTF-16 unit that happens to sit there.
 *
 * A name character outside the basic multilingual plane (`\u{10400}`, and every other character whose code point needs two
 * units) leaves its trailing surrogate at `value[at - 1]` when a root follows it. A class written over *characters* answers
 * `false` for a lone surrogate, so the occurrence was judged to begin a path segment and a longer name was rewritten — the
 * same defect the ASCII class produced, one plane further out. Measured by an independent round.
 */
function precedingCharacter(value: string, at: number): string {
  if (at === 0) return '';
  const low = value.charCodeAt(at - 1);
  if (low >= 0xdc00 && low <= 0xdfff && at >= 2) {
    const high = value.charCodeAt(at - 2);
    if (high >= 0xd800 && high <= 0xdbff) return value.slice(at - 2, at);
  }
  return value[at - 1]!;
}

function rewriteAuthorReference(value: string, authorRoot: string, sandboxRoot: string): string {
  let result = '';
  let written = 0;
  for (let at = value.indexOf(authorRoot); at !== -1; at = value.indexOf(authorRoot, at + authorRoot.length)) {
    const before = precedingCharacter(value, at);
    const after = at + authorRoot.length;
    // **Both sides read the same way**: the character before the occurrence must not continue a name, and the character
    // after it must be a separator or the end of the value. Reading the left side as the raw unit `value[at - 1]` made a
    // name character outside the basic plane (two units) look like a separator.
    const isReference = (before === '' || (before !== '/' && !NAME_CHARACTER.test(before)))
      && (after === value.length || value[after] === '/');
    result += value.slice(written, at) + (isReference ? sandboxRoot : authorRoot);
    written = after;
  }
  return written === 0 ? value : result + value.slice(written);
}

