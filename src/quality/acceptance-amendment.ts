import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { taskDir, taskPath } from '../core/layout.js';
import { withTaskLock } from '../core/state.js';
import { join } from 'node:path';
import { acceptanceContractHashOf, readTask, type AcceptanceCriterion, type TaskRecord } from '../core/task.js';
import { readCurrentTaskRevisionState } from '../workflow/revision.js';

/**
 * **The one governed writer for an acceptance statement, and the one place that decides whether a certification still
 * stands.**
 *
 * A task's acceptance criteria are frozen at creation and they are what a seal, a verify pass and a judge verdict are
 * *about*: `revision.acceptanceContractHash` freezes the contract, and every reader that asks "does this revision still
 * describe what it is asked about" answers with `contract-moved` when the task's contract has moved away from it.
 *
 * That rule is only half a mechanism without a way to correct the contract, and the missing half was measured on a real
 * change: one criterion's statement asserted an implementation that the change had falsified ("the same predicate `cwd`
 * already uses", true of neither of the two rules the code actually has), and there was **no route to correct it** —
 * `kata-cli tasks declare` writes `upstreamCoverage` and `acceptanceMatrix` and explicitly refuses to rewrite criteria,
 * `ledger claim restate` corrects a claim (the reviewer-facing argument) rather than the criterion, and the only remaining
 * option was hand-editing `task.json` inside the task's lock-free window, which is exactly what this repository keeps
 * deleting. So the choice was between an amendment nobody can audit and one that is recorded.
 *
 * What this module is careful about:
 *
 *  - **The audit comes first, and it is append-only.** The old text, the new text, both contract hashes, the reason, the
 *    actor and the revision whose certification this voids are written to `acceptance-amendments.jsonl` *before* the task
 *    record is touched, so an amendment that lands always has the decision that produced it. Nothing is ever rewritten.
 *  - **The amendment is a compare-and-swap, not an edit.** The caller must supply the statement it believes is current;
 *    a mismatch is refused with the text actually on disk. Two authors cannot silently amend the same criterion to
 *    different things, and an amendment written from a stale reading cannot land at all.
 *  - **A revision that cannot detect the amendment is refused rather than trusted.** A revision sealed before this field
 *    existed records no contract hash, so `revisionStatus` has nothing to compare and would keep answering `current` —
 *    the amendment would look applied and the old certification would survive it. That state is refused *by name* and the
 *    remedy it prints is executable: re-seal under this engine (which records the hash), then amend, which voids it.
 *  - **A criterion that declares claim clauses is refused.** `ClaimDeclaration` keeps a sentence and the check that must
 *    make it true *together*, deliberately; rewriting the sentence alone would leave the clause asserting wording the
 *    contract no longer carries. The refusal names the clauses so the boundary is visible instead of guessed at.
 *  - **Only the statement.** The criterion id, its position, the matrix, `ownedPaths` and every other declaration are out
 *    of reach: this is a correction of one sentence, not a re-authoring of the contract.
 */

/**
 * One recorded amendment. Append-only, and deliberately narrow: it names the two texts, the two contract hashes and the
 * revision it voids, so a reader can reconstruct the audit without trusting this module's code to still exist.
 */
export interface AcceptanceAmendment {
    version: 1;
    id: string;
    taskId: string;
    acceptanceId: string;
    /** The text the contract carried, as the caller believed it — and as it was verified to be, under the lock. */
    previousStatement: string;
    statement: string;
    /** The contract hash the revision froze, which this amendment makes stale. */
    previousContractHash: string;
    /** The contract hash the task now carries. */
    contractHash: string;
    /**
     * The revision that was current when the contract moved: the one whose frozen hash no longer matches, so its
     * certification — and every verdict bound to it — cannot stand.
     */
    voidedRevision: string;
    reason: string;
    by: string;
    at: string;
}

export type AcceptanceAmendmentsRead =
    | { kind: 'usable'; amendments: AcceptanceAmendment[] }
    | { kind: 'absent' }
    | { kind: 'unreadable'; reason: string };

export type AmendAcceptanceResult =
    | { ok: true; amendment: AcceptanceAmendment }
    | { ok: false; refused: string };

/** The append-only decision log, beside the task it belongs to rather than inside the task record. */
export function acceptanceAmendmentsPath(root: string, taskId: string): string {
    return join(taskDir(root, taskId), 'acceptance-amendments.jsonl');
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
    return typeof error === 'object' && error !== null && 'code' in error;
}

