import type { AcceptanceCriterion, AcceptanceMatrix, UpstreamCoverage } from '../core/task.js';
import {
    classifyCodeGraphCandidates,
    discoverCodeGraphCandidates,
    readWaivers,
    requiresMatrix,
    requiresUpstreamCoverage,
    validateMatrix,
    validatePathCoverage,
    validateUpstreamCoverage,
    validateWaivers,
    type CodeGraphCandidate,
    type CodeGraphCandidateDisposition,
    type Waiver,
} from '../quality/acceptance-matrix.js';
import { outOfScopeRepairPaths, repairScopePaths } from '../quality/repair.js';
import { computeManifestHash } from './revision.js';
import { readActiveRepair, readActiveReviewRepairBaseline } from './seal-reads.js';
import { findOwnershipConflicts, inferOwnedPathsFromWorkspace } from './revision.js';
import { readObligations } from '../quality/repair-obligations.js';

/**
 * Everything a seal refuses on, collected instead of fail-fast.
 *
 * The seal's preflight used to be nine sequential early returns, so a task with three independent closure problems was
 * told about one per run — and every run of that repair loop paid the whole evidence cost again before hitting the next
 * one. The validators are pure reads now and their results are collected: every blocker is reported together, each
 * keeping the message and the diagnostics key the early return used, so nothing that consumed them has to change.
 *
 * Fail-closed is unchanged: any blocker is still a refusal. Stages whose *input* is invalid are skipped rather than
 * run (a matrix that does not exist cannot be validated, and a matrix that does not validate cannot be checked for path
 * coverage), which is also what keeps the collected list from reporting phantom blockers.
 */

export interface SealBlocker {
    /** The diagnostics key the fail-fast return used, so consumers and tests recognise the blocker. */
    code: string;
    message: string;
    diagnostics: Record<string, unknown>;
}

export interface SealPreflightTask {
    acceptance?: AcceptanceCriterion[];
    acceptanceMatrix?: AcceptanceMatrix;
    upstreamCoverage?: UpstreamCoverage;
    workflowProfile?: { strictClosure?: boolean; reviewMode?: string };
    ownedPaths?: string[];
}

export interface SealPreflightOptions {
    waivers?: Waiver[];
    allowOwnershipConflicts?: boolean;
    allowOutOfScopeRepair?: boolean;
    /** Set when owned-path resolution failed; carried as a blocker rather than thrown from the caller. */
    ownedPathsError?: string;
}

export interface SealPreflightResult {
    /** Ordered as the fail-fast version ordered its checks, so the first blocker is the one it would have reported. */
    blockers: SealBlocker[];
    ownedPaths: string[];
    waivers: Waiver[];
    ownershipConflicts: Array<{ taskId: string; path: string }>;
    codeGraphCandidates: CodeGraphCandidate[];
    codeGraphDisposition?: CodeGraphCandidateDisposition;
}

