import { describe, expect, it } from 'vitest';
import { ROUND_PROTOCOL_VERSION, type RoundEvent } from '../../src/quality/round-protocol.js';
import { decideRound, ROUND_ALLOWLIST, type RoundRunnerInput } from '../../src/quality/round-runner.js';

/**
 * **A declared capability the stream contradicts is a refusal** — criterion AC-2.
 *
 * This is the half a host-authored receipt could never support: a receipt is a statement about a session, and a statement nobody can refute
 * is what let a constant capability list certify a round that never ran (`aad-r7-f4`). A stream is observable, so a capability becomes a
 * proposition: a mutating tool call refutes `read_only_fs`, a tool outside the node's allow-list refutes `bounded_tools`.
 *
 * The cases live in their own file because a criterion's selector must be its own: the seal dedupes evidence by selector, so two criteria
 * sharing one file cannot both be evidenced by it — measured, AC-3/AC-4/AC-5 failed `insufficient_evidence_level` for exactly that reason.
 */

/** A request whose limits the cases can exceed on purpose. */
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

const launch = (capabilities: string[] = ['fresh_context', 'read_only_fs', 'bounded_tools', 'budget_enforced']): RoundEvent =>
    ({ kind: 'launched', protocol: ROUND_PROTOCOL_VERSION, capabilities: capabilities as never });

describe('a declared capability the stream contradicts refutes the round', () => {
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
});
