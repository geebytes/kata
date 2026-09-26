import type { ExecutionStatus, ExecutorCapability, ReviewExecutionReceipt } from './review-execution.js';
import type { ProtocolRefusal, RoundEvent } from './round-protocol.js';

/**
 * **Kata decides what a round was, from the stream it watched.**
 *
 * The previous shape let the host write the receipt, so the party whose independence is in question authored the artefact that certifies it. It
 * also meant a capability claim could not be checked against anything: the constant `['fresh_context','read_only_fs','bounded_tools','budget_enforced']`
 * was returned for a process that never started and the round came back `completed` (finding `aad-r7-f4`, from the first round this flow ever
 * executed).
 *
 * Here the host launches and describes; kata counts, refutes, decides, and writes. Every path but `completed` writes **no receipt** — the
 * artefact exists only when a session produced a result *and* nothing the stream showed contradicted what the host claimed.
 *
 * Nothing in this module spawns a process, reads a clock or touches the filesystem, so every rule below is testable without a host.
 */

/**
 * Tools that only read. **The positive list, not a list of writers.**
 *
 * The first version enumerated mutating tools (`write`, `edit`, `bash`, …) and was refuted by measurement: `powershell` is a first-class
 * built-in of the very platform this repository ships an adapter for, it was not in the list, and a stream declaring the two capabilities the
 * review node requires was therefore never checked against the allow-list at all — the predicate was gated on the host *volunteering*
 * `bounded_tools`, which the review node does not require. Naming what is permitted cannot miss a writer nobody thought of.
 */
export const READ_ONLY_TOOLS = ['read', 'grep', 'find', 'ls'] as const;

/**
 * The tools a review round may call. **Kata's list, not the host's** — which is what makes `bounded_tools` a proposition the stream can refute
 * rather than a claim about a prompt. A node that needed a wider set would widen this constant, and the widening would be a kata change with a
 * test, rather than a sentence in a host's documentation.
 */
export const ROUND_ALLOWLIST = READ_ONLY_TOOLS;

export interface RoundRequestFacts {
    runId: string;
    requestSha256: string;
    requiredCapabilities: ExecutorCapability[];
    budget: { maxHypotheses: number; maxToolCalls: number; maxOutputBytes: number; maxWallMs: number };
}

export interface RoundRunnerInput {
    request: RoundRequestFacts;
    events: RoundEvent[];
    /** The parser's verdict about the stream's shape, if it had one. A stream that is not a stream is a round that did not run. */
    refusal: ProtocolRefusal | null;
    /** The tools this node permits. A call outside it refutes a declared `bounded_tools`. */
    allowlist: readonly string[];
    startedAt: string;
    endedAt: string;
    elapsedMs: number;
    /** True when the process was killed at the wall-clock bound rather than ending on its own. */
    timedOut: boolean;
}

export interface RoundExecuted {
    status: 'completed';
    receipt: ReviewExecutionReceipt;
    /** The reviewer's record, verbatim. */
    record: string;
    /** What the host said about its own ending, kept beside kata's derivation. */
    hostReported: { status: string; reason?: string } | null;
    telemetry: ReviewExecutionReceipt['telemetry'];
    /** Always empty: a round that completed broke none of the rules, and one shape for both outcomes keeps the caller from branching. */
    refusals: [];
}

export interface RoundRefused {
    status: Exclude<ExecutionStatus, 'completed'>;
    reason: string;
    /** Every rule this stream broke, so an operator sees all of them rather than the first. */
    refusals: string[];
    hostReported: { status: string; reason?: string } | null;
}

export type RoundOutcome = RoundExecuted | RoundRefused;

