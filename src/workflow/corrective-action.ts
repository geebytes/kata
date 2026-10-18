import { readdir } from 'node:fs/promises';
import { correctiveActionPath, judgePath, tasksDir } from '../core/layout.js';
import { readValidatedOptional } from '../core/schema.js';
import { writeFileAtomic } from '../core/state.js';
import { assertValidTaskId } from '../core/ids.js';
import { closureObligationOf } from '../quality/repair-declarations.js';
import { readCurrentTaskRevisionState } from './revision.js';

/**
 * **A corrective action is a task that says which class contract it discharges.**
 *
 * The design separates two work units: a *delivery* slice, and a *corrective action* for a defect in the workflow itself.
 * The second half had no representation at all — nothing recorded that a task exists *because of* a class, so nothing could
 * stop the same class from being answered by a fresh task every time a reviewer reported it. Measured on this repository:
 * five consecutive rounds, three classes, three sites, each repair widening the same enumeration, and each round free to
 * start the next repair because no record said "this class already has an owner".
 *
 * Two rules follow from that record, and they are the whole mechanism:
 *
 * - **One open corrective action per class.** A second declaration for the same class while the first is still open is
 *   refused, naming the task that already owns it. This is what turns "a new reviewer reported it again" into a fact about
 *   an existing task rather than a new one.
 * - **The class vocabulary is the review loop's own.** The obligation is validated by `closureObligationOf`, the reader the
 *   recurrence packet and the seal already use, so this record cannot drift into a second definition of the same class.
 *
 * A class is *discharged* when the corrective task is certified — a Judge pass bound to its current revision. That is the
 * same bar the dependency gate uses to let a dependent task re-validate, so the two cannot disagree about whether the fix
 * has happened.
 */

export type CorrectiveActionDeclaration = {
    taskId: string;
    classKey: string;
    sourceChangeId: string;
    sourceFindingIds?: string[];
    owner: string;
    declaredAt: string;
    updatedAt: string;
    note?: string;
    obligation: {
        states: string[];
        sourceOfTruth: string;
        inventory: string[];
        invariant: string;
        repairSurface: string[];
        effectivenessTest: string;
        ifRecursAgain: 'rewrite_mechanism' | 'waive_with_owner' | 'abandon_change';
    };
};

export type CorrectiveActionRead =
    | { kind: 'absent'; declaration: null }
    | { kind: 'usable'; declaration: CorrectiveActionDeclaration }
    | { kind: 'unreadable'; detail: string };

export async function readCorrectiveAction(root: string, taskId: string): Promise<CorrectiveActionRead> {
    try {
        const record = await readValidatedOptional<CorrectiveActionDeclaration>('corrective-action', correctiveActionPath(root, taskId));
        return record === null ? { kind: 'absent', declaration: null } : { kind: 'usable', declaration: record };
    } catch (error) {
        return { kind: 'unreadable', detail: error instanceof Error ? error.message : String(error) };
    }
}

/** One task's declaration, with the state of the work that discharges it. */
export type CorrectiveActionStatus = {
    taskId: string;
    declaration: CorrectiveActionDeclaration | null;
    readState: 'absent' | 'usable' | 'unreadable';
    detail?: string;
    /** Whether the corrective task is certified: a Judge pass bound to its current revision. */
    discharged: boolean;
    /** The revision the certification was read from, when there is one. */
    certifiedRevisionId: string | null;
};

export async function readCorrectiveActionStatus(root: string, taskId: string): Promise<CorrectiveActionStatus> {
    assertValidTaskId(taskId);
    const read = await readCorrectiveAction(root, taskId);
    const revisionRead = await readCurrentTaskRevisionState(root, taskId);
    const revision = revisionRead.kind === 'current' ? revisionRead.revision : null;
    let discharged = false;
    if (revision) {
        try {
            const judge = await readValidatedOptional<{ result?: string; revisionId?: string }>('judge-result', judgePath(root, taskId));
            discharged = judge?.result === 'PASS' && judge.revisionId === revision.id;
        } catch {
            discharged = false;
        }
    }
    return {
        taskId,
        declaration: read.kind === 'usable' ? read.declaration : null,
        readState: read.kind,
        ...(read.kind === 'unreadable' ? { detail: read.detail } : {}),
        discharged,
        certifiedRevisionId: revision?.id ?? null,
    };
}

