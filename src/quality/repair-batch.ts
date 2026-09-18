import { repairBatchPath } from '../core/layout.js';
import { mutateTaskArtefact } from '../core/state.js';
import { readValidatedOptional, validate } from '../core/schema.js';
import { isTerminalSeverity } from './finding-lifecycle.js';

/**
 * Repair batches (the pass-cost proposal's C1).
 *
 * The measurement: **three of six fix→seal→pass cycles in one day existed only because findings were repaired one at a
 * time.** Every repair produced a new revision, which invalidated *both* nodes' passes, so the second batch paid a full
 * re-verification for work the first batch had already discovered.
 *
 * A batch is a set of findings opened together and closed together, so the seal and the delta round happen **at batch
 * close**, not per finding. What this module deliberately does *not* do is decide when to open or close one: that is the
 * author's decision, and the platform's job is to make the batch visible, count the rounds it saved, and hold the same
 * severity gate as before.
 *
 * The invariant it keeps (the proposal's C1, and §15): **a batch may not silently drop a terminal finding.** A batch that
 * is closed while a `blocking` or `major` finding it opened for is still open is refused unless the finding was repaired
 * or explicitly carried — the closing is where the counting stops, never where the obligation disappears.
 */
export interface RepairBatchFinding {
    /** The finding this batch opened for, as reported by a node. */
    id: string;
    severity: string;
    /** This task's acceptance criterion, when the finding names one. */
    acceptanceId?: string;
    source: 'review' | 'judge' | 'adversarial-verify' | 'adversarial-review';
    message: string;
}

export interface RepairBatch {
    id: string;
    openedAt: string;
    closedAt?: string;
    findings: RepairBatchFinding[];
    /** The revision the batch was closed on, so it is answerable which round resolved it. */
    closedByRevisionId?: string;
    /** Findings the batch answered by repairing them, named at closure. */
    answered?: string[];
    /** Findings the author explicitly decided not to answer, with the reason (`findings defer` semantics). */
    deferred?: Array<{ id: string; reason: string }>;
}

export interface RepairBatchRecord {
    batches: RepairBatch[];
    updatedAt: string;
}

/**
 * Opens a batch, or extends the open one.
 *
 * Extending rather than opening a second is the whole mechanism: the cost being removed is the *revision per repair*, so
 * findings that arrive while a batch is open belong to it.
 */
export async function openRepairBatch(
    root: string,
    taskId: string,
    findings: RepairBatchFinding[],
): Promise<RepairBatch> {
    let opened: RepairBatch | null = null;
    await mutateTaskArtefact(root, taskId, repairBatchPath(root, taskId), async () => {
        const record = await readBatchRecord(root, taskId);
        const open = record.batches.find((batch) => !batch.closedAt);
        if (open) {
            const known = new Set(open.findings.map((finding) => finding.id));
            for (const finding of findings) if (!known.has(finding.id)) open.findings.push(finding);
            opened = open;
        } else {
            opened = {
                id: `batch-${record.batches.length + 1}`,
                openedAt: new Date().toISOString(),
                findings: [...findings],
            };
            record.batches.push(opened);
        }
        return `${JSON.stringify({ ...record, updatedAt: new Date().toISOString() }, null, 2)}\n`;
    });
    return opened as unknown as RepairBatch;
}

/** Why a batch may not be closed, when it may not. */
export type CloseRefusal = { refused: true; reason: 'open_terminal_findings'; findings: RepairBatchFinding[] };

/**
 * Closes the open batch, counting the rounds it saved — or refuses, naming the terminal findings still open.
 *
 * The refusal is the invariant: closing a batch is when the platform stops asking for a re-verification, so it is exactly
 * the moment a dropped obligation would become invisible.
 */
export async function closeRepairBatch(
    root: string,
    taskId: string,
    options: { revisionId?: string; answered?: string[]; deferred?: Array<{ id: string; reason: string }>; stillOpen?: string[] },
): Promise<RepairBatch | CloseRefusal> {
    let outcome: RepairBatch | CloseRefusal | null = null;
    await mutateTaskArtefact(root, taskId, repairBatchPath(root, taskId), async () => {
        const record = await readBatchRecord(root, taskId);
        const open = record.batches.find((batch) => !batch.closedAt);
        if (!open) {
            outcome = { refused: true, reason: 'open_terminal_findings', findings: [] };
            return `${JSON.stringify(record, null, 2)}\n`;
        }
        const answered = new Set(options.answered ?? []);
        const deferred = new Set((options.deferred ?? []).map((entry) => entry.id));
        // A finding is accounted for when it was repaired, was explicitly deferred, or the caller says it is no longer
        // open (a node re-ran and did not re-report it). Anything else terminal still open blocks the close.
        const unaccounted = open.findings.filter(
            (finding) =>
                isTerminalSeverity(finding.severity) &&
                !answered.has(finding.id) &&
                !deferred.has(finding.id) &&
                !(options.stillOpen ?? []).includes(finding.id),
        );
        if (unaccounted.length > 0) {
            outcome = { refused: true, reason: 'open_terminal_findings', findings: unaccounted };
            return `${JSON.stringify(record, null, 2)}\n`;
        }
        open.closedAt = new Date().toISOString();
        if (options.revisionId) open.closedByRevisionId = options.revisionId;
        if (options.answered?.length) open.answered = [...options.answered];
        if (options.deferred?.length) open.deferred = [...options.deferred];
        outcome = open;
        return `${JSON.stringify({ ...record, updatedAt: new Date().toISOString() }, null, 2)}\n`;
    });
    return outcome as unknown as RepairBatch | CloseRefusal;
}

export async function readBatches(root: string, taskId: string): Promise<RepairBatch[]> {
    return (await readBatchRecord(root, taskId)).batches;
}

/** The open batch, if there is one — what a gate asks before it asks for another re-verification. */
export async function openBatch(root: string, taskId: string): Promise<RepairBatch | null> {
    return (await readBatches(root, taskId)).find((batch) => !batch.closedAt) ?? null;
}

/**
 * What the batching saved, for the surface that reports it.
 *
 * Counted rather than estimated: with `N` findings repaired in one batch, the platform performed **one** seal and one
 * round per node where it would otherwise have performed one per finding. The number is the difference, and the record
 * it is computed from is the batch itself.
 */
export async function batchSaving(root: string, taskId: string): Promise<{
    batches: number;
    closed: number;
    findingsBatched: number;
    sealsAvoided: number;
}> {
    const batches = await readBatches(root, taskId);
    const closed = batches.filter((batch) => batch.closedAt);
    const findingsBatched = closed.reduce((sum, batch) => sum + batch.findings.length, 0);
    return {
        batches: batches.length,
        closed: closed.length,
        findingsBatched,
        // One seal per additional finding, per node, is what a per-finding repair would have cost.
        sealsAvoided: closed.reduce((sum, batch) => sum + Math.max(0, batch.findings.length - 1), 0),
    };
}

async function readBatchRecord(root: string, taskId: string): Promise<RepairBatchRecord> {
    const record = await readValidatedOptional<RepairBatchRecord>('repair-batch', repairBatchPath(root, taskId));
    return record ?? { batches: [], updatedAt: new Date(0).toISOString() };
}

/** Validates a record on read, so a malformed batch file is reported rather than silently treated as "no batches". */
export function validateBatchRecord(value: unknown): RepairBatchRecord {
    return validate<RepairBatchRecord>('repair-batch', value);
}