export function decideRound(input: RoundRunnerInput): RoundOutcome {
    const refusals: string[] = [];
    const ended = input.events.find((event): event is Extract<RoundEvent, { kind: 'ended' }> => event.kind === 'ended');
    const hostReported = ended ? { status: ended.status, ...(ended.reason ? { reason: ended.reason } : {}) } : null;
    const refuse = (status: RoundRefused['status'], reason: string): RoundRefused => ({ status, reason, refusals, hostReported });

    // 1. A stream that is not a stream describes no round, whatever it contains.
    if (input.refusal) {
        refusals.push(`line ${input.refusal.line}: ${input.refusal.detail}`);
        return refuse('executor_unavailable', `the round's stream is not a protocol stream — ${input.refusal.detail}`);
    }

    // 2. What the host says it provides, against what this node requires.
    const launched = input.events.find((event): event is Extract<RoundEvent, { kind: 'launched' }> => event.kind === 'launched');
    if (!launched) {
        refusals.push('no `launched` event');
        return refuse('executor_unavailable', 'the stream carried no `launched` event, so no session was described');
    }
    const missing = input.request.requiredCapabilities.filter((capability) => !launched.capabilities.includes(capability));
    if (missing.length > 0) {
        refusals.push(`the host did not provide ${missing.join(', ')}`);
        return refuse('executor_unavailable', `the host did not provide ${missing.join(', ')}, which this node requires`);
    }

    // 3. The same claims, refuted by the stream rather than taken on faith. This is the half a receipt could never check: a capability is only a
    //    fact if something observable would have looked different had it been false.
    //
    //    **The allow-list applies unconditionally.** It is kata's list, not the host's declaration, and gating the check on the host
    //    volunteering `bounded_tools` left the review node — which requires only `fresh_context` and `read_only_fs` — with no tool check at all.
    const declared = launched.capabilities;
    const calls = input.events.filter((event): event is Extract<RoundEvent, { kind: 'tool_call' }> => event.kind === 'tool_call');
    const outside = calls.filter((call) => !input.allowlist.includes(call.tool));
    if (outside.length > 0) {
        const first = outside[0]!;
        refusals.push(`\`${first.tool}\` was called${first.target ? ` on ${first.target}` : ''}, outside the allowlist ${input.allowlist.join(', ')}`);
        return refuse(
            'executor_unavailable',
            `the stream shows a call to \`${first.tool}\`, which is outside this node's allowlist (${input.allowlist.join(', ')})`
                + `${declared.filter((capability) => capability === 'read_only_fs' || capability === 'bounded_tools').length > 0
                    ? ` — ${declared.filter((capability) => capability === 'read_only_fs' || capability === 'bounded_tools').join(' and ')} ${declared.length > 1 ? 'were' : 'was'} declared, and a capability the stream contradicts is not a capability`
                    : ''}`,
        );
    }

    // 4. The envelope, counted here rather than reported by the party it bounds.
    const telemetry = countTelemetry(input.events);
    const result = input.events.find((event): event is Extract<RoundEvent, { kind: 'result' }> => event.kind === 'result');
    const hypotheses = countHypotheses(result?.text);
    if (telemetry.toolCalls !== null && telemetry.toolCalls > input.request.budget.maxToolCalls) {
        refusals.push(`the round used ${telemetry.toolCalls} tool calls against a limit of ${input.request.budget.maxToolCalls}`);
        return refuse('budget_exhausted', `the round used ${telemetry.toolCalls} tool calls against a limit of ${input.request.budget.maxToolCalls}`);
    }
    if (telemetry.outputBytes !== null && telemetry.outputBytes > input.request.budget.maxOutputBytes) {
        refusals.push(`the round produced ${telemetry.outputBytes} output bytes against a limit of ${input.request.budget.maxOutputBytes}`);
        return refuse('budget_exhausted', `the round produced ${telemetry.outputBytes} output bytes against a limit of ${input.request.budget.maxOutputBytes}`);
    }
    if (hypotheses > input.request.budget.maxHypotheses) {
        refusals.push(`the round raised ${hypotheses} hypotheses against a limit of ${input.request.budget.maxHypotheses}`);
        return refuse('budget_exhausted', `the round raised ${hypotheses} hypotheses against a limit of ${input.request.budget.maxHypotheses}`);
    }
    // **Measured here, not taken from the child's exit code.** `timedOut` is the caller's reading of `exitCode === 124`, which a child can
    //    reach for its own reasons; `elapsedMs` is kata's own clock, and it was computed, passed and never read — so a round that ran sixty
    //    times past `maxWallMs` was certified while this branch claimed the wall clock was enforced.
    if (input.elapsedMs > input.request.budget.maxWallMs) {
        refusals.push(`the round ran ${input.elapsedMs} ms against a limit of ${input.request.budget.maxWallMs} ms`);
        return refuse('timeout', `the round ran ${input.elapsedMs} ms against a limit of ${input.request.budget.maxWallMs} ms`);
    }
    if (input.timedOut) {
        refusals.push(`the process was killed at the wall-clock bound (${input.request.budget.maxWallMs} ms)`);
        return refuse('timeout', `the process was killed at the wall-clock bound (${input.request.budget.maxWallMs} ms)`);
    }

    // 5. The result. A session can only produce one by running, so its absence is a refusal rather than an empty conclusion — and kata's
    //    derivation wins over the host's own account of how it ended.
    if (!result) {
        refusals.push('the stream carried no `result` event');
        return refuse('executor_unavailable', `the session produced no result, so there is nothing to certify${hostReported ? ` (the host reported \`${hostReported.status}\`)` : ''}`);
    }

    return {
        status: 'completed',
        record: result.text,
        hostReported,
        telemetry,
        refusals: [],
        receipt: {
            runId: input.request.runId,
            requestSha256: input.request.requestSha256,
            capabilities: launched.capabilities,
            startedAt: input.startedAt,
            endedAt: input.endedAt,
            telemetry,
            // The host's own completion line, verbatim, under the field the contract already defines for exactly that: the source an auditor
            // can compare against the platform's record. Nothing else about the host is written, because kata has no platform of its own to name.
            ...(launched.platform || launched.sessionId || hostReported
                ? {
                    executor: {
                        platform: launched.platform ?? '(unspecified)',
                        ...(launched.sessionId ? { sessionId: launched.sessionId } : {}),
                        ...(hostReported ? { completionReport: JSON.stringify(hostReported) } : {}),
                    },
                }
                : {}),
            status: 'completed',
        },
    };
}

/**
 * Counts, from the stream. `null` means *not measured* and stays `null`: a zero the host never produced is the defect `aad-r7-f3` found — a
 * figure reported as measured-and-zero makes `unmeasuredTelemetry` report that nothing was unmeasured.
 */
export function countTelemetry(events: RoundEvent[]): ReviewExecutionReceipt['telemetry'] {
    const calls = events.filter((event) => event.kind === 'tool_call').length;
    const declared = events.find((event): event is Extract<RoundEvent, { kind: 'telemetry' }> => event.kind === 'telemetry');
    // Output bytes come from the events kata saw; the host may also declare them, and the larger of the two is the honest bound because
    // under-reporting is the failure mode that matters.
    const observedBytes = events.reduce((total, event) => (event.kind === 'output' ? total + event.bytes : total), 0);
    return {
        toolCalls: calls,
        outputBytes: events.some((event) => event.kind === 'output') ? observedBytes : null,
        tokens: declared?.tokens ?? null,
        truncations: declared?.truncations ?? null,
    };
}

/** The first `telemetry` line's `tokens`, which is the closest thing to a `fresh_context` proxy the stream carries. Recorded, never gated. */
export function firstTurnTokens(events: RoundEvent[]): number | null {
    const declared = events.find((event): event is Extract<RoundEvent, { kind: 'telemetry' }> => event.kind === 'telemetry');
    return declared?.firstTurnTokens ?? declared?.tokens ?? null;
}

/** Counts the hypotheses a result declares, so the hypothesis limit is enforced rather than advised. */
export function countHypotheses(text: string | undefined): number {
    if (typeof text !== 'string') return 0;
    try {
        const parsed = JSON.parse(text) as { hypotheses?: unknown };
        return Array.isArray(parsed.hypotheses) ? parsed.hypotheses.length : 0;
    } catch {
        return 0;
    }
}
