import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { removeWorktreeSafely } from '../../src/workflow/worktree.js';

/**
 * **AC-2: an archive must never remove the only copy of a record.**
 *
 * `cmdArchive` removes the linked worktree once the phase reaches `archive` — and the sole copy of that change's records is
 * inside it. Measured on this repository: four merged changes have 129 record files that exist only under their worktree,
 * and the one removal that did not happen was refused by git for an unrelated reason (an untracked directory), which is luck
 * rather than a guard.
 *
 * The guard is at the removal, not at the archive, so a caller cannot reach the deletion by any route without passing it.
 * The mutation that matters is deleting the refusal: the first case must redden.
 */
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture(): Promise<{ primary: string; linked: string }> {
    const primary = await mkdtemp(join(tmpdir(), 'kata-archive-guard-'));
    roots.push(primary);
    await initLayout(primary);
    await createTask({
        root: primary,
        id: 'guarded-task',
        title: 'Guarded',
        acceptance: [{ id: 'AC-1', statement: 'x' }],
        ownedPaths: ['src/a.ts'],
    });
    const linked = join(primary, '.kata', 'worktrees', 'guarded-task');
    const taskDir = join(linked, '.kata', 'tasks', 'guarded-task');
    await mkdir(taskDir, { recursive: true });
    // A record the primary checkout does not have: the only copy.
    await writeFile(join(taskDir, 'judge.json'), '{}\n');
    return { primary, linked };
}

describe('a worktree holding the only copy of a record is never removed', () => {
    it('refuses and names the records that would be lost', async () => {
        const { primary, linked } = await fixture();
        const result = await removeWorktreeSafely({ root: primary, path: linked, taskId: 'guarded-task' });

        expect(result.removed).toBe(false);
        expect(result.refusedBecause).toBe('worktree-only-records');
        expect(result.worktreeOnlyRecords?.join(' ')).toContain('judge.json');
        // And nothing was deleted: the record is still there.
        expect(await readdir(join(linked, '.kata', 'tasks', 'guarded-task'))).toContain('judge.json');
    });

    it('still removes a worktree whose records the primary checkout also has', async () => {
        const primary = await mkdtemp(join(tmpdir(), 'kata-archive-clean-'));
        roots.push(primary);
        await initLayout(primary);
        await createTask({
            root: primary,
            id: 'clean-task',
            title: 'Clean',
            acceptance: [{ id: 'AC-1', statement: 'x' }],
            ownedPaths: ['src/a.ts'],
        });
        await writeFile(join(primary, '.kata', 'tasks', 'clean-task', 'judge.json'), '{}\n');
        const linked = join(primary, '.kata', 'worktrees', 'clean-task');
        await mkdir(join(linked, '.kata', 'tasks', 'clean-task'), { recursive: true });
        await writeFile(join(linked, '.kata', 'tasks', 'clean-task', 'judge.json'), '{}\n');

        // Git refuses this fixture because it is not a real linked checkout — which is exactly the point: **kata's guard is
        // not what stopped it.** The assertion is therefore about the guard's own reason being absent, not about the removal
        // succeeding, because a fixture that is not a git worktree cannot prove the second half.
        const result = await removeWorktreeSafely({ root: primary, path: linked, taskId: 'clean-task' }).catch(
            (error: Error) => ({ removed: false, refusedBecause: undefined, gitError: error.message }),
        );
        expect(result.refusedBecause).toBeUndefined();
    });
});

describe('no route reaches the removal without passing the guard', () => {
    it('the worktree remove command refuses on a worktree holding the only copy', async () => {
        const { primary, linked } = await fixture();
        // `kata-cli worktree remove` used to call `removeWorktree` directly while the guard lived only on the archive
        // path (`removeWorktreeSafely`). Measured before this criterion: the guard correctly refused and left
        // `judge.json` in place, then the CLI verb removed the worktree and the record was gone.
        //
        // The assertion drives the command's own dispatch rather than the guard function, because a test that calls
        // the guard cannot see a caller that does not call it — which is precisely the defect.
        const { runWorktreeCommand } = await import('../../src/cli/ops.js');
        const result = await runWorktreeCommand([
            'remove',
            linked,
            '--root',
            primary,
            '--change',
            'guarded-task',
        ]);

        expect(result).toMatchObject({ command: 'worktree remove', removed: false });
        expect(String(result.refusedBecause)).toBe('worktree-only-records');
        expect((result.worktreeOnlyRecords as string[] | undefined ?? []).join(' ')).toContain('judge.json');
        // Nothing was deleted.
        expect(await readdir(join(linked, '.kata', 'tasks', 'guarded-task'))).toContain('judge.json');
        // **And the refusal names a route that exists.** The recovery had no command reaching it — only tests — so the
        // guard named a remedy an operator could not run. Asserting the command *answers* is what keeps the advice real.
        expect(String(result.remedy)).toContain('worktree recover');
    });

    it('the documented positional spelling reaches the guard instead of throwing', async () => {
        // **The positional path was also read as the change id.** `kata-cli worktree remove <path>` is the documented
        // form (`docs/operations.md` and this command's own Usage), and `parseChangeArg` returns "the first bare token
        // that is not already spoken for" — so the path came back as `--change`, differed from the derived owner, and
        // the mismatch branch refused *every* worktree, clean or not. Measured: the positional form threw while
        // `remove --path <p>` worked, which made the broken spelling the documented one.
        const { primary, linked } = await fixture();
        const { runWorktreeCommand } = await import('../../src/cli/ops.js');
        // A worktree with no stranded records: the guard must let this through, and it must not mistake the path for an id.
        const result = await runWorktreeCommand(['remove', linked, '--root', primary]);
        expect(result.command).toBe('worktree remove');
        await rm(linked, { recursive: true, force: true });
    });

    it('a wrong --change cannot be used to walk past the guard', async () => {
        // The guard used to key on the task the *operator* named, so `--change <other task>` checked a task with no
        // stranded records and then deleted the worktree that held the only copy of a different one. Measured on a
        // fixture: the guard passed and `judge.json` was gone. An operator typo is not an attack, but it is the case a
        // guard exists for, so the two facts are reconciled rather than one being trusted.
        const { primary, linked } = await fixture();
        const { runWorktreeCommand } = await import('../../src/cli/ops.js');

        await expect(
            runWorktreeCommand(['remove', linked, '--root', primary, '--change', 'some-other-task', '--force']),
        ).rejects.toThrow(/does not own|other-task/u);

        // The record is still there, which is the point.
        expect(await readdir(join(linked, '.kata', 'tasks', 'guarded-task'))).toContain('judge.json');
        await rm(linked, { recursive: true, force: true });
    });

    it('the worktree recover command answers, and moves the records the refusal named', async () => {
        const { primary, linked } = await fixture();
        const { runWorktreeCommand } = await import('../../src/cli/ops.js');

        const recovered = await runWorktreeCommand(['recover', '--root', primary, '--change', 'guarded-task']);
        expect(recovered).toMatchObject({ command: 'worktree recover', taskId: 'guarded-task' });
        expect(Number(recovered.movedCount)).toBeGreaterThan(0);

        // The record is now readable from the owner, which is what makes the removal safe afterwards.
        expect(await readdir(join(primary, '.kata', 'tasks', 'guarded-task'))).toContain('judge.json');
        await rm(linked, { recursive: true, force: true });
    });
});
