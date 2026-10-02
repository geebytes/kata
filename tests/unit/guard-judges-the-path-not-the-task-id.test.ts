import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { removeWorktreeSafely } from '../../src/workflow/worktree.js';

/**
 * AC-2 — the guard judges the path being removed, not a task id the caller supplied.
 *
 * The measured defect (reading 2, blocking): the guard asked
 * `report.find((entry) => entry.taskId === input.taskId)`. A worktree called `T` that held the records of `U` produced a
 * report entry for `U`; asking about `T` found nothing, the guard passed, and `archive` removed the worktree — deleting
 * `U`'s only copy — while returning `{"removed":true}`.
 *
 * The caller's task id is a claim about the worktree, and the guard exists precisely because that claim may be wrong.
 * This criterion therefore drives the guard by *path* and never supplies a matching id.
 */
const roots: string[] = [];

function repo(name: string): string {
    const root = mkdtempSync(join(tmpdir(), `kata-guard-path-${name}-`));
    roots.push(root);
    writeFileSync(join(root, 'package.json'), '{ "name": "guarded", "private": true }\n');
    execFileSync('git', ['init', '-q'], { cwd: root });
    writeFileSync(join(root, '.gitignore'), '.kata/\n');
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: root });
    return root;
}

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('the removal guard judges the path', () => {
    it('refuses a worktree whose directory name is not the task that holds the only copy', async () => {
        const primary = repo('misnamed');
        // The worktree is called `T`; it holds the records of `U`. `worktree create --path` produces this shape.
        const worktree = join(primary, '.kata', 'worktrees', 'T');
        mkdirSync(join(worktree, '.kata', 'tasks', 'U'), { recursive: true });
        writeFileSync(join(worktree, '.kata', 'tasks', 'U', 'verdicts.json'), '{}\n');

        const verdict = await removeWorktreeSafely({ root: primary, path: worktree, taskId: 'T', force: true });

        expect(verdict.removed, 'the guard must not let this through just because the ids differ').toBe(false);
        expect(verdict.refusedBecause).toBe('worktree-only-records');
        expect(verdict.worktreeOnlyRecords).toContain('tasks/verdicts.json');
        expect(existsSync(join(worktree, '.kata', 'tasks', 'U', 'verdicts.json')), 'the only copy survives').toBe(true);
    });

    it('refuses a worktree whose records the caller did not name', async () => {
        // The caller says nothing at all, which is the documented `worktree remove <path>` shape.
        const primary = repo('unnamed');
        const worktree = join(primary, '.kata', 'worktrees', 'a-worktree');
        mkdirSync(join(worktree, '.kata', 'tasks', 'holder'), { recursive: true });
        writeFileSync(join(worktree, '.kata', 'tasks', 'holder', 'judge.json'), '{}\n');

        const verdict = await removeWorktreeSafely({ root: primary, path: worktree, taskId: primary, force: true });

        expect(verdict.removed).toBe(false);
        expect(verdict.worktreeOnlyRecords).toContain('tasks/judge.json');
    });

    it('does not refuse a worktree the owner has already got the records of', async () => {
        // The other direction: a guard that refuses everything is not a guard, it is a wall. `removed: true` is only
        // reachable through a real git worktree, so this case asserts what the guard decided rather than git's answer:
        // no refusal, and the removals it did not block on record grounds.
        const primary = repo('clean');
        const worktree = join(primary, '.kata', 'worktrees', 'clean');
        mkdirSync(join(worktree, '.kata', 'tasks', 'clean'), { recursive: true });
        writeFileSync(join(worktree, '.kata', 'tasks', 'clean', 'judge.json'), '{}\n');
        // The owner has the same record, so nothing is worktree-only.
        mkdirSync(join(primary, '.kata', 'tasks', 'clean'), { recursive: true });
        writeFileSync(join(primary, '.kata', 'tasks', 'clean', 'judge.json'), '{}\n');

        const verdict: { refusedBecause?: string } = (await removeWorktreeSafely({
            root: primary,
            path: worktree,
            taskId: primary,
            force: true,
        }).catch((error: unknown) => ({ blockedByGit: String(error), refusedBecause: undefined }))) as {
            refusedBecause?: string;
        };
        expect(verdict.refusedBecause, JSON.stringify(verdict)).toBeUndefined();
        expect(existsSync(join(worktree, '.kata', 'tasks', 'clean', 'judge.json'))).toBe(true);
    });
});
