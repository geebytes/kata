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

/**
 * Runs a git command in the repository through the shared subprocess facility, reporting failure instead of throwing.
 *
 * `LC_ALL=C` is pinned here, and only here: git translates its messages, and anything kata decides from git's text would
 * otherwise depend on the operator's locale. The pin lives on this function rather than in `runProcessSync` because that
 * facility also serves checks, CodeGraph and Git Flow, and pinning the locale for a project's own test commands would
 * change their behaviour — a check that asserts on its own localized output is not kata's to break.
 *
 * What the pin buys, stated for what it actually is: git's stderr is interpolated into messages kata throws
 * (`createWorktree` puts it in the failure a user reads), so without the pin a translated git error sits inside an
 * English sentence.
 *
 * It is **not** what fixed the worktree classification. That defect was a regex over git's prose that git 2.43 never
 * matched — `not a valid object name|does not have any commits` against an actual `invalid reference: HEAD`, in English
 * as well as in translation — and it was fixed by asking the repository a structural question instead (`hasCommit`, an
 * exit code). The pin is a separate, smaller improvement to the message a failure carries; reading it as the fix would
 * suggest the structural change was unnecessary, which is backwards.
 */
export function runGit(root: string, args: string[]): GitCommandResult {
    const result = runProcessSync('git', args, { cwd: root, timeoutMs: 60_000, env: { ...process.env, LC_ALL: 'C' } });
    return { ok: result.ok, stdout: result.stdout, stderr: result.stderr.trim() };
}

/**
 * Whether `HEAD` resolves to a commit.
 *
 * This is the structural question behind "the repository has no commit to branch from": git answers it with an exit
 * code, so the answer does not move when git's wording or the locale does.
 */
export function hasCommit(root: string): boolean {
    return runGit(root, ['rev-parse', '--verify', 'HEAD']).ok;
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

/**
 * The paths this branch changed since it diverged from the repository's default branch.
 *
 * **What closes the committed-work gap.** `git status` reports uncommitted work only, so a change already committed *outside*
 * the declaration was invisible to the seal's undeclared-content reading — measured, and stated as a boundary rather than
 * claimed as coverage. The missing reading is "what has this branch done since it started", and that has a standard anchor:
 * the merge base with the default branch. The diff against it names every committed path, whether or not the working tree
 * is clean.
 *
 * Returns `null` when the anchor cannot be determined (no default branch, no history, not a git repository). **Not an empty
 * list**: "nothing was committed outside the declaration" and "the reading was not possible" are different facts, and a
 * caller that cannot tell them apart reports a pass it never established.
 */
export function changedPathsSinceBranchPoint(root: string, options: { since?: string } = {}): string[] | null {
    // **`since` is the narrower anchor, and the one a caller with a clock should use.** The branch point answers "everything
    // this branch did", which on a shared branch includes work another change committed before this one was opened — reading
    // that as *this* change's undeclared content would refuse a legitimate seal. A task knows when it opened, so the commit
    // log since then answers "what this change committed", which is the question.
    if (options.since !== undefined) {
        // **The anchor is validated here, because `git` silently ignores one it cannot parse.** Measured: `--since` with an
        // out-of-range or unparseable value lists every commit, so a caller passing a bad timestamp would be told there is no
        // committed work outside its declaration — the fail-open direction, over an input the helper never checked. An
        // unusable anchor is `null` (unavailable, the caller says so) rather than an empty list (a pass nobody established),
        // and a usable one is normalized to the ISO form `git` parses rather than passed through as it arrived.
        const parsed = Date.parse(options.since);
        // An anchor in the future is refused for the same measured reason: `git --since=<future>` lists every commit rather
        // than none, so "since a time that has not happened" would come back as "everything is after it".
        if (Number.isNaN(parsed) || parsed > Date.now()) return null;
        const log = runGit(root, ['log', `--since=${new Date(parsed).toISOString()}`, '--name-only', '--pretty=format:']);
        if (!log.ok) return null;
        return [...new Set(log.stdout.split('\n').map((line) => line.trim().replaceAll('\\', '/')).filter(Boolean))];
    }
    const base = mergeBaseWithDefaultBranch(root);
    if (base === null) return null;
    const result = runGit(root, ['diff', '--name-only', `${base}..HEAD`]);
    if (!result.ok) return null;
    return [...new Set(result.stdout.split('\n').map((line) => line.trim().replaceAll('\\', '/')).filter(Boolean))];
}

/** The commit this branch diverged from, or `null` when there is no default branch to compare against. */
function mergeBaseWithDefaultBranch(root: string): string | null {
    // Both conventional names, because which one exists is the repository's business and hard-coding one would silently
    // disable the reading in half of them. `origin/HEAD` is consulted first because it is the remote's own answer.
    const head = readGitValue(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    const candidates = [head, 'main', 'master'].filter((name): name is string => typeof name === 'string' && name.length > 0);
    for (const candidate of candidates) {
        const base = readGitValue(root, ['merge-base', 'HEAD', candidate]);
        if (base !== null && base.length > 0) return base;
    }
    return null;
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
