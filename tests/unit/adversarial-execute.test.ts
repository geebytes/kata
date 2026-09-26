import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { runAdversarialCommand } from '../../src/cli/ops.js';

/**
 * The entry point's **shape** — an opaque declared command, and a packet whose halves must agree before anything runs.
 *
 * What it no longer does is read the receipt that command writes. Kata runs the command, reads the **events** it emits, counts the round,
 * refutes any capability the stream contradicts, and writes the receipt itself; the stream cases live in
 * `execute-streams-the-round.test.ts`, and the reason for the change is `docs/design/2026-09-26-decoupled-round-protocol.md` (finding
 * `aad-r7-f4`: a host-authored receipt certified a node no session had examined).
 *
 * This file keeps the two refusals that are about the entry point rather than about the artefact: no executor declared, and a packet whose
 * brief does not bind to its request.
 */
const cleanup: string[] = [];

const request = {
    runId: 'run-1',
    requestSha256: 'a'.repeat(64),
    briefSha256: 'b'.repeat(64),
    budget: { maxHypotheses: 6, maxToolCalls: 215, maxOutputBytes: 64_693_181, maxWallMs: 3_940_500 },
    requiredCapabilities: ['fresh_context', 'read_only_fs'],
};

async function fixture(briefSha256 = request.briefSha256): Promise<{ root: string; packet: string; stub: string; ran: string }> {
    const root = await mkdtemp(join(tmpdir(), 'kata-execute-'));
    cleanup.push(root);
    await initLayout(root);
    await createTask({ root, id: 'execute', title: 'Execute', acceptance: [{ id: 'AC-1', statement: 'x' }] } as never);

    const packet = join(root, 'packet.json');
    await writeFile(packet, JSON.stringify({ request, brief: { sha256: briefSha256, text: 'the issued brief' } }), 'utf8');

    // A stub declared command: it records that it ran, and emits nothing. Whether it ran at all is the assertion in some cases.
    const ran = join(root, 'ran.txt');
    const stub = join(root, 'executor.mjs');
    await writeFile(stub, "import { appendFileSync } from 'node:fs';\nappendFileSync(process.env.KATA_RAN, 'ran\\n');\n", 'utf8');
    return { root, packet, stub: `node ${stub}`, ran };
}

async function execute(root: string, args: string[]): Promise<Record<string, unknown>> {
    const before = process.cwd();
    process.chdir(root);
    process.env.KATA_RAN = join(root, 'ran.txt');
    try {
        return await runAdversarialCommand(args);
    } finally {
        delete process.env.KATA_RAN;
        process.chdir(before);
    }
}

describe('adversarial execute runs a declared command, and decides from what it hears', () => {
    afterEach(async () => {
        await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    });

    it('refuses rather than choosing an executor when none was declared', async () => {
        const { root, packet } = await fixture();
        const result = await execute(root, ['execute', '--change', 'execute', '--node', 'review', '--packet', packet]);
        expect(result.status).toBe('refused');
        expect(String(result.error)).toContain('No executor command was declared');
        // And it says what it will do with one, which is a different sentence from what the previous shape said.
        expect(String(result.error)).toContain('reads the events it emits');
    });

    it('refuses an unbound packet before running anything', async () => {
        const { root, packet, stub, ran } = await fixture('f'.repeat(64));
        const result = await execute(root, ['execute', '--change', 'execute', '--node', 'review', '--packet', packet, '--executor', stub]);
        expect(result.reason).toBe('packet_unbound');
        expect(String(result.error)).toContain('does not bind to its request');
        // The disk assertion, not merely the return value: a refusal that still launched a session is not a refusal.
        await expect(readFile(ran, 'utf8')).rejects.toThrow();
    });
});
