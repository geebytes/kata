import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { requireWorkflowReceipt } from '../../src/cli/workflow.js';
import { acknowledgeContextPacket, createContextPacket } from '../../src/workflow/context-fabric.js';

/**
 * **A refusal names which of two situations this is, because the remedies differ.**
 *
 * The message was one sentence for both "no receipt exists" and "a receipt exists and no longer describes the task". One
 * remedy is `handoff create`, the other is to re-acknowledge after whatever moved the task. Measured while walking a real
 * change: two `scope apply` calls each superseded the acknowledged receipt, and the third attempt was refused with a
 * sentence that named neither the cause nor the command — the reader had to diff the packet against the working tree to
 * find out what had happened.
 */
let root: string;

afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
});

async function workspace(id: string): Promise<string> {
    root = await mkdtemp(join(tmpdir(), 'kata-handoff-refusal-'));
    await initLayout(root);
    await createTask({ root, id, title: 'Handoff refusal', acceptance: [{ id: 'AC-1', statement: 'x' }], ownedPaths: ['src/a.ts'] });
    return root;
}

describe('a handoff refusal says which situation it is', () => {
    it('names the creating commands when the task has no receipt at all', async () => {
        const id = 'no-receipt-task';
        const workspaceRoot = await workspace(id);
        const error = await requireWorkflowReceipt(workspaceRoot, id, 'implementer').catch((thrown: Error) => thrown);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('has none');
        expect((error as Error).message).toContain('handoff create');
        expect((error as Error).message).toContain('handoff acknowledge');
    });

    it('names the cause and the last refusal when a receipt exists but is stale', async () => {
        const id = 'stale-receipt-task';
        const workspaceRoot = await workspace(id);
        // Acknowledge, then move the task: the receipt describes the task as it stood, so this supersedes it.
        const packet = await createContextPacket({ root: workspaceRoot, taskId: id, fromRole: 'implementer', toRole: 'implementer', platform: 'test' });
        await acknowledgeContextPacket({ root: workspaceRoot, taskId: id, id: packet.id, platform: 'test', role: 'implementer' });
        // Supersede the receipt the way the task moving does: the receipt binds the packet it acknowledged by hash, so a
        // receipt whose hash no longer matches is exactly what a scope apply or an edit to a declared path produces. The
        // fixture is written directly because no product command should be able to forge a receipt — that it cannot is the
        // point of the check this reaches.
        const receiptPath = join(workspaceRoot, '.kata/tasks', id, 'handoffs', `${packet.id}.receipt.json`);
        const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as Record<string, unknown>;
        await writeFile(receiptPath, `${JSON.stringify({ ...receipt, packetSha256: 'f'.repeat(64) }, null, 2)}\n`);

        const error = await requireWorkflowReceipt(workspaceRoot, id, 'implementer').catch((thrown: Error) => thrown);
        expect(error).toBeInstanceOf(Error);
        // The two facts the reader needs: that a receipt exists, and why none of them is current.
        expect((error as Error).message).toContain('receipt(s) is current');
        expect((error as Error).message).toContain('Last refusal:');
        expect((error as Error).message).not.toContain('has none');
    });
});
