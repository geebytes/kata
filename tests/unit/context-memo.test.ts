import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { createContextPacket, acknowledgeContextPacket, partitionReads } from '../../src/workflow/context-fabric.js';

/**
 * L1-03: a role must not be asked to re-read content it has already acknowledged at this hash.
 *
 * The memo is content-addressed rather than path-addressed, which is the property that makes it safe: editing a file
 * between two handoffs puts it back in `requiredReads`, even though the path is the same. An absent memo is the
 * conservative answer — every read required — which is the behaviour that existed before this phase.
 */
describe('the context memo', () => {
    const roots: string[] = [];
    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    /** A task root, because `partitionReads` reads the receipts `acknowledgeContextPacket` writes. */
    async function taskRoot(id: string): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-memo-'));
        roots.push(root);
        await initLayout(root);
        await createTask({ root, id, title: 'Context memo', acceptance: [{ id: 'AC-1', statement: 'A memo is content-addressed.' }] });
        return root;
    }

    /** Writes the reads a packet lists, so the partition has real content to hash. */
    async function seedReads(root: string, files: Record<string, string>): Promise<void> {
        for (const [path, content] of Object.entries(files)) {
            const absolute = join(root, path);
            await mkdir(join(absolute, '..'), { recursive: true });
            await writeFile(absolute, content, 'utf8');
        }
    }

    it('requires every read when nothing has been acknowledged', async () => {
        const root = await taskRoot('memo-task');
        await seedReads(root, { 'AGENTS.md': 'a', 'docs/x.md': 'b' });

        const partition = await partitionReads({ root, taskId: 'memo-task', role: 'reviewer', paths: ['AGENTS.md', 'docs/x.md'] });

        expect(partition.requiredReads).toEqual(['AGENTS.md', 'docs/x.md']);
        expect(partition.continuedReads).toEqual([]);
        expect(Object.keys(partition.hashes)).toEqual(['AGENTS.md', 'docs/x.md']);
    });

    it('continues an unchanged read and requires a changed one', async () => {
        const root = await taskRoot('memo-task');
        // Two reads the packet really lists: `AGENTS.md` and the task record. `partitionReads` is asked about the same
        // paths the packet carried, so the continuation is about the memo rather than about a path that was never read.
        const paths = ['AGENTS.md', '.kata/tasks/memo-task/task.json'];
        const packet = await createContextPacket({ root, taskId: 'memo-task', fromRole: 'implementer', toRole: 'reviewer' });
        // The acknowledgement is what writes the memo — through the real command path, not by hand.
        await acknowledgeContextPacket({ root, taskId: 'memo-task', id: packet.id, platform: 'pi', role: 'reviewer' });

        const before = await partitionReads({ root, taskId: 'memo-task', role: 'reviewer', paths });
        // The task record is continued; `AGENTS.md` is not, because acknowledging the packet rewrote it (kata owns the
        // shared contract and re-stamps its STRATA block on install), so the memo holds the post-write hash rather than
        // the one this test wrote by hand.
        expect(before.continuedReads).toEqual(['.kata/tasks/memo-task/task.json']);

        await writeFile(join(root, 'AGENTS.md'), 'changed', 'utf8');
        const after = await partitionReads({ root, taskId: 'memo-task', role: 'reviewer', paths });

        // Path-addressed would have continued both; content-addressed requires the edited one.
        expect(after.requiredReads).toEqual(['AGENTS.md']);
        expect(after.continuedReads).toEqual(['.kata/tasks/memo-task/task.json']);
    });

    it('keeps a read that does not exist as required', async () => {
        const root = await taskRoot('memo-task');

        const partition = await partitionReads({ root, taskId: 'memo-task', role: 'reviewer', paths: ['.llmwiki/SCHEMA.md'] });

        // A missing read is not "already read": the receiver has to learn it is missing.
        expect(partition.requiredReads).toEqual(['.llmwiki/SCHEMA.md']);
        expect(partition.hashes['.llmwiki/SCHEMA.md']).toBeUndefined();
    });

    it('does not continue a read on another role’s acknowledgement', async () => {
        // The memo is per role: a designer's acknowledgement says nothing about what the reviewer has read.
        const root = await taskRoot('memo-task');
        await seedReads(root, { 'AGENTS.md': 'a' });
        const packet = await createContextPacket({ root, taskId: 'memo-task', fromRole: 'implementer', toRole: 'designer' });
        await acknowledgeContextPacket({ root, taskId: 'memo-task', id: packet.id, platform: 'pi', role: 'designer' });

        const partition = await partitionReads({ root, taskId: 'memo-task', role: 'reviewer', paths: ['AGENTS.md'] });

        expect(partition.requiredReads).toEqual(['AGENTS.md']);
        expect(partition.continuedReads).toEqual([]);
    });

    it('records the memo on the receipt, which is what the next packet compares against', async () => {
        const root = await taskRoot('memo-task');
        await seedReads(root, { 'AGENTS.md': 'a' });
        const packet = await createContextPacket({ root, taskId: 'memo-task', fromRole: 'implementer', toRole: 'reviewer' });

        expect(packet.context.contextMemo?.hashes['AGENTS.md']).toMatch(/^[a-f0-9]{64}$/);
        const receipt = await acknowledgeContextPacket({ root, taskId: 'memo-task', id: packet.id, platform: 'pi', role: 'reviewer' });

        expect(receipt.contextMemo).toEqual(packet.context.contextMemo);
    });
});
