import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureWorkspaceHygiene, ignoredRuntimePaths, resolveWorkspaceRootForTask } from '../../src/core/layout.js';
import { runGit } from '../../src/core/git.js';
import { createWorktree, listWorktrees, removeWorktree, worktreesDir } from '../../src/workflow/worktree.js';
import { runCommand } from '../../src/workflow/orchestrator.js';

/**
 * Linked worktrees with kata's own convention.
 *
 * `isolated_worktree` was a declaration kata could not act on: every host nested worktrees wherever it liked, nothing
 * resolved `--root` on the agent's behalf, and — worse — the session pointer was not ignored, so a checkout could
 * carry an "active task" nobody activated there.
 */
describe('kata worktrees', () => {
    const roots: string[] = [];

    afterEach(async () => {
        await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });

    async function repo(): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-worktree-'));
        roots.push(root);
        execFileSync('git', ['init', '-q', '-b', 'main', '.'], { cwd: root });
        execFileSync('git', ['config', 'user.email', 'kata@example.test'], { cwd: root });
        execFileSync('git', ['config', 'user.name', 'Kata Test'], { cwd: root });
        await writeFile(join(root, '.gitignore'), '# repo\n', 'utf8');
        await writeFile(join(root, 'subject.ts'), 'export const value = 1;\n', 'utf8');
        execFileSync('git', ['add', '-A'], { cwd: root });
        execFileSync('git', ['commit', '-qm', 'initial'], { cwd: root });
        return root;
    }

    async function openTask(root: string, taskId: string): Promise<void> {
        await runCommand('open', taskId, root, {
            title: 'Worktree fixture',
            acceptance: [{ id: 'AC-1', statement: 'The task works from its worktree.' }],
        });
    }

    it('ignores the session pointer and the worktree directory', async () => {
        const root = await repo();

        const hygiene = await ensureWorkspaceHygiene(root);

        expect(hygiene.gitignoreUpdated).toBe(true);
        const gitignore = await readFile(join(root, '.gitignore'), 'utf8');
        for (const entry of ignoredRuntimePaths) expect(gitignore).toContain(entry);
        // Idempotent: a second call changes nothing.
        expect((await ensureWorkspaceHygiene(root)).gitignoreUpdated).toBe(false);
        // And git agrees — including the pointer that must never be committed.
        await mkdir(join(root, '.kata/runtime'), { recursive: true });
        await writeFile(join(root, '.kata/runtime/active-task.json'), '{}\n', 'utf8');
        const check = execFileSync('git', ['check-ignore', '.kata/runtime/active-task.json', '.kata/worktrees/'], { cwd: root, encoding: 'utf8' });
        expect(check.trim().split('\n')).toEqual(['.kata/runtime/active-task.json', '.kata/worktrees/']);
    });

    it('creates a worktree under .kata/worktrees, carrying the task state', async () => {
        const root = await repo();
        await openTask(root, 'worktree-task');
        execFileSync('git', ['add', '-A'], { cwd: root });
        execFileSync('git', ['commit', '-qm', 'task state'], { cwd: root });

        const created = await createWorktree({ root, taskId: 'worktree-task' });

        expect(created).toMatchObject({ branch: 'kata/worktree-task', base: 'main', taskId: 'worktree-task' });
        expect(relative(root, created.path)).toBe(join('.kata', 'worktrees', 'worktree-task'));
        // The checkout carries the committed state, so nothing needed copying.
        expect(created.taskStateCopied).toBe(false);
        expect(await stat(join(created.path, '.kata/tasks/worktree-task/current-state.json')).then(() => true)).toBe(true);
        // The nested worktree does not appear as untracked paths in its primary checkout. (Writing the ignore rule
        // itself is a tree change, which is why this asserts the worktree path rather than an empty status.)
        const status = execFileSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8' });
        expect(status).not.toContain('.kata/worktrees/');
        expect(status).toContain('.gitignore');
    });

    it('copies the task state when the base commit predates the task, and never the session pointer', async () => {
        const root = await repo();
        // The task is created after the commit the worktree branches from.
        await openTask(root, 'uncommitted-task');
        await mkdir(join(root, '.kata/runtime'), { recursive: true });
        await writeFile(join(root, '.kata/runtime/active-task.json'), `${JSON.stringify({ taskId: 'uncommitted-task' })}\n`, 'utf8');

        const created = await createWorktree({ root, taskId: 'uncommitted-task' });

        expect(created.taskStateCopied).toBe(true);
        expect(await stat(join(created.path, '.kata/tasks/uncommitted-task/current-state.json')).then(() => true)).toBe(true);
        // The session pointer belongs to the session that activates in the worktree, not to the one that created it.
        expect(await stat(join(created.path, '.kata/runtime/active-task.json')).then(() => true).catch(() => false)).toBe(false);
    });

    it('resolves task commands to the worktree they run in, leaving the primary checkout alone', async () => {
        const root = await repo();
        await openTask(root, 'resolve-task');
        execFileSync('git', ['add', '-A'], { cwd: root });
        execFileSync('git', ['commit', '-qm', 'task state'], { cwd: root });
        const created = await createWorktree({ root, taskId: 'resolve-task' });

        // The nearest owner wins: both checkouts own the task, and the command ran inside the worktree.
        expect(resolveWorkspaceRootForTask('resolve-task', created.path)).toBe(created.path);
        expect(resolveWorkspaceRootForTask('resolve-task', root)).toBe(root);

        await runCommand('design', 'resolve-task', created.path);

        const phaseIn = async (path: string): Promise<string> => JSON.parse(await readFile(join(path, '.kata/tasks/resolve-task/current-state.json'), 'utf8')).phase;
        expect(await phaseIn(created.path)).toBe('plan');
        expect(await phaseIn(root)).toBe('intake');
    });

    it('lists the worktrees with the tasks each one carries', async () => {
        const root = await repo();
        await openTask(root, 'listed-task');
        execFileSync('git', ['add', '-A'], { cwd: root });
        execFileSync('git', ['commit', '-qm', 'task state'], { cwd: root });
        const created = await createWorktree({ root, taskId: 'listed-task' });

        const entries = await listWorktrees(root);

        expect(entries.map((entry) => entry.path)).toEqual([root, created.path]);
        expect(entries[0]).toMatchObject({ kind: 'main', current: true, branch: 'main' });
        expect(entries[1]).toMatchObject({ kind: 'linked', current: false, branch: 'kata/listed-task', tasks: ['listed-task'] });
        expect(worktreesDir(root)).toBe(join(root, '.kata', 'worktrees'));
    });

    it('refuses to remove a worktree with uncommitted changes, and says what --force would cost', async () => {
        const root = await repo();
        await openTask(root, 'remove-task');
        execFileSync('git', ['add', '-A'], { cwd: root });
        execFileSync('git', ['commit', '-qm', 'task state'], { cwd: root });
        const created = await createWorktree({ root, taskId: 'remove-task' });
        await writeFile(join(created.path, 'subject.ts'), 'export const value = 2;\n', 'utf8');

        await expect(removeWorktree({ root, path: created.path })).rejects.toThrow(/uncommitted changes/);

        const removed = await removeWorktree({ root, path: created.path, force: true });
        expect(removed).toMatchObject({ removed: true });
        expect(removed.warning).toMatch(/that work is gone/);
        expect((await listWorktrees(root)).map((entry) => entry.path)).toEqual([root]);
    });

    /**
     * A commitless repository is not a worktree problem, and the message has to say so.
     *
     * This test is why the classification moved off git's prose. It passed against an older git whose failure read
     * `not a valid object name`; git 2.43 says `fatal: invalid reference: HEAD` (English) or `fatal: 无效引用：HEAD`
     * (this environment's locale), neither of which the regex matched — so the branch became unreachable and the remedy
     * users are promised disappeared. `docs/design/2026-09-20-worktree-no-commit-message.md` has the measurements.
     */
    async function commitlessRepo(): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-worktree-nocommit-'));
        roots.push(root);
        execFileSync('git', ['init', '-q', '-b', 'main', '.'], { cwd: root });
        execFileSync('git', ['config', 'user.email', 'kata@example.test'], { cwd: root });
        execFileSync('git', ['config', 'user.name', 'Kata Test'], { cwd: root });
        return root;
    }

    it('reports a repository with no commit to branch from', async () => {
        const root = await commitlessRepo();

        await expect(createWorktree({ root, branch: 'kata/none' })).rejects.toThrow(/no commit to branch from/);
    });

    it('names that remedy under a non-English locale too, because the answer is not read from the message git prints', async () => {
        const root = await commitlessRepo();
        const previous = process.env.LC_ALL;
        // The text git prints is translated; the classification must not notice. This is the half of the fix that
        // only a locale change can prove.
        process.env.LC_ALL = 'zh_CN.UTF-8';
        try {
            await expect(createWorktree({ root, branch: 'kata/none' })).rejects.toThrow(/no commit to branch from/);
        } finally {
            if (previous === undefined) delete process.env.LC_ALL;
            else process.env.LC_ALL = previous;
        }
    });

    it('runs git with a pinned locale, so parsed output cannot change with the operator environment', async () => {
        // Asserted on the language git actually emits, not on kata's own string: the point is that a caller's locale
        // cannot reach the output kata parses. A test that greps for Chinese text would re-introduce the dependency.
        const root = await commitlessRepo();
        const previous = process.env.LC_ALL;
        process.env.LC_ALL = 'zh_CN.UTF-8';
        try {
            const result = runGit(root, ['worktree', 'add', '-b', 'kata/locale', join(root, 'wt'), 'HEAD']);

            expect(result.ok).toBe(false);
            // The Chinese form of this message is `fatal: 无效引用：HEAD`; the pin means we never see it.
            expect(result.stderr).toMatch(/invalid reference|not a valid object/i);
            expect(result.stderr).not.toMatch(/引用/);
        } finally {
            if (previous === undefined) delete process.env.LC_ALL;
            else process.env.LC_ALL = previous;
        }
    });

    it('does not borrow the no-commit remedy for a failure that is not one', async () => {
        // A healthy repository with an unresolvable base: git fails, but nothing about this failure is "no commit".
        const root = await repo();

        await expect(createWorktree({ root, branch: 'kata/bad-base', base: 'refs/heads/does-not-exist' }))
            .rejects.toThrow(/git worktree add failed/);
        await expect(createWorktree({ root, branch: 'kata/bad-base', base: 'refs/heads/does-not-exist' }))
            .rejects.not.toThrow(/no commit to branch from/);
    });

    it('still creates the worktree in a repository that has a commit', async () => {
        // The guardrail in the other direction: a structural check that is too eager would refuse a healthy repository.
        const root = await repo();

        const created = await createWorktree({ root, branch: 'kata/healthy' });

        await expect(stat(created.path)).resolves.toBeDefined();
    });
});
