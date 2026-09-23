import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { runFalsification } from '../../src/quality/falsifier-run.js';
import { readFalsifierReddenings } from '../../src/quality/falsifier-reddenings.js';

const cleanup: string[] = [];
afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-falsify-'));
    cleanup.push(root);
    await initLayout(root);
    await createTask({ root, id: 'f-task', title: 'f-task', ownedPaths: ['src/x.ts'], acceptance: [{ id: 'AC-1', statement: 'x' }] } as never);
    return root;
}

/** A scripted runner: the check's exit code per step, so each refusal is a case rather than a spawned process. */
function runner(exits: number[]): { run: (command: string) => Promise<number>; calls: string[] } {
    const calls: string[] = [];
    let i = 0;
    return {
        calls,
        run: async (command: string) => {
            calls.push(command);
            const code = command === 'CHECK' ? (exits[Math.min(i, exits.length - 1)] ?? 0) : 0;
            if (command === 'CHECK') i += 1;
            return code;
        },
    };
}

const base = {
    findingId: 'a-finding',
    check: 'CHECK',
    mutation: 'MUTATE',
    restore: 'RESTORE',
    revisionId: 'revision-one',
    at: '2026-09-23T02:00:00.000Z',
};


/** AC-4: the three refusals, one per step — each is a reason rather than a silent failure, and nothing is recorded unless all three steps behaved. */
describe('the falsifier run refuses at each step it cannot verify', () => {
    it('refuses when the check does not pass before any mutation', async () => {
        const root = await workspace();
        const { run, calls } = runner([1, 1, 0]);
        const result = await runFalsification({ ...base, root, taskId: 'f-task', run });
        expect(result).toMatchObject({ recorded: false, refused: 'check_not_passing' });
        // Nothing was mutated: a check that is already red says nothing about the repair.
        expect(calls).toEqual(['CHECK']);
        expect(await readFalsifierReddenings(root, 'f-task')).toEqual([]);
    });

    it('refuses when the check does not redden under the mutation', async () => {
        const root = await workspace();
        const { run, calls } = runner([0, 0, 0]);
        const result = await runFalsification({ ...base, root, taskId: 'f-task', run });
        expect(result).toMatchObject({ recorded: false, refused: 'did_not_redden' });
        // **The restore runs even when the run refuses.** Measured by using the tool on this change: an early return left the
        // defect in the working tree, so a declined falsification damaged the workspace it was inspecting.
        expect(calls).toEqual(['CHECK', 'MUTATE', 'CHECK', 'RESTORE', 'CHECK']);
        expect(await readFalsifierReddenings(root, 'f-task')).toEqual([]);
    });

    it('refuses when the restore does not bring the check back', async () => {
        const root = await workspace();
        const { run } = runner([0, 1, 1]);
        const result = await runFalsification({ ...base, root, taskId: 'f-task', run });
        expect(result).toMatchObject({ recorded: false, refused: 'restore_failed' });
        // A reddening observed on a tree that never came back cannot be attributed to the mutation alone.
        expect(await readFalsifierReddenings(root, 'f-task')).toEqual([]);
    });
});

