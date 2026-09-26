import type { ExecutorCapability } from './review-execution.js';

/**
 * **The host-facing protocol: one JSON object per line on the executor's stdout.**
 *
 * This is the whole interface a host must satisfy. It is a *data* contract rather than a TypeScript interface a host must import, because the
 * thing being decoupled is the platform: a `.ts`, `.mjs` or `.sh` command, or a platform extension, only has to emit these lines in order.
 *
 * It exists because of what the previous shape could not check (measured, `docs/design/2026-09-26-decoupled-round-protocol.md`): the receipt
 * was authored by the host and handed over once, at the end, so a capability claim was a statement nobody could refute — a constant
 * `['fresh_context','read_only_fs','bounded_tools','budget_enforced']` was returned for a process that never started, and that round came back
 * `completed`. A stream is observable, so the same claim becomes a proposition a check can refute (see `round-runner.ts`).
 *
 * **What this module owns:** the vocabulary, and the rules that decide whether a stream is a stream at all. It does not decide a round's
 * outcome — that is the runner's — and it writes nothing.
 */

/** The version kata speaks. A host that does not know it must fail rather than guess. */
export const ROUND_PROTOCOL_VERSION = 1;

/** A bound so a host cannot buffer kata out of memory with one line. The largest record measured here is 45 KB. */
export const MAX_EVENT_LINE_BYTES = 32 * 1024 * 1024;

export type RoundEvent =
    /** Once, first. `capabilities` is what the host claims it provides; the runner refutes it against the stream. */
    | { kind: 'launched'; protocol: number; capabilities: ExecutorCapability[]; platform?: string; sessionId?: string }
    | { kind: 'tool_call'; tool: string; target?: string }
    | { kind: 'output'; bytes: number }
    /** Figures only the host can observe. Absent means unmeasured — never zero-by-default. */
    | { kind: 'telemetry'; tokens?: number | null; truncations?: number | null; firstTurnTokens?: number | null }
    | { kind: 'result'; text: string }
    /** The host's own account of how it ended. The runner derives the round's status itself and keeps this as `hostReported`. */
    | { kind: 'ended'; status: 'completed' | 'budget_exhausted' | 'timeout' | 'cancelled'; reason?: string };

export const ROUND_EVENT_KINDS = ['launched', 'tool_call', 'output', 'telemetry', 'result', 'ended'] as const;

export interface ProtocolRefusal {
    /** The line number the refusal is about, 1-based, so an operator can open the stream and look. */
    line: number;
    detail: string;
}

export interface RoundParser {
    /** Feed a chunk of stdout. Lines split across chunks are one event: the remainder is kept. */
    feed(chunk: string): void;
    /** Everything that arrived, in order, plus the parser's own verdict about the stream's shape. */
    parse(): { events: RoundEvent[]; refusal: ProtocolRefusal | null };
}

/**
 * The parser. Its rules are the ones a host can violate by accident, and each refusal names the line and what was expected — a protocol whose
 * failure mode is "nothing was recorded and nobody knows why" is worse than no protocol.
 */
