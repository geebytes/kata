import type { AcceptanceMatrix, AcceptanceMatrixRow } from '../core/task.js';
import { matrixChecks } from './check-resolver.js';
import type { CheckCommand } from './evidence.js';

/**
 * Which checks a change actually touches, derived by the platform (F4 of the finding-lifecycle design).
 *
 * The design's problem: which checks a seal runs was decided by how a project *declared* them (`buildChecks` tiers), so
 * "the inner loop is expensive" could only be answered by each project hand-sorting its own checks into tiers — a
 * case-by-case fix that turns one general problem into N project configurations and greets every new project with it.
 *
 * The platform already has both inputs: the change surface (`revision-delta.ts`) and the acceptance matrix (acceptance →
 * implementation/test paths → evidence commands). So the default is *derived*:
 *
 *   1. map each changed path to the acceptance rows that declare it (implementation or test path);
 *   2. take the checks those rows declare as evidence;
 *   3. **fall back to the full set** whenever the mapping cannot be made — a path no row declares, a matrix that is
 *      absent, or a row whose declaration resolves to nothing.
 *
 * Rule 3 is a hard requirement, not an optimisation: a derivation that silently under-runs is worse than no derivation
 * at all, and "cheap" must never mean "invisible".
 */
export interface RelevantChecks {
    /** The checks this change touches, in matrix order. */
    relevant: CheckCommand[];
    /** The checks declared for the task that the change does not touch: excluded, and reported as excluded. */
    excluded: CheckCommand[];
    /**
     * Why the derivation fell back to everything, when it did. A reader must be able to tell "this change touches one
     * acceptance" from "the platform could not tell, so it ran everything".
     */
    fellBackToFull: boolean;
    fallbackReason?: string;
    changedPaths: string[];
    /** The acceptance ids the changed paths mapped to. */
    acceptanceIds: string[];
}

function rowDeclaresPath(row: AcceptanceMatrixRow, path: string): boolean {
    return [...row.implementationPaths, ...row.testPaths].some((declared) => {
        if (declared === path) return true;
        // A declared directory covers the paths under it; a declared file is matched exactly.
        return declared.endsWith('/') && path.startsWith(declared);
    });
}

/** The acceptance rows a changed path belongs to, by the paths the rows declare. */
export function rowsForChangedPaths(matrix: AcceptanceMatrix, changedPaths: string[]): AcceptanceMatrixRow[] {
    const rows = new Map<string, AcceptanceMatrixRow>();
    for (const path of changedPaths) {
        for (const row of matrix.rows) {
            if (rowDeclaresPath(row, path)) rows.set(row.acceptanceId, row);
        }
    }
    return [...rows.values()].sort((a, b) => a.acceptanceId.localeCompare(b.acceptanceId));
}

/**
 * The derivation, with its fallback.
 *
 * `full` is the set that would run anyway (matrix checks plus whatever the project declared); `relevant` is what the
 * change touches. When anything about the mapping is uncertain the answer is `full`, and `fellBackToFull` says so.
 */
export function deriveRelevantChecks(input: {
    root: string;
    matrix: AcceptanceMatrix | undefined;
    changedPaths: string[];
    full: CheckCommand[];
}): RelevantChecks {
    const { root, matrix, changedPaths, full } = input;
    if (changedPaths.length === 0) {
        return { relevant: full, excluded: [], fellBackToFull: true, fallbackReason: 'no change surface to derive from', changedPaths, acceptanceIds: [] };
    }
    if (!matrix || matrix.rows.length === 0) {
        return { relevant: full, excluded: [], fellBackToFull: true, fallbackReason: 'the task declares no acceptance matrix', changedPaths, acceptanceIds: [] };
    }

    const rows = rowsForChangedPaths(matrix, changedPaths);
    if (rows.length === 0) {
        return {
            relevant: full,
            excluded: [],
            fellBackToFull: true,
            fallbackReason: `no acceptance row declares any of the changed paths (${changedPaths.join(', ')})`,
            changedPaths,
            acceptanceIds: [],
        };
    }

    // The rows' own evidence, resolved the same way a seal resolves them.
    let relevant: CheckCommand[] = [];
    try {
        relevant = matrixChecks(root, { version: 1, rows });
    } catch (error) {
        return {
            relevant: full,
            excluded: [],
            fellBackToFull: true,
            fallbackReason: `the acceptance rows for the change could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
            changedPaths,
            acceptanceIds: rows.map((row) => row.acceptanceId),
        };
    }
    if (relevant.length === 0) {
        return {
            relevant: full,
            excluded: [],
            fellBackToFull: true,
            fallbackReason: 'the acceptance rows for the change declare no evidence checks',
            changedPaths,
            acceptanceIds: rows.map((row) => row.acceptanceId),
        };
    }

    const relevantKeys = new Set(relevant.map(checkKey));
    const excluded = full.filter((check) => !relevantKeys.has(checkKey(check)));
    return {
        relevant,
        excluded,
        fellBackToFull: false,
        changedPaths,
        acceptanceIds: rows.map((row) => row.acceptanceId),
    };
}

function checkKey(check: CheckCommand): string {
    return [check.kind, check.command, (check.args ?? []).join('\0'), check.cwd ?? ''].join('|');
}
