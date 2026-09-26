import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import type { Readable } from 'node:stream';

/**
 * **A pi executor for `kata-cli adversarial execute` — the host half of the round protocol.**
 *
 * It launches an isolated session and **describes** it. It does not enforce the envelope, does not decide the round's status, and does not write a
 * receipt: kata reads these lines, counts them, refutes any capability they contradict, and writes the artefact itself
 * (`docs/design/2026-09-26-decoupled-round-protocol.md`). That split is what makes a capability claim checkable — the previous shape had the host
 * author the receipt, and a constant capability list was returned for a process that never started while the round came back `completed`
 * (`aad-r7-f4`).
 *
 * ```bash
 * kata-cli adversarial execute --change <id> --node review --packet <p> --executor "node host/pi-adapter.ts"
 * ```
 *
 * **What it claims, and why each is true rather than asserted:**
 *
 *   * `fresh_context` — `pi -p --no-session` is a new process: no inherited transcript, no resume, no memory of the authoring session.
 *   * `read_only_fs` / `bounded_tools` — `--tools read,grep,find,ls` is applied by the child's own argument parsing. Kata refutes this from the
 *     stream: a `tool_call` outside the allowlist refuses the round, so the claim is a proposition rather than a promise.
 *   * `budget_enforced` — kata enforces it, including the wall clock: `runProcess` arms the kill, so this file holds no timer and reads no
 *     budget. An earlier version did both, which is why the boundary case in `tests/unit/round-boundary.test.ts` now names the whole family of
 *     strings it must not contain rather than the three it happened to have thought of.
 */

interface Packet {
    // `runId` and `briefSha256` are read for one purpose: asserting that the packet's two halves agree. Everything else the request carries
    // — the budget above all — belongs to kata, and a host that reads it is a host that enforces it.
    request: { runId: string; briefSha256: string };
    brief?: { sha256?: string; text?: string; lines?: string[] };
}

/** The protocol version this file speaks. A mismatch is kata's to refuse, and it says so by name. */
const PROTOCOL = 1;
const CAPABILITIES = ['fresh_context', 'read_only_fs', 'bounded_tools', 'budget_enforced'] as const;

function emit(event: Record<string, unknown>): void {
    process.stdout.write(`${JSON.stringify(event)}\n`);
}