/**
 * Every corrective action this repository holds, by class.
 *
 * **The class key is compared on the invariant as well as the name**, because two different invariants can share a coarse
 * label (`instrument_unsound` is a name for a family, not a class): refusing a declaration because an unrelated defect was
 * once called by the same name would block legitimate work, which is the failure mode of a check that reads a label as a
 * fact.
 */
export type OpenCorrectiveAction = {
    taskId: string;
    classKey: string;
    invariant: string;
    owner: string;
    discharged: boolean;
};

export async function readCorrectiveActions(root: string): Promise<{ open: OpenCorrectiveAction[]; unreadable: Array<{ taskId: string; detail: string }> }> {
    let taskIds: string[];
    try {
        const entries = await readdir(tasksDir(root), { withFileTypes: true });
        taskIds = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    } catch {
        return { open: [], unreadable: [] };
    }

    const open: OpenCorrectiveAction[] = [];
    const unreadable: Array<{ taskId: string; detail: string }> = [];
    for (const taskId of taskIds) {
        const read = await readCorrectiveAction(root, taskId);
        if (read.kind === 'absent') continue;
        if (read.kind === 'unreadable') {
            unreadable.push({ taskId, detail: read.detail });
            continue;
        }
        const status = await readCorrectiveActionStatus(root, taskId);
        open.push({
            taskId,
            classKey: read.declaration.classKey,
            invariant: read.declaration.obligation.invariant,
            owner: read.declaration.owner,
            discharged: status.discharged,
        });
    }
    return { open, unreadable };
}

/**
 * Declare that this task discharges a class contract.
 *
 * **Refused when another task already owns the same class.** That refusal is the mechanism: the design's rule is "one
 * corrective action per class, until it is discharged", and a rule with no reader is a paragraph. The refusal names the
 * owning task and its owner, so the operator's next move is a decision (carry it there, or discharge that one first)
 * rather than a new task.
 *
 * **The obligation is validated by the review loop's own reader.** `closureObligationOf` is what the recurrence packet, the
 * repair declarations and the seal all use, so a declaration that reaches this writer with a malformed contract is refused
 * with the same sentence those readers would produce — not a second opinion about what a class contract is.
 */
export async function declareCorrectiveAction(input: {
    root: string;
    taskId: string;
    classKey: string;
    sourceChangeId: string;
    owner: string;
    obligation: unknown;
    sourceFindingIds?: string[];
    note?: string;
}): Promise<{ declaration: CorrectiveActionDeclaration; status: CorrectiveActionStatus }> {
    const { root, taskId } = input;
    assertValidTaskId(taskId);
    assertValidTaskId(input.sourceChangeId);
    if (input.classKey.trim() === '') throw new Error(`Cannot declare a corrective action for '${taskId}': a class key is required — an unnamed class cannot be matched against the one already being repaired.`);
    if (input.owner.trim() === '') throw new Error(`Cannot declare a corrective action for '${taskId}': an owner is required, because a mechanism correction nobody owns is the state this record exists to prevent.`);

    const obligation = closureObligationOf(input.obligation);
    if (obligation === null) {
        throw new Error(`Cannot declare a corrective action for '${taskId}': the obligation is missing. A class contract is required, because a corrective action without one is a repair with no way to say when the class is closed.`);
    }
    if (obligation instanceof Error) {
        throw new Error(`Cannot declare a corrective action for '${taskId}': ${obligation.message}.`);
    }

    const existing = await readCorrectiveActions(root);
    if (existing.unreadable.length > 0) {
        // **A record nobody can read is not a free class.** Declaring over it would let a damaged declaration be replaced
        // silently, and the operator would lose the owner and the contract that were there.
        throw new Error(`Cannot declare a corrective action for '${taskId}': ${existing.unreadable.length} existing declaration(s) cannot be read (${existing.unreadable.map((entry) => `${entry.taskId}: ${entry.detail}`).join('; ')}), so whether this class is already owned is unknown.`);
    }
    const owner = existing.open.find((entry) => entry.taskId !== taskId
        && !entry.discharged
        && entry.classKey === input.classKey.trim()
        && entry.invariant === obligation.invariant);
    if (owner) {
        throw new Error(
            `Cannot declare a corrective action for '${taskId}': class '${input.classKey.trim()}' with that invariant is already owned by '${owner.taskId}' (owner: ${owner.owner}), and it has not been discharged. `
            + `Carry the finding there, or discharge that task first — a second corrective action for one class is how the same defect gets repaired twice.`,
        );
    }

    const now = new Date().toISOString();
    const declaration: CorrectiveActionDeclaration = {
        taskId,
        classKey: input.classKey.trim(),
        sourceChangeId: input.sourceChangeId,
        ...(input.sourceFindingIds === undefined ? {} : { sourceFindingIds: [...input.sourceFindingIds] }),
        owner: input.owner.trim(),
        declaredAt: now,
        updatedAt: now,
        ...(input.note === undefined ? {} : { note: input.note }),
        obligation,
    };
    await writeFileAtomic(correctiveActionPath(root, taskId), `${JSON.stringify(declaration, null, 2)}\n`);
    return { declaration, status: await readCorrectiveActionStatus(root, taskId) };
}

