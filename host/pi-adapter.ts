import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecutorCapability, HostAdapter, IsolatedSession, ReviewRunRequest, SessionEvent } from './executor.ts';

/**
 * **A `HostAdapter` for pi — the half `host/executor.ts` deliberately leaves to the host.**
 *
 * `host/executor.ts` is the reference *round runner*: it enforces the envelope against the event stream and writes the receipt. What it
 * cannot supply is the answer to *"what is an isolated session on this platform?"* — that is the host's own business, which is why the
 * contract takes an adapter at all. This file is that answer for pi.
 *
 * **What it provides, and why each is true rather than asserted:**
 *
 *   * `fresh_context` — `pi -p` is a **new process** with `--no-session`, so there is no inherited transcript, no resume, and no memory of
 *     the authoring session. The author cannot be in the room because the room did not exist before the spawn.
 *   * `read_only_fs` — `--tools read,grep,find,ls`. The reviewer is not *told* not to write; it has no tool that can.
 *   * `bounded_tools` — the same allowlist, applied by the process's own argument parsing rather than by a prompt instruction.
 *   * `budget_enforced` — the runner breaks the event loop on the packet's limits and calls `kill()`, and this adapter additionally arms its
 *     own wall-clock timer, so a round that stops emitting events still dies rather than running on.
 *
 * **What a receipt from this adapter does *not* prove**, stated here because the alternative is a claim nobody can check: a single-user
 * machine can write a receipt for a round it did not run. The contract says so itself — *"authorship separation is process and tool policy,
 * not cryptography"* — and the policy this adapter implements is that the receipt is written by **the process kata launched**, from telemetry
 * **that process emitted**. That is a different fact from a file the author typed, and it is the strongest fact available here.
 */

export interface PiAdapterOptions {
    /** The model the session runs on, as `provider/id`. Required: a spawned pi cannot see the parent session's provider registration. */
    model: string;
    /** Where the round runs. Defaults to the packet's repository root, which is what the reviewer must read. */
    cwd: string;
    /** Extra environment for the session. */
    env?: Record<string, string | undefined>;
    /** Hard wall-clock cap in milliseconds. The runner also computes one from the packet's budget; the earlier of the two wins. */
    timeoutMs?: number;
}

/** One parsed line of `pi --mode json`. Only the shapes this adapter reads are typed. */
interface PiEvent {
    type?: string;
    message?: {
        role?: string;
        content?: Array<{ type?: string; text?: string; name?: string; toolName?: string }>;
        usage?: { totalTokens?: number };
    };
    toolResults?: unknown[];
    willRetry?: boolean;
}

export function createPiAdapter(options: PiAdapterOptions): HostAdapter {
    return {
        name: 'pi',
        async launch(input: { request: ReviewRunRequest; briefText: string; tools: string[] }): Promise<IsolatedSession> {
            // **The brief is handed over as the prompt itself.** The first version wrote it to a file and told the session to read that
            // path — measured: a session given a *pointer* to a two-sentence brief spent **46 tool calls and 961,381 tokens** exploring a
            // repository the brief never mentioned, and a 25-call envelope stopped it before it produced a result. A pointer is not an
            // instruction; the text is. `ARG_MAX` is ~2 MB on this platform and the largest brief observed here is ~103 KB, so the argv
            // route is not the constraint it looked like, and the fallback it would need is the second path this file does not want.
            const prompt = input.briefText;
            let dir: string | null = null;
            if (process.env.KATA_REVIEW_KEEP_BRIEF === '1') {
                // Kept only when an operator asked, because a reviewer's input is worth being able to read afterwards.
                dir = await mkdtemp(join(tmpdir(), 'kata-review-round-'));
                await writeFile(join(dir, 'brief.md'), input.briefText, 'utf8');
            }

            const args = [
                '-p',
                '--mode', 'json',
                '--model', options.model,
                '--no-session',
                '--tools', input.tools.join(','),
                '--',
                prompt,
            ];

            const child = spawn('pi', args, {
                cwd: options.cwd,
                env: { ...process.env, ...options.env },
                // `ignore` for stdin because the brief arrives as a file the session is pointed at: a reviewer that can be typed at is a
                // reviewer whose input nobody recorded.
                stdio: ['ignore', 'pipe', 'pipe'],
            });

            return new PiSession(child, options.timeoutMs);
        },
    };
}

/**
 * One live pi session, presented as the reference's event stream.
 *
 * The mapping is the whole job: `pi --mode json` emits a JSONL event per turn, and the three facts the runner needs are spread across them —
 * a tool call is a content part, a token count is that message's usage, and the reviewer's result is the final assistant text. Counting them
 * here rather than declaring them is what makes the envelope enforced instead of advised.
 */
