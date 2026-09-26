import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { runAdversarialCommand } from '../../src/cli/ops.js';
import { ROUND_PROTOCOL_VERSION } from '../../src/quality/round-protocol.js';

/**
 * **The CLI-level half of the redesign: `execute` writes the receipt, from the stream it watched.**
 *
 * The host is a shell command that prints protocol lines, so these cases run the real command path with no platform and no session involved —
 * which is the point of a protocol: it can be exercised by anything that can write to stdout.
 *
 * The finding these cases exist for is `aad-r7-f4`: under the previous shape the host wrote the receipt, so a constant capability list was
 * returned for a process that never started and kata called the round `completed`.
 */
describe('adversarial execute reads a stream and writes the receipt itself', () => {
    const roots: string[] = [];
    const previousCwd = process.cwd();
    afterEach(async () => {
        process.chdir(previousCwd);
        await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });

    async function workspace(): Promise<{ root: string; packet: string; request: Record<string, unknown> }> {
        const root = await mkdtemp(join(tmpdir(), 'kata-execute-'));
        roots.push(root);
        await initLayout(root);
        await createTask({ root, id: 'streams', title: 'S', ownedPaths: ['src/a.ts'], acceptance: [{ id: 'AC-1', statement: 'x' }] } as never);
        const brief = 'the issued brief, verbatim';
        const request = {
            runId: 'run-streams-1',
            node: 'review',
            revisionId: 'revision-x',
            briefSha256: createHash('sha256').update(brief).digest('hex'),
            reviewIrSha256: 'b'.repeat(64),
            budget: { maxHypotheses: 6, maxToolCalls: 10, maxOutputBytes: 100_000, maxWallMs: 30_000 },
            requiredCapabilities: ['fresh_context', 'read_only_fs'],
            resultSchemaVersion: 1,
            requestSha256: 'c'.repeat(64),
        };
        const packet = join(root, 'packet.json');
        await writeFile(packet, JSON.stringify({ request, brief: { sha256: request.briefSha256, text: brief } }), 'utf8');
        process.chdir(root);
        return { root, packet, request };
    }

    /** A host, as a command: it prints whatever lines the case hands it, and writes nothing else. */
    async function executorFor(root: string, lines: string[]): Promise<string> {
        const path = join(root, 'host.mjs');
        await writeFile(path, `for (const line of ${JSON.stringify(lines)}) process.stdout.write(line + '\\n');\n`, 'utf8');
        return `node ${path}`;
    }

    const launched = JSON.stringify({ kind: 'launched', protocol: ROUND_PROTOCOL_VERSION, capabilities: ['fresh_context', 'read_only_fs'], platform: 'fake' });

    it('writes the receipt from the stream, records the run, and names both in the note', async () => {
        const { root, packet } = await workspace();
        const record = JSON.stringify({ node: 'review', status: 'recorded', hypotheses: [{ id: 'h1' }], findings: [] });
        const executor = await executorFor(root, [launched, JSON.stringify({ kind: 'tool_call', tool: 'read' }), JSON.stringify({ kind: 'result', text: record }), JSON.stringify({ kind: 'ended', status: 'completed' })]);

        const result = await runAdversarialCommand(['execute', '--change', 'streams', '--node', 'review', '--packet', packet, '--executor', executor]);
        expect(result.status).toBe('executed');
        const receipt = JSON.parse(await readFile(String(result.receiptPath), 'utf8')) as { runId: string; capabilities: string[]; telemetry: Record<string, unknown> };
        expect(receipt.runId).toBe('run-streams-1');
        expect(receipt.capabilities).toEqual(['fresh_context', 'read_only_fs']);
        expect(receipt.telemetry.toolCalls).toBe(1);
        expect(await readFile(String(result.resultPath), 'utf8')).toContain('hypotheses');
        // And the register, which is what `record` consults: the run kata watched.
        const runs = JSON.parse(await readFile(join(root, '.kata/tasks/streams/round-runs.json'), 'utf8')) as { runs: Array<{ runId: string; status: string }> };
        expect(runs.runs).toEqual([expect.objectContaining({ runId: 'run-streams-1', status: 'completed' })]);
    });

    it('refuses a capability the stream contradicts, and writes no receipt', async () => {
        const { root, packet } = await workspace();
        const executor = await executorFor(root, [launched, JSON.stringify({ kind: 'tool_call', tool: 'write', target: 'src/a.ts' }), JSON.stringify({ kind: 'result', text: '{}' })]);

        const result = await runAdversarialCommand(['execute', '--change', 'streams', '--node', 'review', '--packet', packet, '--executor', executor]);
        expect(result.status).toBe('executor_unavailable');
        expect(String(result.error)).toContain('read_only_fs');
        expect(result.receiptPath).toBeUndefined();
    });

    it('refuses a stream that produced no result, whatever the host reported', async () => {
        const { root, packet } = await workspace();
        const executor = await executorFor(root, [launched, JSON.stringify({ kind: 'ended', status: 'completed' })]);

        const result = await runAdversarialCommand(['execute', '--change', 'streams', '--node', 'review', '--packet', packet, '--executor', executor]);
        expect(result.status).toBe('executor_unavailable');
        expect(String(result.error)).toContain('produced no result');
        expect((result.hostReported as { status?: string })?.status).toBe('completed');
    });

    it('stops a round the stream shows exceeding the envelope, even when the host says it completed', async () => {
        const { root, packet } = await workspace();
        const calls = Array.from({ length: 12 }, () => JSON.stringify({ kind: 'tool_call', tool: 'read' }));
        const executor = await executorFor(root, [launched, ...calls, JSON.stringify({ kind: 'result', text: '{}' }), JSON.stringify({ kind: 'ended', status: 'completed' })]);

        const result = await runAdversarialCommand(['execute', '--change', 'streams', '--node', 'review', '--packet', packet, '--executor', executor]);
        expect(result.status).toBe('budget_exhausted');
        expect(String(result.error)).toContain('12 tool calls against a limit of 10');
    });

    it('refuses a receipt no run stands behind, which is what a host-authored file is now', async () => {
        const { root } = await workspace();
        // Exactly what the previous shape produced: an artefact written by the host, with no round kata ever watched.
        const handWritten = join(root, 'receipt.json');
        await writeFile(handWritten, JSON.stringify({
            runId: 'run-streams-1', requestSha256: 'c'.repeat(64), capabilities: ['fresh_context', 'read_only_fs'],
            startedAt: '2026-09-26T00:00:00.000Z', endedAt: '2026-09-26T00:01:00.000Z',
            telemetry: { toolCalls: 3, outputBytes: 10, tokens: 100, truncations: 0 }, status: 'completed',
        }), 'utf8');
        const recordPath = join(root, 'result.json');
        await writeFile(recordPath, JSON.stringify({ node: 'review', status: 'recorded', briefSha256: 'd'.repeat(64), hypotheses: [] }), 'utf8');

        const result = await runAdversarialCommand(['record', '--change', 'streams', '--node', 'review', '--from-file', recordPath, '--receipt-file', handWritten]);
        expect(result.recorded).toBe(false);
        expect(result.reason).toBe('receipt_unwatched');
        expect(String(result.error)).toContain('no run with id run-streams-1');
    });
});
