import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout, worktreeOnlyRecords } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';

/**
 * **AC-3: the detector compares the two task trees recursively.**
 *
 * The detector used to compare *top-level names*: it listed the worktree's task directory once and the primary's once, and
 * reported a name that appeared only on the left. A **directory** present in both roots therefore hid everything inside
 * it — measured on this repository, `revisions/` exists under both, so a worktree-only `revisions/rev1.json` was invisible
 * and the detector reported `[]` while a recursive diff found **252 stranded files** (mostly under `handoffs/`, which also
 * exists in both roots).
 *
 * That false negative is worse than a missing feature: the repository-level case asserted `worktreeOnlyRecords(repo) === []`
 * and passed, so the suite certified a migration as complete while 252 governed files still lived only under directories
 * `archive` deletes. A detector that cannot see the real thing is the defect it exists for, so the nested shape is what
 * this file pins — and the "reports nothing" case below keeps its meaning by making the two roots genuinely equal.
 */
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture(): Promise<{ primary: string; worktree: string }> {
    const primary = await mkdtemp(join(tmpdir(), 'kata-records-'));
    roots.push(primary);
    await initLayout(primary);
    await createTask({
        root: primary,
        id: 'records-task',
        title: 'Records',
        acceptance: [{ id: 'AC-1', statement: 'x' }],
        ownedPaths: ['src/a.ts'],
    });

    const worktree = join(primary, '.kata', 'worktrees', 'records-task');
    const taskDir = join(worktree, '.kata', 'tasks', 'records-task');
    await mkdir(taskDir, { recursive: true });
    await writeFile(join(taskDir, 'judge.json'), '{}\n');
    await writeFile(join(taskDir, 'review.json'), '{}\n');
    return { primary, worktree };
}

