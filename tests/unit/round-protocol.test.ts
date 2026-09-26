import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { createRoundParser, ROUND_EVENT_KINDS, ROUND_PROTOCOL_VERSION, type RoundEvent } from '../../src/quality/round-protocol.js';
import { decideRound, ROUND_ALLOWLIST, type RoundRunnerInput } from '../../src/quality/round-runner.js';
import { readRoundRuns, recordRoundRun, roundRunsPath, runIsCertified } from '../../src/quality/round-registry.js';

/**
 * **The host streams; kata decides and writes.**
 *
 * These cases pin the redesign's two halves: the protocol (what a stream must be to describe a round at all) and the runner (what kata derives
 * from it — including the capability refutations a host-authored receipt could never support). The finding that forced both is `aad-r7-f4`: a
 * constant capability list was returned for a process that never started, kata called the round `completed`, and the receipt certified a node no
 * session had examined.
 */
const REQUEST = {
    runId: 'run-1',
    requestSha256: 'a'.repeat(64),
    requiredCapabilities: ['fresh_context', 'read_only_fs'] as const,
    budget: { maxHypotheses: 6, maxToolCalls: 10, maxOutputBytes: 1000, maxWallMs: 1000 },
};

function run(events: RoundEvent[], overrides: Partial<RoundRunnerInput> = {}) {
    return decideRound({
        request: { ...REQUEST, requiredCapabilities: [...REQUEST.requiredCapabilities] },
        events,
        refusal: null,
        allowlist: ROUND_ALLOWLIST,
        startedAt: '2026-09-26T00:00:00.000Z',
        endedAt: '2026-09-26T00:01:00.000Z',
        elapsedMs: 60_000,
        timedOut: false,
        ...overrides,
    });
}

describe('the protocol decides whether a stream describes a round', () => {
    const feed = (text: string, options = {}) => {
        const parser = createRoundParser(options);
        parser.feed(text);
        return parser.parse();
    };

    it('accepts a stream whose first line launches and whose last describes an ending', () => {
        const parsed = feed(`${JSON.stringify({ kind: 'launched', protocol: ROUND_PROTOCOL_VERSION, capabilities: ['fresh_context'] })}\n`
            + `${JSON.stringify({ kind: 'tool_call', tool: 'read' })}\n`
            + `${JSON.stringify({ kind: 'result', text: '{}' })}\n`
            + `${JSON.stringify({ kind: 'ended', status: 'completed' })}\n`);
        expect(parsed.refusal).toBeNull();
        expect(parsed.events.map((event) => event.kind)).toEqual(['launched', 'tool_call', 'result', 'ended']);
    });

    it('refuses a stream whose first line is not `launched`, naming the line', () => {
        const parsed = feed(`${JSON.stringify({ kind: 'tool_call', tool: 'read' })}\n`);
        expect(parsed.refusal?.detail).toContain('the first line was `tool_call`, not `launched`');
        expect(parsed.refusal?.line).toBe(1);
    });

    it('refuses a host that speaks another protocol, and says which it speaks', () => {
        const parsed = feed(`${JSON.stringify({ kind: 'launched', protocol: 99, capabilities: [] })}\n`);
        expect(parsed.refusal?.detail).toContain('this host speaks protocol 99, kata speaks 1');
    });

    it('refuses a line that is not a protocol event, naming the line and quoting it', () => {
        const parsed = feed(`${JSON.stringify({ kind: 'launched', protocol: ROUND_PROTOCOL_VERSION, capabilities: [] })}\nnot json at all\n`);
        expect(parsed.refusal?.line).toBe(2);
        expect(parsed.refusal?.detail).toContain('is not JSON');
    });

    it('refuses an event after `ended`, because the stream is over', () => {
        const parsed = feed(`${JSON.stringify({ kind: 'launched', protocol: ROUND_PROTOCOL_VERSION, capabilities: [] })}\n`
            + `${JSON.stringify({ kind: 'ended', status: 'completed' })}\n`
            + `${JSON.stringify({ kind: 'output', bytes: 1 })}\n`);
        expect(parsed.refusal?.detail).toContain('followed `ended`');
    });

    it('treats a line split across two chunks as one event', () => {
        const parser = createRoundParser();
        const line = `${JSON.stringify({ kind: 'launched', protocol: ROUND_PROTOCOL_VERSION, capabilities: ['fresh_context'] })}\n`;
        parser.feed(line.slice(0, 20));
        parser.feed(line.slice(20));
        const parsed = parser.parse();
        expect(parsed.refusal).toBeNull();
        expect(parsed.events).toHaveLength(1);
    });

    it('refuses a line past the byte bound rather than buffering a host out of memory', () => {
        // 32 MB in production; the bound is a parameter so the rule is testable without allocating it here.
        const parsed = feed(`${JSON.stringify({ kind: 'launched', protocol: ROUND_PROTOCOL_VERSION, capabilities: [] })}\n${'x'.repeat(50)}\n`, { maxLineBytes: 40 });
        expect(parsed.refusal).not.toBeNull();
        expect(parsed.refusal?.detail).toContain('the 40-byte bound');
    });
});

