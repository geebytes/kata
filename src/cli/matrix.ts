import { readTask } from '../core/task.js';
import { mutateTaskArtefact } from '../core/state.js';
import { resolveWorkspaceRoot, taskPath } from '../core/layout.js';
import { validateMatrix } from '../quality/acceptance-matrix.js';

/**
 * Correcting a sealed task's acceptance-matrix declaration.
 *
 * The matrix could only be supplied through `open --bootstrap-file`, which exists at creation and never again. Measured
 * consequence: two criteria declared the same `testSelector`; the seal dedupes evidence by selector (correctly), so one
 * criterion ended up with no evidence at all and verify failed `insufficient_evidence_level` — with no supported way to
 * correct the declaration. The only remaining option was hand-editing `task.json`, which is precisely the
 * unverifiable-write pattern this platform exists to remove.
 *
 * Two corrections are supported, and they are deliberately different in kind:
 *
 *  - **the evidence declaration** (`--selector`) — validated against the whole declaration so a correction cannot
 *    reproduce the ambiguity it was made to fix;
 *  - **the statement** (`--statement`) — the declaration that can be false as written. It is guarded, not free: it requires
 *    a reason, the previous text is kept beside the task, and the ids are untouched. Statements were outside this command's
 *    scope by design; two criteria in `wiring-coverage-check` being unsatisfiable as written is why that changed.
 */
export interface MatrixCommandResult extends Record<string, unknown> {
    command: 'matrix';
    taskId: string;
    action: string;
    updated: boolean;
    reason?: string;
    acceptanceId?: string;
    selector?: string;
    error?: string;
}

/** Reads a flag's single value. Deliberately one value per flag: `--selector` names one selector. */
function valueAfter(argv: string[], flag: string): string | undefined {
    const index = argv.indexOf(flag);
    if (index === -1) return undefined;
    const value = argv[index + 1];
    return value && !value.startsWith('--') ? value : undefined;
}

/**
 * Selectors declared by more than one criterion.
 *
 * The seal emits one evidence file per selector, so a selector shared by two criteria evidences one of them and leaves
 * the other unreferenced. This is a property of the declaration as a whole, which is why it is checked before writing.
 */
export function sharedSelectors(rows: Array<{ acceptanceId: string; evidence?: Array<{ testSelector?: string }> }>): string[] {
    const bySelector = new Map<string, Set<string>>();
    for (const row of rows) {
        for (const item of row.evidence ?? []) {
            if (!item.testSelector) continue;
            const owners = bySelector.get(item.testSelector) ?? new Set<string>();
            owners.add(row.acceptanceId);
            bySelector.set(item.testSelector, owners);
        }
    }
    return [...bySelector.entries()]
        .filter(([, owners]) => owners.size > 1)
        .map(([selector, owners]) => `${selector} declared by ${[...owners].sort().join(', ')}`);
}

