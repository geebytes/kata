import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { uniqueCopies } from '../../src/core/layout.js';

/**
 * AC-6 — archive chooses what to remove from the worktrees holding the only copy, not from a directory named after the
 * task.
 *
 * The measured defect (reading 1, F1, blocking): `cmdArchive` selected its target with
 *
 *   const linked = join(worktreesDir(root), taskId);

 * so a worktree whose directory name differs from the task it holds was **never looked at**. Its `removeWorktreeSafely`
 * call passed the same derivation for `path` and `taskId`, which meant the guard judged the right kind of object — just
 * not this one. Reproduced on the frozen revision restored with `git archive`: the removal returned `{"removed":true}`
 * and the only copy of another task's records was gone.
 *
 * The criterion is what the archive consults: the set of worktrees the model says hold this task's only copy.
 */
const roots: string[] = [];

function repo(name: string): string {
    const root = mkdtempSync(join(tmpdir(), `kata-uc-archive-${name}-`));
    roots.push(root);
    writeFileSync(join(root, 'package.json'), '{ "name": "uc", "private": true }\n');
    return root;
}

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('archive removes by unique copy, not by name', () => {
    it('finds the worktree holding this task records even when its directory is named something else', async () => {
        const primary = repo('misnamed');
        // The task is `held`; its worktree is called `T`, which is what `worktree create --path` produces.
        const worktree = join(primary, '.kata', 'worktrees', 'T');
        mkdirSync(join(worktree, '.kata', 'tasks', 'held'), { recursive: true });
        writeFileSync(join(worktree, '.kata', 'tasks', 'held', 'judge.json'), '{}\n');

        const holding = await uniqueCopies({ root: primary, taskId: 'held' });
        // The archive must consult this, and it names the real location rather than a guess built from the task id.
        expect(holding).toHaveLength(1);
        expect(holding[0]!.worktreeRoot).toBe(worktree);
        expect(existsSync(join(worktree, '.kata', 'tasks', 'held', 'judge.json'))).toBe(true);
    });

    it('names nothing for a task whose worktree holds no record of it', async () => {
        const primary = repo('clean');
        const worktree = join(primary, '.kata', 'worktrees', 'held');
        mkdirSync(join(worktree, '.kata', 'tasks', 'held'), { recursive: true });
        mkdirSync(join(primary, '.kata', 'tasks', 'held'), { recursive: true });
        writeFileSync(join(primary, '.kata', 'tasks', 'held', 'judge.json'), '{}\n');

        expect(await uniqueCopies({ root: primary, taskId: 'held' })).toEqual([]);
    });

    it('the targets an archive may remove exclude every worktree holding this task only copy', async () => {
        // **The decision, not the command.** Driving `runCommand('archive')` cannot reach the cleanup branch — the
        // archive trust boundary refuses first — so a case written that way is green whatever the selector does. The
        // first version of this test was exactly that false negative, and the mutation is what showed it.
        const primary = repo('end-to-end');
        const taskId = 'held';
        const { archiveRemovalTargets } = await import('../../src/workflow/orchestrator.js');

        // A worktree called `T` holding the only copy of `held`'s records.
        const worktree = join(primary, '.kata', 'worktrees', 'T');
        mkdirSync(join(worktree, '.kata', 'tasks', taskId), { recursive: true });
        writeFileSync(join(worktree, '.kata', 'tasks', taskId, 'judge.json'), '{}\n');

        const targets = await archiveRemovalTargets(primary, taskId);
        // The old selector returned `.kata/worktrees/held`, which does not exist — so this list is what told the guard
        // nothing, and the removal it should have refused never happened because it was never attempted on the right path.
        expect(targets, JSON.stringify(targets)).toContain(worktree);
    });

    it('falls back to the directory named after the task when nothing is unique', async () => {
        const primary = repo('named');
        const taskId = 'held';
        const named = join(primary, '.kata', 'worktrees', taskId);
        mkdirSync(join(named, '.kata', 'tasks', taskId), { recursive: true });
        mkdirSync(join(primary, '.kata', 'tasks', taskId), { recursive: true });
        writeFileSync(join(primary, '.kata', 'tasks', taskId, 'judge.json'), '{}\n');

        const { archiveRemovalTargets } = await import('../../src/workflow/orchestrator.js');
        expect(await archiveRemovalTargets(primary, taskId)).toEqual([named]);
    });

    it('names a record unique to a worktree the task id does not predict', async () => {
        // The shape that made the old selector blind: two tasks in one worktree, only one of which is the archive's.
        const primary = repo('two-tasks');
        const worktree = join(primary, '.kata', 'worktrees', 'aaa');
        mkdirSync(join(worktree, '.kata', 'tasks', 'aaa'), { recursive: true });
        mkdirSync(join(worktree, '.kata', 'tasks', 'zzz'), { recursive: true });
        writeFileSync(join(worktree, '.kata', 'tasks', 'aaa', 'judge.json'), '{}\n');
        writeFileSync(join(worktree, '.kata', 'tasks', 'zzz', 'verdicts.json'), '{}\n');

        const forZzz = await uniqueCopies({ root: primary, taskId: 'zzz' });
        expect(forZzz.map((copy) => copy.path)).toEqual(['tasks/verdicts.json']);
        expect(forZzz[0]!.worktreeRelative).toBe(join('.kata', 'worktrees', 'aaa'));
    });
});
