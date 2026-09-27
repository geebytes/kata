import { appendFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { taskDir, taskPath } from '../core/layout.js';
import { mutateTaskArtefact } from '../core/state.js';
import { validate } from '../core/schema.js';
import { readTask, type AcceptanceMatrix, type UpstreamCoverage } from '../core/task.js';
import { findOrphanAcs } from './acceptance-matrix.js';

/**
 * **The two declarations a task carries, and the governed way to change them.**
 *
 * Both are part of `task.json`, and until this module neither had a command. That is the defect class this repository
 * records most: a declaration with a reader and no governed writer, so the only route was hand-editing the file — which is
 * exactly what happened while walking a real change. `design` refused with
 *
 *     Design blocked: 1 acceptance criterion(s) have no upstream requirement (AC-1)
 *
 * and the fix available to the author was to edit `task.json` by hand, outside every lock and with no record of who
 * decided it or why. `ownedPaths` has `scope change` (recorded, attributable, with a reason); the acceptance matrix and
 * the upstream coverage had nothing.
 *
 * **One step rather than the two `scope` uses**, and the difference is real rather than a shortcut: `scope` needs a record
 * and then an apply because the apply changes the surface a revision hashes, so the record has to exist before the surface
 * moves. These two are not hashed as a surface — they live inside `task.json` — so the decision and its effect can land
 * together. What is preserved is the property that matters: the record is written **before** the task, both under the lock,
 * and a refusal writes neither.
 *
 * The rules are the ones the readers enforce, applied at the write: a coverage whose criterion has no requirement is
 * refused here for the same reason `design` refuses it, so the hand-edit route cannot produce a task the next command
 * rejects.
 */
export type DeclarableField = 'upstreamCoverage' | 'acceptanceMatrix';

export interface DeclarationChange {
    id: string;
    at: string;
    /** Who decided, so a declaration is attributable rather than ambient. */
    by: string;
    /** The sentence the next reader will judge the decision by. Required, because an unexplained one is drift. */
    reason: string;
    field: DeclarableField;
    /** A summary of the change, since the payload can be large and the log is read by people. */
    summary: string;
}

export type DeclarationResult =
    | { ok: true; change: DeclarationChange; field: DeclarableField; summary: string }
    | { ok: false; refused: string };

/** The append-only decision log, beside the task it belongs to rather than inside the task record. */
export function declarationChangesPath(root: string, taskId: string): string {
    return join(taskDir(root, taskId), 'declaration-changes.jsonl');
}

function summarise(field: DeclarableField, value: unknown): string {
    if (field === 'upstreamCoverage') {
        const coverage = value as UpstreamCoverage;
        const sources = coverage.sources?.length ?? 0;
        const mapped = (coverage.sources ?? []).flatMap((source) => source.requirements ?? []).filter((req) => req.mappedTo).length;
        return `${sources} source(s), ${mapped} requirement(s) mapped to a criterion`;
    }
    const matrix = value as AcceptanceMatrix;
    const rows = matrix.rows?.length ?? 0;
    const evidence = (matrix.rows ?? []).flatMap((row) => row.evidence ?? []).length;
    return `${rows} row(s), ${evidence} evidence declaration(s)`;
}

/**
 * Record and apply a declaration change.
 *
 * The order is load-bearing: validate, then write the record, then write the task. A refusal at any point leaves the task
 * exactly as it was, which is the half a caller cannot check afterwards.
 */
export async function declareTaskField(input: {
    root: string;
    taskId: string;
    field: DeclarableField;
    value: unknown;
    reason: string;
    by: string;
    now?: string;
}): Promise<DeclarationResult> {
    if (!input.reason?.trim()) {
        return { ok: false, refused: 'A declaration change requires --reason: it changes what the change is judged against, and an unexplained one is drift.' };
    }
    // `readTask` throws when the record is absent, so the absence is caught rather than checked against a null: a check
    // would be dead code beside a throwing reader, which is a guard that cannot fire.
    let task;
    try {
        task = await readTask(input.root, input.taskId);
    } catch {
        return { ok: false, refused: `no task '${input.taskId}' exists in this workspace` };
    }

    // **The schema first, then the rule.** Validated against the task schema rather than against a second shape, so the file
    // that lands is one every reader accepts. It runs *before* the rule below, and that order was learned by running the
    // command on a real payload: handed a file whose top level held the whole bootstrap contract rather than a coverage
    // object, the rule read `coverage.sources` off it and threw `coverage.sources is not iterable` at the operator. A crash
    // where a refusal belongs is the same shape as a refusal no reader can act on — the input reached a function that
    // assumes a shape nothing had checked.
    try {
        validate('task', { ...task, [input.field]: input.value });
    } catch (error) {
        return { ok: false, refused: `the declaration would not produce a valid task record: ${(error as Error).message}` };
    }

    // **The rule the reader enforces, enforced at the write.** `design` refuses a task whose criterion has no upstream
    // requirement, so accepting one here would hand the next command a task it must reject — the write trusting its input
    // while every read path validates it, which is the shape both halves of `scope` were fixed for.
    if (input.field === 'upstreamCoverage') {
        const coverage = input.value as UpstreamCoverage;
        const orphanAcs = findOrphanAcs(task.acceptance ?? [], coverage);
        if (orphanAcs.length > 0) {
            return {
                ok: false,
                refused: `${orphanAcs.length} acceptance criterion(s) would have no upstream requirement (${orphanAcs.map((orphan) => orphan.acId).join(', ')}), which \`kata-cli design\` refuses. Map each criterion to a requirement, or record why it is out of scope on the requirement.`,
            };
        }
    }

    const change: DeclarationChange = {
        id: `declaration-${Date.now().toString(36)}`,
        at: input.now ?? new Date().toISOString(),
        by: input.by,
        reason: input.reason.trim(),
        field: input.field,
        summary: summarise(input.field, input.value),
    };

    // The record first, so a task that carries the change always has the decision that produced it. The reverse order would
    // let a crash leave the declaration with no account of itself.
    const log = declarationChangesPath(input.root, input.taskId);
    await mkdir(dirname(log), { recursive: true });
    await appendFile(log, `${JSON.stringify(change)}\n`, 'utf8');
    await mutateTaskArtefact(input.root, input.taskId, taskPath(input.root, input.taskId), async (existing) =>
        JSON.stringify({ ...(JSON.parse(existing) as Record<string, unknown>), [input.field]: input.value, updatedAt: change.at }, null, 2) + '\n');

    return { ok: true, change, field: input.field, summary: change.summary };
}
