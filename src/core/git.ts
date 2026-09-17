import { runProcessSync } from '../process/run.js';

/**
 * The one place kata reads the repository.
 *
 * Four modules used to run git their own way — with `-C <root>` or `cwd: root`, throwing or returning null on failure
 * — so "read the repository state" had no owner and the lifecycle's most depended-on facts (branch, head, changed
 * paths) were re-derived wherever they were needed. Everything below is a read; nothing here mutates the repository.
 */

export interface GitCommandResult {
    ok: boolean;
    stdout: string;
    stderr: string;
}

/** Runs a git command in the repository, reporting failure instead of throwing. */
/** Runs a git command in the repository through the shared subprocess facility, reporting failure instead of throwing. */
export function runGit(root: string, args: string[]): GitCommandResult {
    const result = runProcessSync('git', args, { cwd: root, timeoutMs: 60_000 });
    return { ok: result.ok, stdout: result.stdout, stderr: result.stderr.trim() };
}

/** A single-value read, or `null` when git cannot answer (not a repository, missing ref, and so on). */
export function readGitValue(root: string, args: string[]): string | null {
    const result = runGit(root, args);
    const value = result.stdout.trim();
    return result.ok && value ? value : null;
}

export function currentGitBranch(root: string): string | null {
    return readGitValue(root, ['branch', '--show-current']);
}

export function currentGitHead(root: string): string | null {
    return readGitValue(root, ['rev-parse', 'HEAD']);
}

/** True when the path is inside a git work tree. */
export function isGitRepository(root: string): boolean {
    return readGitValue(root, ['rev-parse', '--is-inside-work-tree']) === 'true';
}

/**
 * The repository-relative paths git reports as changed, including untracked files, from `git status --porcelain=v1 -z`.
 * Renames contribute both names, because both are paths the change touched.
 */
export function changedGitPaths(root: string): string[] {
    const result = runGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    if (!result.ok) return [];

    const tokens = result.stdout.split('\0').filter(Boolean);
    const paths: string[] = [];
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index] ?? '';
        // The two-character status is followed by a space and the path. A rename or copy reports its source path in the
        // next token, and both names are paths the change touched.
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

export interface GitWorktree {
    path: string;
    head: string | null;
    branch: string | null;
    /** `main` for the primary work tree, `linked` for one created by `git worktree add`, `bare`, `prunable`. */
    kind: 'main' | 'linked' | 'bare' | 'prunable' | 'unknown';
    detached: boolean;
}

/** The worktrees git knows about, primary first. */
export function gitWorktreeList(root: string): GitWorktree[] {
    const result = runProcessSync('git', ['worktree', 'list', '--porcelain'], { cwd: root, timeoutMs: 30_000 });
    if (!result.ok) return [];

    const worktrees: GitWorktree[] = [];
    let current: Partial<GitWorktree> & { bare?: boolean; prunable?: boolean } = {};
    const flush = (): void => {
        if (current.path) {
            worktrees.push({
                path: current.path,
                head: current.head ?? null,
                branch: current.branch ?? null,
                kind: current.bare ? 'bare' : current.prunable ? 'prunable' : worktrees.length === 0 ? 'main' : 'linked',
                detached: current.detached === true,
            });
        }
        current = {};
    };

    for (const line of result.stdout.split(/\r?\n/)) {
        if (!line.trim()) { flush(); continue; }
        const [key, ...rest] = line.split(' ');
        const value = rest.join(' ');
        if (key === 'worktree') { flush(); current.path = value; }
        else if (key === 'HEAD') current.head = value;
        else if (key === 'branch') current.branch = value.replace(/^refs\/heads\//, '');
        else if (key === 'detached') current.detached = true;
        else if (key === 'bare') current.bare = true;
        else if (key === 'prunable') current.prunable = true;
    }
    flush();
    return worktrees;
}

/** Creates a linked worktree. Returns git's own failure rather than throwing. */
export function gitWorktreeAdd(root: string, path: string, branch: string, options: { base?: string; createBranch?: boolean } = {}): GitCommandResult {
    const args = options.createBranch === false
        ? ['worktree', 'add', path, branch]
        : ['worktree', 'add', '-b', branch, path, options.base ?? 'HEAD'];
    return runGit(root, args);
}

/** Removes a linked worktree. Git refuses on uncommitted changes unless `force` is set. */
export function gitWorktreeRemove(root: string, path: string, options: { force?: boolean } = {}): GitCommandResult {
    return runGit(root, ['worktree', 'remove', ...(options.force ? ['--force'] : []), path]);
}

export function gitCurrentBranchOf(root: string): string | null {
    return readGitValue(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
}
