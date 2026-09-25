#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { runReviewRound, type ReviewPacket } from './executor.ts';
import { createPiAdapter } from './pi-adapter.ts';

/**
 * **The declared command for `kata-cli adversarial execute` on pi.**
 *
 * ```bash
 * kata-cli adversarial brief --change <id> --node review --emit-request tmp/packet.json
 * kata-cli adversarial execute --change <id> --node review --packet tmp/packet.json \
 *     --executor "node host/run-round.ts" --receipt-out tmp/packet.receipt.json
 * kata-cli adversarial record --change <id> --node review \
 *     --from-file tmp/packet.result.json --receipt-file tmp/packet.receipt.json
 * ```
 *
 * The contract, in `execute`'s own words: *"kata runs a **declared** command and validates the receipt it writes. Kata does not decide how a
 * session is isolated — the command does."* So this file decides, for pi:
 *
 *   * the session is `pi -p --mode json --no-session` in a **new process** with a read-only tool allowlist (`host/pi-adapter.ts`);
 *   * the envelope is enforced by `runReviewRound` against the **event stream** — tool calls, output bytes, hypotheses and wall clock —
 *     rather than declared by anyone;
 *   * the receipt is written **only** when a capable session ran to a conclusion. Every refusal writes no receipt and exits non-zero, because
 *     `execute` reads receipt-or-nothing and a receipt for a round that did not run is the defect this whole boundary exists to prevent.
 *
 * The reviewer's result is written beside the receipt as `<receipt>.result.json`, extracted from its final message, so the third command above
 * has something to record. Extraction is deliberately literal — the **last** balanced JSON object in the result that names a `node` — because
 * the alternative is a host that decides what the reviewer meant.
 */

async function main(): Promise<number> {
    const packetPath = process.env.KATA_REVIEW_PACKET;
    const receiptPath = process.env.KATA_REVIEW_RECEIPT;
    if (!packetPath || !receiptPath) {
        process.stderr.write('KATA_REVIEW_PACKET and KATA_REVIEW_RECEIPT are both required: this command is declared to `kata-cli adversarial execute`, which provides them.\n');
        return 2;
    }

    const packetRaw = await readFile(packetPath, 'utf8').catch(() => null);
    if (packetRaw === null) {
        process.stderr.write(`no packet at ${packetPath}\n`);
        return 2;
    }
    const packet = JSON.parse(packetRaw) as ReviewPacket;

    // The model is not a decision kata makes, and a spawned pi cannot see the parent session's provider registration — measured: without an
    // explicit model a subprocess call fails with `Request is missing x-opencode-session`. So the host supplies it, and the default is the
    // one this repository has been dispatching rounds with all along.
    const model = process.env.KATA_REVIEW_MODEL ?? 'litellm/deepseek-v4.1-flash-goat';
    const cwd = process.env.KATA_REVIEW_CWD ?? process.cwd();

    const adapter = createPiAdapter({
        model,
        cwd,
        // A hard stop independent of the runner's own accounting: a session that stops emitting events is still a session that must die.
        timeoutMs: packet.request.budget.maxWallMs + 30_000,
    });

    const outcome = await runReviewRound({ packet, adapter, now: () => Date.now() });

    if (!outcome.receipt) {
        // **No receipt, and that is the answer.** `execute` turns this into `executor_unavailable`, which is what the gate then reports —
        // "this host cannot run an independent pass under kata's capability contract". A degraded receipt would hide that behind a pass.
        process.stderr.write(`${outcome.status}: ${outcome.reason}\n`);
        return 1;
    }

    await writeFile(receiptPath, `${JSON.stringify(outcome.receipt, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify({
        status: outcome.status,
        receiptPath,
        capabilities: outcome.receipt.capabilities,
        telemetry: outcome.receipt.telemetry,
    })}\n`);

    const record = extractRecord(outcome.reviewerResult);
    if (record) {
        const resultPath = receiptPath.replace(/\.json$/, '') + '.result.json';
        await writeFile(resultPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
        process.stdout.write(`${JSON.stringify({ resultPath, findings: (record as { findings?: unknown[] }).findings?.length ?? 0 })}\n`);
    } else {
        // The receipt is still valid and still written: the round ran under an enforced envelope, and the fact that its result was not
        // shaped as a record is a fact about the round, not about the execution. Saying so is cheaper than failing the whole run.
        process.stderr.write('the round produced no record-shaped result; the receipt stands and no result file was written\n');
    }
    return 0;
}

/** The last balanced JSON object in the text that names a `node`, or null. Literal on purpose: a host does not interpret a reviewer. */
function extractRecord(text: string | undefined): unknown | null {
    if (typeof text !== 'string') return null;
    const candidates: unknown[] = [];
    for (let start = text.lastIndexOf('{'); start >= 0; start = text.lastIndexOf('{', start - 1)) {
        const end = balancedEnd(text, start);
        if (end < 0) continue;
        try {
            const parsed = JSON.parse(text.slice(start, end + 1)) as { node?: unknown };
            if (parsed && typeof parsed === 'object' && 'node' in parsed) candidates.push(parsed);
        } catch {
            continue;
        }
        if (candidates.length > 0) break;
    }
    return candidates[0] ?? null;
}

/** The index of the brace that closes the object opening at `start`, respecting strings and escapes. `-1` when it never closes. */
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