export async function collectSealPreflight(input: {
    root: string;
    taskId: string;
    task: SealPreflightTask;
    ownedPaths: string[];
    options: SealPreflightOptions;
}): Promise<SealPreflightResult> {
    const { root, taskId, task, ownedPaths, options } = input;
    const blockers: SealBlocker[] = [];
    const deny = (code: string, message: string, diagnostics: Record<string, unknown>): void => {
        blockers.push({ code, message, diagnostics });
    };

    // 1-2. The acceptance matrix: required by strict closure, and only meaningful when it validates.
    const matrixRequired = requiresMatrix(task.workflowProfile);
    const matrixUsable = Boolean(task.acceptanceMatrix);
    if (matrixRequired && !task.acceptanceMatrix) {
        deny('missingMatrix', 'Strict closure requires an acceptanceMatrix; add it to task.json before sealing.', { missingMatrix: true });
    } else if (matrixUsable) {
        const matrixErrors = validateMatrix(task.acceptance ?? [], task.acceptanceMatrix);
        if (matrixRequired && matrixErrors.length > 0) {
            deny('matrixErrors', `Acceptance matrix validation failed: ${matrixErrors.length} error(s).`, { matrixErrors });
        }
    }

    // 3-4. Upstream coverage: required by strict closure, and validated against the matrix when present.
    if (requiresUpstreamCoverage(task.workflowProfile) && !task.upstreamCoverage) {
        deny(
            'missingUpstreamCoverage',
            'Strict closure requires upstreamCoverage before sealing; add it to task.json (map upstream doc requirements to ACs or out-of-scope).',
            { missingUpstreamCoverage: true },
        );
    } else if (task.upstreamCoverage) {
        const coverageErrors = validateUpstreamCoverage(task.acceptance ?? [], task.acceptanceMatrix, task.upstreamCoverage, root);
        if (coverageErrors.length > 0) {
            deny('coverageErrors', `Upstream coverage validation failed before sealing: ${coverageErrors.length} error(s).`, { coverageErrors });
        }
    }

    // 5. A legacy task (no matrix) cannot record closure against obligations it never declared.
    if (!task.acceptanceMatrix) {
        const unresolved = (await readObligations(root, taskId)).filter((obligation) => !obligation.resolvedAt);
        if (unresolved.length > 0) {
            deny(
                'unresolvedObligations',
                'Legacy task has unresolved repair obligations; add an acceptanceMatrix to task.json so closure can record matrix-matched evidence for the affected AC(s).',
                {
                    unresolvedObligations: unresolved.length,
                    unresolvedAcceptanceIds: [...new Set(unresolved.map((obligation) => obligation.acceptanceId).filter((id): id is string => Boolean(id)))],
                },
            );
        }
    }

    // 6. Declared ownership is required, and the caller reports why resolving it failed.
    if (options.ownedPathsError) {
        deny('missingOwnedPaths', options.ownedPathsError, { missingOwnedPaths: true });
    }

    let ownershipConflicts: Array<{ taskId: string; path: string }> = [];
    let waivers: Waiver[] = [];
    let codeGraphCandidates: CodeGraphCandidate[] = [];
    let codeGraphDisposition: CodeGraphCandidateDisposition | undefined;

    if (options.ownedPathsError) {
        // Without owned paths the path-shaped checks cannot run; the blocker above is the whole answer.
        return { blockers, ownedPaths, waivers, ownershipConflicts, codeGraphCandidates, codeGraphDisposition };
    }

    // 7. A review repair must have changed the manifest it was opened against.
    const reviewRepairBaseline = await readActiveReviewRepairBaseline(root, taskId);
    if (reviewRepairBaseline) {
        const manifestHash = await computeManifestHash(root, ownedPaths);
        if (manifestHash === reviewRepairBaseline) {
            deny('repairRequired', 'Cannot seal review repair without a changed task manifest; fix the recorded findings and tests before retrying --seal.', { mode: 'implement', repairRequired: true });
        }
    }

    // 8. Bounded repair: while a repair is active, the seal may not carry changes outside its accepted scope.
    //    Drift-authorized repairs record no scopes and are deliberately unconstrained.
    const activeRepair = await readActiveRepair(root, taskId);
    if (activeRepair) {
        const scopePaths = repairScopePaths(
            task.acceptanceMatrix,
            activeRepair.scopes.map((scope) => scope.id).filter((id): id is string => Boolean(id)),
        );
        if (scopePaths.length > 0) {
            const unrelatedRepairPaths = outOfScopeRepairPaths(taskId, await inferOwnedPathsFromWorkspace(root), scopePaths);
            if (unrelatedRepairPaths.length > 0 && !options.allowOutOfScopeRepair) {
                deny(
                    'unrelatedRepairPaths',
                    `Repair touched files outside the failed acceptance scope: ${unrelatedRepairPaths.join(', ')}. Fix only the failing acceptance criteria, or confirm with --allow-out-of-scope-repair.`,
                    { mode: 'implement', unrelatedRepairPaths, repairScopePaths: scopePaths },
                );
            }
        }
    }

    // 9. Declared ownership must not overlap another active task's claim.
    ownershipConflicts = ownedPaths.length ? await findOwnershipConflicts(root, taskId, ownedPaths) : [];
    if (ownershipConflicts.length > 0 && !options.allowOwnershipConflicts) {
        deny('ownershipConflicts', 'Cannot seal while declared task ownership overlaps another task. Use --allow-ownership-conflicts to confirm and proceed.', { ownershipConflicts });
    }

    // 10-12. Strict closure: waivers, then path coverage, then the CodeGraph candidates the matrix did not declare.
    if (matrixRequired) {
        const persistedWaivers = await readWaivers(root, taskId);
        waivers = [...new Map([...persistedWaivers, ...(options.waivers ?? [])].map((waiver) => [waiver.path, waiver])).values()];
        const waiverErrors = validateWaivers(waivers);
        if (waiverErrors.length > 0) {
            deny('waiverErrors', 'Invalid recorded waiver.', { waiverErrors });
            return { blockers, ownedPaths, waivers, ownershipConflicts, codeGraphCandidates, codeGraphDisposition };
        }

        if (task.workflowProfile?.strictClosure && task.acceptanceMatrix) {
            codeGraphCandidates = await discoverCodeGraphCandidates(root, task.acceptanceMatrix, ownedPaths);
            codeGraphDisposition = classifyCodeGraphCandidates(task.acceptanceMatrix, ownedPaths, waivers, codeGraphCandidates);
        }

        const coverage = task.acceptanceMatrix ? validatePathCoverage(task.acceptanceMatrix, ownedPaths) : undefined;
        const waivedPaths = new Set(waivers.map((waiver) => waiver.path));
        const unwaivedMissingImpl = (coverage?.missingImplementationPaths ?? []).filter((path) => !waivedPaths.has(path));
        const unwaivedMissingTest = (coverage?.missingTestPaths ?? []).filter((path) => !waivedPaths.has(path));
        if (unwaivedMissingImpl.length > 0 || unwaivedMissingTest.length > 0 || (codeGraphDisposition?.unresolvedCandidates.length ?? 0) > 0) {
            deny(
                'pathCoverage',
                'Owned path coverage incomplete: matrix implementation and test paths must be covered by owned paths or waived.',
                {
                    missingImplementationPaths: unwaivedMissingImpl,
                    missingTestPaths: unwaivedMissingTest,
                    waivedImplementationPaths: (coverage?.missingImplementationPaths ?? []).filter((path) => waivedPaths.has(path)),
                    waivedTestPaths: (coverage?.missingTestPaths ?? []).filter((path) => waivedPaths.has(path)),
                    ...(codeGraphCandidates.length > 0 ? { codeGraphCandidates, ...(codeGraphDisposition ?? {}) } : {}),
                    waivers,
                },
            );
        }
    }

    return { blockers, ownedPaths, waivers, ownershipConflicts, codeGraphCandidates, codeGraphDisposition };
}

