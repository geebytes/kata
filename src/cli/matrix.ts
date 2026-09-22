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
 * What this command is **not**: a way to change the acceptance criteria. The statements and their ids are untouched;
 * only the evidence declaration is corrected, and the result is validated against the whole declaration so a correction
 * cannot reproduce the ambiguity it was made to fix.
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
    if (action !== 'set' || !change) {
        throw new Error('Usage: kata-cli matrix set --change <task-id> --acceptance <AC-id> --selector <test path> --reason "<why>"');
    }
    const root = resolveWorkspaceRoot(rootOverride);
    const acceptanceId = valueAfter(argv, '--acceptance');
    const selector = valueAfter(argv, '--selector');
    const reason = valueAfter(argv, '--reason');

    // A corrected declaration is a decision, and an unexplained one is the drift this records — the same rule
    // `scope change` applies to a grown surface.
    if (!reason || !reason.trim()) {
        return { command: 'matrix', taskId: change, action, updated: false, error: 'A matrix correction requires --reason: a declaration that changes shape is a decision, and an unexplained one is the drift this records.' };
    }
    if (!acceptanceId) {
        return { command: 'matrix', taskId: change, action, updated: false, error: 'A matrix correction requires --acceptance <AC-id>.' };
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