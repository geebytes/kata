import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runReviewRound, type HostAdapter, type IsolatedSession, type ReviewPacket, type SessionEvent } from '../../host/executor.js';

/**
 * H1's platform-neutral core, driven by a fake adapter.
 *
 * No host is started: what is under test is the envelope enforcement, the telemetry accounting, the binding check and the
 * refusals. A real host is the adapter's business, which is the point of the split — the logic that decides whether a
 * receipt may exist is testable without one.
 */

const envelope = { maxHypotheses: 6, maxToolCalls: 10, maxOutputBytes: 1000, maxWallMs: 1000 };

function packet(overrides: Partial<ReviewPacket['request']> = {}, briefText = 'the issued brief, verbatim'): ReviewPacket {
    const request = {
        runId: 'run-1',
        requestSha256: 'a'.repeat(64),
        briefSha256: 'b'.repeat(64),
        budget: envelope,
        requiredCapabilities: ['fresh_context', 'read_only_fs'] as const,
        ...overrides,
    };
    return { request: { ...request, requiredCapabilities: [...request.requiredCapabilities] }, brief: { sha256: request.briefSha256, text: briefText } };
}

/** A session that replays a scripted event list. Records what it was launched with, and whether it was killed. */
function adapterFor(events: SessionEvent[], capabilities: IsolatedSession['capabilities'] = ['fresh_context', 'read_only_fs', 'bounded_tools', 'budget_enforced']) {
    const launched: Array<{ briefText: string; tools: string[] }> = [];
    let killed: string | undefined;
    const adapter: HostAdapter = {
        name: 'fake',
        async launch({ briefText, tools }) {
            launched.push({ briefText, tools });
            return {
                capabilities,
                // A property holding an iterator, not a method: the interface is `events: AsyncIterable`, and a method
                // is a function that has to be called first. Measured by the first run of this test.
                events: (async function* replay() {
                    for (const event of events) yield event;
                })(),
                async kill(reason) {
                    killed = reason;
                },
            };
        },
    };
    return { adapter, launched, killed: () => killed };
}

describe('the host executor core', () => {
    it('runs the round on the brief it was given, and reports measured telemetry', async () => {
        const { adapter, launched } = adapterFor([
            { kind: 'tool_call', tool: 'read' },
            { kind: 'tool_call', tool: 'grep' },
            { kind: 'output', bytes: 400 },
            { kind: 'reviewer_result', text: JSON.stringify({ hypotheses: [{ id: 'h1' }] }), tokens: 120, truncations: 1 },
        ]);
        let clock = 0;
        const outcome = await runReviewRound({ packet: packet(), adapter, now: () => clock });

        expect(outcome.status).toBe('completed');
        expect(outcome.receipt?.telemetry).toEqual({ toolCalls: 2, outputBytes: 400, tokens: 120, truncations: 1 });
        // The receipt is bound to the request, not to a value it produced itself.
        expect(outcome.receipt?.runId).toBe('run-1');
        expect(outcome.receipt?.requestSha256).toBe('a'.repeat(64));

        // §1.3: the session's input is the issued brief, verbatim. A round started without it is an ignorant reviewer,
        // which is not the same thing as an independent one.
        expect(launched[0]?.briefText).toBe(packet().brief.text);
        expect(launched[0]?.tools).toEqual(['read', 'grep', 'find', 'ls']);
    });

    it('refuses a packet whose brief does not bind to its request, without launching anything', async () => {
        const { adapter, launched } = adapterFor([]);
        const broken = packet();
        broken.brief.sha256 = 'c'.repeat(64);

        const outcome = await runReviewRound({ packet: broken, adapter, now: () => 0 });
        expect(outcome.status).toBe('executor_unavailable');
        expect(outcome.receipt).toBeUndefined();
        expect(outcome.reason).toMatch(/does not bind/);
        expect(launched).toHaveLength(0);
    });

    it('refuses a packet carrying no brief text, rather than running a session with no checklist', async () => {
        const { adapter, launched } = adapterFor([]);
        const outcome = await runReviewRound({ packet: packet({}, '   '), adapter, now: () => 0 });
        expect(outcome.status).toBe('executor_unavailable');
        expect(outcome.reason).toMatch(/no brief text/);
        expect(launched).toHaveLength(0);
    });

    it('reports executor_unavailable and produces no receipt when a required capability is missing', async () => {
        // The host cannot enforce read-only, so it must say so. A receipt with a shorter capability list would be a
        // degraded round reported as a round.
        const { adapter, killed } = adapterFor([{ kind: 'tool_call', tool: 'read' }], ['fresh_context']);
        const outcome = await runReviewRound({ packet: packet(), adapter, now: () => 0 });

        expect(outcome.status).toBe('executor_unavailable');
        expect(outcome.receipt).toBeUndefined();
        expect(outcome.reason).toContain('read_only_fs');
        expect(killed()).toBe('capability_missing');
    });

    it('stops a round that exceeds the tool-call envelope, and never calls it completed', async () => {
        const events: SessionEvent[] = Array.from({ length: 12 }, () => ({ kind: 'tool_call' as const, tool: 'read' }));
        const { adapter, killed } = adapterFor(events);
        const outcome = await runReviewRound({ packet: packet(), adapter, now: () => 0 });

        expect(outcome.status).toBe('budget_exhausted');
        expect(outcome.receipt).toBeUndefined();
        // Stopped at the first call **past** the limit, not at the end of the script: the envelope is enforced as the
        // stream arrives, so 11 of the 12 scripted calls were consumed and the round never reached its conclusion.
        expect(outcome.reason).toContain('11 tool calls');
        expect(killed()).toBe('budget_exhausted');
    });

    it('stops a round whose output exceeds the envelope', async () => {
        const { adapter } = adapterFor([{ kind: 'output', bytes: 5000 }]);
        const outcome = await runReviewRound({ packet: packet(), adapter, now: () => 0 });

        expect(outcome.status).toBe('budget_exhausted');
        expect(outcome.receipt).toBeUndefined();
        expect(outcome.reason).toContain('5000 output bytes');
    });

    it('stops a round that raises more hypotheses than the envelope allows', async () => {
        const { adapter } = adapterFor([
            { kind: 'reviewer_result', text: JSON.stringify({ hypotheses: Array.from({ length: 7 }, (_, i) => ({ id: `h${i}` })) }) },
        ]);
        const outcome = await runReviewRound({ packet: packet(), adapter, now: () => 0 });

        expect(outcome.status).toBe('budget_exhausted');
        expect(outcome.reason).toContain('7 hypotheses');
    });

    it('stops a round that runs past its wall clock', async () => {
        let clock = 0;
        const { adapter } = adapterFor([{ kind: 'tool_call', tool: 'read' }]);
        const outcome = await runReviewRound({
            packet: packet(),
            adapter,
            // The deadline is metered by the injected clock, not by how long the test takes.
            now: () => {
                clock += 2000;
                return clock;
            },
        });

        expect(outcome.status).toBe('timeout');
        expect(outcome.receipt).toBeUndefined();
        expect(outcome.reason).toContain('1000 ms');
    });

    it('is not part of the kata executable: src/ never imports host/', async () => {
        // The boundary is a checked fact, not a promise. `host/` produces the receipt for rounds that review kata's own
        // changes; if kata could call it, the authorised party would be producing its own independence evidence.
        const offenders: string[] = [];
        const walk = async (dir: string) => {
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
