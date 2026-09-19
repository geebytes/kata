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
    /**
     * The revision the batch **started from** — what the next round narrows against (C4).
     *
     * Named `baseRevisionId`, not `closedByRevisionId`, because the plausible reading of "closed by" is the revision the
     * batch closed *on*, and passing that would make the next delta empty: the base and the new revision would be the same
     * content. The distinction is the whole point of C4, so it is carried by the field's name.
     */
    baseRevisionId?: string;
    /** The content identity of that base, so C4 can still narrow after a re-seal of unchanged content. */
    baseManifestHash?: string;
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
    // The base is the revision that was current when the batch **opened** — the artifact the repair starts from. Reading it
    // here rather than accepting it at close is the difference C4 depends on: at close the revision has already moved, and
    // a caller-supplied "the revision we closed on" would make the next round's delta empty.
    const { readCurrentTaskRevision } = await import('../workflow/revision.js');
    const base = await readCurrentTaskRevision(root, taskId).catch(() => null);

    let opened: RepairBatch | null = null;
    await mutateTaskArtefact(root, taskId, repairBatchPath(root, taskId), async () => {
        const record = await readBatchRecord(root, taskId);
        const open = record.batches.find((batch) => !batch.closedAt);
        if (open) {
            // Extending, never duplicating: the base stays the one this batch opened from, which is what the next round
            // must narrow against.
            const known = new Set(open.findings.map((finding) => finding.id));
            for (const finding of findings) if (!known.has(finding.id)) open.findings.push(finding);
            opened = open;
        } else {
            opened = {
                id: `batch-${record.batches.length + 1}`,
                openedAt: new Date().toISOString(),
                ...(base ? { baseRevisionId: base.id, baseManifestHash: base.manifestHash } : {}),
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
 *
 * A terminal finding is accounted for in one of exactly three ways, and the option names say which:
 *   - `answered` — it was repaired;
 *   - `deferred` — the author decided not to answer it, with a **reason** (the `findings defer` semantics);
 *   - `noLongerReported` — a re-run of the node did not report it again.
 *
 * Anything else terminal and still open **refuses the close**. (The third option was called `stillOpen` when this module
 * landed, which is the opposite of what it does: it lists findings that no longer block. A name that inverts its own
 * meaning on the one path whose job is to refuse is worse than a longer name.)
 */
export async function closeRepairBatch(
    root: string,
    taskId: string,
    options: {
        /**
         * The revision the batch started from, i.e. the one the *next* round should narrow against. Omit only when it
         * cannot be known — C4 then falls back to full scope and says so rather than measuring against a guess.
         */
        baseRevisionId?: string;
        answered?: string[];
        deferred?: Array<{ id: string; reason: string }>;
        noLongerReported?: string[];
    },
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
                !(options.noLongerReported ?? []).includes(finding.id),
        );
        if (unaccounted.length > 0) {
            outcome = { refused: true, reason: 'open_terminal_findings', findings: unaccounted };
            return `${JSON.stringify(record, null, 2)}\n`;
        }
        open.closedAt = new Date().toISOString();
        if (options.baseRevisionId) open.baseRevisionId = options.baseRevisionId;
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

/**
 * Opens (or extends) the batch a set of decided findings belongs to — the wiring C1 was missing.
 *
 * The defect this closes: `openRepairBatch` and `closeRepairBatch` had **no production caller**, so no batch was ever
 * opened, so `defaultBriefScope` always found none and C4's delta default always fell back to full scope with the reason
 * *"no repair batch has closed"*. The mechanism was reachable and inert — the same shape as the write-policy string copy
 * and the four drift sources before it.
 *
 * Called where the findings are **recorded**, not where they are repaired: the point is that a set of findings discovered
 * together is repaired together, and the record of that begins the moment they are known.
 */
export async function recordFindingsForBatching(
    root: string,
    taskId: string,
    findings: Array<{ id: string; severity: string; message: string; acceptanceId?: string }>,
    source: RepairBatchFinding['source'],
): Promise<RepairBatch | null> {
    // Only findings that actually gate a node: a nit has no batch to belong to, and recording one would inflate the
    // saving the batch is supposed to measure.
    const gating = findings
        .filter((finding) => isTerminalSeverity(finding.severity))
        .map((finding) => ({
            id: finding.id,
            severity: finding.severity,
            message: finding.message,
            source,
            ...(finding.acceptanceId ? { acceptanceId: finding.acceptanceId } : {}),
        }));
    if (gating.length === 0) return null;
    return openRepairBatch(root, taskId, gating);
}

/**
 * Closes the open batch once a seal has answered it — the other half of the wiring.
 *
 * Called **after a successful seal**, because that is the moment the platform has re-verified the repaired artifact: the
 * batch's own contract is "one seal and one delta round per node per batch", so the seal is what ends it.
 *
 * The base revision is **not** a parameter. It was stamped when the batch opened, and accepting one here would let a caller
 * pass the revision that was just sealed — the base and the new revision would then be identical content, and the next
 * round would narrow to nothing. Deriving it is the only way that mistake cannot be made.
 *
 * Findings are marked accounted for by asking the obligations store, not by trusting a list: a batch closes when its
 * findings are genuinely resolved, deferred with a reason, or no longer reported by the node that raised them.
 */
export async function closeBatchAfterSeal(
    root: string,
    taskId: string,
): Promise<RepairBatch | CloseRefusal | null> {
    const batch = await openBatch(root, taskId);
    if (!batch) return null;

    const { readObligations } = await import('./repair-obligations.js');
    const obligations = await readObligations(root, taskId).catch(() => []);
    const resolved = new Set(obligations.filter((obligation) => obligation.resolvedAt).map((obligation) => obligation.findingId).filter(Boolean) as string[]);
    const { readTrackedFindings } = await import('./finding-disposition.js');
    const tracked = await readTrackedFindings(root, taskId).catch(() => []);
    const deferred = tracked
        .filter((finding) => finding.disposition === 'deferred' || finding.disposition === 'accepted')
        .map((finding) => ({ id: finding.id, reason: finding.dispositionReason ?? 'no reason recorded' }));

    const answered = batch.findings.filter((finding) => resolved.has(finding.id)).map((finding) => finding.id);
    // A finding the current run no longer reports is accounted for by absence — the batch's third way, and the reason the
    // option is named for what it means rather than for the state it is in.
    const stillTracked = new Set(tracked.map((finding) => finding.id));
    const noLongerReported = batch.findings.filter((finding) => !stillTracked.has(finding.id)).map((finding) => finding.id);

    return closeRepairBatch(root, taskId, { answered, deferred, noLongerReported });
}

/**
 * Records the gating findings of a freshly recorded pass into the batch — the producer at the write.
 *
 * Placed here rather than only at the node's refusal because *this* is where a pass's findings are written, and it is
 * reached whether or not the node goes on to refuse: a `verify` command can stop earlier for its own reasons (evidence,
 * obligations, the Wiki closure) and never reach the gate that reports the same findings. Hooking the write makes the batch
 * independent of which refusal happened to come first.
 */
export async function recordPassFindingsForBatching(
    root: string,
    taskId: string,
    node: 'verify' | 'review',
    findings: Array<{ id: string; severity: string; message: string; path?: string }>,
): Promise<RepairBatch | null> {
    return recordFindingsForBatching(
        root,
        taskId,
        findings.map((finding) => ({ id: finding.id, severity: finding.severity, message: finding.message })),
        node === 'verify' ? 'adversarial-verify' : 'adversarial-review',
    );
}
