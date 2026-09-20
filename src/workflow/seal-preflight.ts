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
import { obligationIsAnswered, readObligations } from '../quality/repair-obligations.js';
import { deferredChecks, renderCommand, runWithConcurrency, type CheckCommand, type EvidenceEnvelope } from '../quality/evidence.js';

/**
 * How many independent preflight reads may be in flight (L1-04).
 *
 * Bounded rather than unbounded for the reason the seal's own concurrency is opt-in: these reads touch the same
 * workspace and the same CodeGraph index, and a preflight that oversubscribes them turns a diagnostic into a timeout.
 */
const preflightConcurrency = 4;

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
    /**
     * The checks this seal is about to run. Used only for the obligation dry run: an obligation is answerable when the
     * evidence this run will produce answers it, and the declared checks are what will produce that evidence.
     */
    plannedChecks?: CheckCommand[];
    /** Whether this seal will run the checks a project marked `tier: 'frozen'`; a deferred check produces no evidence. */
    includeFrozen?: boolean;
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
    // The acceptance ids this run intends to satisfy: every criterion the task declares, since the seal is the run that
    // proves them. The resolver is given the same set, so the dry run and the real answer are computed over one input.
    const resolvedAcceptanceIds = task.acceptanceMatrix
        ? task.acceptanceMatrix.rows.map((row) => row.acceptanceId)
        : (task.acceptance ?? []).flatMap((item) => (item.id ? [item.id] : []));
    /**
     * The evidence this run is about to collect, as far as answerability is concerned: one passing item per declared
     * check. Ids are the check ids, because that is what `evidenceIds` carries and what a matrix row matches on.
     */
    // Only the checks this run will actually execute: a deferred (frozen-tier) check produces no evidence, so counting it
    // as planned made the dry run over-promise and let a seal pass while an obligation stayed unresolved.
    const willRun = (options.plannedChecks ?? []).filter((check) => !deferredChecks(options.plannedChecks ?? [], options.includeFrozen === true).includes(check));
    const plannedEvidence: EvidenceEnvelope[] = willRun.map((check) => ({
        id: check.id ?? check.name ?? check.command,
        taskId,
        kind: check.kind,
        command: renderCommand(check.command, check.args ?? []),
        ...(check.id ? { checkId: check.id } : {}),
        exitCode: 0,
        startedAt: '',
        finishedAt: '',
        diffHash: '',
    }));
    const blockers: SealBlocker[] = [];
    const deny = (code: string, message: string, diagnostics: Record<string, unknown>): void => {
        blockers.push({ code, message, diagnostics });
    };

    // 1-5. The independent reads, collected concurrently and reported in the order below (L1-04).
    //
    // Every step here is a pure read whose only ordering requirement is that a read consuming an earlier read's value
    // runs after it; the matrix and coverage steps read the task, not each other, so they overlap. The scheduler bounds
    // them rather than leaving them unbounded, because they touch the same workspace and the same CodeGraph index.
    // `blockers` is filled out of order and read in order, which is what keeps the reported list identical to the
    // serial one a caller and its tests already depend on.
    const matrixRequired = requiresMatrix(task.workflowProfile);
    const independent: Array<() => Promise<void>> = [
        // 1-2. The acceptance matrix: required by strict closure, and only meaningful when it validates.
        async () => {
            if (matrixRequired && !task.acceptanceMatrix) {
                deny('missingMatrix', 'Strict closure requires an acceptanceMatrix; add it to task.json before sealing.', { missingMatrix: true });
            } else if (task.acceptanceMatrix) {
                const matrixErrors = validateMatrix(task.acceptance ?? [], task.acceptanceMatrix);
                if (matrixRequired && matrixErrors.length > 0) {
                    deny('matrixErrors', `Acceptance matrix validation failed: ${matrixErrors.length} error(s).`, { matrixErrors });
                }
            }
        },
        // 3-4. Upstream coverage: required by strict closure, and validated against the matrix when present.
        async () => {
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
        },
        // 5. An obligation this run cannot answer. An obligation this run **will** answer must not refuse it: the seal
        //    runs this check before the checks, and the resolver that stamps `resolvedAt` runs after them, so denying an
        //    answerable obligation stopped the very run that would have produced its evidence — a deadlock. The verdict
        //    comes from the same `obligationIsAnswered` rule the resolver uses, asked here about the evidence this run is
        //    about to collect, so the two cannot drift into a seal that passes while leaving the obligation open.
        async () => {
            const unresolved = (await readObligations(root, taskId)).filter((obligation) => !obligation.resolvedAt);
            if (unresolved.length === 0) return;
            const answerable = new Set(
                unresolved
                    .filter((obligation) =>
                        obligationIsAnswered({
                            obligation,
                            resolvedAcceptanceIds,
                            evidence: plannedEvidence,
                            ...(task.acceptanceMatrix ? { matrix: task.acceptanceMatrix } : {}),
                        }).answered,
                    )
                    .map((obligation) => obligation.id),
            );
            const unanswered = unresolved.filter((obligation) => !answerable.has(obligation.id));
            if (unanswered.length === 0) return;
            const acceptanceIds = [...new Set(unanswered.map((obligation) => obligation.acceptanceId).filter((id): id is string => Boolean(id)))];
            deny(
                'unresolvedObligations',
                `Unresolved repair obligations: ${unanswered.length} obligation(s) this seal cannot answer${acceptanceIds.length > 0 ? ` (${acceptanceIds.join(', ')})` : ''}. Every terminal finding owes a repair, and the seal records which evidence answered it. Supply passing evidence for the affected acceptance id(s), or add an acceptanceMatrix to task.json to bind each one to a specific check.`,
                {
                    unresolvedObligations: unanswered.length,
                    unresolvedAcceptanceIds: acceptanceIds,
                    // The distinction the reader needs: these were answerable, and are not why the seal is blocked.
                    ...(answerable.size > 0 ? { answerableObligations: answerable.size } : {}),
                },
            );
        },
    ];
    await runWithConcurrency(independent, preflightConcurrency, () => 1, async (step) => { await step(); });

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