/**
 * One line of the log, or `null` when it is not a well-formed amendment.
 *
 * Every field is checked rather than trusted, because this file is the audit: a reader that skipped a line it could not
 * parse would report a shorter history as a complete one, which is the failure mode the three-state read below exists to
 * prevent. `taskId` is checked against the task as well, so an amendment cannot be filed under the wrong change.
 */
function amendmentRecord(value: unknown, taskId: string): AcceptanceAmendment | null {
    if (typeof value !== 'object' || value === null) return null;
    const record = value as Partial<AcceptanceAmendment>;
    if (record.version !== 1 || record.taskId !== taskId) return null;
    const strings: Array<keyof AcceptanceAmendment> = [
        'id', 'acceptanceId', 'previousStatement', 'statement',
        'previousContractHash', 'contractHash', 'voidedRevision', 'reason', 'by', 'at',
    ];
    if (!strings.every((key) => typeof record[key] === 'string')) return null;
    return record as AcceptanceAmendment;
}

/**
 * The amendments recorded against this task: **absent, usable, or unreadable.** A log that exists and cannot be parsed is
 * never reported as "no amendments" — a reader deciding whether a contract was corrected must be able to tell "it was not"
 * from "I could not look".
 */
export async function readAcceptanceAmendments(root: string, taskId: string): Promise<AcceptanceAmendmentsRead> {
    let raw: string;
    try {
        raw = await readFile(acceptanceAmendmentsPath(root, taskId), 'utf8');
    } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') return { kind: 'absent' };
        return { kind: 'unreadable', reason: error instanceof Error ? error.message : String(error) };
    }
    const amendments: AcceptanceAmendment[] = [];
    for (const [index, line] of raw.split('\n').entries()) {
        if (line.trim() === '') continue;
        let parsed: unknown;
        try {
            parsed = JSON.parse(line);
        } catch (error) {
            return { kind: 'unreadable', reason: `${acceptanceAmendmentsPath(root, taskId)} line ${index + 1} is not JSON: ${(error as Error).message}` };
        }
        const record = amendmentRecord(parsed, taskId);
        if (!record) return { kind: 'unreadable', reason: `${acceptanceAmendmentsPath(root, taskId)} line ${index + 1} is not a well-formed amendment` };
        amendments.push(record);
    }
    return { kind: 'usable', amendments };
}

/**
 * Correct one acceptance statement, recording the decision and voiding the revision that certified the old contract.
 *
 * The whole read-modify-write runs under the task lock — the same lock a seal and a review commit take — because the
 * compare-and-swap below is only a guarantee if nothing can move the contract between the read and the write. Every
 * refusal is a value and writes nothing at all.
 */