describe('kata derives the round, rather than reading the host', () => {
    const launch = (capabilities: string[] = ['fresh_context', 'read_only_fs', 'bounded_tools', 'budget_enforced']): RoundEvent =>
        ({ kind: 'launched', protocol: ROUND_PROTOCOL_VERSION, capabilities: capabilities as never });

    it('writes a receipt only when a session produced a result', () => {
        const outcome = run([launch(), { kind: 'tool_call', tool: 'read' }, { kind: 'result', text: JSON.stringify({ hypotheses: [{ id: 'h1' }] }) }]);
        expect(outcome.status).toBe('completed');
        if (outcome.status !== 'completed') throw new Error('unreachable');
        expect(outcome.receipt.runId).toBe('run-1');
        expect(outcome.receipt.requestSha256).toBe('a'.repeat(64));
        expect(outcome.receipt.telemetry.toolCalls).toBe(1);
        // The result a session can only produce by running is the one thing whose absence refuses, so its presence is what the receipt records.
        expect(outcome.record).toContain('hypotheses');
    });

    it('refuses a round whose stream produced no result, whatever the host said about ending', () => {
        const outcome = run([launch(), { kind: 'tool_call', tool: 'read' }, { kind: 'ended', status: 'completed' }]);
        expect(outcome.status).toBe('executor_unavailable');
        if (outcome.status === 'completed') throw new Error('unreachable');
        expect(outcome.reason).toContain('produced no result');
        expect(outcome.hostReported).toEqual({ status: 'completed' });
    });

    it('refutes a declared read_only_fs when the stream shows a write', () => {
        const outcome = run([launch(), { kind: 'tool_call', tool: 'write', target: 'src/a.ts' }, { kind: 'result', text: '{}' }]);
        expect(outcome.status).toBe('executor_unavailable');
        if (outcome.status === 'completed') throw new Error('unreachable');
        expect(outcome.reason).toContain('read_only_fs');
        expect(outcome.reason).toContain('write');
    });

    it('refutes a declared bounded_tools when the stream shows a tool outside the node allowlist', () => {
        const outcome = run([launch(), { kind: 'tool_call', tool: 'deploy' }, { kind: 'result', text: '{}' }]);
        expect(outcome.status).toBe('executor_unavailable');
        if (outcome.status === 'completed') throw new Error('unreachable');
        expect(outcome.reason).toContain('bounded_tools');
        expect(outcome.reason).toContain('deploy');
    });

    it('names a required capability the host did not provide', () => {
        const outcome = run([launch(['fresh_context']), { kind: 'result', text: '{}' }]);
        expect(outcome.status).toBe('executor_unavailable');
        if (outcome.status === 'completed') throw new Error('unreachable');
        expect(outcome.reason).toContain('read_only_fs');
    });

    it('counts the envelope itself, so a host that reports success past its budget is still stopped', () => {
        const calls: RoundEvent[] = Array.from({ length: 12 }, () => ({ kind: 'tool_call', tool: 'read' }));
        const outcome = run([launch(), ...calls, { kind: 'result', text: '{}' }, { kind: 'ended', status: 'completed' }]);
        expect(outcome.status).toBe('budget_exhausted');
        if (outcome.status === 'completed') throw new Error('unreachable');
        expect(outcome.reason).toContain('12 tool calls against a limit of 10');
        expect(outcome.hostReported).toEqual({ status: 'completed' });
    });

    it('reports a figure nobody measured as null rather than as a zero that reads like a measurement', () => {
        const outcome = run([launch(), { kind: 'result', text: '{}' }]);
        if (outcome.status !== 'completed') throw new Error('unreachable');
        expect(outcome.receipt.telemetry.toolCalls).toBe(0);
        expect(outcome.receipt.telemetry.outputBytes).toBeNull();
        expect(outcome.receipt.telemetry.tokens).toBeNull();
        expect(outcome.receipt.telemetry.truncations).toBeNull();
    });

    it('keeps the host\'s own ending verbatim, beside kata\'s derivation', () => {
        const outcome = run([launch(), { kind: 'result', text: '{}' }, { kind: 'ended', status: 'completed', reason: 'finished early' }], { timedOut: true });
        expect(outcome.status).toBe('timeout');
        if (outcome.status === 'completed') throw new Error('unreachable');
        expect(outcome.hostReported).toEqual({ status: 'completed', reason: 'finished early' });
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

    const record = {
        runId: 'run-1', requestSha256: 'a'.repeat(64), node: 'review', status: 'completed' as const,
        startedAt: '2026-09-26T00:00:00.000Z', endedAt: '2026-09-26T00:01:00.000Z',
        toolCalls: 3, outputBytes: 120, tokens: null, truncations: null, firstTurnTokens: 10_000, hostReported: null, refusals: [],
    };

    it('certifies a receipt whose run it watched complete', async () => {
        const root = await workspace();
        await recordRoundRun(root, 'rounds', record);
        const runs = await readRoundRuns(root, 'rounds');
        expect(runs).toHaveLength(1);
        expect(runIsCertified(runs, { runId: 'run-1', requestSha256: 'a'.repeat(64) }).certified).toBe(true);
    });

    it('refuses a receipt no run stands behind, and names the remedy', async () => {
        const root = await workspace();
        const verdict = runIsCertified([], { runId: 'run-1', requestSha256: 'a'.repeat(64) });
        expect(verdict.certified).toBe(false);
        if (verdict.certified) throw new Error('unreachable');
        expect(verdict.reason).toContain('no run with id run-1');
        expect(verdict.reason).toContain('adversarial execute');
    });

    it('refuses a receipt that names a different request than its run answered', async () => {
        const root = await workspace();
        await recordRoundRun(root, 'rounds', record);
        const verdict = runIsCertified(await readRoundRuns(root, 'rounds'), { runId: 'run-1', requestSha256: 'b'.repeat(64) });
        expect(verdict.certified).toBe(false);
        if (verdict.certified) throw new Error('unreachable');
        expect(verdict.reason).toContain('may only report the request it answered');
    });

    it('refuses an artefact whose run did not complete, quoting why', async () => {
        const root = await workspace();
        await recordRoundRun(root, 'rounds', { ...record, status: 'budget_exhausted', refusals: ['the round used 12 tool calls against a limit of 10'] });
        const verdict = runIsCertified(await readRoundRuns(root, 'rounds'), { runId: 'run-1', requestSha256: 'a'.repeat(64) });
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

describe('the protocol has one definition, and the executable never reaches into the host', () => {
    it('declares every event kind the schema names, and no kind the schema does not', async () => {
        const schema = JSON.parse(await readFile('schemas/round-events.schema.json', 'utf8')) as {
            $id?: string;
            properties: { kind: { enum: string[] } };
        };
        expect(schema.$id, 'a bundled schema without an $id cannot be registered or looked up').toBeTruthy();
        expect([...schema.properties.kind.enum].sort()).toEqual([...ROUND_EVENT_KINDS].sort());
    });

    it('is not part of the kata executable: src/ never imports host/', async () => {
        // The boundary is a checked fact, not a promise. `host/` produces the events that become a receipt for rounds reviewing kata's own
        // changes; if kata could call it, the authorised party would be producing its own independence evidence.
        const offenders: string[] = [];
        const walk = async (dir: string): Promise<void> => {
            for (const entry of await readdir(dir, { withFileTypes: true })) {
                const path = join(dir, entry.name);
                if (entry.isDirectory()) await walk(path);
                else if (/\.tsx?$/.test(entry.name)) {
                    const source = await readFile(path, 'utf8');
                    if (/from\s+['"][^'"]*\/host\/|from\s+['"]host\//.test(source)) offenders.push(path);
                }
            }
        };
        await walk(join(process.cwd(), 'src'));
        expect(offenders).toEqual([]);
    });
});

