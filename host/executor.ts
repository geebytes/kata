/**
 * The **reference declared command** for `kata-cli adversarial execute`.
 *
 * Under option A, kata runs a declared command and reads the receipt it writes; it does not decide how a session is
 * isolated, and this file is not part of `kata-cli`. It exists to show that the contract is satisfiable and to keep the
 * envelope/telemetry logic testable without a host — a project may declare any equivalent command instead, including a
 * shell script, and the contract does not change.
 *
 * It reaches the packet and the receipt through the environment, which is the interface `execute` provides:
 *   KATA_REVIEW_PACKET   the path of the packet to run
 *   KATA_REVIEW_RECEIPT  the path this command must write its receipt to
 */


export interface ReviewEnvelope {
    maxHypotheses: number;
    maxToolCalls: number;
    maxOutputBytes: number;
    maxWallMs: number;
}

export type ExecutorCapability = 'fresh_context' | 'read_only_fs' | 'bounded_tools' | 'budget_enforced';

export interface ReviewRunRequest {
    runId: string;
    requestSha256: string;
    briefSha256: string;
    budget: ReviewEnvelope;
    requiredCapabilities: ExecutorCapability[];
}

/** What the host was handed: the request, and verbatim the brief it names. */
export interface ReviewPacket {
    request: ReviewRunRequest;
    brief: { sha256: string; text: string };
}

export interface SessionEvent {
    kind: 'tool_call' | 'output' | 'reviewer_result';
    /** Present for `tool_call`. */
    tool?: string;
    /** Present for `output`; the bytes the platform reported for that chunk. */
    bytes?: number;
    /** Present for `reviewer_result`; the JSON body the reviewer produced, as text. */
    text?: string;
    tokens?: number;
    truncations?: number;
}

/** A session the adapter has already isolated. Its `capabilities` are the adapter's claim about what it did. */
export interface IsolatedSession {
    capabilities: ExecutorCapability[];
    events: AsyncIterable<SessionEvent>;
    kill(reason: string): Promise<void>;
}

export interface HostAdapter {
    /** Named in diagnostics; the contract does not depend on which host this is. */
    name: string;
    launch(input: { request: ReviewRunRequest; briefText: string; tools: string[] }): Promise<IsolatedSession>;
}

export type ExecutionStatus = 'completed' | 'budget_exhausted' | 'timeout' | 'cancelled' | 'executor_unavailable';

export interface ReviewExecutionTelemetry {
    toolCalls: number;
    outputBytes: number;
    tokens: number;
    truncations: number;
}

export interface ReviewExecutionReceipt {
    runId: string;
    requestSha256: string;
    capabilities: ExecutorCapability[];
    startedAt: string;
    endedAt: string;
    telemetry: ReviewExecutionTelemetry;
    status: ExecutionStatus;
}

export interface RoundOutcome {
    /** Absent whenever the round did not run to a conclusion — a capability was missing, or the packet did not bind. */
    receipt?: ReviewExecutionReceipt;
    status: ExecutionStatus;
    reason: string;
    /** The reviewer's own result body, when the session produced one. */
    reviewerResult?: string;
}

export interface RoundOptions {
    packet: ReviewPacket;
    adapter: HostAdapter;
    /** The read-only tool set the adapter must grant. */
    tools?: string[];
    /** Injected clock, in milliseconds. A round is metered, never approximated to wall time by the caller. */
    now: () => number;
}

/**
 * Run one round and produce its receipt.
 *
 * Every refusal returns **no receipt**: an execution receipt states that a capable session ran under an enforced
 * envelope, so producing one for a round that did not is the defect this component exists to avoid. Nothing here is
 * validated by trust — the binding is checked against the packet, and the envelope is enforced against the event stream
 * rather than declared.
 */
