import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { batchSaving, closeRepairBatch, openBatch, openRepairBatch, readBatches } from '../../src/quality/repair-batch.js';

/**
 * Repair batches (C1), and the invariant they may not trade away.
 *
 * The measurement the mechanism exists for: three of six fix→seal→pass cycles in one day existed only because findings
 * were repaired one at a time — each repair produced a revision, and each revision invalidated both nodes' passes.
 */
describe('a repair batch', () => {
    const roots: string[] = [];
    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    async function workspace(): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-batch-'));
        roots.push(root);
        await initLayout(root);
        await createTask({ root, id: 'b-task', title: 'B', acceptance: [{ id: 'AC-1', statement: 'x' }] });
        return root;
    }

    const finding = (id: string, severity = 'minor'): { id: string; severity: string; source: 'review'; message: string } => ({
        id,
        severity,
        source: 'review',
        message: `finding ${id}`,
    });

    it('extends the open batch rather than opening a second, which is the whole saving', async () => {
        const root = await workspace();
        await openRepairBatch(root, 'b-task', [finding('f-1')]);
        await openRepairBatch(root, 'b-task', [finding('f-2'), finding('f-1')]);

        const batches = await readBatches(root, 'b-task');
        // One batch, two findings — not two batches, which is what a revision per finding would have produced.
        expect(batches).toHaveLength(1);
        expect(batches[0]!.findings.map((entry) => entry.id)).toEqual(['f-1', 'f-2']);
    });

    it('refuses to close while a terminal finding it opened for is unaccounted', async () => {
        const root = await workspace();
        await openRepairBatch(root, 'b-task', [finding('blocker', 'major'), finding('minor-1')]);

        const refused = await closeRepairBatch(root, 'b-task', { answered: ['minor-1'] });
        expect(refused).toMatchObject({ refused: true, reason: 'open_terminal_findings' });
        // The refusal names the finding that would otherwise have become invisible.
        expect((refused as { findings: Array<{ id: string }> }).findings.map((entry) => entry.id)).toEqual(['blocker']);
        expect(await openBatch(root, 'b-task')).not.toBeNull();
    });

    it('closes when every terminal finding is repaired, deferred with a reason, or no longer reported', async () => {
        const root = await workspace();
        await openRepairBatch(root, 'b-task', [finding('major-1', 'major'), finding('minor-1')]);

        // Deferred with a reason is accounting for it; so is "a re-run no longer reports it".
        const closed = await closeRepairBatch(root, 'b-task', {
            revisionId: 'revision-1',
            deferred: [{ id: 'major-1', reason: 'fixed by the same change, not worth a separate round' }],
            stillOpen: [],
            answered: ['minor-1'],
        });
        expect(closed).toMatchObject({ id: 'batch-1', closedByRevisionId: 'revision-1', answered: ['minor-1'] });
        expect(await openBatch(root, 'b-task')).toBeNull();
    });

    it('counts what the batching saved, from the record rather than from an estimate', async () => {
        const root = await workspace();
        await openRepairBatch(root, 'b-task', [finding('f-1'), finding('f-2'), finding('f-3')]);
        await closeRepairBatch(root, 'b-task', { answered: ['f-1', 'f-2', 'f-3'] });

        // Three findings in one batch: a per-finding repair would have sealed three times, this sealed once.
        expect(await batchSaving(root, 'b-task')).toMatchObject({ batches: 1, closed: 1, findingsBatched: 3, sealsAvoided: 2 });
    });

    it('a malformed batch file is an error, not "no batches"', async () => {
        const root = await workspace();
        const { writeFile } = await import('node:fs/promises');
        await writeFile(join(root, '.kata/tasks/b-task/repair-batch.json'), JSON.stringify({ batches: [{ id: 'x' }] }), 'utf8');
        await expect(readBatches(root, 'b-task')).rejects.toThrow();
    });
});
