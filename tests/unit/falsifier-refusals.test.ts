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
        const taskId = 'f-task';
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


/**
 * A reddening must not erase an absence, and it did.
 *
 * `recordFalsifierReddening` wrote `{ reddenings, updatedAt }` and nothing else, so recording a reddening **silently erased every
 * recorded absence** — and the command reported what it recorded, not what it removed. Measured on `closure-gate`: `cg5-f1`'s
 * absence was accepted at 16:34 and gone when the ledger was read after `cg5-f2`'s reddening was recorded; the seal then refused
 * `cg5-f1` for having no disposition, which was true.
 *
 * The asymmetry was the tell: `recordFalsifierAbsence` preserved `reddenings` and this one did not preserve `absences`. Two
 * shapes in one ledger, and only one writer knew about both.
 */
describe('the two shapes in one ledger do not erase each other', () => {
    it('keeps a recorded absence when a reddening is recorded afterwards', async () => {
        const root = await workspace();
        const taskId = 'f-task';
        const { recordFalsifierAbsence, recordFalsifierReddening, readFalsifierReddenings, readFalsifierAbsences } =
            await import('../../src/quality/falsifier-reddenings.js');

        await recordFalsifierAbsence(root, taskId, {
            findingId: 'prose-fix', reason: 'the repair is to a document, so no check can redden',
            revisionId: 'revision-1', recordedAt: '2026-09-23T00:00:00.000Z',
        });
        await recordFalsifierReddening(root, taskId, {
            findingId: 'code-fix', check: 'npx vitest run x', mutation: 'm', revisionId: 'revision-1',
            reddenedAt: '2026-09-23T00:01:00.000Z', observed: { before: 0, mutated: 1, after: 0 },
        });

        expect((await readFalsifierReddenings(root, taskId)).map((r) => r.findingId)).toEqual(['code-fix']);
        // Before the fix this was empty, and the seal's refusal named the finding for having no disposition.
        expect((await readFalsifierAbsences(root, taskId)).map((a) => a.findingId)).toEqual(['prose-fix']);
    });
});