async function main(): Promise<number> {
    const packetPath = process.env.KATA_REVIEW_PACKET;
    if (!packetPath) {
        process.stderr.write('KATA_REVIEW_PACKET is required: this command is declared to `kata-cli adversarial execute`, which provides it.\n');
        return 2;
    }
    const packet = JSON.parse(await readFile(packetPath, 'utf8')) as Packet;
    // The packet delivers the brief as `lines` (so a reviewer's own tools can open it) or as `text`; the session is handed the text either way.
    // **The cross-check the type beside it claims** (`rpr7-f3`): the packet's two halves must agree, and a host that spawns a session anyway
    // is a host that would feed a session material its own request hash does not name.
    if (packet.brief?.sha256 && packet.brief.sha256 !== packet.request.briefSha256) {
        process.stderr.write(`the packet's brief does not bind to its request: brief.sha256 is ${packet.brief.sha256}, request.briefSha256 is ${packet.request.briefSha256}.\n`);
        return 2;
    }
    const brief = packet.brief?.text ?? (packet.brief?.lines ?? []).join('\n');
    if (!brief.trim()) {
        process.stderr.write('the packet carries no brief text, so the session would be given no instruction set.\n');
        return 2;
    }

    const model = process.env.KATA_REVIEW_MODEL ?? 'litellm/deepseek-v4.1-flash-goat';
    // **No budget arithmetic here.** An earlier version read `budget.maxWallMs`, added 30 000 ms and armed its own kill — which is the
    // envelope's wall-clock term, computed from the packet and enforced by the host. Kata already arms that kill through `runProcess`, so the
    // adapter's timer was a second enforcement of a limit it does not own, and criterion AC-5 says it holds none.

    // **`launched` is emitted before the session starts, and it is a claim kata will check.** If the child cannot be spawned at all, this file
    // emits no `result` — and a stream without a result is refused, which is the honest outcome for a round that never ran.
    emit({ kind: 'launched', protocol: PROTOCOL, capabilities: [...CAPABILITIES], platform: 'pi' });

    const args = [
        '-p',
        '--mode', 'json',
        '--model', model,
        '--no-session',
        '--tools', 'read,grep,find,ls',
        '--',
        // **The brief is the prompt.** Measured: a session handed a *path* to a two-sentence brief spent 46 tool calls and 961,381 tokens
        // exploring a repository the brief never mentioned, while handing it the text took 0 calls and 18,046 tokens. A pointer is not an
        // instruction; the text is.
        brief,
    ];
    const child = spawn('pi', args, { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }) as ChildProcessByStdio<null, Readable, Readable>;

    // **The transcript, so a round that never emits a record is still readable.** Measured on this repository: a session can read ninety
    // times and end without writing the record, and the process route had no second channel at all — kata saw only the events the adapter
    // forwarded, so the work was unrecoverable. `kata-cli adversarial salvage` reads a transcript; this is the file it reads, written
    // beside the packet unless `KATA_REVIEW_TRANSCRIPT` names another place.
    const transcriptPath = process.env.KATA_REVIEW_TRANSCRIPT ?? `${packetPath}.transcript.jsonl`;
    const transcript = createWriteStream(transcriptPath, { flags: 'a' });

    let buffer = '';
    let result: string | null = null;
    let stderrTail = '';

    child.stdout.on('data', (chunk: Buffer) => {
        transcript.write(chunk);
        buffer += chunk.toString('utf8');
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) handleLine(line.trim());
    });
    child.stderr.on('data', (chunk: Buffer) => {
        stderrTail = `${stderrTail}${chunk.toString('utf8')}`.slice(-2000);
    });

    function handleLine(line: string): void {
        if (!line.startsWith('{')) return;
        let event: { type?: string; message?: { content?: Array<{ type?: string; text?: string; toolName?: string; name?: string }>; usage?: Record<string, number> }; messages?: Array<{ role?: string; content?: Array<{ type?: string; text?: string }> }>; toolResults?: unknown[] };
        try {
            event = JSON.parse(line) as typeof event;
        } catch {
            return;
        }
        if (event.type === 'turn_end') {
            const message = event.message;
            for (const part of message?.content ?? []) {
                // **A part the adapter cannot name is not a tool call.** `'(unnamed)'` was emitted here, and since it is in no allow-list it
                // reported a parsing gap as a capability refutation (`rpr7-f5`) — the stream saying "this host does not know what it saw" while
                // the refusal said "this host called something forbidden". Reporting the bytes and saying nothing else is the honest form.
                if (part.type === 'toolCall' || part.type === 'tool_use') {
                    const tool = part.toolName ?? part.name;
                    if (tool) emit({ kind: 'tool_call', tool });
                    else emit({ kind: 'output', bytes: Buffer.byteLength(JSON.stringify(part), 'utf8') });
                }
                else if (part.type === 'text' && typeof part.text === 'string' && part.text.length > 0) emit({ kind: 'output', bytes: Buffer.byteLength(part.text, 'utf8') });
            }
            const usage = message?.usage;
            if (usage) {
                // **What this round is charged, not what one turn's context cost.** Each `turn_end` reports the usage of *that API call*, whose
                // input is the whole conversation so far, so summing `totalTokens` counts the same context once per turn — one round reported
                // 11.75 M that way (`aad-r7-f3`). The billed quantity is what each call added: its output plus the input no earlier call cached.
                const billed = (usage.input ?? 0) - (usage.cacheRead ?? 0) + (usage.output ?? 0) + (usage.reasoning ?? 0);
                if (billed > 0) emit({ kind: 'telemetry', tokens: billed, ...(result === null ? { firstTurnTokens: billed } : {}) });
            }
            const toolResultBytes = Buffer.byteLength(JSON.stringify(event.toolResults ?? []), 'utf8');
            if (toolResultBytes > 2) emit({ kind: 'output', bytes: toolResultBytes });
            return;
        }
        if (event.type === 'agent_end') {
            // The reviewer's result is its last assistant message; the record is the last balanced JSON object in it that names a `node`.
            const messages = event.messages ?? [];
            for (let index = messages.length - 1; index >= 0; index -= 1) {
                const message = messages[index]!;
                if (message.role !== 'assistant') continue;
                const text = (message.content ?? []).filter((part) => part.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('');
                const record = extractRecord(text);
                if (record) result = record;
                break;
            }
            if (result !== null) emit({ kind: 'result', text: result });
        }
    }

    const exitCode = await new Promise<number>((resolve) => {
        child.on('close', (code) => resolve(code ?? 0));
        child.on('error', (error) => {
            stderrTail = `${stderrTail}${error.message}`.slice(-2000);
            resolve(-1);
        });
    });
    transcript.end();
    if (result === null) {
        // The host's own account of how it ended. Kata derives the round's status itself and keeps this verbatim, so a disagreement is visible
        // rather than authoritative.
        emit({ kind: 'ended', status: exitCode === 0 ? 'completed' : 'cancelled', reason: stderrTail.trim().slice(-400) || `exit ${exitCode}` });
        process.stderr.write(`no record-shaped result was produced; exit ${exitCode}${stderrTail.trim() ? `: ${stderrTail.trim().slice(-400)}` : ''}`
            + ` The raw transcript is at ${transcriptPath}, which \`kata-cli adversarial salvage\` can read.\n`);
        return 1;
    }
    emit({ kind: 'ended', status: 'completed' });
    return 0;
}

/** The last balanced JSON object in the text that names a `node`, or null. Literal on purpose: an executor does not interpret a reviewer. */
function extractRecord(text: string): string | null {
    for (let start = text.lastIndexOf('{'); start >= 0; start = text.lastIndexOf('{', start - 1)) {
        const end = balancedEnd(text, start);
        if (end < 0) continue;
        const candidate = text.slice(start, end + 1);
        try {
            const parsed = JSON.parse(candidate) as { node?: unknown };
            if (parsed && typeof parsed === 'object' && 'node' in parsed) return candidate;
        } catch {
            continue;
        }
    }
    return null;
}

function balancedEnd(text: string, start: number): number {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
        const char = text[index];
        if (escaped) { escaped = false; continue; }
        if (char === '\\') { escaped = true; continue; }
        if (char === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (char === '{') depth += 1;
        else if (char === '}') {
            depth -= 1;
            if (depth === 0) return index;
        }
    }
    return -1;
}

process.exitCode = await main();
