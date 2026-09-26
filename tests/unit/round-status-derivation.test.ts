import { describe, expect, it } from 'vitest';
import { ROUND_PROTOCOL_VERSION, type RoundEvent } from '../../src/quality/round-protocol.js';
import { decideRound, ROUND_ALLOWLIST, type RoundRunnerInput } from '../../src/quality/round-runner.js';

/**
 * **The round's status is derived from the stream, not reported by the host** — criterion AC-3.
 *
 * Two rules, both about who decides: a session that produced no result certifies nothing however the host describes its ending, and the
 * envelope is counted by the party it bounds. A figure nobody measured stays `null` rather than becoming a zero that reads like a
 * measurement (`aad-r7-f3`).
 */

/** A request whose limits the cases can exceed on purpose. */
const REQUEST = {
    runId: 'run-1',
    requestSha256: 'a'.repeat(64),
    requiredCapabilities: ['fresh_context', 'read_only_fs'] as const,
    budget: { maxHypotheses: 6, maxToolCalls: 10, maxOutputBytes: 1000, maxWallMs: 60_000 },
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

const launch = (capabilities: string[] = ['fresh_context', 'read_only_fs', 'bounded_tools', 'budget_enforced']): RoundEvent =>
    ({ kind: 'launched', protocol: ROUND_PROTOCOL_VERSION, capabilities: capabilities as never });

describe('the round status comes from the stream, not from the host', () => {
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
