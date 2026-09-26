import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { kataDir } from '../core/layout.js';
import type { ExecutionStatus, ReviewExecutionReceipt } from './review-execution.js';

/**
 * **The execution registry: the store of record for runs kata actually observed.**
 *
 * Found by the audit (`docs/design/2026-09-26-decoupled-round-protocol-conflicts.md` G2), and without it the decoupling buys nothing at
 * admission: once kata writes the receipt, the receipt's authority is *"kata wrote it"* — and `adversarial record` would accept any file that
 * happens to validate. A hand-written receipt would pass the same checks a watched round does.
 *
 * So `execute` records what it watched. `record` then requires the receipt's `runId` to appear here **as a completed run**. An unexecuted
 * receipt is refused rather than merely implausible, which is the strongest claim available on one machine — the schema's own sentence stands:
 * *"authorship separation is process and tool policy, not cryptography."*
 *
 * Same store-of-record shape as the falsifier ledger, for the same reason: a fact written by the command that observed it, read by the command
 * that has to decide.
 */

export interface RoundRunRecord {
    runId: string;
    requestSha256: string;
    node: string;
    /** kata's derivation, not the host's report. */
    status: ExecutionStatus;
    reason?: string;
    startedAt: string;
    endedAt: string;
    toolCalls: number | null;
    outputBytes: number | null;
    tokens: number | null;
    truncations: number | null;
    /** The closest thing to a `fresh_context` proxy the stream carries. Recorded, never gated. */
    firstTurnTokens: number | null;
    /** The host's own account of how it ended, kept beside kata's derivation. */
    hostReported: { status: string; reason?: string } | null;
    refusals: string[];
    /**
     * **The receipt kata wrote for this run**, kept so the admitted artefact can be compared with it.
     *
     * Without this the register certified an *identity*: a receipt whose capability list had been widened or whose telemetry had been edited
     * was admitted, because the only things compared were the run id, the request hash and the status. Storing the artefact makes the
     * admission rule the strong one — **the receipt you hand over must be the one kata wrote** — which is what "written by kata" has to mean.
     */
    receipt?: unknown;
}

interface RoundRunLedger {
    version: number;
    runs: RoundRunRecord[];
}

export function roundRunsPath(root: string, taskId: string): string {
    // `kataDir`, not `taskPath`: the latter names `task.json`, and joining a filename onto a filename produced a path under the file.
    return join(kataDir(root), 'tasks', taskId, 'round-runs.json');
}

/** Append-only on purpose: a later re-run must not retroactively legitimise an earlier artefact. */
export async function recordRoundRun(root: string, taskId: string, run: RoundRunRecord): Promise<void> {
    const { mutateTaskArtefact } = await import('../core/state.js');
    await mutateTaskArtefact(root, taskId, roundRunsPath(root, taskId), async (current) => {
        const ledger = parseLedger(current);
        const runs = ledger.runs.filter((entry) => entry.runId !== run.runId);
        runs.push(run);
        return `${JSON.stringify({ version: 1, runs }, null, 2)}\n`;
    });
}

export async function readRoundRuns(root: string, taskId: string): Promise<RoundRunRecord[]> {
    const raw = await readFile(roundRunsPath(root, taskId), 'utf8').catch(() => null);
    if (raw === null) return [];
    return parseLedger(raw).runs;
}

/**
 * **The admission question**: was this receipt produced by a run kata watched end under an enforced envelope?
 *
 * Returns the reason it was not, so `record` can refuse by name rather than by silence — a refusal that does not say what is missing is a
 * refusal nobody can act on.
 */
export function runIsCertified(
    runs: RoundRunRecord[],
    receipt: ReviewExecutionReceipt,
): { certified: true; run: RoundRunRecord } | { certified: false; reason: string } {
    const run = runs.find((entry) => entry.runId === receipt.runId);
    if (!run) {
        return {
            certified: false,
            reason: `no run with id ${receipt.runId} was executed by this repository — a receipt is evidence of a round kata watched, and a receipt with no run behind it is a file. Run the round with \`kata-cli adversarial execute --executor "<cmd>"\`, which records it.`,
        };
    }
    if (run.requestSha256 !== receipt.requestSha256) {
        return {
            certified: false,
            reason: `the run ${receipt.runId} answered request ${run.requestSha256.slice(0, 12)}… while this receipt claims ${receipt.requestSha256.slice(0, 12)}… — a receipt may only report the request it answered.`,
        };
    }
    if (run.receipt && !sameReceipt(run.receipt, receipt)) {
        return {
            certified: false,
            reason: `the receipt for run ${receipt.runId} is not the one kata wrote: its fields differ from the record of that run. A receipt is evidence of what was observed, so it may be handed over unaltered and not otherwise.`,
        };
    }
    if (run.status !== 'completed') {
        return {
            certified: false,
            reason: `the run ${receipt.runId} ended \`${run.status}\`${run.refusals.length > 0 ? `: ${run.refusals.join('; ')}` : ''} — a round that did not complete certifies nothing, whatever artefact accompanies it.`,
        };
    }
    return { certified: true, run };
}

/**
 * Field-by-field equality over the receipt kata wrote. Compared as JSON with sorted keys so a reformatted artefact is still the same
 * artefact — the rule is about content, not about bytes.
 */
function sameReceipt(recorded: unknown, admitted: ReviewExecutionReceipt): boolean {
    return canonical(recorded) === canonical(admitted);
}

function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>)
            .filter(([, entry]) => entry !== undefined)
            .sort(([left], [right]) => left.localeCompare(right));
        return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}

/** Tolerant on read, strict on write: a register that fails to parse must not be read as "no runs", because that would refuse valid work. */
function parseLedger(raw: string): RoundRunLedger {
    // An absent file reads as an empty register, which is the same rule the other lock-guarded artefacts follow: the reader is handed the
    // document as it exists on disk, and a document that does not exist yet is not a corrupt one.
    if (raw.trim() === '') return { version: 1, runs: [] };
    try {
        const parsed = JSON.parse(raw) as Partial<RoundRunLedger>;
        if (!Array.isArray(parsed?.runs)) throw new Error('runs is not an array');
        return { version: parsed.version ?? 1, runs: parsed.runs as RoundRunRecord[] };
    } catch (error) {
        throw new Error(`round-runs.json is not a readable register: ${error instanceof Error ? error.message : String(error)}`);
    }
}