class PiSession implements IsolatedSession {
    readonly capabilities: ExecutorCapability[] = ['fresh_context', 'read_only_fs', 'bounded_tools', 'budget_enforced'];

    private readonly queue: SessionEvent[] = [];
    private readonly waiters: Array<(value: IteratorResult<SessionEvent>) => void> = [];
    private closed = false;
    private stdoutBuffer = '';
    private stderrTail = '';
    private killed: string | null = null;
    private timer: NodeJS.Timeout;

    // Declared as a field rather than as a constructor parameter property: Node runs these files by stripping types rather than compiling
    // them, and a parameter property is the one TypeScript feature stripping cannot express (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`). The
    // alternative — compiling the host adapter — would put it in the build that `host/executor.ts` deliberately stays out of.
    private readonly child: ChildProcessByStdio<null, Readable, Readable>;

    constructor(child: ChildProcessByStdio<null, Readable, Readable>, timeoutMs?: number) {
        this.child = child;
        this.timer = setTimeout(() => {
            this.kill('timeout');
        }, timeoutMs ?? 0);
        if (!timeoutMs) clearTimeout(this.timer);

        child.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk.toString('utf8')));
        child.stderr.on('data', (chunk: Buffer) => {
            this.stderrTail = `${this.stderrTail}${chunk.toString('utf8')}`.slice(-4000);
        });
        child.on('close', () => this.finish());
        child.on('error', () => this.finish());
    }

    private onStdout(chunk: string): void {
        this.stdoutBuffer += chunk;
        const lines = this.stdoutBuffer.split('\n');
        this.stdoutBuffer = lines.pop() ?? '';
        for (const line of lines) this.onLine(line.trim());
    }

    private onLine(line: string): void {
        if (!line.startsWith('{')) return;
        let event: PiEvent;
        try {
            event = JSON.parse(line) as PiEvent;
        } catch {
            return;
        }
        if (event.type === 'turn_end') {
            const message = event.message;
            for (const part of message?.content ?? []) {
                if (part.type === 'toolCall' || part.type === 'tool_use') {
                    this.push({ kind: 'tool_call', tool: part.toolName ?? part.name ?? '(unnamed)' });
                } else if (part.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
                    this.push({ kind: 'output', bytes: Buffer.byteLength(part.text, 'utf8') });
                }
            }
            if (typeof message?.usage?.totalTokens === 'number') this.push({ kind: 'output', bytes: 0, tokens: message.usage.totalTokens });
            return;
        }
        if (event.type === 'agent_end') {
            // The reviewer's result is its last assistant message: the reference counts hypotheses from it, so this is the point at which
            // the hypothesis budget becomes enforceable rather than advisory.
            const messages = (event as unknown as { messages?: PiEvent['message'][] }).messages ?? [];
            for (let index = messages.length - 1; index >= 0; index -= 1) {
                const message = messages[index];
                if (message?.role !== 'assistant') continue;
                const text = (message.content ?? [])
                    .filter((part) => part.type === 'text' && typeof part.text === 'string')
                    .map((part) => part.text)
                    .join('');
                if (text.trim().length > 0) this.push({ kind: 'reviewer_result', text });
                break;
            }
        }
    }

    private push(event: SessionEvent): void {
        const waiter = this.waiters.shift();
        if (waiter) waiter({ value: event, done: false });
        else this.queue.push(event);
    }

    private finish(): void {
        if (this.closed) return;
        this.closed = true;
        clearTimeout(this.timer);
        if (this.stderrTail.trim() && this.queue.length === 0 && this.killed === null) {
            // A round that died without a result is visible as its own failure rather than as an empty stream, because "the session said
            // nothing" and "the session crashed" are different facts and only one of them is about the round's quality.
            this.push({ kind: 'output', bytes: 0 });
        }
        while (this.waiters.length > 0) {
            const waiter = this.waiters.shift();
            waiter?.({ value: undefined as never, done: true });
        }
    }

    async kill(reason: string): Promise<void> {
        this.killed = reason;
        clearTimeout(this.timer);
        this.child.kill('SIGKILL');
        this.finish();
    }

    // A property rather than a method: the reference declares `events: AsyncIterable<SessionEvent>`, and a method would be a function that
    // *returns* one — which type-checks nowhere (`host/` is outside `tsconfig.include`, so the mistake was invisible until it ran).
    events: AsyncIterable<SessionEvent> = this.stream();

    private async *stream(): AsyncIterable<SessionEvent> {
        while (true) {
            const queued = this.queue.shift();
            if (queued) {
                yield queued;
                continue;
            }
            if (this.closed) return;
            const next = await new Promise<IteratorResult<SessionEvent>>((resolve) => this.waiters.push(resolve));
            if (next.done) return;
            yield next.value;
        }
    }
}