describe('records that exist only under a linked worktree are reported', () => {
    it('names the top-level files the primary checkout cannot see', async () => {
        const { primary } = await fixture();
        const report = await worktreeOnlyRecords(primary);

        const forTask = report.find((entry) => entry.taskId === 'records-task');
        expect(forTask, 'the task with worktree-only records must appear').toBeDefined();
        expect(forTask?.files).toContain(join('tasks', 'judge.json'));
        expect(forTask?.files).toContain(join('tasks', 'review.json'));
        expect(forTask?.worktree).toContain(join('.kata', 'worktrees', 'records-task'));
    });

    it('names a worktree-only file nested inside a directory both roots have', async () => {
        const { primary, worktree } = await fixture();
        const primaryTaskDir = join(primary, '.kata', 'tasks', 'records-task');
        const worktreeTaskDir = join(worktree, '.kata', 'tasks', 'records-task');

        // `revisions/` exists in both roots. The primary's is empty; the worktree's holds two revisions. A name-only
        // comparison sees the directory on both sides and reports nothing — the measured false negative.
        await mkdir(join(primaryTaskDir, 'revisions'), { recursive: true });
        await mkdir(join(worktreeTaskDir, 'revisions'), { recursive: true });
        await writeFile(join(worktreeTaskDir, 'revisions', 'rev1.json'), '{}\n');
        await writeFile(join(worktreeTaskDir, 'revisions', 'rev2.json'), '{}\n');

        const report = await worktreeOnlyRecords(primary);
        const forTask = report.find((entry) => entry.taskId === 'records-task');

        expect(forTask, 'a nested worktree-only file must make the task appear').toBeDefined();
        const named = (forTask?.files ?? []).join('\n');
        expect(named).toContain('rev1.json');
        expect(named).toContain('rev2.json');
    });

    it('names a worktree-only file under handoffs/, the directory that carried the stranded files', async () => {
        const { primary, worktree } = await fixture();
        const primaryTaskDir = join(primary, '.kata', 'tasks', 'records-task');
        const worktreeTaskDir = join(worktree, '.kata', 'tasks', 'records-task');

        await mkdir(join(primaryTaskDir, 'handoffs'), { recursive: true });
        await mkdir(join(worktreeTaskDir, 'handoffs'), { recursive: true });
        await writeFile(join(worktreeTaskDir, 'handoffs', 'handoff-abc.json'), '{}\n');

        const report = await worktreeOnlyRecords(primary);
        const forTask = report.find((entry) => entry.taskId === 'records-task');
        expect(forTask?.files.join('\n')).toContain('handoff-abc.json');
    });

    it('does not report a file that exists in both roots', async () => {
        const { primary, worktree } = await fixture();
        const primaryTaskDir = join(primary, '.kata', 'tasks', 'records-task');
        const worktreeTaskDir = join(worktree, '.kata', 'tasks', 'records-task');

        await mkdir(join(primaryTaskDir, 'revisions'), { recursive: true });
        await mkdir(join(worktreeTaskDir, 'revisions'), { recursive: true });
        await writeFile(join(primaryTaskDir, 'revisions', 'rev1.json'), '{}\n');
        await writeFile(join(worktreeTaskDir, 'revisions', 'rev1.json'), '{}\n');

        const report = await worktreeOnlyRecords(primary);
        const forTask = report.find((entry) => entry.taskId === 'records-task');
        // `judge.json` and `review.json` are still worktree-only; `revisions/rev1.json` is not and must not be named.
        expect(forTask?.files.join('\n')).not.toContain('rev1.json');
    });

    it('reports nothing when the two roots agree', async () => {
        const primary = await mkdtemp(join(tmpdir(), 'kata-records-clean-'));
        roots.push(primary);
        await initLayout(primary);
        await createTask({
            root: primary,
            id: 'clean-task',
            title: 'Clean',
            acceptance: [{ id: 'AC-1', statement: 'x' }],
            ownedPaths: ['src/a.ts'],
        });
        // A worktree that holds no task records at all: the two roots genuinely agree, which is what makes "nothing" a
        // meaningful answer here rather than a restatement of the bug.
        await mkdir(join(primary, '.kata', 'worktrees', 'clean-task'), { recursive: true });
        expect(await worktreeOnlyRecords(primary)).toEqual([]);
    });

    it('reports evidence that exists only under the worktree, which is a second store', async () => {
        // **The detector looked at one directory.** `.kata/evidence/` is flat and keys its files by `<taskId>-`, so an
        // enumeration written as `.kata/tasks/<worktree name>` could not see it at all: measured on this repository,
        // 1053 evidence files lived only under worktrees while the report said `[]` and the removal guard therefore let
        // `archive` delete the only copy. A surface derived per-owner must be enumerated per-owner.
        const primary = await mkdtemp(join(tmpdir(), 'kata-evidence-only-'));
        roots.push(primary);
        await initLayout(primary);
        await createTask({
            root: primary,
            id: 'evidence-task',
            title: 'Evidence',
            acceptance: [{ id: 'AC-1', statement: 'x' }],
            ownedPaths: ['src/a.ts'],
        });
        const worktree = join(primary, '.kata', 'worktrees', 'evidence-task');
        await mkdir(join(worktree, '.kata', 'tasks', 'evidence-task'), { recursive: true });
        await mkdir(join(worktree, '.kata', 'evidence'), { recursive: true });
        await writeFile(join(worktree, '.kata', 'evidence', 'evidence-task-AC-1-E1.json'), '{}\n');
        // A second task's evidence lives there too, and must not be attributed to this worktree.
        await writeFile(join(worktree, '.kata', 'evidence', 'other-task-AC-1-E1.json'), '{}\n');

        const report = await worktreeOnlyRecords(primary);
        const forTask = report.find((entry) => entry.taskId === 'evidence-task');
        expect(forTask?.files).toContain(join('evidence', 'evidence-task-AC-1-E1.json'));
        expect(forTask?.files).not.toContain(join('evidence', 'other-task-AC-1-E1.json'));
    });

    it('finds a worktree whose directory name is not the task id', async () => {
        // `worktree create --path <somewhere-else>` and a hand-made `git worktree add` both produce this shape. The
        // detector used to read `worktrees/<dirname>/.kata/tasks/<dirname>`, so such a worktree reported `[]` while
        // holding the only copy of a record — and the guard it feeds then let the removal through.
        const primary = await mkdtemp(join(tmpdir(), 'kata-custom-path-'));
        roots.push(primary);
        await initLayout(primary);
        await createTask({
            root: primary,
            id: 'victim',
            title: 'Victim',
            acceptance: [{ id: 'AC-1', statement: 'x' }],
            ownedPaths: ['src/a.ts'],
        });
        // The directory carries no task id at all.
        const worktreeTaskDir = join(primary, '.kata', 'worktrees', 'custom-name', '.kata', 'tasks', 'victim');
        await mkdir(worktreeTaskDir, { recursive: true });
        await writeFile(join(worktreeTaskDir, 'judge.json'), '{}\n');

        const report = await worktreeOnlyRecords(primary);
        const forTask = report.find((entry) => entry.taskId === 'victim');
        expect(forTask, 'a worktree holding a task record must be reported, whatever its directory is called').toBeDefined();
        expect(forTask?.files).toContain(join('tasks', 'judge.json'));
    });
});
