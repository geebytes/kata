import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { createTaskRevision } from '../../src/workflow/revision.js';
import { issueAdversarialBrief } from '../../src/quality/adversarial.js';
import { readRoundRuns, recordRoundRun, roundRunsPath, runIsCertified } from '../../src/quality/round-registry.js';
import type { ReviewExecutionReceipt } from '../../src/quality/review-execution.js';
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

    /**
     * A task with an **issued** brief, and the packet built from its run request.
     *
     * The first version hand-wrote the request, and `execute` now refuses that by name (`packet_not_issued`): the request is
     * operator-supplied, so a packet kata never made must not register a run. The fixture therefore issues a real brief, which is also
     * what makes these cases exercise the path a round actually takes.
     */
    async function workspace(): Promise<{ root: string; packet: string; request: Record<string, unknown> }> {
        const root = await mkdtemp(join(tmpdir(), 'kata-execute-'));
        roots.push(root);
        await initLayout(root);
        await createTask({ root, id: 'streams', title: 'S', ownedPaths: ['src/a.ts'], acceptance: [{ id: 'AC-1', statement: 'x' }] } as never);
        await mkdir(join(root, 'src'), { recursive: true });
        await writeFile(join(root, 'src/a.ts'), 'export const a = 1;\n', 'utf8');
        await createTaskRevision({ root, taskId: 'streams', ownedPaths: ['src/a.ts'], checkIds: [] });
        const brief = await issueAdversarialBrief(root, 'streams', 'review');
        const request = brief.runRequest as unknown as Record<string, unknown>;
        const packet = join(root, 'packet.json');
        await writeFile(packet, JSON.stringify({ request, brief: { sha256: brief.sha256, lines: brief.text.split('\n') } }), 'utf8');
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
        expect(result.status, JSON.stringify(result)).toBe('executed');
        const receipt = JSON.parse(await readFile(String(result.receiptPath), 'utf8')) as { runId: string; capabilities: string[]; telemetry: Record<string, unknown> };
        // The issued run's own id, not a literal: the request is kata's, so the fixture reads it rather than inventing one.
        expect(receipt.runId).toBe(String(result.requestRunId ?? receipt.runId));
        expect(receipt.runId).toMatch(/^[0-9a-f-]{36}$/);
        expect(receipt.capabilities).toEqual(['fresh_context', 'read_only_fs']);
        expect(receipt.telemetry.toolCalls).toBe(1);
        expect(await readFile(String(result.resultPath), 'utf8')).toContain('hypotheses');
        // And the register, which is what `record` consults: the run kata watched.
        const runs = JSON.parse(await readFile(join(root, '.kata/tasks/streams/round-runs.json'), 'utf8')) as { runs: Array<{ runId: string; status: string }> };
        expect(runs.runs).toEqual([expect.objectContaining({ runId: receipt.runId, status: 'completed' })]);
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
        const { root, packet, request } = await workspace();
        // **The budget is kata's, not the packet's.** The first version exceeded a limit it had written into its own packet — which
        // `execute` now refuses at the boundary, and correcting the fixture exposed the real question: the round must exceed what kata
        // issued. One call past the issued limit.
        const issuedLimit = Number((request.budget as { maxToolCalls: number }).maxToolCalls);
        const calls = Array.from({ length: issuedLimit + 1 }, () => JSON.stringify({ kind: 'tool_call', tool: 'read' }));
        const executor = await executorFor(root, [launched, ...calls, JSON.stringify({ kind: 'result', text: '{}' }), JSON.stringify({ kind: 'ended', status: 'completed' })]);

        const result = await runAdversarialCommand(['execute', '--change', 'streams', '--node', 'review', '--packet', packet, '--executor', executor]);
        expect(result.status).toBe('budget_exhausted');
        expect(String(result.error)).toContain(`against a limit of ${issuedLimit}`);
    });

    it('refuses a receipt no run stands behind, which is what a host-authored file is now', async () => {
        const { root } = await workspace();
        // Exactly what the previous shape produced: an artefact written by the host, with no round kata ever watched.
        const handWritten = join(root, 'receipt.json');
        await writeFile(handWritten, JSON.stringify({
            runId: 'run-streams-1', requestSha256: 'c'.repeat(64), capabilities: ['fresh_context', 'read_only_fs'] as const,
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

describe('the execution registry is what makes "kata wrote it" checkable', () => {
    const roots: string[] = [];
    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    async function workspace(): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-rounds-'));
        roots.push(root);
        await initLayout(root);
        await createTask({ root, id: 'rounds', title: 'R', ownedPaths: ['src/a.ts'], acceptance: [{ id: 'AC-1', statement: 'x' }] } as never);
        return root;
    }

    /** The receipt kata writes, as the register stores it — admission compares this artefact, not just its identity. */
    const writtenReceipt: ReviewExecutionReceipt = {
        runId: 'run-1', requestSha256: 'a'.repeat(64), capabilities: ['fresh_context', 'read_only_fs'],
        startedAt: '2026-09-26T00:00:00.000Z', endedAt: '2026-09-26T00:01:00.000Z',
        telemetry: { toolCalls: 3, outputBytes: 120, tokens: null, truncations: null }, status: 'completed' as const,
    };
    const record = {
        ...writtenReceipt, node: 'review',
        toolCalls: 3, outputBytes: 120, tokens: null, truncations: null, firstTurnTokens: 10_000, hostReported: null, refusals: [],
        receipt: writtenReceipt,
    };

    it('certifies a receipt whose run it watched complete', async () => {
        const root = await workspace();
        await recordRoundRun(root, 'rounds', record);
        const runs = await readRoundRuns(root, 'rounds');
        expect(runs).toHaveLength(1);
        expect(runIsCertified(runs, writtenReceipt).certified).toBe(true);
    });

    it('refuses a receipt no run stands behind, and names the remedy', async () => {
        const root = await workspace();
        const verdict = runIsCertified([], writtenReceipt);
        expect(verdict.certified).toBe(false);
        if (verdict.certified) throw new Error('unreachable');
        expect(verdict.reason).toContain('no run with id run-1');
        expect(verdict.reason).toContain('adversarial execute');
    });

    it('refuses a receipt that names a different request than its run answered', async () => {
        const root = await workspace();
        await recordRoundRun(root, 'rounds', record);
        const verdict = runIsCertified(await readRoundRuns(root, 'rounds'), { ...writtenReceipt, requestSha256: 'b'.repeat(64) });
        expect(verdict.certified).toBe(false);
        if (verdict.certified) throw new Error('unreachable');
        expect(verdict.reason).toContain('may only report the request it answered');
    });

    it('refuses an artefact whose run did not complete, quoting why', async () => {
        const root = await workspace();
        // No receipt: a run that did not complete has none, and leaving one in made the content comparison answer first.
        await recordRoundRun(root, 'rounds', { ...record, status: 'budget_exhausted', receipt: undefined, refusals: ['the round used 12 tool calls against a limit of 10'] });
        const verdict = runIsCertified(await readRoundRuns(root, 'rounds'), writtenReceipt);
        expect(verdict.certified).toBe(false);
        if (verdict.certified) throw new Error('unreachable');
        expect(verdict.reason).toContain('budget_exhausted');
        expect(verdict.reason).toContain('12 tool calls');
    });

    it('writes one register per task, and appends rather than replaces', async () => {
        const root = await workspace();
        await recordRoundRun(root, 'rounds', record);
        await recordRoundRun(root, 'rounds', { ...record, runId: 'run-2' });
        expect((await readRoundRuns(root, 'rounds')).map((entry) => entry.runId)).toEqual(['run-1', 'run-2']);
        expect(JSON.parse(await readFile(roundRunsPath(root, 'rounds'), 'utf8')).version).toBe(1);
    });
});