/** A short, stable summary for the surfaces that publish rather than gate. */
export function summarizeCorrectiveAction(status: CorrectiveActionStatus): Record<string, unknown> {
    if (status.readState === 'absent') return { taskId: status.taskId, declared: false };
    if (status.readState === 'unreadable') return { taskId: status.taskId, declared: true, readState: 'unreadable', detail: status.detail };
    return {
        taskId: status.taskId,
        declared: true,
        classKey: status.declaration?.classKey,
        owner: status.declaration?.owner,
        sourceChangeId: status.declaration?.sourceChangeId,
        invariant: status.declaration?.obligation.invariant,
        effectivenessTest: status.declaration?.obligation.effectivenessTest,
        inventorySize: status.declaration?.obligation.inventory.length,
        discharged: status.discharged,
        certifiedRevisionId: status.certifiedRevisionId,
    };
}

/**
 * **Fold a class name to the form two records can be compared in.**
 *
 * The two spellings come from different authors: a reviewer writes a finding's `class` (kebab in practice,
 * `one-fact-derived-twice`), and an author writes the declaration's `classKey` while the *conclusion* vocabulary uses
 * underscores (`instrument_unsound`). Comparing them raw means a class that recurred reads as "not the one we fixed" —
 * a false negative, which is the safe direction but still a lost signal, so the fold is stated here rather than left to
 * whichever two strings happen to be compared.
 *
 * **What it cannot do, said plainly**: a class named differently beyond case and separators will not match. That is a
 * missed detection, never a wrong one — the reader below only ever reports a class it found in both records.
 */
export function normaliseClassKey(key: string): string {
    return key.trim().toLowerCase().replaceAll('_', '-').replace(/\s+/gu, '-');
}

export type OwnedClassRecurrence = {
    classKey: string;
    ownerTaskId: string;
    owner: string;
    /** The class name as the round recorded it, printed so a reader can see the two spellings the fold brought together. */
    recordedAs: string;
    rounds: string[];
    findings: string[];
};

/**
 * **A class that a corrective action owns, recurring in a change that depends on it.**
 *
 * This is the cross-change form of `ifRecursAgain`: an in-change declaration whose repair did not hold is already routed to
 * a person, and this is the same fact when the repair lives in another task. The corrective action said the class was
 * closed; the dependent change's own rounds found it again; so the next move belongs to the class's owner — repairing it
 * again here is how one class gets paid for twice.
 *
 * Pure, and driven by the records: the owned classes come from the dependency edges this change already has, and the
 * recurrences from the rounds it already read. No scan of the repository, no second derivation of "which classes recur".
 */
export function ownedClassRecurrences(input: {
    owned: ReadonlyArray<{ taskId: string; classKey: string; owner: string }>;
    classes: ReadonlyArray<{ class: string; rounds: string[]; findings: string[] }>;
}): OwnedClassRecurrence[] {
    const byNormalised = new Map<string, { taskId: string; classKey: string; owner: string }>();
    for (const entry of input.owned) {
        const key = normaliseClassKey(entry.classKey);
        if (key === '' || byNormalised.has(key)) continue;
        byNormalised.set(key, entry);
    }
    const out: OwnedClassRecurrence[] = [];
    for (const entry of input.classes) {
        const owner = byNormalised.get(normaliseClassKey(entry.class));
        if (!owner) continue;
        out.push({
            classKey: owner.classKey,
            ownerTaskId: owner.taskId,
            owner: owner.owner,
            recordedAs: entry.class,
            rounds: [...entry.rounds],
            findings: [...entry.findings],
        });
    }
    return out;
}