export async function amendAcceptance(input: {
    root: string;
    taskId: string;
    acceptanceId: string;
    /** The statement the caller believes is current; the amendment is refused unless it matches what is on disk. */
    expectedStatement: string;
    statement: string;
    reason: string;
    by: string;
    now?: string;
}): Promise<AmendAcceptanceResult> {
    if (!input.reason?.trim()) {
        return { ok: false, refused: 'An acceptance amendment requires --reason: it changes what every later verdict is judged against, and an unexplained one is indistinguishable from drift.' };
    }
    if (!input.statement?.trim()) {
        return { ok: false, refused: 'An acceptance amendment requires a non-empty statement: a criterion with no sentence is not a contract.' };
    }

    return withTaskLock(input.root, input.taskId, async () => {
        // Read the record through its own validated reader, so an amendment can never be applied on top of a `task.json`
        // that no other command would accept. `readTask` throws for absence and for schema drift; the two are different
        // facts and are reported as such.
        let task: TaskRecord;
        try {
            task = await readTask(input.root, input.taskId);
        } catch (error) {
            const cause = (error as { cause?: unknown } | null)?.cause;
            if (typeof cause === 'object' && cause !== null && (cause as NodeJS.ErrnoException).code === 'ENOENT') {
                return { ok: false, refused: `no task '${input.taskId}' exists in this workspace` };
            }
            return { ok: false, refused: `task '${input.taskId}' has a record that cannot be read, so its contract cannot be corrected: ${(error as Error).message}` };
        }

        const acceptance = task.acceptance ?? [];
        const criterion = acceptance.find((entry) => entry.id === input.acceptanceId);
        if (!criterion) {
            const known = acceptance.map((entry) => entry.id ?? '(no id)').join(', ') || '(none)';
            return { ok: false, refused: `no criterion '${input.acceptanceId}' in task '${input.taskId}'; its criteria are ${known}` };
        }
        if (criterion.statement !== input.expectedStatement) {
            return {
                ok: false,
                refused: `the statement for ${input.acceptanceId} is not the one this amendment was written against, so nothing was changed. On disk it reads: ${JSON.stringify(criterion.statement)} — write that text as the \`expectedStatement\` field of the amendment document and re-run \`kata-cli tasks amend-acceptance --change ${input.taskId} --id ${input.acceptanceId} --file <path> --reason ${JSON.stringify(input.reason.trim())}\` if correcting it is intended.`,
            };
        }
        if ((criterion.claims ?? []).length > 0) {
            const clauses = (criterion.claims ?? []).map((claim) => claim.id).join(', ');
            return {
                ok: false,
                refused: `${input.acceptanceId} declares claim clause(s) (${clauses}), and a clause is a check bound to the sentence it asserts — rewriting the sentence alone would leave those checks asserting wording the contract no longer carries. Correct the clauses with the sentence, deliberately, rather than through this command.`,
            };
        }

        const nextAcceptance: AcceptanceCriterion[] = acceptance.map((entry) => (entry.id === input.acceptanceId ? { ...entry, statement: input.statement } : entry));
        const previousContractHash = acceptanceContractHashOf(task.acceptance, task.acceptanceMatrix);
        const contractHash = acceptanceContractHashOf(nextAcceptance, task.acceptanceMatrix);
        if (contractHash === previousContractHash) {
            return { ok: false, refused: `this amendment would leave the acceptance contract byte-identical, so there is nothing to record. The statement on disk already reads: ${JSON.stringify(criterion.statement)}` };
        }

        // **The revision has to be able to notice.** A revision sealed before `acceptanceContractHash` existed records no
        // contract, so `revisionStatus` would keep answering `current` and the amendment would silently preserve the
        // certification it was meant to void. Refusing here is the difference between a correction and a fiction.
        const revisionRead = await readCurrentTaskRevisionState(input.root, input.taskId);
        if (revisionRead.kind === 'unreadable') {
            return { ok: false, refused: `the current revision of '${input.taskId}' cannot be read (${revisionRead.detail}), so it cannot be shown that this amendment would void anything` };
        }
        if (revisionRead.kind === 'absent') {
            return { ok: false, refused: `task '${input.taskId}' has no sealed revision, so there is no certification for this amendment to void: run \`kata-cli build --seal --change ${input.taskId}\` first, then amend` };
        }
        if (revisionRead.revision.acceptanceContractHash === undefined) {
            return {
                ok: false,
                refused: `revision ${revisionRead.revision.id} records no acceptance-contract hash (it was sealed before that field existed), so it could not tell that this contract moved and its certification would survive the amendment. Re-seal first — \`kata-cli build --seal --change ${input.taskId}\` records the hash — then amend, which is what voids the revision sealed against the old contract.`,
            };
        }

        const recorded = await readAcceptanceAmendments(input.root, input.taskId);
        if (recorded.kind === 'unreadable') {
            return { ok: false, refused: `this task's amendment log cannot be read, so an amendment written now could not be told from one that was never recorded: ${recorded.reason}` };
        }

        const amendment: AcceptanceAmendment = {
            version: 1,
            id: `amendment-${randomUUID()}`,
            taskId: input.taskId,
            acceptanceId: input.acceptanceId,
            previousStatement: criterion.statement,
            statement: input.statement,
            previousContractHash,
            contractHash,
            voidedRevision: revisionRead.revision.id,
            reason: input.reason.trim(),
            by: input.by,
            at: input.now ?? new Date().toISOString(),
        };

        // **The record before the effect**, the order `tasks declare` uses and for the same reason: a task that carries
        // the amendment always has the decision that produced it, while the reverse order can leave a rewritten contract
        // with no account of itself. Both writes are inside this lock, so no reader observes the record without the effect.
        await appendFile(acceptanceAmendmentsPath(input.root, input.taskId), `${JSON.stringify(amendment)}\n`, 'utf8');
        await writeFile(
            taskPath(input.root, input.taskId),
            `${JSON.stringify({ ...task, acceptance: nextAcceptance, updatedAt: amendment.at }, null, 2)}\n`,
            'utf8',
        );
        return { ok: true, amendment };
    });
}