export async function runReviewRound(options: RoundOptions): Promise<RoundOutcome> {
    const { packet, adapter, now } = options;
    const { request, brief } = packet;

    // The brief must be the one the request names. A packet whose halves disagree cannot be run: the pass would be bound
    // to a brief the session never read.
    if (brief.sha256 !== request.briefSha256) {
        return { status: 'executor_unavailable', reason: `the packet's brief does not bind to its request: brief.sha256 is ${brief.sha256}, request.briefSha256 is ${request.briefSha256}` };
    }
    if (!brief.text.trim()) {
        return { status: 'executor_unavailable', reason: 'the packet carries no brief text, so the session would be given no checklist' };
    }

    const startedAt = new Date(now()).toISOString();
    const deadline = now() + request.budget.maxWallMs;
    const tools = options.tools ?? ['read', 'grep', 'find', 'ls'];

    const session = await adapter.launch({ request, briefText: brief.text, tools });

    const missing = request.requiredCapabilities.filter((capability) => !session.capabilities.includes(capability));
    if (missing.length > 0) {
        await session.kill('capability_missing');
        // `executor_unavailable`, not a weaker receipt: this host cannot certify this node, and saying so is the useful
        // outcome. Emitting a receipt with a shorter capability list would be reporting a degraded pass as a pass.
        return { status: 'executor_unavailable', reason: `the host did not provide ${missing.join(', ')}, which this node requires` };
    }

    const telemetry: ReviewExecutionTelemetry = { toolCalls: 0, outputBytes: 0, tokens: 0, truncations: 0 };
    let reviewerResult: string | undefined;
    let hypotheses = 0;
    let stopped: { status: ExecutionStatus; reason: string } | undefined;

    for await (const event of session.events) {
        if (event.kind === 'tool_call') telemetry.toolCalls += 1;
        if (event.kind === 'output') telemetry.outputBytes += event.bytes ?? 0;
        if (event.kind === 'reviewer_result' && typeof event.text === 'string') reviewerResult = event.text;
        telemetry.tokens += event.tokens ?? 0;
        telemetry.truncations += event.truncations ?? 0;
        if (event.kind === 'reviewer_result') hypotheses += countHypotheses(event.text);

        if (telemetry.toolCalls > request.budget.maxToolCalls) {
            stopped = { status: 'budget_exhausted', reason: `the round used ${telemetry.toolCalls} tool calls against a limit of ${request.budget.maxToolCalls}` };
        } else if (telemetry.outputBytes > request.budget.maxOutputBytes) {
            stopped = { status: 'budget_exhausted', reason: `the round produced ${telemetry.outputBytes} output bytes against a limit of ${request.budget.maxOutputBytes}` };
        } else if (hypotheses > request.budget.maxHypotheses) {
            stopped = { status: 'budget_exhausted', reason: `the round raised ${hypotheses} hypotheses against a limit of ${request.budget.maxHypotheses}` };
        } else if (now() > deadline) {
            stopped = { status: 'timeout', reason: `the round exceeded ${request.budget.maxWallMs} ms` };
        }
        if (stopped) break;
    }

    if (stopped) {
        await session.kill(stopped.status);
        return { status: stopped.status, reason: stopped.reason };
    }

    const status: ExecutionStatus = 'completed';
    return {
        status,
        reason: 'the round ran to a conclusion under an enforced envelope',
        ...(reviewerResult === undefined ? {} : { reviewerResult }),
        receipt: {
            runId: request.runId,
            requestSha256: request.requestSha256,
            capabilities: session.capabilities,
            startedAt,
            endedAt: new Date(now()).toISOString(),
            telemetry,
            status,
        },
    };
}

/** Counts the hypotheses a reviewer result declares, so the hypothesis limit is enforced rather than advised. */
function countHypotheses(text: string | undefined): number {
    if (typeof text !== 'string') return 0;
    try {
        const parsed = JSON.parse(text) as { hypotheses?: unknown };
        return Array.isArray(parsed.hypotheses) ? parsed.hypotheses.length : 0;
    } catch {
        return 0;
    }
}
