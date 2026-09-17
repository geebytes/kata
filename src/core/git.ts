import { execFileSync } from 'node:child_process';

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
export function runGit(root: string, args: string[]): GitCommandResult {
    try {
        const stdout = execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return { ok: true, stdout, stderr: '' };
    } catch (error) {
        const failure = error as { stdout?: string; stderr?: string };
        return {
            ok: false,
            stdout: typeof failure.stdout === 'string' ? failure.stdout : '',
            stderr: typeof failure.stderr === 'string' ? failure.stderr.trim() : '',
        };
    }
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
