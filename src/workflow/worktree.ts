import { cp, mkdir, readdir, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { ensureRuntimeGitignore, taskDir, tasksDir } from '../core/layout.js';
import { gitCurrentBranchOf, gitWorktreeAdd, gitWorktreeList, gitWorktreeRemove, runGit, type GitWorktree } from '../core/git.js';
import { assertValidTaskId } from '../core/ids.js';

/**
 * Linked worktrees, owned by kata.
 *
 * Kata declared `isolated_worktree` and then left the creation convention to each host — `.claude/worktrees/`,
 * `.codex/…`, a sibling directory — so nothing could resolve `--root` on the agent's behalf and nested layouts were
 * ambiguous. This module makes the convention kata's: linked worktrees live under `.kata/worktrees/`, which is ignored
 * by git and by repository identity, so a nested worktree never shows up as untracked paths in its primary checkout.
 *
 * What a created worktree gets, so an agent can start working in it immediately:
 *   - kata's workspace hygiene (the `.kata/runtime/` and `.kata/worktrees/` ignore rules);
 *   - the task's own state, copied in when it is not already present (the state is tracked, so a branch whose commit
 *     predates the task would otherwise check out an empty workspace) — **without** the runtime pointer, which is
 *     per-session and must be activated in the worktree itself.
 */

export const worktreesDirName = join('.kata', 'worktrees');

/** Where kata puts linked worktrees for a repository. */
export function worktreesDir(root: string): string {
    return join(root, worktreesDirName);
}

export interface WorktreeEntry extends GitWorktree {
    /** The kata tasks whose state is present in that worktree. */
    tasks: string[];
    /** True for the worktree the command resolved as the workspace root. */
    current: boolean;
}

export async function listWorktrees(root: string): Promise<WorktreeEntry[]> {
    const current = resolve(root);
    const entries = await Promise.all(gitWorktreeList(root).map(async (worktree) => ({
        ...worktree,
        tasks: await tasksInWorktree(worktree.path),
        current: resolve(worktree.path) === current,
    })));
    return entries;
}

async function tasksInWorktree(path: string): Promise<string[]> {
    try {
        const entries = await readdir(tasksDir(path));
        const withState = await Promise.all(entries
            .filter((entry) => !entry.startsWith('.'))
            .map(async (entry) => (await stat(join(tasksDir(path), entry, 'current-state.json')).then(() => true).catch(() => false))
                ? entry
                : null));
        return withState.filter((entry): entry is string => entry !== null).sort();
    } catch {
        return [];
    }
}

export interface CreateWorktreeResult {
    path: string;
    branch: string;
    base: string;
    taskId?: string;
    /** True when the task's state was copied in because the checkout did not carry it. */
    taskStateCopied: boolean;
    gitignoreUpdated: boolean;
    /** How the agent continues: the task-addressed command works from inside the worktree now. */
    rootResolution: string;
}

export async function createWorktree(input: {
    root: string;
    branch?: string;
    path?: string;
    base?: string;
    taskId?: string;
    force?: boolean;
}): Promise<CreateWorktreeResult> {
    const root = input.root;
    if (input.taskId) assertValidTaskId(input.taskId);

    const branch = input.branch ?? (input.taskId ? `kata/${input.taskId}` : undefined);
    if (!branch) throw new Error('worktree create requires --branch, or a --change whose name forms the branch');
    const base = input.base ?? (gitCurrentBranchOf(root) ?? 'HEAD');
    const target = input.path
        ? resolve(root, input.path)
        : join(worktreesDir(root), input.taskId ?? branch.replaceAll('/', '-'));

    // A nested worktree must be ignored before it exists, or git reports its contents as untracked paths in the
    // primary checkout for as long as it lives there.
    await mkdir(worktreesDir(root), { recursive: true });
    const primaryHygiene = await ensureRuntimeGitignore(root);
    await mkdir(join(target, '..'), { recursive: true });

    const created = gitWorktreeAdd(root, target, branch, input.base ? { base: input.base } : { base });
    if (!created.ok) {
        const detail = created.stderr.trim() || created.stdout.trim() || 'unknown error';
        // A repository with no commit has no base to branch from; that is worth saying plainly, because the remedy is
        // one commit rather than anything about worktrees.
        if (/not a valid object name|does not have any commits/i.test(detail)) {
            throw new Error(`git worktree add failed: ${detail}. The repository has no commit to branch from — make an initial commit first.`);
        }
        throw new Error(`git worktree add failed: ${detail}`);
    }

    const hygiene = await ensureRuntimeGitignore(target);
    let taskStateCopied = false;
    if (input.taskId) {
        const present = await stat(join(target, '.kata', 'tasks', input.taskId, 'current-state.json')).then(() => true).catch(() => false);
        if (!present) {
            // The state is tracked, so this mirrors what a commit of the task's state would have checked out — and it
            // deliberately leaves `.kata/runtime/` behind: the active-task pointer belongs to the session that activates
            // in this worktree, not to the one that created it.
            await mkdir(join(target, '.kata', 'tasks'), { recursive: true });
            await cp(taskDir(root, input.taskId), taskDir(target, input.taskId), { recursive: true });
            taskStateCopied = true;
        }
    }

    return {
        path: target,
        branch,
        base,
        ...(input.taskId ? { taskId: input.taskId } : {}),
        taskStateCopied,
        gitignoreUpdated: primaryHygiene || hygiene,
        rootResolution: `Task-addressed commands run from ${relative(root, target) || target} resolve that worktree as the workspace root; pass --root to address another checkout explicitly.`,
    };
}

export interface RemoveWorktreeResult {
    path: string;
    removed: boolean;
    warning?: string;
}

export async function removeWorktree(input: { root: string; path: string; force?: boolean }): Promise<RemoveWorktreeResult> {
    const target = resolve(input.root, input.path);

    // Refuse to remove the checkout the command is running in, or the primary one: git would either fail confusingly or
    // delete work out from under the caller.
    const status = runGit(target, ['status', '--porcelain=v1', '--untracked-files=all']);
    const dirty = status.ok && status.stdout.trim().length > 0;
    const removed = gitWorktreeRemove(input.root, target, input.force ? { force: true } : {});
    if (!removed.ok) {
        const detail = removed.stderr.trim() || removed.stdout.trim();
        throw new Error(dirty && !input.force
            ? `The worktree has uncommitted changes, so git refused to remove it: ${detail}. Commit or discard them, or pass --force.`
            : `git worktree remove failed: ${detail || 'unknown error'}`);
    }

    // A linked worktree's administration entry can survive a removal git performed with --force.
    runGit(input.root, ['worktree', 'prune']);
    return {
        path: target,
        removed: true,
        ...(dirty ? { warning: 'Removed with --force while the worktree had uncommitted changes; that work is gone.' } : {}),
    };
}
