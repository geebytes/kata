import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { runLaneCommand } from '../../src/cli/lane.js';
import { createTaskRevisionIfChanged } from '../../src/workflow/revision.js';

/**
 * **The order of work, decided from content.**
 *
 * Measured three times in one day, the sharpest to the minute: a change sealed its revision at 14:24:15 UTC, its round returned an accepted
 * record, review approved — and eleven minutes later a sibling change's repair touched a path this change declares, so judge failed every
 * criterion with `stale_evidence`. 38 paths on this repository are owned by more than one change, so readiness has a shelf life, and nothing
 * in the workflow said so.
 *
 * These cases pin the decision: a lane is open when the sealed revision still hashes what the task owns, and closed when an owned path's
 * **content** has moved — reported as names, because "superseded" is a verdict and the operator's next action is to look at a file.
 */
describe('lane decides whether a step taken now will still be about this revision', () => {
    const roots: string[] = [];
    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    async function workspace(): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-lane-'));
        roots.push(root);
        await initLayout(root);
        await writeFile(join(root, 'src-a.ts'), 'export const a = 1;\n', 'utf8');
        await createTask({
            root,
            id: 'lane-task',
            title: 'L',
            ownedPaths: ['src-a.ts'],
            acceptance: [{ id: 'AC-1', statement: 'x' }],
        } as never);
        return root;
    }

    async function seal(root: string): Promise<void> {
        await createTaskRevisionIfChanged({ root, taskId: 'lane-task', ownedPaths: ['src-a.ts'], checkIds: [] } as never);
    }

    it('opens the lane when the sealed revision still hashes what the task owns', async () => {
        const root = await workspace();
        await seal(root);
        const report = await runLaneCommand('lane-task', root);
        expect(report.revisionStatus).toBe('current');
        expect(report.laneOpen).toBe(true);
        expect(report.blocking).toBeNull();
        expect(report.driftedPaths).toEqual([]);
    });

    it('closes it when an owned path moves, and names the path', async () => {
        const root = await workspace();
        await seal(root);
        // The sibling's repair: a write to a path this change declares, after the seal. This is the eleven-minute case.
        await writeFile(join(root, 'src-a.ts'), 'export const a = 2;\n', 'utf8');
        const report = await runLaneCommand('lane-task', root);
        expect(report.revisionStatus).toBe('superseded');
        expect(report.laneOpen).toBe(false);
        expect(report.driftedPaths).toEqual(['src-a.ts']);
        expect(String(report.blocking)).toContain('src-a.ts');
        expect(String(report.blocking)).toContain('Re-seal, then dispatch');
    });

    it('is a guard under --require-current, and a report without it', async () => {
        const root = await workspace();
        await seal(root);
        await writeFile(join(root, 'src-a.ts'), 'export const a = 3;\n', 'utf8');
        expect((await runLaneCommand('lane-task', root, { requireCurrent: true })).success, 'the guard form refuses').toBe(false);
        expect((await runLaneCommand('lane-task', root)).success, 'the report form still answers').toBe(true);
    });

    it('closes it when the task declares a path the revision does not carry', async () => {
        const root = await workspace();
        await seal(root);
        // A declaration correction: the revision still hashes its own paths, so only the declaration comparison can see this.
        const taskPath = join(root, '.kata/tasks/lane-task/task.json');
        const task = JSON.parse(await readFile(taskPath, 'utf8'));
        await writeFile(taskPath, `${JSON.stringify({ ...task, ownedPaths: ['src-a.ts', 'src-b.ts'] }, null, 2)}\n`, 'utf8');
        const report = await runLaneCommand('lane-task', root);
        expect(report.revisionStatus).toBe('declaration-moved');
        expect(report.laneOpen).toBe(false);
        expect(report.addedPaths).toEqual(['src-b.ts']);
    });
});