export async function runMatrixCommand(
    argv: string[],
    rootOverride?: string,
): Promise<MatrixCommandResult> {
    const action = argv[0] ?? '';
    const change = valueAfter(argv, '--change');
    if ((action !== 'set' && action !== 'declare') || !change) {
        throw new Error('Usage: kata-cli matrix set --change <task-id> --acceptance <AC-id> --selector <test path> --reason "<why>" · kata-cli matrix declare --change <task-id> --from-file <matrix.json> --reason "<why>"');
    }
    const root = resolveWorkspaceRoot(rootOverride);
    const acceptanceId = valueAfter(argv, '--acceptance');
    const selector = valueAfter(argv, '--selector');
    const reason = valueAfter(argv, '--reason');

    // The other half: a task that has **no** matrix cannot be archived, and its status reads green while it is refused.
    // Measured: `major-finding-closure` and `repair-obligation-deadlock` both report `judge PASS`, `verify PASS`, zero
    // failing evidence and zero obligations, and `archive` refuses them for `missingAcceptanceMatrix` — a field the status
    // payload carries and neither the ladder nor the refusal message names. Rows were declarable only at
    // `open --bootstrap-file`, so a task created before that existed had no way to acquire one.
    if (action === 'declare') {
        const fromFile = valueAfter(argv, '--from-file');
        const why = valueAfter(argv, '--reason');
        if (!fromFile || !why?.trim()) {
            return { command: 'matrix', taskId: change, action, updated: false, error: 'Declaring a matrix requires --from-file <matrix.json> and --reason "<why>".' };
        }
        try {
            const { readFile: read } = await import('node:fs/promises');
            const declared = JSON.parse(await read(`${root}/${fromFile}`, 'utf8')) as { version?: number; rows?: unknown[] };
            const declaredTask = await readTask(root, change);
            if (declaredTask.acceptanceMatrix) {
                return { command: 'matrix', taskId: change, action, updated: false, error: `${change} already declares a matrix; declaring a second would discard the first silently. Correct it with matrix set instead.` };
            }
            const next = { version: declared.version ?? 1, rows: (declared.rows ?? []) };
            const errors = validateMatrix(declaredTask.acceptance ?? [], next as never);
            if (errors.length > 0) {
                return { command: 'matrix', taskId: change, action, updated: false, error: `The declared matrix does not validate: ${errors.map((entry) => entry.message).join('; ')}` };
            }
            await mutateTaskArtefact(root, change, taskPath(root, change), async (raw) => {
                const current = JSON.parse(raw) as Record<string, unknown>;
                return `${JSON.stringify({ ...current, acceptanceMatrix: next }, null, 2)}\n`;
            });
            return { command: 'matrix', taskId: change, action, updated: true, reason: why, rows: next.rows.length };
        } catch (error) {
            return { command: 'matrix', taskId: change, action, updated: false, error: error instanceof Error ? error.message : String(error) };
        }
    }

    // A corrected declaration is a decision, and an unexplained one is the drift this records — the same rule
    // `scope change` applies to a grown surface.
    if (!reason || !reason.trim()) {
        return { command: 'matrix', taskId: change, action, updated: false, error: 'A matrix correction requires --reason: a declaration that changes shape is a decision, and an unexplained one is the drift this records.' };
    }
    if (!acceptanceId) {
        return { command: 'matrix', taskId: change, action, updated: false, error: 'A matrix correction requires --acceptance <AC-id>.' };
    }
    // The **fourth** variant of the same gap, and the one that blocked a seal: a row's evidence command was written as
    // `npx vitest run <selector>`, which the collector cannot append a selector to — so the seal refused with "declares a
    // testSelector but command ... does not support selectors", and no command could correct it. Same shape as the selector,
    // the statement and the implementation path before they got one.
    const evidenceCommand = valueAfter(argv, '--command');
    if (evidenceCommand !== undefined) {
        if (evidenceCommand.trim().length === 0) {
            return { command: 'matrix', taskId: change, action, updated: false, error: 'A command correction requires a non-empty --command.' };
        }
        try {
            const task = await readTask(root, change);
            const matrix = task.acceptanceMatrix;
            if (!matrix) {
                return { command: 'matrix', taskId: change, action, updated: false, error: `${change} declares no acceptance matrix, so there is no row to correct.` };
            }
            const index = matrix.rows.findIndex((row) => row.acceptanceId === acceptanceId);
            if (index === -1) {
                return { command: 'matrix', taskId: change, action, updated: false, error: `Acceptance criterion ${acceptanceId} is not declared by this task, so it has no row to correct.` };
            }
            const previousCommands = (matrix.rows[index]?.evidence ?? []).map((entry) => entry.command);
            const rows = matrix.rows.map((row, position) => (position === index
                ? { ...row, evidence: (row.evidence ?? []).map((entry) => ({ ...entry, command: evidenceCommand })) }
                : row));
            const next = { ...matrix, rows };
            const errors = validateMatrix(task.acceptance ?? [], next as never);
            if (errors.length > 0) {
                return { command: 'matrix', taskId: change, action, updated: false, error: `The corrected matrix does not validate: ${errors.map((entry) => entry.message).join('; ')}` };
            }
            await mutateTaskArtefact(root, change, taskPath(root, change), async (raw) => {
                const current = JSON.parse(raw) as Record<string, unknown>;
                return `${JSON.stringify({ ...current, acceptanceMatrix: next }, null, 2)}\n`;
            });
            return { command: 'matrix', taskId: change, action, updated: true, reason, acceptanceId, evidenceCommand, previousCommands };
        } catch (error) {
            return { command: 'matrix', taskId: change, action, updated: false, error: error instanceof Error ? error.message : String(error) };
        }
    }

    // The third variant of the same gap, and the one that surfaced as a minor finding: a matrix row declared an
    // implementation path that does not exist (`src/quality/change-surface.ts`, a file this change never created), and the
    // brief's reading set then named it — so a reviewer was told to start reading a file that is not there. Rows were
    // declarable only at `open --bootstrap-file`, exactly as selectors and statements were before they got a command.
    const implementationPaths = valueAfter(argv, '--implementation-path');
    if (implementationPaths !== undefined) {
        const paths = implementationPaths.split(',').map((path) => path.trim()).filter((path) => path.length > 0);
        if (paths.length === 0) {
            return { command: 'matrix', taskId: change, action, updated: false, error: 'A path correction requires a non-empty --implementation-path (comma-separated for several).' };
        }
        try {
            const task = await readTask(root, change);
            const matrix = task.acceptanceMatrix;
            if (!matrix) {
                return { command: 'matrix', taskId: change, action, updated: false, error: `${change} declares no acceptance matrix, so there is no row to correct.` };
            }
            const index = matrix.rows.findIndex((row) => row.acceptanceId === acceptanceId);
            if (index === -1) {
                return { command: 'matrix', taskId: change, action, updated: false, error: `Acceptance criterion ${acceptanceId} is not declared by this task, so it has no row to correct.` };
            }
            const previousPaths = [...(matrix.rows[index]?.implementationPaths ?? [])];
            const rows = matrix.rows.map((row, position) => (position === index ? { ...row, implementationPaths: paths } : row));
            const next = { ...matrix, rows };
            const errors = validateMatrix(task.acceptance ?? [], next as never);
            if (errors.length > 0) {
                return { command: 'matrix', taskId: change, action, updated: false, error: `The corrected matrix does not validate: ${errors.map((entry) => entry.message).join('; ')}` };
            }
            await mutateTaskArtefact(root, change, taskPath(root, change), async (raw) => {
                const current = JSON.parse(raw) as Record<string, unknown>;
                return `${JSON.stringify({ ...current, acceptanceMatrix: next }, null, 2)}\n`;
            });
            return { command: 'matrix', taskId: change, action, updated: true, reason, acceptanceId, implementationPaths: paths, previousPaths };
        } catch (error) {
            return { command: 'matrix', taskId: change, action, updated: false, error: error instanceof Error ? error.message : String(error) };
        }
    }

    // A **statement** correction: the declaration that can be false as written. Measured on `wiring-coverage-check`, whose
    // AC-2 said the check "finds the 24 dead exported symbols" and AC-4 that a test asserts "the 15 guards measured to be
    // removable" — both numbers withdrawn, so no test could satisfy them without asserting a falsehood, and there was no
    // governed way to say so. The statements and their ids are what this command was documented not to touch; that was a
    // design, and this is the decision to lift it for statements only.
    const statement = valueAfter(argv, '--statement');
    if (statement !== undefined) {
        if (!statement.trim()) {
            return { command: 'matrix', taskId: change, action, updated: false, error: 'A statement correction requires a non-empty --statement.' };
        }
        try {
            const task = await readTask(root, change);
            const acceptance = (task.acceptance ?? []).find((item) => item.id === acceptanceId);
            if (!acceptance) {
                return { command: 'matrix', taskId: change, action, updated: false, error: `Acceptance criterion ${acceptanceId} is not declared by this task, so it has no statement to correct.` };
            }
            const previous = acceptance.statement;
            if (previous === statement) {
                return { command: 'matrix', taskId: change, action, updated: false, error: 'That statement is already the declared one.' };
            }
            await mutateTaskArtefact(root, change, taskPath(root, change), async (raw) => {
                const current = JSON.parse(raw) as Record<string, unknown>;
                const items = (current.acceptance ?? []) as Array<Record<string, unknown>>;
                return `${JSON.stringify({ ...current, acceptance: items.map((item) => (item.id === acceptanceId ? { ...item, statement } : item)) }, null, 2)}\n`;
            });
            // The previous statement is recorded **beside** the task, never on the acceptance item: that item is
            // `additionalProperties: false` over `id`/`statement`/`claims`, so a history field there would make the task
            // unreadable — checked before this was written rather than discovered after. Same shape as `scope change`
            // recording a grown surface, and as the change record carrying its `surfaceBasis`.
            const corrections = `${root}/.kata/tasks/${change}/declaration-corrections.json`;
            const { readFile: read, writeFile: write, mkdir } = await import('node:fs/promises');
            const { dirname } = await import('node:path');
            await mkdir(dirname(corrections), { recursive: true });
            const history = await read(corrections, 'utf8').then((text) => JSON.parse(text) as unknown[]).catch(() => [] as unknown[]);
            history.push({ acceptanceId, previous, statement, reason, by: valueAfter(argv, '--by') ?? 'user', at: new Date().toISOString() });
            await write(corrections, `${JSON.stringify(history, null, 2)}\n`, 'utf8');
            return { command: 'matrix', taskId: change, action, updated: true, reason, acceptanceId, statement, previous };
        } catch (error) {
            return { command: 'matrix', taskId: change, action, updated: false, error: error instanceof Error ? error.message : String(error) };
        }
    }

    if (!selector) {
        return { command: 'matrix', taskId: change, action, updated: false, error: 'A matrix correction requires --selector <test path>.' };
    }

    try {
        const task = await readTask(root, change);
        const matrix = task.acceptanceMatrix;
        if (!matrix) {
            return { command: 'matrix', taskId: change, action, updated: false, error: `${change} declares no acceptance matrix, so there is no evidence declaration to correct.` };
        }
        const index = matrix.rows.findIndex((row) => row.acceptanceId === acceptanceId);
        if (index === -1) {
            // Refused rather than appended: an orphan row would reference a criterion that does not exist, which is what
            // `validateMatrix` rejects — reaching that error by writing first would leave the task unreadable.
            return { command: 'matrix', taskId: change, action, updated: false, error: `Acceptance criterion ${acceptanceId} is not declared by this task, so it has no row to correct.` };
        }

        const rows = matrix.rows.map((row, position) => {
            if (position !== index) return row;
            const evidence = row.evidence ?? [];
            // The selector is corrected on the declaration the row already carries, so ids and kinds survive unchanged.
            const declared = { id: `${acceptanceId.toLowerCase()}-test`, kind: 'test' as const, command: 'vitest', testSelector: selector };
            const replaced = evidence.length > 0
                ? evidence.map((item, itemIndex) => (itemIndex === 0 ? { ...item, testSelector: selector } : item))
                : [declared];
            const previous = row.evidence?.[0]?.testSelector;
            return {
                ...row,
                testPaths: [...new Set([...(row.testPaths ?? []).filter((path) => path !== previous), selector])],
                evidence: replaced,
            };
        });

        // Validated as a whole, before anything is written: a correction must not reproduce the ambiguity it fixes.
        const shared = sharedSelectors(rows);
        if (shared.length > 0) {
            return {
                command: 'matrix',
                taskId: change,
                action,
                updated: false,
                error: `That correction would leave a selector declared by more than one criterion (${shared.join('; ')}). The seal emits one evidence file per selector, so a shared selector cannot evidence both — declare a distinct selector per criterion.`,
            };
        }

        const next = { ...matrix, rows };
        const errors = validateMatrix(task.acceptance ?? [], next);
        if (errors.length > 0) {
            return { command: 'matrix', taskId: change, action, updated: false, error: `The corrected matrix does not validate: ${errors.map((entry) => entry.message).join('; ')}` };
        }

        // Written through the same locked path every other task mutation uses, so the read-modify-write window is closed
        // by construction rather than by a second lock design.
        await mutateTaskArtefact(root, change, taskPath(root, change), async (raw) => {
            const current = JSON.parse(raw) as Record<string, unknown>;
            return `${JSON.stringify({ ...current, acceptanceMatrix: next }, null, 2)}\n`;
        });
        return { command: 'matrix', taskId: change, action, updated: true, reason, acceptanceId, selector };
    } catch (error) {
        return { command: 'matrix', taskId: change, action, updated: false, error: error instanceof Error ? error.message : String(error) };
    }
}