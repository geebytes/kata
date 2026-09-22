import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { runAdversarialCommand } from '../../src/cli/ops.js';

/**
 * Option A: kata runs a **declared** command and validates the receipt it writes.
 *
 * The entry point is shaped like the one that runs a declared check — an opaque command, a result read back. Nothing here
 * decides flags, tools or models, which is what keeps a change to kata from loosening the envelope it certifies.
 */
const cleanup: string[] = [];

const request = {
    runId: 'run-1',
    requestSha256: 'a'.repeat(64),
    briefSha256: 'b'.repeat(64),
    budget: { maxHypotheses: 6, maxToolCalls: 215, maxOutputBytes: 64_693_181, maxWallMs: 3_940_500 },
    requiredCapabilities: ['fresh_context', 'read_only_fs'],
};

async function fixture(): Promise<{ root: string; packet: string; stub: string; ran: string }> {
    const root = await mkdtemp(join(tmpdir(), 'kata-execute-'));
    cleanup.push(root);
    await initLayout(root);
    await createTask({ root, id: 'execute', title: 'Execute', acceptance: [{ id: 'AC-1', statement: 'x' }] } as never);

    const packet = join(root, 'packet.json');
    await writeFile(packet, JSON.stringify({ request, brief: { sha256: request.briefSha256, text: 'the issued brief' } }), 'utf8');

    // A stub declared command: it records that it ran, then writes the receipt the test asks for from its own env.
    const ran = join(root, 'ran.txt');
    const stub = join(root, 'executor.mjs');
    await writeFile(
        stub,
        [
            "import { appendFileSync, writeFileSync } from 'node:fs';",
            "appendFileSync(process.env.KATA_RAN, 'ran\\n');",
            'const receipt = process.env.KATA_STUB_RECEIPT;',
            "if (receipt) writeFileSync(process.env.KATA_REVIEW_RECEIPT, receipt, 'utf8');",
            '',
        ].join('\n'),
        'utf8',
    );
    return { root, packet, stub: `node ${stub}`, ran };
}

async function execute(root: string, args: string[], env: Record<string, string> = {}): Promise<Record<string, unknown>> {
    const before = process.cwd();
    process.chdir(root);
    for (const [key, value] of Object.entries(env)) process.env[key] = value;
    process.env.KATA_RAN = join(root, 'ran.txt');
    try {
        return await runAdversarialCommand(args);
    } finally {
        for (const key of Object.keys(env)) delete process.env[key];
        delete process.env.KATA_RAN;
        process.chdir(before);
    }
}

describe('adversarial execute runs a declared command and reads its receipt', () => {
    afterEach(async () => {
        await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    });

    it('accepts a receipt the declared command wrote, bound to the packet', async () => {
        const { root, packet, stub } = await fixture();
        const receipt = JSON.stringify({ runId: request.runId, requestSha256: request.requestSha256, capabilities: ['fresh_context', 'read_only_fs'], startedAt: '2026-09-22T00:00:00.000Z', endedAt: '2026-09-22T00:01:00.000Z', telemetry: { toolCalls: 3, outputBytes: 10, tokens: 10, truncations: 0 }, status: 'completed' });

        const result = await execute(root, ['execute', '--change', 'execute', '--node', 'review', '--packet', packet, '--executor', stub], { KATA_STUB_RECEIPT: receipt });

        expect(result.status).toBe('executed');
        expect(result.capabilities).toEqual(['fresh_context', 'read_only_fs']);
        // The command really ran, and the receipt it wrote is where kata says it is.
        expect(await readFile(join(root, 'ran.txt'), 'utf8')).toContain('ran');
        expect(JSON.parse(await readFile(String(result.receiptPath), 'utf8'))).toMatchObject({ runId: request.runId });
    });

    it('refuses when the declared command writes no receipt, rather than writing one on its behalf', async () => {
        const { root, packet, stub } = await fixture();
        const result = await execute(root, ['execute', '--change', 'execute', '--node', 'review', '--packet', packet, '--executor', stub]);

        expect(result.status).toBe('executor_unavailable');
        expect(String(result.error)).toMatch(/wrote no receipt/);
    });

    it('refuses a receipt bound to a different round', async () => {
        const { root, packet, stub } = await fixture();
        const receipt = JSON.stringify({ runId: 'another-run', requestSha256: 'c'.repeat(64), capabilities: ['fresh_context', 'read_only_fs'], startedAt: '', endedAt: '', telemetry: { toolCalls: 0, outputBytes: 0, tokens: 0, truncations: 0 }, status: 'completed' });

        const result = await execute(root, ['execute', '--change', 'execute', '--node', 'review', '--packet', packet, '--executor', stub], { KATA_STUB_RECEIPT: receipt });

        expect(result.status).toBe('refused');
        expect(result.reason).toBe('receipt_unbound');
    });

    it('refuses a receipt that does not advertise what the node requires', async () => {
        const { root, packet, stub } = await fixture();
        const receipt = JSON.stringify({ runId: request.runId, requestSha256: request.requestSha256, capabilities: ['fresh_context'], startedAt: '', endedAt: '', telemetry: { toolCalls: 0, outputBytes: 0, tokens: 0, truncations: 0 }, status: 'completed' });

        const result = await execute(root, ['execute', '--change', 'execute', '--node', 'review', '--packet', packet, '--executor', stub], { KATA_STUB_RECEIPT: receipt });

        expect(result.status).toBe('refused');
        expect(result.reason).toBe('capability_missing');
        expect(String(result.error)).toContain('read_only_fs');
    });

    it('refuses rather than choosing an executor when none was declared', async () => {
        const { root, packet } = await fixture();
        const result = await execute(root, ['execute', '--change', 'execute', '--node', 'review', '--packet', packet]);

        expect(result.status).toBe('refused');
        expect(String(result.error)).toMatch(/does not decide how a session is isolated/);
    });

    it('refuses an unbound packet before running anything', async () => {
        const { root, stub } = await fixture();
        const packet = join(root, 'broken-packet.json');
        await writeFile(packet, JSON.stringify({ request, brief: { sha256: 'd'.repeat(64), text: 'a different brief' } }), 'utf8');
        await rm(join(root, 'ran.txt'), { force: true });

        const result = await execute(root, ['execute', '--change', 'execute', '--node', 'review', '--packet', packet, '--executor', stub]);

        expect(result.status).toBe('refused');
        expect(result.reason).toBe('packet_unbound');
        // The declared command did not run: refusing after launching a session would be a different, weaker behaviour.
        await expect(readFile(join(root, 'ran.txt'), 'utf8')).rejects.toThrow();
    });
});