export function createRoundParser(input: { protocol?: number; maxLineBytes?: number } = {}): RoundParser {
    const protocol = input.protocol ?? ROUND_PROTOCOL_VERSION;
    const maxLineBytes = input.maxLineBytes ?? MAX_EVENT_LINE_BYTES;
    const events: RoundEvent[] = [];
    let refusal: ProtocolRefusal | null = null;
    let remainder = '';
    let lineNumber = 0;

    const refuse = (line: number, detail: string): void => {
        if (!refusal) refusal = { line, detail };
    };

    const accept = (raw: string): void => {
        lineNumber += 1;
        const line = raw.trim();
        if (line === '') return; // A blank line is not an event and not an error: a host may flush whatever it likes between them.
        if (Buffer.byteLength(line, 'utf8') > maxLineBytes) {
            refuse(lineNumber, `line ${lineNumber} is ${Buffer.byteLength(line, 'utf8')} bytes, over the ${maxLineBytes}-byte bound`);
            return;
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(line);
        } catch (error) {
            refuse(lineNumber, `line ${lineNumber} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
            return;
        }
        const event = asRoundEvent(parsed);
        if (!event) {
            refuse(lineNumber, `line ${lineNumber} is not a protocol event: ${line.slice(0, 60)}`);
            return;
        }
        if (events.length === 0 && event.kind !== 'launched') {
            refuse(lineNumber, `the first line was \`${event.kind}\`, not \`launched\``);
            return;
        }
        if (event.kind === 'launched' && events.some((entry) => entry.kind === 'launched')) {
            refuse(lineNumber, `line ${lineNumber} is a second \`launched\`; a stream describes one session`);
            return;
        }
        if (event.kind === 'launched' && event.protocol !== protocol) {
            refuse(lineNumber, `this host speaks protocol ${event.protocol}, kata speaks ${protocol} — the host must be updated, or the command must be run by a kata that speaks its version`);
            return;
        }
        if (events.some((entry) => entry.kind === 'ended')) {
            refuse(lineNumber, `line ${lineNumber} followed \`ended\`; the stream is over`);
            return;
        }
        if (event.kind === 'result' && events.some((entry) => entry.kind === 'result')) {
            refuse(lineNumber, `line ${lineNumber} is a second \`result\`; one round produces one record`);
            return;
        }
        events.push(event);
    };

    return {
        feed(chunk: string): void {
            if (refusal) return;
            remainder += chunk;
            const lines = remainder.split('\n');
            remainder = lines.pop() ?? '';
            for (const line of lines) {
                accept(line);
                if (refusal) return;
            }
            // A chunk that is one enormous line arrives whole in `remainder`; the bound is checked there so a host cannot make the buffer grow
            // without limit by never emitting a newline.
            if (Buffer.byteLength(remainder, 'utf8') > maxLineBytes) {
                refuse(lineNumber + 1, `a single unterminated line exceeded the ${maxLineBytes}-byte bound`);
            }
        },
        parse(): { events: RoundEvent[]; refusal: ProtocolRefusal | null } {
            if (!refusal && remainder.trim() !== '') {
                // A final line without a trailing newline is a real event, not a truncation.
                accept(remainder);
                remainder = '';
            }
            if (!refusal && events.length === 0) {
                refusal = { line: 1, detail: 'the stream carried no events at all, so nothing was launched' };
            }
            if (!refusal && !events.some((entry) => entry.kind === 'launched')) {
                refusal = { line: 1, detail: 'the stream carried no `launched` event' };
            }
            return { events, refusal };
        },
    };
}

/** A shape guard rather than a schema lookup per line: the schema is the documented definition, and a case asserts the two agree. */
function asRoundEvent(value: unknown): RoundEvent | null {
    if (typeof value !== 'object' || value === null) return null;
    const record = value as Record<string, unknown>;
    const kind = record.kind;
    if (typeof kind !== 'string' || !(ROUND_EVENT_KINDS as readonly string[]).includes(kind)) return null;
    switch (kind) {
        case 'launched': {
            if (typeof record.protocol !== 'number' || !Array.isArray(record.capabilities)) return null;
            return {
                kind: 'launched',
                protocol: record.protocol,
                capabilities: record.capabilities.filter((entry): entry is ExecutorCapability => typeof entry === 'string'),
                ...(typeof record.platform === 'string' ? { platform: record.platform } : {}),
                ...(typeof record.sessionId === 'string' ? { sessionId: record.sessionId } : {}),
            };
        }
        case 'tool_call':
            return typeof record.tool === 'string'
                ? { kind: 'tool_call', tool: record.tool, ...(typeof record.target === 'string' ? { target: record.target } : {}) }
                : null;
        case 'output':
            return typeof record.bytes === 'number' ? { kind: 'output', bytes: record.bytes } : null;
        case 'telemetry':
            return {
                kind: 'telemetry',
                tokens: numberOrNull(record.tokens),
                truncations: numberOrNull(record.truncations),
                firstTurnTokens: numberOrNull(record.firstTurnTokens),
            };
        case 'result':
            return typeof record.text === 'string' ? { kind: 'result', text: record.text } : null;
        case 'ended':
            return typeof record.status === 'string'
                ? { kind: 'ended', status: record.status as 'completed' | 'budget_exhausted' | 'timeout' | 'cancelled', ...(typeof record.reason === 'string' ? { reason: record.reason } : {}) }
                : null;
        default:
            return null;
    }
}

function numberOrNull(value: unknown): number | null {
    return typeof value === 'number' ? value : null;
}
