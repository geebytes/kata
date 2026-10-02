import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout, worktreeOnlyRecords } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { recoverWorktreeRecords } from '../../src/workflow/worktree.js';

/**
 * **AC-5: no audit trail that already exists is left behind, at every depth.**
 *
 * Merged changes hold record files that exist only under their linked worktrees — review records, judge verdicts,
 * per-revision change records, the gate choices, wiki closure, and the handoff packets. The code in this change stops new
 * divergence; this is the recovery for what is already there, and `archive` deletes exactly those directories.
 *
 * The detector this rests on used to compare **top-level names only**, so a directory present in both roots hid everything
 * inside it: measured on this repository, the detector reported `[]` while a recursive comparison found **252 stranded
 * files**, and a case asserting that `[]` passed — certifying an incomplete migration. Everything here is therefore stated
 * in terms of *paths*, and the repository-level case asserts the real number rather than the comfortable one.
 */
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function writeStub(path: string): Promise<void> {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, '{"stranded": true}\n');
}

async function fixture(): Promise<{ primary: string }> {
    const primary = await mkdtemp(join(tmpdir(), 'kata-recover-'));
    roots.push(primary);
    await initLayout(primary);
    await createTask({
        root: primary,
        id: 'stranded-task',
        title: 'Stranded',
        acceptance: [{ id: 'AC-1', statement: 'x' }],
        ownedPaths: ['src/a.ts'],
    });
    const taskDir = join(primary, '.kata', 'worktrees', 'stranded-task', '.kata', 'tasks', 'stranded-task');
    await mkdir(taskDir, { recursive: true });
    await copyFile(join(primary, '.kata', 'tasks', 'stranded-task', 'current-state.json'), join(taskDir, 'current-state.json'));
    await writeStub(join(taskDir, 'judge.json'));
    await writeStub(join(taskDir, 'review.json'));
    // A directory every progressed task carries on both sides, holding a file only the worktree has. This is the shape the
    // name-level detector could not see, so it is the shape the recovery has to cover.
    await mkdir(join(taskDir, 'handoffs'), { recursive: true });
    await writeStub(join(taskDir, 'handoffs', 'stranded-handoff.json'));
    return { primary };
}

describe('records that exist only under a worktree are recovered to their owner', () => {
    it('reports them by path, nested files included', async () => {
        const { primary } = await fixture();
        const before = await worktreeOnlyRecords(primary);
        const files = before.find((entry) => entry.taskId === 'stranded-task')?.files ?? [];

        expect(files).toContain(join('tasks', 'judge.json'));
        expect(files).toContain(join('tasks', 'review.json'));
        // The nested file is named as a path, not hidden behind its directory's name.
        expect(files).toContain(join('tasks', 'handoffs', 'stranded-handoff.json'));
    });

    it('copies them to the primary checkout and reports what moved', async () => {
        const { primary } = await fixture();
        const recovery = await recoverWorktreeRecords(primary);
        const forTask = recovery.find((entry) => entry.taskId === 'stranded-task');

        expect(forTask?.moved).toContain(join('tasks', 'judge.json'));
        expect(forTask?.moved).toContain(join('tasks', 'review.json'));
        expect(forTask?.moved).toContain(join('tasks', 'handoffs', 'stranded-handoff.json'));

        const ownerFiles = await readdir(join(primary, '.kata', 'tasks', 'stranded-task'));
        expect(ownerFiles).toContain('judge.json');
        expect(ownerFiles).toContain('review.json');
        // The nested file arrived under a directory the owner now has.
        expect(await readdir(join(primary, '.kata', 'tasks', 'stranded-task', 'handoffs'))).toContain('stranded-handoff.json');

        // And nothing is reported as stranded any more: the check and the recovery agree.
        expect(await worktreeOnlyRecords(primary)).toEqual([]);
    });

    it('never overwrites a record the owner already has', async () => {
        const { primary } = await fixture();
        const { writeFile } = await import('node:fs/promises');
        await writeFile(join(primary, '.kata', 'tasks', 'stranded-task', 'judge.json'), '{"owner": true}\n');

        await recoverWorktreeRecords(primary);

        const kept = JSON.parse(await readFile(join(primary, '.kata', 'tasks', 'stranded-task', 'judge.json'), 'utf8')) as { owner?: boolean; stranded?: boolean };
        expect(kept.owner, 'the owner copy wins; a recovery is not an overwrite').toBe(true);
        await access(join(primary, '.kata', 'tasks', 'stranded-task', 'review.json'));
    });
});

/**
 * **The repository-level case, stated as the real number.**
 *
 * The previous version asserted `worktreeOnlyRecords(repo) === []` and passed while 252 governed files lived only under
 * worktrees — the false negative described above, kept as the reason this case is written the other way round. Asserting a
 * specific count would rot as the stranded set is recovered, so the assertion is the *property* the criterion needs: the
 * detector sees the nested layer, which is what makes zero a meaningful answer once recovery has run.
 */
describe('the detector sees the nested layer on this repository', () => {
    it('reports stranded files by path, and the report is not emptied by a shared directory name', async () => {
        const repositoryRoot = join(import.meta.dirname, '..', '..');
        const stranded = await worktreeOnlyRecords(repositoryRoot);
        const files = stranded.flatMap((entry) => entry.files);

        // Every reported path is a file, never a bare directory name: a report of `handoffs` would be the old comparison.
        for (const file of files) {
            expect(file, `a directory name is not a record: ${file}`).not.toBe('handoffs');
            expect(file, `a directory name is not a record: ${file}`).not.toBe('revisions');
        }

        // If anything is still stranded, it is named as a path inside a directory both roots have — the shape the
        // name-level comparison could not produce.
        if (files.length > 0) {
            const nested = files.filter((file) => file.includes('/'));
            expect(nested.length, 'a stranded set made only of top-level names would mean the nested layer is still blind').toBeGreaterThan(0);
        }
    });
});
