import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { containedPath } from '../store/verify-context.js';
import { createTask, type AcceptanceMatrix, type ClaimDeclaration, type CreateTaskInput, type UpstreamCoverage } from '../core/task.js';
import { readCurrentState, appendStateEvent, mutateTaskArtefact, transition, transitionForRepair, withTaskLock, writeCurrentState, type Phase, type Actor } from '../core/state.js';
import { buildContextManifest, type ContextManifest } from '../core/context.js';
import { checkFreshness, collectEvidence, computeDiffHash, isPassing, readRecordedEvidence, type CheckCommand, type EvidenceEnvelope } from '../quality/evidence.js';
import { planCheckReuse, type CheckReusePlan } from '../quality/check-reuse.js';
import { findMatrixDeclarationGaps } from '../quality/acceptance-matrix.js';
import { reviewTierFor } from '../quality/review-ladder.js';
import { readChangeRecord } from '../quality/change-record.js';
import { type ReviewFinding } from '../quality/reviewer.js';
import { judge, type JudgeAcceptanceResult, type JudgeResult } from '../quality/judge.js';
import { createHandoff } from './handoff.js';
import { CometGuard } from '../comet/guard.js';
import { assertValidAcceptanceId, assertValidTaskId, requirementIdPattern } from '../core/ids.js';
import { loadConfig } from '../core/config.js';
import { resolveBuildChecks } from '../quality/project-checks.js';
import { describeClaimFailure, evaluateClaims, resolveClaimChecks, validateClaims } from '../quality/claims.js';
import { collectSealPreflight } from './seal-preflight.js';
import { bindsToRevision, currentRevisionIdentity, currentRevisionIdentityFrom, revisionBindingFields } from './verdict-binding.js';
import { dependencyRootsFor, matrixChecks, dedupeChecks as dedupeCheckCommands, sanitizeCheckName } from '../quality/check-resolver.js';
import { acknowledgeCometOpen, defaultWorkflowProfile, isWorkflowProfile, type WorkflowProfile } from '../core/workflow-profile.js';
import { ensureWikiClosure, evaluateWikiClosure, wikiClosureRemedy } from '../wiki/closure.js';
import { distillPassedTaskKnowledge } from '../wiki/provenance.js';
import { nextActionForTask, readUpstreamSummary, suggestCandidateAction } from './navigation.js';
import { type TaskRevision, commitReviewDecision, computeManifestHash, contentSnapshotHash, createTaskRevisionIfChanged, findOwnershipConflicts, inferOwnedPathsFromWorkspace, normalizeOwnedPaths, readReviewDecisionSnapshot, readTaskRevision, revisionIsCurrent, revisionStatus, workspaceDrift } from './revision.js';
import { checksForExecutionSandbox, createExecutionSandbox } from './execution-sandbox.js';
import { classifyCodeGraphCandidates, discoverCodeGraphCandidates, readWaivers, validateMatrix, validatePathCoverage, validateUpstreamCoverage, findRequirementsWithoutEvidence, findOrphanAcs, validateWaivers, writeWaivers, requiresMatrix, requiresUpstreamCoverage, getMatrixRowForAc, acceptanceIdsByCheckId, evidenceMatchesRow, isEntrypointEvidenceKind, type CodeGraphCandidate, type CodeGraphCandidateDisposition, type Waiver } from '../quality/acceptance-matrix.js';
import { outOfScopeRepairPaths, repairScopePaths, type RepairReason, type RepairRecordShape, appendReviewRound } from '../quality/repair.js';
import { assertRepairBaselineStillCurrent, authorizeRepair } from './repair-entry.js';
import { isRepairableScope, repairableJudgeScopes, repairableVerifyScopes, type RepairScope } from '../quality/judge.js';
import { evaluateAcceptanceAdequacy } from '../quality/evidence-adequacy.js';
import { readBlockingProblems, readReview, readReviewMode, readReviewRecord } from './review-read.js';
import { readLedger } from '../store/ledger.js';
import type { VerdictBinding } from './verdict-binding.js';
import { describeBlockingProblems } from '../quality/review-ladder.js';
import { openLedgerProblems, openProblemsReportFields } from '../store/verdict.js';
import { isCurrentAssuranceLevel } from '../kernel/types.js';
import { codeGraphInvocation } from '../codegraph/runtime.js';
import { runProcess } from '../process/run.js';
import { readValidated, readValidatedOptional, validate, validateArtefact } from '../core/schema.js';
import { ensureWorkspaceHygiene } from '../core/layout.js';
import { readTask } from '../core/task.js';
import type { CheckProgressEvent } from '../quality/evidence.js';
import { buildChangeRecord, writeChangeRecord } from '../quality/change-record.js';
import { currentStatePath, evidenceDir, judgePath, repairPath, reviewPath as layoutReviewPath, taskDir, taskPath, verifyPath } from '../core/layout.js';

export type KataCommand = 'open' | 'design' | 'build' | 'review' | 'judge' | 'verify' | 'archive' | 'hotfix' | 'tweak';

export interface CommandResult {
    command: KataCommand;
    taskId: string;
    phase: Phase;
    success: boolean;
    diagnostics?: Record<string, unknown>;
    error?: string;
}

const defaultActor: Actor = { id: 'kata-agent', role: 'implementer' };
const reviewerActor: Actor = { id: 'kata-reviewer', role: 'reviewer' };
const judgeActor: Actor = { id: 'kata-judge', role: 'judge' };

export interface CommandOptions {
    title?: string;
    acceptance?: Array<{ id?: string; statement: string; claims?: ClaimDeclaration[] }>;
    requirements?: Array<{ id?: string; statement: string; source?: string }>;
    checks?: CheckCommand[];
    guard?: CometGuard;
    platform?: string;
    seal?: boolean;
    approve?: boolean;
    reviewEvidence?: string;
    reviewResultFile?: string;
    confirmHostModel?: boolean;
    allowOwnershipConflicts?: boolean;
    allowOutOfScopeRepair?: boolean;
    /** Report the resolved seal check set instead of sealing: what would run, where it came from, and what it cost last. */
    listChecks?: boolean;
    /**
     * Run the checks a project declared `tier: 'frozen'` as well. Off by default: those are the expensive whole-project
     * verifications a project wants at the point the artefact is frozen, and a seal that deferred them says so.
     */
    frozen?: boolean;
    /**
     * Where a task's deferred findings are handed over, for `archive`.
     *
     * Closing a task with known problems stays possible — the design does not pretend otherwise — but it is a recorded
     * decision naming where the finding goes, rather than a list that quietly stops being printed.
     */
    findingsCarriedTo?: string;
    /** Override the config's discovery switch for this run. */
    discoverChecks?: boolean;
    /**
     * Run the whole check set regardless of the change surface, for the points where the artefact is frozen. The tier
     * mechanism already covers declared expensive checks; this covers the derivation itself.
     */
    fullChecks?: boolean;
    /** The owned paths a review actually read (F5). Absent means "the whole revision", the conservative reading. */
    reviewedPaths?: string[];
    workflowProfile?: WorkflowProfile;
    ownedPaths?: string[];
    waivers?: Waiver[];
    /**
     * The declared contract a strict task is born with: acceptance criteria, acceptance matrix, upstream coverage.
     *
     * Without it `open` could only write the placeholder criterion, while `design` refuses to run unless the matrix
     * already exists — so a strict task's only route to a designable state was hand-editing `task.json`, and the
     * platform had no way to check what was written there. Supplied as a file so the criteria carry their claims and
     * the matrix its rows in one record.
     */
    bootstrapFile?: string;
    /** The author's non-derivable rationale, recorded only after the seal rejects factual prose. */
    judgement?: string;
    /** The parsed bootstrap contract itself. `bootstrapFile` is the CLI's spelling; this is what the orchestrator takes. */
    bootstrap?: {
        acceptance: Array<{ id?: string; statement: string; claims?: ClaimDeclaration[] }>;
        acceptanceMatrix?: AcceptanceMatrix;
        upstreamCoverage?: UpstreamCoverage;
    };
    signal?: AbortSignal;
    onProgress?: (event: CheckProgressEvent) => void;
}

function actorFor(actor: Actor, platform?: string): Actor {
    return platform ? { ...actor, platform } : actor;
}

async function guardTransition(
    guard: CometGuard | undefined,
    action: 'check' | 'apply',
    taskId: string,
    phase: string,
): Promise<void> {
    if (!guard) return;
    const result = await guard[action](taskId, phase);
    if (action === 'check' && !result.passed) {
        throw new Error(`Guard ${action} failed for ${phase}: ${result.reason ?? 'guard rejected'}`);
    }
}

export async function runCommand(
    command: KataCommand,
    taskId: string,
    root: string,
    options: CommandOptions = {},
): Promise<CommandResult> {
    assertValidTaskId(taskId);
    switch (command) {
        case 'open':
            return cmdOpen(taskId, root, options);
        case 'design':
            return cmdDesign(taskId, root, options);
        case 'build':
            return cmdBuild(taskId, root, options);
        case 'review':
            return cmdReview(taskId, root, options);
        case 'judge':
            return cmdJudge(taskId, root, options);
        case 'verify':
            return cmdVerify(taskId, root, options);
        case 'archive':
            return cmdArchive(taskId, root, options);
        case 'hotfix':
            return cmdHotfix(taskId, root, options);
        case 'tweak':
            return cmdTweak(taskId, root, options);
        default:
            return { command, taskId, phase: 'intake', success: false, error: `Unknown command: ${command}` };
    }
}

async function cmdOpen(
    taskId: string,
    root: string,
    options: CommandOptions = {},
): Promise<CommandResult> {
    const requirements = options.requirements ?? [];
    // Ids supplied by the caller are checked here rather than at seal: an acceptance id is kata's own numbering, and a
    // requirement id is quoted from the upstream document — both are validated against the one rule that governs them
    // (`core/ids.ts`, kept in step with the schema assets by a test), and a mistake is reported where it is made.
    for (const criterion of options.acceptance ?? []) {
        if (criterion.id) assertValidAcceptanceId(criterion.id);
    }
    for (const requirement of requirements) {
        if (requirement.id && !requirementIdPattern.test(requirement.id)) {
            throw new Error(
                `Invalid upstream requirement id: ${requirement.id}. Use the identifier the upstream document itself uses `
                + `(letters, digits, '.', '_', ':' or '-').`,
            );
        }
    }
    // A declared contract, when one is supplied, is the task's own: it replaces the placeholder criterion rather than
    // sitting beside it. The matrix is validated here and refused before the task directory exists, so a contract that
    // cannot be satisfied leaves nothing behind to clean up — and, more to the point, the *open* command is where the
    // mistake was made, which is where it should be reported.
    const bootstrap = options.bootstrap;
    if (bootstrap) {
        const bootstrapErrors = validateMatrix(bootstrap.acceptance, bootstrap.acceptanceMatrix);
        if (bootstrapErrors.length > 0) {
            return {
                command: 'open', taskId, phase: 'intake', success: false,
                error: `Bootstrap contract refused: ${bootstrapErrors.map((error) => error.message).join('; ')}`,
                diagnostics: { bootstrapErrors },
            };
        }
        for (const criterion of bootstrap.acceptance) {
            if (criterion.id) assertValidAcceptanceId(criterion.id);
        }
    }
    const acceptance = bootstrap?.acceptance.length
        ? bootstrap.acceptance
        : options.acceptance?.length
            ? options.acceptance
            : requirements.length > 0
                ? requirements.map((r, i) => ({ id: `AC-${i + 1}`, statement: r.statement }))
                : [{ id: 'AC-1', statement: 'Implement the change successfully.' }];
    let normalizedOwnedPaths: string[] | undefined;
    if (options.ownedPaths?.length) {
        try {
            normalizedOwnedPaths = normalizeOwnedPaths(root, options.ownedPaths);
        } catch (error) {
            return {
                command: 'open',
                taskId,
                phase: 'intake',
                success: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }
    const input: CreateTaskInput = {
        root,
        id: taskId,
        title: options.title ?? (requirements[0]?.statement.slice(0, 80) ?? `Change ${taskId}`),
        acceptance,
        workflowProfile: options.workflowProfile ?? defaultWorkflowProfile(),
        ...(requirements.length > 0 ? { requirements: requirements.map((r, i) => ({ id: r.id ?? `REQ-${i + 1}`, statement: r.statement, ...(r.source ? { source: r.source } : {}), confirmedAt: new Date().toISOString() })) } : {}),
        ...(normalizedOwnedPaths?.length ? { ownedPaths: normalizedOwnedPaths } : {}),
        ...(bootstrap?.acceptanceMatrix ? { acceptanceMatrix: bootstrap.acceptanceMatrix } : {}),
        ...(bootstrap?.upstreamCoverage ? { upstreamCoverage: bootstrap.upstreamCoverage } : {}),
    };

    const task = await createTask(input);
    let context: ContextManifest;
    try {
        context = await buildContextManifest({ root, taskId, sourceRefs: [] });
    } catch {
        context = { taskId, sourceRefs: [], authoritativeWiki: [], excludedWiki: [], excludedWikiSummary: { relevant: [], unrelated: { count: 0, byReason: {} } }, warnings: [] };
    }

    const ownershipConflicts = normalizedOwnedPaths?.length
        ? await findOwnershipConflicts(root, taskId, normalizedOwnedPaths)
        : [];
    const warnings = [
        ...context.warnings,
        ...(ownershipConflicts.length > 0 ? [`Ownership conflicts detected: ${ownershipConflicts.map((c) => `${c.taskId}:${c.path}`).join(', ')}`] : []),
    ];

    return {
        command: 'open',
        taskId: task.id,
        phase: 'intake',
        success: true,
        diagnostics: {
            acceptanceCount: task.acceptance.length,
            authoritativeWikiCount: context.authoritativeWiki.length,
            warnings,
            ...(ownershipConflicts.length > 0 ? { ownershipConflicts } : {}),
        },
    };
}

async function cmdDesign(taskId: string, root: string, options?: CommandOptions): Promise<CommandResult> {
    const actor: Actor = actorFor({ id: 'kata-designer', role: 'designer' }, options?.platform);
    const workflowProfile = await acknowledgeCometOpenIfRequired(root, taskId);

    const task = await readTask(root, taskId);
    const current = await readCurrentState(root, taskId);
    if (!task.acceptanceMatrix && (current.phase === 'implement' || current.phase === 'hardVerify')) {
        const handoff = await createHandoff(root, taskId, 'designer');
        return {
            command: 'design', taskId, phase: current.phase, success: true,
            diagnostics: { migrationMode: 'acceptance_matrix', nextRole: 'designer', guardInstructions: handoff.guardInstructions },
        };
    }
    if (requiresMatrix(task.workflowProfile) && !task.acceptanceMatrix) {
        return {
            command: 'design', taskId, phase: 'intake', success: false,
            error: 'Strict closure requires an acceptanceMatrix; add it to task.json before designing.',
            diagnostics: { missingMatrix: true },
        };
    }
    const matrixErrors = validateMatrix(task.acceptance ?? [], task.acceptanceMatrix);
    if (requiresMatrix(task.workflowProfile) && matrixErrors.length > 0) {
        return {
            command: 'design', taskId, phase: 'intake', success: false,
            error: `Acceptance matrix validation failed during design: ${matrixErrors.length} error(s).`,
            diagnostics: { matrixErrors },
        };
    }
    // Upstream coverage: strict tasks MUST declare which upstream requirements each
    // AC covers (or explicitly out-of-scope). Prevents self-authored-AC scope drift.
    const coverageRequired = requiresUpstreamCoverage(task.workflowProfile);
    if (coverageRequired && !task.upstreamCoverage) {
        return {
            command: 'design', taskId, phase: 'intake', success: false,
            error: 'Strict closure requires upstreamCoverage (map upstream doc requirements to ACs or out-of-scope); add it to task.json before designing.',
            diagnostics: { missingUpstreamCoverage: true },
        };
    }
    const coverageErrors = validateUpstreamCoverage(task.acceptance ?? [], task.acceptanceMatrix, task.upstreamCoverage, root);
    if (coverageRequired && coverageErrors.length > 0) {
        return {
            command: 'design', taskId, phase: 'intake', success: false,
            error: `Upstream coverage validation failed during design: ${coverageErrors.length} error(s).`,
            diagnostics: { coverageErrors },
        };
    }
    // Orphan AC enforcement: every acceptance criterion must be justified by ≥1
    // upstream requirement. Prevents adding ACs that no requirement demands.
    if (task.upstreamCoverage) {
        const orphanAcs = findOrphanAcs(task.acceptance ?? [], task.upstreamCoverage);
        if (orphanAcs.length > 0) {
            return {
                command: 'design', taskId, phase: 'intake', success: false,
                error: `Design blocked: ${orphanAcs.length} acceptance criterion(s) have no upstream requirement (${orphanAcs.map((o) => o.acId).join(', ')}). Every AC must be justified by an upstream requirement or the requirement marked out-of-scope.`,
                diagnostics: { orphanAcs },
            };
        }
    }

    await guardTransition(options?.guard, 'check', taskId, 'plan');
    const state = await transition(taskId, 'plan', actor, { root });
    await guardTransition(options?.guard, 'apply', taskId, 'plan');
    const handoff = await createHandoff(root, taskId, 'implementer');

    return {
        command: 'design',
        taskId,
        phase: state.phase,
        success: true,
        diagnostics: {
            nextRole: 'implementer',
            actor,
            guardInstructions: handoff.guardInstructions,
            ...(workflowProfile ? { workflowProfile } : {}),
        },
    };
}

async function acknowledgeCometOpenIfRequired(root: string, taskId: string): Promise<WorkflowProfile | undefined> {
    const task = await readTask(root, taskId);
    if (!isWorkflowProfile(task.workflowProfile)) return undefined;
    if (task.workflowProfile.comet.openStatus !== 'required') return task.workflowProfile;
    return acknowledgeCometOpen(root, taskId);
}


/**
 * The seal heartbeat: one JSON line per check transition in `.kata/tasks/<task>/seal-progress.jsonl`.
 *
 * Written for a monitoring agent, not for a human reading a terminal: `state`, the check's name, how long it has been
 * running, and when the line was written. A failure to write it never fails a seal — the log is an observation, and a
 * seal that died because its log was unwritable would be worse than one nobody can watch.
 */
export async function sealProgressWriter(
    root: string,
    taskId: string,
    /**
     * How a line reaches the log. Injected so the ordering contract below can be tested deterministically — a real
     * filesystem makes the race that used to exist here fire once in a hundred runs, which is not a test.
     */
    appendLine?: (line: Record<string, unknown>) => Promise<void>,
): Promise<((event: CheckProgressEvent) => void) & { finish: () => Promise<void> }> {
    const { appendFile, mkdir } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    const { sealProgressPath } = await import('../core/layout.js');
    const path = sealProgressPath(root, taskId);
    const startedAt = new Map<string, number>();
    const append = appendLine ?? (async (line: Record<string, unknown>): Promise<void> => {
        await mkdir(dirname(path), { recursive: true });
        await appendFile(path, `${JSON.stringify(line)}\n`, 'utf8');
    });

    // Every append is chained rather than fired and forgotten. The previous writer called `void write(...)` per event
    // and awaited only its own `seal_complete`, so a line emitted just before `finish()` could still be in flight and
    // land *after* it — measured as a failing `lines.at(-1)` assertion inside a real seal while the same test passed
    // standalone. `finish()` now resolves only once every earlier line is durable, which is what makes "seal_complete is
    // last" a guarantee instead of a coincidence.
    let queue: Promise<void> = Promise.resolve();
    const write = (line: Record<string, unknown>): Promise<void> => {
        queue = queue
            .then(() => append(line))
            .catch(() => {
                // Observation only: never let the log decide the seal.
            });
        return queue;
    };

    const writer = ((event: CheckProgressEvent): void => {
        const now = Date.now();
        const name = String(event.check ?? '');
        if (event.type === 'quality_check_progress' && event.state === 'started') startedAt.set(name, now);
        const started = startedAt.get(name);
        void write({
            type: event.type,
            check: name,
            state: event.state,
            ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
            ...(started !== undefined ? { elapsedMs: now - started } : {}),
            at: new Date(now).toISOString(),
        });
    }) as ((event: CheckProgressEvent) => void) & { finish: () => Promise<void> };
    writer.finish = async () => {
        await write({ type: 'seal_complete', at: new Date().toISOString(), checks: startedAt.size });
    };
    return writer;
}

/**
 * The ledger's claims that are not supported, for the change record and the ladder's diagnostics.
 *
 * One reader for one question: the record and the archive gate must not disagree about which problems are open, which is
 * the defect this file's history is largely made of. Returns an empty list for a change with no ledger, because a record
 * about a change that predates the ledger has no problems to report from it.
 */
async function ledgerClaimsForRecord(root: string, taskId: string): Promise<Array<{ id: string; severity: string; status: string }>> {
    const { readLedger } = await import('../store/ledger.js');
    const { unsupportedClaims } = await import('../store/verdict.js');
    const ledger = await readLedger(root, taskId);
    // One derivation: `unsupportedClaims` assembles the kernel's input, exactly as the ladder and the archive gate do.
    return unsupportedClaims(ledger).map((claim) => ({ id: claim.claimId, severity: claim.severity, status: 'open' }));
}

async function cmdBuild(
    taskId: string,
    root: string,
    options: CommandOptions = {},
): Promise<CommandResult> {
    if (options.listChecks) {
        const task = await readTask(root, taskId);
        const resolved = await describeSealChecks(root, taskId, await resolveSealChecks(root, task, options));
        return {
            command: 'build', taskId, phase: task.phase, success: true,
            diagnostics: { checks: resolved, checkCount: resolved.length },
        };
    }
    const current = JSON.parse(
        await readFile(currentStatePath(root, taskId), 'utf8'),
    ) as { phase: Phase };
    // 修复入口只把任务送回 implement；是否立刻继续 seal 由调用方显式决定（与 review 边界一致）。
    let enteredRepairAwaitingSeal = false;
    if (current.phase === 'plan') {
        await guardTransition(options.guard, 'check', taskId, 'implement');
        await transition(taskId, 'implement', actorFor(defaultActor, options.platform), { root });
        await guardTransition(options.guard, 'apply', taskId, 'implement');
    } else if (current.phase === 'hardVerify' || current.phase === 'review' || current.phase === 'judge') {
        // **A refusal is a value here, not an exception.** The router can return `repair_unreadable_current_revision`,
        // `repair_failed_judge` and their siblings, all naming `/kata-build` — and this call used to throw the denial,
        // so the command the dispatcher had just recommended died with a stack trace: no envelope, no `command`, no
        // diagnostics, nothing upstream able to report it. Measured by dispatching the route for a corrupted pointer.
        const entry = await reenterImplementForRepairEntry(current.phase, taskId, root, actorFor(defaultActor, options.platform));
        if (!entry.authorized) {
            return {
                command: 'build',
                taskId,
                phase: current.phase,
                success: false,
                error: entry.denial ?? `Build cannot run from ${current.phase}`,
                diagnostics: { repairEntry: { entryPhase: current.phase, denial: entry.denial ?? null } },
            };
        }
        enteredRepairAwaitingSeal = current.phase !== 'hardVerify';
    } else if (current.phase !== 'implement') {
        return {
            command: 'build',
            taskId,
            phase: current.phase,
            success: false,
            error: `Build cannot run from ${current.phase}. A build starts implementation or repairs an authorised entry `
                + `(hardVerify, review, judge); from ${current.phase} there is nothing for it to do.`,
            diagnostics: { buildRefusedFrom: current.phase },
        };
    }

    if (enteredRepairAwaitingSeal) {
        return {
            command: 'build',
            taskId,
            phase: 'implement',
            success: true,
            diagnostics: {
                mode: 'implement',
                implementationPrompt: 'Review repair 已进入 implement。先修复 repair.json 中的 findings、写聚焦 RED/GREEN 测试；本次不会 seal 或创建 revision。',
                sealCommand: `kata build --change ${taskId} --seal`,
            },
        };
    }

    if (!(options.seal ?? true)) {
        let buildOwnedPaths: string[] = [];
        try {
            const currentTask = JSON.parse(
                await readFile(taskPath(root, taskId), 'utf8'),
            ) as { ownedPaths?: string[] };
            if (currentTask.ownedPaths?.length) {
                buildOwnedPaths = currentTask.ownedPaths;
            }
        } catch { /* task may not exist yet */ }
        if (buildOwnedPaths.length === 0 && options.ownedPaths?.length) {
            buildOwnedPaths = options.ownedPaths;
        }
        const ownershipConflicts = buildOwnedPaths.length
            ? await findOwnershipConflicts(root, taskId, buildOwnedPaths)
            : [];
        return {
            command: 'build',
            taskId,
            phase: 'implement',
            success: true,
            diagnostics: {
                mode: 'implement',
                implementationPrompt: '先写聚焦的失败测试（RED），再最小实现并运行聚焦 GREEN；不要在编码前封存 build 证据。',
                sealCommand: `kata-cli build --change ${taskId} --seal`,
                ...(ownershipConflicts.length > 0 ? { ownershipConflicts } : {}),
            },
        };
    }

    const task = await readTask(root, taskId);
    // C3, and the order matters: a claim whose check cannot fail is refused **before** the check set is resolved. It used
    // to be refused after, which meant `resolveClaimChecks` dereferenced `claim.check.expect.exitCode` on exactly the
    // declaration the refusal exists to reject — so the documented 'a check that cannot fail is not evidence' message
    // was replaced by `Cannot read properties of undefined (reading 'exitCode')`. The refusal is the better error and it
    // is the one the design promises, so the guard runs first and the resolver never sees an unusable claim.
    const claimRefusalsEarly = validateClaims(task.acceptance ?? []);
    if (claimRefusalsEarly.length > 0) {
        return {
            command: 'build',
            taskId,
            phase: current.phase,
            success: false,
            error: `Acceptance claims cannot be checked: ${claimRefusalsEarly.map((refusal) => refusal.detail).join('; ')}`,
            diagnostics: {
                claimRefusals: claimRefusalsEarly,
                remedy: 'Give each claim a check with an expected exit code (a check that cannot fail is not evidence).',
            },
        };
    }
    let checks: CheckCommand[];
    try {
        checks = await resolveSealChecks(root, task, options);
    } catch (error) {
        return {
            command: 'build', taskId, phase: 'implement', success: false,
            error: error instanceof Error ? error.message : String(error),
            diagnostics: { matrixError: true },
        };
    }

    // The preflight is collected, not fail-fast: a task with three independent closure problems hears about all three
    // in one run instead of one per run — and without paying the evidence cost between them. The first blocker keeps
    // the message and diagnostics key the early return had, so nothing that reads this result has to change.
    let ownedPaths: string[] = [];
    let ownedPathsError: string | undefined;
    try {
        ownedPaths = await resolveSealOwnedPaths(root, taskId, task, options);
    } catch (error) {
        ownedPathsError = error instanceof Error ? error.message : String(error);
    }

    const preflight = await collectSealPreflight({
        root,
        taskId,
        task,
        ownedPaths,
        options: {
            ...(options.waivers ? { waivers: options.waivers } : {}),
            ...(options.allowOwnershipConflicts ? { allowOwnershipConflicts: true } : {}),
            ...(options.allowOutOfScopeRepair ? { allowOutOfScopeRepair: true } : {}),
            ...(ownedPathsError ? { ownedPathsError } : {}),
            // The checks this seal is about to run, so the obligation dry run can tell an obligation this run will answer
            // from one it cannot. Without them every unresolved obligation would refuse the seal that answers it.
            plannedChecks: checks,
            ...(options.frozen === true ? { includeFrozen: true } : {}),
        },
    });
    if (preflight.blockers.length > 0) {
        const [first, ...rest] = preflight.blockers;
        return {
            command: 'build',
            taskId,
            phase: 'implement',
            success: false,
            error: rest.length === 0
                ? first!.message
                : `${first!.message}\nThis seal is blocked by ${preflight.blockers.length} independent problems; fix all of them before retrying:\n${preflight.blockers.map((blocker, index) => `${index + 1}. ${blocker.message}`).join('\n')}`,
            diagnostics: {
                ...first!.diagnostics,
                // Every blocker, so a caller can act on all of them rather than only the first.
                blockers: preflight.blockers.map((blocker) => ({ code: blocker.code, message: blocker.message, diagnostics: blocker.diagnostics })),
                blockerCount: preflight.blockers.length,
            },
        };
    }

    const { waivers, ownershipConflicts, codeGraphCandidates, codeGraphDisposition } = preflight;
    // Reaching here means every blocker was absent; a non-strict task has no waivers to persist.
    if (requiresMatrix(task.workflowProfile)) await writeWaivers(root, taskId, waivers);

    let sandbox;
    try {
        sandbox = await createExecutionSandbox(root);
    } catch (error) {
        return {
            command: 'build', taskId, phase: 'implement', success: false,
            error: error instanceof Error ? error.message : String(error),
            diagnostics: { mode: 'seal', reason: 'isolated_execution_unavailable' },
        };
    }
    try {
    // What this seal narrows against: the revision that was current before it. Its digests are half the change
    // surface the record derives — the half that survives the round committing.
    const baseSnapshot = await readReviewDecisionSnapshot(root, taskId);
    const baseRevision = baseSnapshot.revisionRead.kind === 'current' ? baseSnapshot.revisionRead.revision : null;
    const sealed = ownedPaths.length
        ? await createTaskRevisionIfChanged({
            root,
            contentRoot: sandbox.root,
            contentDigests: sandbox.contentDigests,
            taskId,
            ownedPaths,
            checkIds: checks.map((check) => check.id ?? `${check.kind}:${check.command}:${(check.args ?? []).join(' ')}`),
            ...(ownershipConflicts.length > 0 && options.allowOwnershipConflicts
                ? { ownershipConflicts, ownershipConflictsAcknowledged: true }
                : {}),
        })
        : undefined;
    const revision = sealed?.revision;

    // Reuse, per check, and say so (L1-01). The revision identity still gates the whole thing — same owned-path content,
    // same resolved check set — but *within* that identity a check is now reusable on its own record: it previously
    // passed, its recorded input fingerprint still matches, and it was declared against rows whose files are unchanged.
    //
    // The "rows whose files are unchanged" half is deliberately NOT implemented here: `checkInputFingerprint` already
    // encodes *which* files a check reads (command, args, cwd, and — for a test check — the selector that names the
    // files), so a change to a file the check reads moves the fingerprint and invalidates it. Adding a second, path-level
    // rule on top of that would be the same decision made twice, and the row-to-evidence question belongs to
    // `evidenceCoversAcceptance`. The old `item.diffHash === currentTreeHash` guard is therefore replaced by the
    // fingerprint rather than merely dropped: it was a whole-tree predicate where a per-check one is what the finding
    // asked for.
    //
    // Everything else runs. Uncertainty invalidates rather than assumes, which is the direction the gate needs.
    let reusePlan: CheckReusePlan | undefined;
    if (sealed?.reused && revision) {
        const recorded = await readRecordedEvidence(root, taskId);
        const plan = planCheckReuse(checks, recorded);
        reusePlan = plan;
        if (plan.reusable.length === checks.length && checks.length > 0) {
            return {
                command: 'build',
                taskId,
                phase: 'implement',
                success: true,
                diagnostics: {
                    mode: 'seal',
                    reusedRevision: revision.id,
                    reusedEvidence: plan.reusable.length,
                    reusedChecks: plan.reusable.map((entry) => entry.checkId),
                    sealedAt: revision.createdAt,
                },
            };
        }
        // The reusable checks carry `importResult`, so `collectEvidence` records them without spawning anything while
        // the evidence set stays whole and in declaration order.
        checks = plan.planned;
    }

    // A readable heartbeat. Monitoring a seal used to mean `pgrep`-ing for a process — which false-positives on the
    // agent's own command line — or waiting blind, so the seal writes what it is doing, when, and for how long.
    const progress = await sealProgressWriter(root, taskId);
    const coveredChecks = checks
        .filter((check) => check.coveredBy)
        .map((check) => ({ name: check.name ?? check.command, coveredBy: check.coveredBy as string }));
    const deferredChecks = options.frozen === true
        ? []
        : checks.filter((check) => check.tier === 'frozen' && !check.coveredBy).map((check) => check.name ?? check.command);
    // C3: a claim whose check could never fail is refused up front — a decorative check is exactly what a false sentence
    // hides behind — and the run's claims are evaluated against the evidence once it is collected.
    const claimRefusals = validateClaims(task.acceptance ?? []);
    if (claimRefusals.length > 0) {
        // Refused before anything runs: a claim whose check cannot fail would otherwise sit in the set as decoration,
        // and the sentence it was supposed to prove would look checked.
        return {
            command: 'build',
            taskId,
            phase: current.phase,
            success: false,
            error: `Acceptance claims cannot be checked: ${claimRefusals.map((refusal) => refusal.detail).join('; ')}`,
            diagnostics: {
                claimRefusals,
                remedy: 'Give each claim a check with an expected exit code (a check that cannot fail is not evidence).',
            },
        };
    }
    // F4: which of those checks this change actually touches is **derived**, not declared by the project. The freeze
    // points still require everything (`--frozen` / `missingFrozenTierEvidence`), and a derivation that cannot be made
    // falls back to the full set — so "cheap" can never mean "silently under-run".
    const relevant = await deriveSealRelevantChecks(root, taskId, checks, revision ?? null, options);
    const checksToRun = relevant.checks ?? checks;
    // The log directory has to exist **before** the checks, not when their evidence is written: `writeEvidence` creates
    // it afterwards, so the first seal of a task ran every bounded check against a directory that was not there — and
    // `runProcess`'s tee discards the write failure, so the envelope named a transcript that did not exist. Creating it
    // here is where the requirement belongs; `runProcess` serves checks, CodeGraph and Git Flow and has no business
    // knowing which of its callers wants an artifact directory.
    await mkdir(evidenceDir(root), { recursive: true });
    const evidence = await collectEvidence(taskId, checksForExecutionSandbox(checksToRun, root, sandbox.root), {
        ...(revision ? { revision } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.frozen === true ? { includeFrozen: true } : {}),
        acceptanceByCheckId: acceptanceIdsByCheckId(task.acceptanceMatrix),
        inputDiffHash: sandbox.contentDigests ? contentSnapshotHash(sandbox.contentDigests) : undefined,
        // thing. The envelope keeps the reference and the bounded excerpt; a reader who needs the transcript reads the
        // file instead of finding a truncated log and no way to tell.
        checkLogDir: evidenceDir(root),
        onProgress: (event) => {
            progress(event);
            options.onProgress?.(event);
        },
    });
    await progress.finish();
    // **Collected, not swallowed.** A failure to move a superseded revision's set aside used to be silently ignored, and
    // the consequence is invisible: the outgoing set stays under the active names and the next seal writes over it. The
    // problems are carried into the result rather than printed, because a caller that persists the seal needs to see them.
    const evidenceArchiveProblems = await writeEvidence(root, taskId, evidence);
    // A2: the factual half of the round's record is written from what the machine holds — the working tree's changed
    // paths, the envelopes just collected, the claim outcomes, the tracked findings — rather than asked of the author.
    // The measurement behind it: of thirty de-duplicated findings across thirteen passes of one change, twenty (seven of
    // the eleven `major`) were about the author's *prose about their own work* — a ledger row, a count, a pointer. Prose
    // had no checker, so it was the cheapest falsifiable surface a reviewer could attack, and every repair wrote more of
    // it. The author is left `judgement`: why this fix, what was traded away.
    // C3: derive claim truth from the evidence before the machine record freezes the seal's factual surface.
    const claimSummary = evaluateClaims(task.acceptance ?? [], evidence);
    const changeRecord = revision
        ? await buildChangeRecord({
            root,
            taskId,
            revisionId: revision.id,
            ...(baseRevision ? { baseRevisionId: baseRevision.id } : {}),
            ownedPaths,
            evidence,
            // The revision's content identity is what the record's surface is derived from; live `git status` is added
            // on top for drift since the seal. Passing only the digests would miss paths the round touched after
            // sealing; passing only git (the previous behaviour) made the field empty whenever the round committed first.
            ...(revision.contentDigests ? { contentDigests: revision.contentDigests } : {}),
            ...(baseRevision?.contentDigests ? { baseContentDigests: baseRevision.contentDigests } : {}),
            ...(options.judgement ? { judgement: options.judgement } : {}),
            claimFailures: claimSummary.failures,
            // **The record reports the ledger's own problems.** It used to list the round-shaped findings table; with the
            // claims in the ledger, an unsupported claim is what "known and not answered" means now, and the record's
            // self-evidence check still refuses prose that restates the count differently from the field.
            findings: (await ledgerClaimsForRecord(root, taskId)).map((claim) => ({
                id: claim.id, severity: claim.severity, disposition: claim.status,
            })),
        }).catch(() => null)
        : null;
    // §6 self-evidence for A: a record whose prose restates a derivable quantity is refused, and the refusal names both
    // the quantity and the sentence. The seal does not paper over it — the author's judgement is the one field they wrote.
    const changeRecordRefusal = changeRecord ? await writeChangeRecord(root, taskId, changeRecord).catch(() => null) : null;
    if (changeRecordRefusal && typeof changeRecordRefusal !== 'string') {
        return {
            command: 'build',
            taskId,
            phase: 'implement',
            success: false,
            error: `Seal blocked: ${changeRecordRefusal.refused.join('; ')}`,
            diagnostics: { mode: 'seal', judgementRefusals: changeRecordRefusal.refused },
        };
    }
    if (evidence.some((item) => !isPassing(item))) {
        return {
            command: 'build',
            taskId,
            phase: 'implement',
            success: false,
            error: claimSummary.failures.length > 0
                ? `Evidence sealing failed, and ${claimSummary.failures.length} acceptance claim(s) are contradicted: ${claimSummary.failures
                    .map((failure) => describeClaimFailure(failure))
                    .join('; ')}`
                : 'Evidence sealing failed; fix the failing checks before retrying --seal.',
            diagnostics: {
                mode: 'seal',
                evidenceCount: evidence.length,
                passing: evidence.filter((item) => isPassing(item)).length,
                failing: evidence.filter((item) => !isPassing(item)).length,
                // Which checks failed, by id, so "sealing failed" is answerable without re-reading the evidence files.
                failingChecks: evidence
                    .filter((item) => !isPassing(item))
                    .map((item) => ({ checkId: item.checkId ?? null, name: item.name ?? null, command: item.command, exitCode: item.exitCode, expectedExitCode: item.expectExitCode ?? 0 })),
                ...(claimSummary.ran.length > 0 ? { claims: claimSummary.ran.map((claim) => claim.checkId) } : {}),
                ...(claimSummary.failures.length > 0
                    ? { claimFailures: claimSummary.failures.map((failure) => ({ ...failure, description: describeClaimFailure(failure) })) }
                    : {}),
                ...(reusePlan
                    ? {
                        reusedChecks: reusePlan.reusable.map((entry) => entry.checkId),
                        invalidatedChecks: reusePlan.invalidated,
                    }
                    : {}),
            },
        };
    }

    // Seal-time requirement evidence check: every mapped upstream requirement must
    // be backed by its AC's passing evidence (not just declared in coverage).
    if (task.upstreamCoverage) {
        const reqsWithoutEvidence = findRequirementsWithoutEvidence(task.upstreamCoverage, task.acceptanceMatrix, evidence);
        if (reqsWithoutEvidence.length > 0) {
            return {
                command: 'build', taskId, phase: 'implement', success: false,
                error: `Seal blocked: ${reqsWithoutEvidence.length} mapped upstream requirement(s) have no passing evidence (${reqsWithoutEvidence.map((r) => r.requirementId).join(', ')}). Every mapped requirement must be backed by its AC's evidence.`,
                diagnostics: { requirementsWithoutEvidence: reqsWithoutEvidence },
            };
        }
    }

    if (revision) {

    }
    // C1: a successful seal is what ends a repair batch — its contract is one seal and one delta round per node per batch.
    // The base revision was stamped when the batch opened, so nothing here supplies one.
    //
    // This runs **after** the resolution above, and that order is the point: closure reads `answered` from the obligations
    // that carry a resolvedAt, so closing before resolving refused every batch on its first successful seal — one run
    // late, with the refusal swallowed by this `.catch`. Same ordering class as the seal that refused the run whose
    // evidence would answer it.
    // Lever 1's root cause, measured: this result was discarded, and the consequence was invisible until it showed up as
    // cost. An unclosed batch means the next round gets no delta — so it reviews the whole change surface instead of the
    // repair, which is the difference between 2.82M and 9.88M tokens on the change this was measured on. The mechanism was
    // never missing: it runs, decides correctly, and its answer was thrown away. So the answer is read.
    // A review repair is outstanding only when the manifest changed, which the preflight just established; resolving
    // it here is what closes the repair against the revision that superseded it.
    if (revision && await readActiveReviewRepairBaseline(root, taskId)) {
        await resolveReviewRepair(root, taskId, revision.id);
    }

    const wikiClosure = await ensureWikiClosure(root, taskId);
    await guardTransition(options.guard, 'check', taskId, 'hardVerify');
    await transition(taskId, 'hardVerify', actorFor(defaultActor, options.platform), { root });
    await guardTransition(options.guard, 'apply', taskId, 'hardVerify');

    return {
        command: 'build',
        taskId,
        phase: 'hardVerify',
        success: evidence.every((e) => isPassing(e)),
        diagnostics: {
            evidenceCount: evidence.length,
            passing: evidence.filter((e) => isPassing(e)).length,
            failing: evidence.filter((e) => !isPassing(e)).length,
            // Checks that were not executed because another check covers them: named here so "not run" is a decision the
            // reader can audit, never an absence they have to notice.
            ...(coveredChecks.length > 0 ? { coveredChecks } : {}),
            ...(relevant.derivation ? { derivedChecks: relevant.derivation } : {}),
            // C3: a claim is reported by id rather than only as a red run, so the sentence that failed is visible in the
            // seal's own output — and a claim with no evidence counts as failed, because it declared itself checkable.
            ...(claimSummary.ran.length > 0 ? { claims: claimSummary.ran.map((claim) => claim.checkId) } : {}),
            ...(claimSummary.failures.length > 0
                ? { claimFailures: claimSummary.failures.map((failure) => ({ ...failure, description: describeClaimFailure(failure) })) }
                : {}),
            // Named, not silent: a check declared `tier: 'frozen'` did not run here, and the reader can see that this
            // was the seal's decision (run `--seal --frozen` to include them).
            ...(deferredChecks.length > 0 ? { deferredChecks } : {}),
            wikiClosure,
            // A batch left open is reported rather than swallowed: it is the reason the next round has no delta to narrow
            // against, and "why is the next review expensive" should be answerable from the seal that caused it.
            ...(ownedPaths.length ? { ownedPaths, ownedPathsSource: task.ownedPaths?.length ? 'task' : 'build-option' } : {}),
            ...(codeGraphCandidates.length > 0 ? { codeGraphCandidates, ...(codeGraphDisposition ?? {}) } : {}),
            ...(revision ? { revisionId: revision.id } : {}),
            ...(ownershipConflicts.length > 0 ? { ownershipConflicts } : {}),
            // A partial reuse is reported too: which checks ran, which were carried forward, and why the rest ran.
            ...(reusePlan
                ? { reusedChecks: reusePlan.reusable.map((entry) => entry.checkId), invalidatedChecks: reusePlan.invalidated }
                : {}),
        },
    };
    } finally {
        await sandbox.dispose();
    }
}


/**
 * The checks a seal resolves, with each one's identity and origin stamped on. The seal and the preflight
 * (`build --list-checks`) both call this, so the answer a caller inspects is the answer that runs.
 */
async function resolveSealChecks(
    root: string,
    task: {
        ownedPaths?: string[];
        acceptanceMatrix?: import('../core/task.js').AcceptanceMatrix;
        acceptance?: import('../core/task.js').AcceptanceCriterion[];
    },
    options: CommandOptions,
): Promise<CheckCommand[]> {
    const projectChecks = options.checks?.length
        ? options.checks.map((check) => ({ ...check, source: check.source ?? 'explicit' as const }))
        : await resolveBuildChecks(root, await loadConfig(root), task.ownedPaths ?? [], {
            ...(options.discoverChecks !== undefined ? { discoverChecks: options.discoverChecks } : {}),
        });
    // The runner entry is resolved through the dependency roots, not the project-directory literal: in a linked worktree
    // the dependency is present in an ancestor workspace (and the execution sandbox copies from those same candidates),
    // so `join(projectDir, 'node_modules', …)` named a path that never exists there and every matrix check died with
    // MODULE_NOT_FOUND. Resolved through the same list the sandbox uses, the check runs the dependency it has.
    const matrixDerivedChecks = !options.checks?.length && task.acceptanceMatrix
        ? matrixChecks(root, task.acceptanceMatrix, { dependencyRoots: dependencyRootsFor(root) })
        : [];
    // C3: the clauses of the acceptance statements that declared themselves checkable. They join the seal's set as
    // ordinary checks — same resolver, same collector, same evidence binding — so a false claim fails *here*, on the
    // revision it describes, rather than being caught by the next independent round.
    const claims = options.checks?.length ? [] : resolveClaimChecks(root, task.acceptance ?? []);
    return dedupeCheckCommands([...projectChecks, ...matrixDerivedChecks, ...claims]);
}

/** The resolved checks as a report: identity, origin, timeout, and what each cost the last time it ran. */
async function describeSealChecks(root: string, taskId: string, checks: CheckCommand[]) {
    const previous = await readRecordedEvidence(root, taskId);
    return checks.map((check) => {
        const last = [...previous].reverse().find((envelope) => (check.id ? envelope.checkId === check.id : false)
            || (check.name ? envelope.name === check.name : false));
        return {
            id: check.id ?? `${check.kind}:${check.command}:${(check.args ?? []).join(' ')}`,
            ...(check.name ? { name: check.name } : {}),
            kind: check.kind,
            command: check.command,
            args: check.args ?? [],
            source: check.source ?? 'explicit',
            // What the preflight has to say about whether this will run: its tier, and (when it is covered) which check
            // stands in for it. Both are decisions the reader should see before sealing, not after.
            ...(check.tier ? { tier: check.tier } : {}),
            ...(check.coveredBy ? { coveredBy: check.coveredBy } : {}),
            timeoutMs: check.timeoutMs ?? 600_000,
            lastDurationMs: last ? Math.max(0, Date.parse(last.finishedAt) - Date.parse(last.startedAt)) : null,
            lastExitCode: last?.exitCode ?? null,
        };
    });
}

async function resolveSealOwnedPaths(
    root: string,
    taskId: string,
    task: { ownedPaths?: string[] },
    options: CommandOptions,
): Promise<string[]> {
    const declared = options.ownedPaths?.length
        // Normalize — and therefore refuse — before anything is written. This function used to persist the merged
        // surface first and let `createTaskRevisionIfChanged` reject it afterwards, so `build --seal --owned-path
        // ../outside.ts` reported a refusal *after* the escaped path was already on disk: the refusing command
        // mutated the task it refused, and the next seal then failed from that persisted state. The write is the
        // place to refuse it, in the same terms every read path already uses.
        //
        // The refusal names **every** offending value, not just the first: `normalizeOwnedPaths` throws on one, and a
        // caller who passed two bad paths needs to know both. Nothing is written, and the message says so — the
        // previous behaviour left a reader unable to tell a refusal from a partial write.
        ? declaredOwnedPathsOrThrow(root, options.ownedPaths)
        : undefined;
    if (declared && declared.length === 0) {
        throw new Error('seal requires at least one --owned-path');
    }
    if (task.ownedPaths?.length) {
        const merged = declared?.length
            ? [...new Set([...task.ownedPaths, ...declared])].sort()
            : task.ownedPaths;
        if (merged.length > task.ownedPaths.length) {
            await persistTaskOwnedPaths(root, taskId, task, merged);
        }
        return merged;
    }
    if (!declared?.length) {
        throw new Error('seal requires at least one --owned-path when the task has no ownedPaths');
    }
    await persistTaskOwnedPaths(root, taskId, task, declared);
    return declared;
}

/**
 * The declared seal surface, normalized as a whole so the refusal can name every offending path at once.
 *
 * `normalizeOwnedPaths` reports one violation per call by construction (it maps and throws on the first), which is
 * right for a single value and wrong for a list a user typed: an adversarial pass recorded that the seal's refusal
 * named only the first bad path while the second was equally refused. Normalizing each value separately collects the
 * whole set, and the aggregate message states that nothing was written — so a caller never has to ask whether a
 * refusal left something behind.
 */
function declaredOwnedPathsOrThrow(root: string, paths: string[]): string[] {
    const refused: string[] = [];
    const accepted: string[] = [];
    for (const path of paths) {
        try {
            accepted.push(...normalizeOwnedPaths(root, [path]));
        } catch {
            refused.push(path);
        }
    }
    if (refused.length > 0) {
        throw new Error(
            `Task-owned path must be inside the repository: ${refused.join(', ')}`
            + ' — nothing was written, and the task still carries its previous owned paths.',
        );
    }
    return [...new Set(accepted)].sort();
}

async function persistTaskOwnedPaths(
    root: string,
    taskId: string,
    task: { ownedPaths?: string[] },
    ownedPaths: string[],
): Promise<void> {
    await writeFile(
        taskPath(root, taskId),
        `${JSON.stringify({ ...task, ownedPaths }, null, 2)}\n`,
        'utf8',
    );
}

/**
 * Records the sealed evidence set.
 *
 * The previous set is **archived**, not deleted: a superseded revision's evidence stays auditable, filed under the
 * revision it belonged to. The active set stays at the top level, so readers see exactly what the current seal proved.
 */
/**
 * Record the sealed evidence set, and report what the archive of the previous set could not do.
 *
 * **The empty `catch` this used to have.** A failure to move a superseded revision's envelopes and transcripts aside was
 * swallowed twice over — once around the whole block and once on each `rename` — so the caller could not tell "archived
 * cleanly" from "the outgoing set is still under the active names", which is the state that makes the next seal read a
 * superseded revision's transcript as its own. The failures are collected and named instead; the seal still proceeds,
 * because losing the archive must not lose the evidence that was just collected.
 */
async function writeEvidence(root: string, taskId: string, evidence: EvidenceEnvelope[]): Promise<string[]> {
    const evidenceDirectory = evidenceDir(root);
    await mkdir(evidenceDirectory, { recursive: true });
    const problems: string[] = [];

    const { readdir, rename } = await import('node:fs/promises');
    try {
        // Both the envelopes and the transcripts beside them: the artifacts are evidence too, and archiving only the
        // `.json` files was how a superseded revision's transcript stayed at the active path — where the next seal, which
        // writes the same name, would be read as if it were still that revision's.
        const files = (await readdir(evidenceDirectory)).filter(
            (file) => file.startsWith(`${taskId}-`) && (file.endsWith('.json') || file.endsWith('.log')),
        );
        if (files.length > 0) {
            // The revision the outgoing set was collected for, read from the envelope rather than guessed.
            const previous = JSON.parse(await readFile(join(evidenceDirectory, files[0]!), 'utf8')) as { revisionId?: string };
            // `evidenceArchiveDir` rather than the same three segments spelled here: the layout module owns where an
            // artefact lives, and a second spelling is how the two drift apart.
            const { evidenceArchiveDir } = await import('../core/layout.js');
            const archiveDir = evidenceArchiveDir(root, previous.revisionId ?? 'unsealed');
            await mkdir(archiveDir, { recursive: true });
            for (const file of files) {
                await rename(join(evidenceDirectory, file), join(archiveDir, file))
                    .catch((error: Error) => problems.push(`could not archive ${file}: ${error.message}`));
            }
        }
    } catch (error) {
        problems.push(`could not archive the previous evidence set: ${(error as Error).message}`);
    }

    for (const envelope of evidence) {
        await writeFile(
            join(evidenceDirectory, `${taskId}-${evidenceFileSuffix(envelope)}.json`),
            `${JSON.stringify(envelope, null, 2)}\n`,
            'utf8',
        );
    }
    return problems;
}

function evidenceFileSuffix(envelope: EvidenceEnvelope): string {
    // 与 check name 共用同一清洗实现，避免两处规则分叉。
    const raw = sanitizeCheckName(envelope.name ?? envelope.kind) || envelope.kind;
    // 文件名不得超过 ext4/tmpfs 的 255 字节上限（ENAMETOOLONG）；超长命令名截断并保留可辨识前缀。
    // 前缀（taskId + '-' + '.json'）约占 20 字节，截断到 200 字节留足余量。
    return raw.length > 200 ? raw.slice(0, 200) : raw;
}

async function readActiveReviewRepairBaseline(root: string, taskId: string): Promise<string | undefined> {
    const repair = await readValidatedOptional<RepairRecordShape>('repair', repairPath(root, taskId));
    if (!repair) return undefined;
    // 两种评审修复原因都要参与「必须先改变 manifest 才能 seal」的校验：
    // review_findings（按严重级授权）与 revision_superseded（按证据漂移授权）。
    const isReviewRepair = repair.reason === 'review_findings' || repair.reason === 'revision_superseded';
    if (!isReviewRepair || repair.resolvedAt || !repair.baselineManifestHash) return undefined;
    return repair.baselineManifestHash;
}

interface ActiveRepair {
    reason?: RepairReason;
    scopes: Array<{ id?: string; repairScope?: RepairScope }>;
}

/**
 * The repair a task is currently working through, if any. Repairs that are done (`resolvedAt`) do not
 * constrain the next seal: a sealed revision resolves the repair that produced it.
 */
async function readActiveRepair(root: string, taskId: string): Promise<ActiveRepair | null> {
    const repair = await readValidatedOptional<RepairRecordShape>('repair', repairPath(root, taskId));
    if (!repair || repair.resolvedAt) return null;
    return {
        ...(repair.reason ? { reason: repair.reason } : {}),
        scopes: Array.isArray(repair.scopes)
            ? repair.scopes.map((scope) => ({ id: scope.id, repairScope: scope.repairScope as RepairScope | undefined }))
            : [],
    };
}

async function resolveReviewRepair(root: string, taskId: string, revisionId: string): Promise<void> {
    const repairRecordPath = repairPath(root, taskId);
    // Under the task lock and through the shared artefact writer: this was an unlocked read-modify-write, which the
    // repository's own invariant scan could not see because the path reached the writer through a local variable.
    await mutateTaskArtefact(root, taskId, repairRecordPath, async (current) => {
        const repair = JSON.parse(current) as RepairRecordShape;
        return `${JSON.stringify({
            ...repair,
            resolvedAt: new Date().toISOString(),
            resolvedRevisionId: revisionId,
        }, null, 2)}\n`;
    });
}

/**
 * Entering implementation from a gate is one operation: ask `workflow/repair-entry.ts` whether it is authorized, then
 * let `state.transitionForRepair` write the event, the current state and the repair record.
 */
async function reenterImplementForRepairEntry(
    entryPhase: 'hardVerify' | 'review' | 'judge',
    taskId: string,
    root: string,
    actor: Actor,
): Promise<{ authorized: boolean; denial?: string }> {
    const authorization = await authorizeRepair(entryPhase, root, taskId);
    if (!authorization.authorized) {
        // Returned, not thrown: the caller answers with an envelope, and the operator gets the reason the authoriser
        // wrote rather than a stack trace with the same words inside it.
        return { authorized: false, denial: authorization.denial ?? `Build cannot re-enter implementation from ${entryPhase}` };
    }
    const decidedOn = authorization.repair?.baselineRevisionId;
    await transitionForRepair({
        taskId,
        actor,
        entryPhase,
        repair: authorization.repair,
        root,
        // The baseline the authoriser recorded has to still describe the pointer at the moment the record is written.
        // Authorisation and this write are two steps with the lock released in between, so a seal landing there would
        // otherwise be recorded as a repair of the wrong revision (measured).
        ...(decidedOn
            ? {
                verifyStillCurrent: () => assertRepairBaselineStillCurrent(root, taskId, decidedOn),
            }
            : {}),
    });
    return { authorized: true };
}


/**
 * The frozen-tier checks that have no passing evidence for what is currently sealed.
 *
 * Kata cannot know which of a project's commands is "the full suite"; the project says so by declaring a tier, and this
 * is where that declaration is held to: a seal may defer a frozen check (and name it), but the node that concludes the
 * change may not conclude without it.
 */
async function missingFrozenTierEvidence(
    root: string,
    taskId: string,
    task: { ownedPaths?: string[] },
    evidence: EvidenceEnvelope[],
): Promise<string[]> {
    const config = await loadConfig(root);
    const checks = await resolveBuildChecks(root, config, task.ownedPaths ?? []);
    const frozen = checks.filter((check) => check.tier === 'frozen');
    if (frozen.length === 0) return [];
    const passing = evidence.filter((envelope) => isPassing(envelope));
    return frozen
        .filter((check) => !passing.some((envelope) => (check.id ? envelope.checkId === check.id : false)
            || (check.name ? envelope.name === check.name : false)))
        .map((check) => check.name ?? check.command);
}


/**
 * The checks this seal will actually run, derived from the change surface (F4).
 *
 * When the derivation excludes anything, the excluded checks are **named** in the result and recorded as `skipped`
 * progress events — the same discipline `coveredBy` and the frozen tier already use, because a run that quietly does less
 * than it used to is indistinguishable from a run that does the same work twice.
 */
async function deriveSealRelevantChecks(
    root: string,
    taskId: string,
    checks: CheckCommand[],
    /** The sealed revision this run is a re-seal of, or `null` for a first seal. Typed as the revision itself: the narrow
     * structural type that stood here was what forced the `as never` at the delta call below. */
    revision: TaskRevision | null,
    options: CommandOptions,
): Promise<{ checks?: CheckCommand[]; derivation?: Record<string, unknown> }> {
    // Only a re-seal can be narrowed: the first seal has nothing to compare against, and the freeze points must see
    // everything regardless.
    if (options.frozen === true || options.fullChecks === true) return {};
    const previousSnapshot = await readReviewDecisionSnapshot(root, taskId);
    const previous = revision ? null : (previousSnapshot.revisionRead.kind === 'current' ? previousSnapshot.revisionRead.revision : null);
    const base = revision ?? previous;
    if (!base?.pathDigests) return {};
    const { changeSurfaceAgainstWorkspace } = await import('../quality/revision-delta.js');
    // `base` is a `TaskRevision` here — the guard above established it carries `pathDigests`, which is a field of that
    // type and of nothing else in the union. The cast that used to stand here said so instead of showing it.
    const surface = await changeSurfaceAgainstWorkspace(root, base);
    if (surface.status !== 'available') return {};

    const task = await readTask(root, taskId).catch(() => null);
    const { deriveRelevantChecks } = await import('../quality/relevant-checks.js');
    const derivation = deriveRelevantChecks({
        root,
        matrix: (task as { acceptanceMatrix?: import('../core/task.js').AcceptanceMatrix } | null)?.acceptanceMatrix,
        changedPaths: surface.changedPaths,
        full: checks,
    });
    if (derivation.fellBackToFull) {
        return { derivation: { changedPaths: surface.changedPaths, fellBackToFull: true, fallbackReason: derivation.fallbackReason ?? null } };
    }
    return {
        // Only the relevant set runs; the rest is named in `diagnostics.derivedChecks.excludedChecks` and never silently
        // dropped. A check the derivation excluded still has its declaration, its id and its place in `--list-checks`.
        checks: [...derivation.relevant, ...checks.filter((check) => check.coveredBy)],
        derivation: {
            changedPaths: surface.changedPaths,
            acceptanceIds: derivation.acceptanceIds,
            relevantCount: derivation.relevant.length,
            excludedChecks: derivation.excluded.map((check) => check.name ?? check.command),
            fellBackToFull: false,
        },
    };
}

async function cmdVerify(
    taskId: string,
    root: string,
    options: CommandOptions = {},
): Promise<CommandResult> {
    const taskRaw = await readFile(taskPath(root, taskId), 'utf8');
    const task = JSON.parse(taskRaw) as {
        acceptance: Array<{ id?: string; statement: string }>;
        acceptanceMatrix?: import('../core/task.js').AcceptanceMatrix;
        upstreamCoverage?: import('../core/task.js').UpstreamCoverage;
        workflowProfile?: { reviewMode?: string };
    };

    const current = await readCurrentState(root, taskId);
    const currentDiffHash = await computeDiffHash(root);
    const evidence = await readTaskEvidence(root, taskId, options);
    const scopeHashes = await currentScopeHashes(root, evidence);
    const revisionId = revisionIdForEvidence(evidence);
    const review = await readReview(root, taskId);
    const revision = revisionId ? await readTaskRevision(root, taskId, revisionId) : undefined;
    // With the task id, so a revision whose declaration the task has since outgrown reads as `declaration-moved` rather than
    // `current` — the status payload is where an operator learns which of the two happened.
    const status = revision ? await revisionStatus(root, revision, taskId) : undefined;
    const drift = revision ? await workspaceDrift(root, revision.ownedPaths) : [];
    const matrix = task.acceptanceMatrix;
    // A project that declared `tier: 'frozen'` checks asked for that verification at the point the artefact is frozen —
    // which is here. Refusing while one has no passing evidence for this revision makes the declaration real instead of
    // advice, and the refusal names the command that fixes it.
    const frozenGaps = await missingFrozenTierEvidence(root, taskId, task as { ownedPaths?: string[] }, evidence);
    if (frozenGaps.length > 0) {
        return {
            command: 'verify',
            taskId,
            phase: 'hardVerify',
            success: false,
            error: `Frozen-tier checks have no passing evidence for the sealed revision: ${frozenGaps.join(', ')}. `
                + `Run: kata-cli build --change ${taskId} --seal --frozen`,
            diagnostics: { mode: 'verify', frozenTierMissing: frozenGaps },
        };
    }
    // **Both non-current states fail readiness, for the reason distill-gates refuses the same evidence** (rba7-f2). This
    // read `status?.status === 'superseded'`, so a `declaration-moved` revision took the normal readiness path and the verdict
    // was then stamped with that revision's id — while `distill-gates.ts` skips the very envelope, because a revision the task
    // has outgrown cannot be the basis of an archive. Two answers to one state is the shape this line keeps removing; both
    // consumers now ask `revisionIsCurrent`, so there is one answer, and the diagnostics report which of the two it was.
    const verifyResult = status && !revisionIsCurrent(status)
        ? supersededReadiness(taskId, task.acceptance, currentDiffHash, revision!.id)
        : evaluateReadiness(taskId, task.acceptance, evidence, currentDiffHash, scopeHashes, matrix, task.workflowProfile?.reviewMode);
    if (revisionId) verifyResult.revisionId = revisionId;
    const implementationReady = verifyResult.result === 'PASS';
    const wikiClosure = await evaluateWikiClosure(root, taskId);
    if (!wikiClosure.valid) verifyResult.result = 'FAIL';
    // Persist out-of-scope requirements into verify.json so reviewers reading the
    // verify artifact (not just the command output) can judge their legitimacy.
    if (task.upstreamCoverage) {
        (verifyResult as { outOfScopeRequirements?: unknown }).outOfScopeRequirements = task.upstreamCoverage.sources.flatMap((s) =>
            (s.requirements ?? []).filter((r) => !r.mappedTo).map((r) => ({
                id: r.id,
                statement: r.statement,
                sourceRef: s.ref,
                reason: r.outOfScopeReason ?? '',
            })),
        );
    }
    // The verdict names the revision it is about (id) and the content it saw (manifest hash), so a re-seal that changed
    // nothing does not expire it.
    //
    // **Read as three states at the command boundary, because this is where an operator stands.** `currentRevisionIdentity`
    // refuses an unreadable artefact by throwing, which is right for the decision surfaces and wrong here: measured with a
    // corrupted pointer, the router reported `currentRevisionUnreadable`, dispatched `/kata-verify`, and the command then
    // threw *after* verifying everything and *before* writing `verify.json` — so the run was discarded and the operator got
    // no envelope at all from the command the router had just recommended. A repair tool has to answer with a refusal it
    // can read.
    const verifyRevisionRead = (await readReviewDecisionSnapshot(root, taskId)).revisionRead;
    if (verifyRevisionRead.kind === 'unreadable') {
        return {
            command: 'verify',
            taskId,
            phase: current.phase,
            success: false,
            error: `Verification cannot conclude: the current revision cannot be read (${verifyRevisionRead.detail}). `
                + 'The sealed content this verdict would be about is unknown, so nothing is recorded. Repair or remove the artefact and run verify again.',
            // No `openProblems` here: this refusal runs before the ledger is read, and publishing `0` beside the reason
            // would be the "0 means no problems" substitution this round exists to remove, in its own new field.
            diagnostics: { currentRevisionUnreadable: verifyRevisionRead.detail },
        };
    }
    // **Derived from the read taken above, not read again.** The pointer is written non-atomically, so a check followed by
    // an independent read is not a check: measured by corrupting the file between the two reads, the command threw at this
    // line after verifying everything and before writing `verify.json` — the very discard the refusal above was added to
    // prevent. This is the same fix `review-read.ts` needed, and the primitive for it already exists.
    const verifyBinding = await currentRevisionIdentityFrom(verifyRevisionRead, root, taskId);
    await writeFile(
        verifyPath(root, taskId),
        `${JSON.stringify({ ...verifyResult, ...revisionBindingFields(verifyBinding) }, null, 2)}\n`,
        'utf8',
    );

    // Verify does not decide what happens next: it asks the same resolver the dispatcher uses, over the artefacts it
    // just wrote, so both surfaces answer with one ladder, one vocabulary and the priorities the dispatcher shows.
    const upstream = await readUpstreamSummary(root, taskId);
    const suggestion = suggestCandidateAction(current.phase, upstream);
    const repairReason = suggestion.reason;
    const nextAction = nextActionForTask(taskId, suggestion.nextSkill, suggestion.role, suggestion.reason);

    // Verify concludes on the evidence, not on an author's reading of it. It used to report which adversarial nodes the
    // profile would require — a statement about a mechanism that no longer certifies anything, and one that named the
    // *first* node of a list whose meaning changed with the mode. The mode is still read below, because the strict
    // matrix rule does depend on it; nothing else here does.
    const reviewMode = task.workflowProfile?.reviewMode;
    // A strict matrix declaration gap is reported, not blocked: a task sealed before strict rows required declared check
    // ids must keep verifying, or the rule would retroactively invalidate every binding it holds.
    const matrixGaps = findMatrixDeclarationGaps(task.acceptanceMatrix, reviewTierFor(reviewMode) !== 'standard');

    const ledgerProblems = await openLedgerProblems(root, taskId);
    return {
        command: 'verify',
        taskId,
        phase: current.phase,
        success: verifyResult.result === 'PASS',
        ...(verifyResult.result === 'FAIL' ? {
            error: implementationReady && !wikiClosure.valid
                ? `Implementation verification passed; the Wiki closure is incomplete (${wikiClosure.reason}). ${wikiClosureRemedy(wikiClosure.reason, taskId)}`
                : wikiClosure.valid
                    ? repairReason === 'rebuild_stale_evidence'
                        ? 'Verify found stale evidence; reseal checks against the current implementation before review/judge.'
                        : repairReason === 'add_entrypoint_evidence'
                            ? 'Verify requires integration/entrypoint evidence for at least one AC; unit evidence alone is insufficient.'
                            : repairReason === 'resolve_repair_obligations'
                                ? 'Verify blocked by unresolved repair obligations; supply matrix-linked evidence and mark obligations resolved.'
                                : 'Verify failed; repair evidence or blocking findings before review/judge.'
                    : `Verify failed; the Wiki closure is incomplete (${wikiClosure.reason}). ${wikiClosureRemedy(wikiClosure.reason, taskId)}`
        } : {}),
        diagnostics: {
            verifyResult: verifyResult.result,
            acceptanceResults: verifyResult.acceptance.map((a) => ({
                id: a.id,
                result: a.result,
                repairScope: a.repairScope,
            })),
            evidenceCount: evidence.length,
            // **Counted from the ledger, which is where a problem is recorded on this route.** These two fields reported the
            // round-shaped findings table; `openLedgerProblems` is the same question in the vocabulary the gates read.
            // **Absent, not zero, when the ledger could not be read.** Publishing `0` beside a separate detail string
            // was the same substitution in a new costume: a consumer reading only `openProblems` sees "no problems" for a
            // ledger that said nothing of the kind. The field is omitted instead, and the reason is what carries the fact
            // — which is exactly how the envelope already reports a check it could not run.
            ...openProblemsReportFields(ledgerProblems),
            // **The change record, read back.** The seal writes it and refuses prose that contradicts its own derived
            // numbers, and until this line nothing ever read one: an audited artefact with a writer and no reader, which is
            // the shape the wiring check reports and the shape `readChangeRecord` existed for. Reported here so an operator
            // can see what the record says about the revision under verification.
            changeRecord: await readChangeRecord(root, taskId).catch(() => null),
            implementationReady,
            governanceReady: wikiClosure.valid,
            ...(matrixGaps.length > 0 ? { acceptanceMatrixDeclarationGaps: matrixGaps } : {}),
            ...(task.upstreamCoverage ? {
                outOfScopeRequirements: task.upstreamCoverage.sources.flatMap((s) =>
                    (s.requirements ?? []).filter((r) => !r.mappedTo).map((r) => ({
                        id: r.id,
                        statement: r.statement,
                        sourceRef: s.ref,
                        reason: r.outOfScopeReason ?? '',
                    })),
                ),
            } : {}),
            wikiClosure,
            ...(revisionId ? { revisionId } : {}),
            ...(status ? { revisionStatus: status.status } : {}),
            ...(revision ? { workspaceDrift: drift } : {}),
            nextAction,
        },
    };
}

async function cmdReview(taskId: string, root: string, options: CommandOptions = {}): Promise<CommandResult> {
    try {
        const isApprove = options.approve === true;
        const reviewResultFile = options.reviewResultFile?.trim();
        if (options.reviewResultFile !== undefined) {
            if (!reviewResultFile) {
                return { command: 'review', taskId, phase: (await readCurrentState(root, taskId)).phase, success: false, error: '--result-file requires a workspace-relative JSON file path' };
            }
            if (options.approve) {
                return {
                    command: 'review', taskId, phase: 'review', success: false,
                    error: 'Review result recording and approval are separate steps: record the subagent result first, then approve it after its findings are disposed of.',
                };
            }
            const current = await readCurrentState(root, taskId);
            if (current.phase !== 'review') {
                return {
                    command: 'review', taskId, phase: current.phase, success: false,
                    error: `Review result recording requires review phase; current phase is ${current.phase}.`,
                };
            }
            const resultPath = containedPath(root, reviewResultFile);
            if (!resultPath) {
                return { command: 'review', taskId, phase: 'review', success: false, error: `--result-file must stay inside the workspace: ${reviewResultFile}` };
            }
            let findings: ReviewFinding[];
            let declaredCoverage: string[] | null = null;
            try {
                const result = JSON.parse(await readFile(resultPath, 'utf8')) as { findings?: unknown; declaredCoverage?: unknown };
                if (!Array.isArray(result.findings)) throw new Error('the JSON object must contain a findings array');
                findings = validateArtefact<ReviewFinding[]>('review-finding', result.findings);
                const foreignFinding = findings.find((finding) => finding.taskId !== taskId);
                if (foreignFinding) throw new Error(`finding ${foreignFinding.id} names task ${foreignFinding.taskId}, not ${taskId}`);
                // An empty set is only a result when the reviewer says what it covered. Without that, a four-byte
                // artefact is indistinguishable from a subagent that produced nothing at all.
                const coverage = result.declaredCoverage;
                if (findings.length === 0 && coverage === undefined) {
                    throw new Error('an empty findings array is only a result when the object also declares coverage: add declaredCoverage with the claim ids that were read and found sound');
                }
                // **A declaration is validated wherever it appears, and it is always kept.** The first version validated
                // and persisted it only on the empty-findings path, so `{ findings: [...], declaredCoverage: ['C-9'] }` was
                // accepted with an invented claim id and the field was dropped — a declaration with a validator on one
                // path and no reader on the other.
                if (coverage !== undefined) {
                    if (!Array.isArray(coverage) || coverage.length === 0 || !coverage.every((claim): claim is string => typeof claim === 'string' && claim.trim().length > 0)) {
                        throw new Error('declaredCoverage must be a non-empty list of the claim ids that were read and found sound');
                    }
                    const known = new Set((await readLedger(root, taskId)).claims.map((claim) => claim.id));
                    const unknown = (coverage as string[]).filter((claimId) => !known.has(claimId));
                    if (unknown.length > 0) {
                        throw new Error(`declaredCoverage names ${unknown.join(', ')}, which this ledger does not hold; the declaration must name the claims that were read`);
                    }
                    declaredCoverage = coverage as string[];
                }
            } catch (error) {
                return {
                    command: 'review', taskId, phase: 'review', success: false,
                    error: `Cannot record review result from ${reviewResultFile}: ${(error as Error).message}`,
                };
            }
            // The read this binding came from is handed to the record reader, which used to take a second look at the
            // same non-atomic pointer to decide whether this revision already had a record.
            const resultSnapshot = await readReviewDecisionSnapshot(root, taskId);
            const resultRevisionRead = resultSnapshot.revisionRead;
            const binding = await currentRevisionIdentityFrom(resultRevisionRead, root, taskId);
            const existing = await readReviewRecord(root, taskId, resultRevisionRead);
            if (!existing.ok) {
                return { command: 'review', taskId, phase: 'review', success: false, error: `Cannot record a review result: ${existing.why}` };
            }
            // **A recorded result blocks a second recording; the enter-review placeholder does not.** Two facts were being
            // asked as one. The first version asked `existing.findings.length > 0`, so an empty *result* read as "nothing
            // recorded yet" and a second write replaced it — the empty result was both accepted and invisible. Tightening
            // it to "any record" fixed that and created the opposite defect, measured by an independent review: entering
            // review writes a placeholder bound to the revision with no findings, so from then on every `--result-file`
            // was refused and the command the design and the rendered skill both promise was unreachable — "re-enter
            // review" could only produce another placeholder. The two are told apart by *what wrote the record*: a
            // placeholder carries no `reviewRoute`, and a recorded round always does.
            // **The record's own binding, field by field.** A record that names a revision is a record for this revision
            // only when the two bindings agree — and the binding set includes the frozen candidate, not just the id.
            // Reading only `revisionId`/`manifestHash` made "already recorded" answer false for a record the seal had
            // bound by content, which is the case the empty-result defect rode in on.
            const existingRecord: VerdictBinding = {
                ...(typeof existing.record.revisionId === 'string' ? { revisionId: existing.record.revisionId } : {}),
                ...(typeof existing.record.manifestHash === 'string' ? { manifestHash: existing.record.manifestHash } : {}),
                ...(typeof existing.record.codeManifestHash === 'string' ? { codeManifestHash: existing.record.codeManifestHash } : {}),
                ...(typeof existing.record.governanceManifestHash === 'string' ? { governanceManifestHash: existing.record.governanceManifestHash } : {}),
                ...(typeof existing.record.instrumentManifestHash === 'string' ? { instrumentManifestHash: existing.record.instrumentManifestHash } : {}),
                ...(typeof existing.record.candidateFreezeSha256 === 'string' ? { candidateFreezeSha256: existing.record.candidateFreezeSha256 } : {}),
            };
            const placeholder = isReviewPlaceholder(existing.record);
            if (!placeholder && Object.keys(existingRecord).length > 0 && bindsToRevision(existingRecord, binding)) {
                return {
                    command: 'review', taskId, phase: 'review', success: false,
                    error: 'A review result is already recorded for this revision. Re-enter review before recording a replacement.',
                };
            }
            const revisionId = revisionIdForEvidence(await readTaskEvidence(root, taskId, options));
            const recordPath = layoutReviewPath(root, taskId);
            const committed = await commitReviewDecision(root, taskId, resultSnapshot, async (lock) => {
                await mutateTaskArtefact(
                    root,
                    taskId,
                    recordPath,
                    async () => `${JSON.stringify({ ...(revisionId ? { revisionId } : {}), ...revisionBindingFields(binding), findings, ...(declaredCoverage === null ? {} : { declaredCoverage }), status: 'pending', reviewRoute: 'adversarial' }, null, 2)}\n`,
                    lock,
                );
            });
            if (committed.kind !== 'committed') {
                return { command: 'review', taskId, phase: 'review', success: false, error: 'Cannot record a review result because the sealed revision moved or became unavailable while it was being committed. Re-run /kata-review.' };
            }
            return {
                command: 'review',
                taskId,
                phase: 'review',
                success: true,
                diagnostics: {
                    role: 'reviewer',
                    resultFile: reviewResultFile,
                    findings: findings.length,
                    ...(revisionId ? { revisionId } : {}),
                },
            };
        }

        if (isApprove) {
            const current = await readCurrentState(root, taskId);
            if (current.phase !== 'review') {
                return {
                    command: 'review', taskId, phase: current.phase, success: false,
                    error: `Review approval requires review phase; current phase is ${current.phase}.`,
                };
            }
            const reviewEvidence = options.reviewEvidence?.trim();
            if (!reviewEvidence) {
                return {
                    command: 'review', taskId, phase: 'review', success: false,
                    error: 'Review approval requires non-empty review evidence.',
                };
            }
            // **The bar, asked of the one reader, before anything is written.** The branch that read `review.json`'s
            // findings here was deleted once on the argument that the ledger route "reads the ledger, and only the
            // ledger" — and an independent review then measured what that left behind: with an open `blocking` finding in
            // the record and a ledger that passes, the approval was granted, the change was routed to the judge, and the
            // repair entry was authorised, while the distill gate refused the very same change (`tmp/repro-c3c4.mts`).
            // Removing the branch did not remove the second answer; it moved it one surface over.
            //
            // The repair is not to add a branch back, it is to stop each caller assembling the question: the refusal now
            // asks `readBlockingProblems`, the same reader the gate, the repair entry and the router ask. A record that
            // cannot be read refuses here too, rather than escaping as an exception.
            const { ledgerVerdict: readLedgerVerdict } = await import('../store/verdict.js');
            // Read once and used by both refusals below: the bar sentence says which problems are open, and the
            // kernel's reasons say why the ledger does not pass. An operator needs both, and one message that
            // carried only one of them would send them looking for the other.
            const ledger = await readLedgerVerdict({ root, changeId: taskId });
            // **One pointer read answers the bar, the request check and the round this approval stamps.** The branch used
            // to take three looks at the same non-atomically written file — `readBlockingProblems` reading it internally,
            // `verifyAgainstRequest` reading it again, and `currentRevisionIdentity` a third time for the stamped round —
            // so a seal landing in between left the approval resting on one revision while it stamped another. Same
            // invariant as the review entry and the repair writer, measured by an independent review.
            const approvalSnapshot = await readReviewDecisionSnapshot(root, taskId);
            const approvalRevisionRead = approvalSnapshot.revisionRead;
            const approvalBar = await readBlockingProblems(root, taskId, approvalRevisionRead);
            if (!approvalBar.ok) {
                return {
                    command: 'review', taskId, phase: 'review', success: false,
                    error: `Review approval cannot be judged by the evidence ledger and cannot be decided: ${approvalBar.why}.`,
                };
            }
            if (approvalBar.problems.length > 0) {
                const ledgerReasons = ledger.kind === 'decided' && ledger.decision.verdict !== 'pass'
                    ? `. The evidence ledger does not pass (${ledger.decision.verdict}): ${ledger.decision.reasons
                        .map((reason) => `${reason.code}${reason.claimId ? ` (${reason.claimId})` : ''}: ${reason.detail}`)
                        .join(' | ')}`
                    : '';
                return {
                    command: 'review', taskId, phase: 'review', success: false,
                    error: `Review approval requires every problem at the mode's bar to be disposed of. ${describeBlockingProblems(approvalBar.mode, approvalBar.problems)}${ledgerReasons}`,
                    diagnostics: {
                        blockingProblems: approvalBar.problems,
                        ...(ledger.kind === 'decided' ? { ledger: { state: 'decided' as const, verdict: ledger.decision.verdict, reasons: ledger.decision.reasons } } : {}),
                        nextAction: nextActionForTask(taskId, '/kata-build', 'implementer', 'repair_blocking_review_findings'),
                    },
                };
            }
            // **Two routes to an approval, and the ledger's is the stronger one.** A change whose claims and evidence
            // are recorded in a ledger is decided by the kernel over content kata verified itself, so what holds the
            // approval is the evidence rather than a round-shaped pass about it. A change with no ledger keeps the route
            // it had, and that absence is a fact the caller can see — which is what lets the old route be retired change
            // by change instead of all at once.
            const { ledgerDrift } = await import('../store/ledger.js');
            let ledgerApproval: { subjectRevision: string; tier: string; assurance: string; claims: number; limits: string[] } | null = null;
            if (ledger.kind === 'unreadable') {
                // A ledger that exists and cannot be read decides nothing, and it must not fall through to the other route
                // as though it had never been written: those are two different facts.
                return {
                    command: 'review', taskId, phase: 'review', success: false,
                    error: `Review approval cannot be judged by the evidence ledger: ${ledger.detail}`,
                };
            }
            if (ledger.kind === 'decided') {
                // A verdict must not outlive the content it was about, so the frozen digests are compared with what the
                // paths hold now. A path that cannot be read makes the comparison impossible, which is a refusal rather
                // than a silent pass.
                const drift = await ledgerDrift(root, taskId);
                if (drift && drift.unreadable.length > 0) {
                    return {
                        command: 'review', taskId, phase: 'review', success: false,
                        error: `Review approval cannot be judged by the evidence ledger: it names paths that cannot be read (${drift.unreadable.join(', ')}), so no comparison against the frozen subject is possible.`,
                    };
                }
                const moved = drift ? [...drift.changed, ...drift.added, ...drift.removed] : [];
                if (moved.length > 0) {
                    return {
                        command: 'review', taskId, phase: 'review', success: false,
                        error: `The ledger describes content that has moved since it was frozen: ${moved.join(', ')}. Re-freeze the subject and re-verify the claims the change reopened, then approve.`,
                        diagnostics: {
                            ledger: { state: 'decided', verdict: ledger.decision.verdict, subjectRevision: ledger.subjectRevision, moved },
                            nextAction: nextActionForTask(taskId, '/kata-build', 'implementer', 'satisfy_ledger_deficits'),
                        },
                    };
                }
                if (ledger.decision.verdict !== 'pass') {
                    const reasons = ledger.decision.reasons
                        .map((reason) => `${reason.code}${reason.claimId ? ` (${reason.claimId})` : ''}: ${reason.detail}`);
                    // **The verdict says the ledger does not pass; this says which problems are at this mode's bar.** The
                    // reasons are the kernel's vocabulary and the caller had to reconstruct the mode's severity rule from
                    // them; naming the problems is the same ladder the routers read, so the refusal and the routing cannot
                    // disagree about what blocks. A mode whose bar no open problem reaches adds nothing to the sentence.
                    // **The same read the refusal above rested on.** This used to take a second look at the pointer, so
                    // the bar sentence and `diagnostics.blockingProblems` could describe a different state from the
                    // decision they explain (measured by an independent review); the read is already in hand here.
                    const blockingRead = await readBlockingProblems(root, taskId, approvalRevisionRead);
                    // **The bar sentence names the problems at the bar, and only those.** Naming every open problem would
                    // claim the mode refuses something it does not — a `major` problem is open under `std` and is not at
                    // std's bar, so a sentence that listed it would be a declaration claiming more than its reality.
                    const blockingProblems = blockingRead.ok ? blockingRead.problems : [];
                    const bar = blockingRead.ok
                        ? describeBlockingProblems(blockingRead.mode, blockingProblems)
                        : blockingRead.why;
                    return {
                        command: 'review', taskId, phase: 'review', success: false,
                        error: `The evidence ledger does not pass (${ledger.decision.verdict}): ${reasons.join(' | ')}${bar === '' ? '' : `. ${bar}`}`,
                        diagnostics: {
                            blockingProblems,
                            ledger: {
                                state: 'decided',
                                verdict: ledger.decision.verdict,
                                tier: ledger.tier,
                                assurance: ledger.assurance,
                                reasons: ledger.decision.reasons,
                                deficits: ledger.decision.deficits,
                            },
                            nextAction: nextActionForTask(taskId, '/kata-build', 'implementer', 'satisfy_ledger_deficits'),
                        },
                    };
                }

                // **A retired assurance value is refused here, and the repair now exists.** The earlier refusal was a
                // dead end (it dispatched "re-run the verification" while `ensureAssurance` kept the stronger value, so
                // re-running returned the same one), and deleting it was over-correction: measured with a *passing*
                // ledger carrying `sandboxed`, the approval returned `success: true` and wrote that value into a fresh
                // review record. A recorded round now replaces a recorded round **and** the decision surface refuses a
                // value no current writer can produce, so the refusal names a repair that works.
                if (!isCurrentAssuranceLevel(ledger.assurance)) {
                    return {
                        command: 'review', taskId, phase: 'review', success: false,
                        error: `Review approval refused: historical assurance cannot authorize a current review (${ledger.assurance}). `
                            + `Run \`kata-cli ledger evidence verify --change ${taskId}\` — a later round replaces this value rather than `
                            + 'outranking it — then approve.',
                        diagnostics: {
                            ledger: { state: 'decided', assurance: ledger.assurance, legacyAssurance: true },
                            nextAction: nextActionForTask(taskId, '/kata-build', 'implementer', 'satisfy_ledger_deficits'),
                        },
                    };
                }
                // **The handshake is a gate, not a printout.** `ledger run` hands a reviewer a request — the claim's own
                // reading set, the evidence types its tier requires, the deadline, the probes it must answer — and
                // `ledger request-check` compares what arrived against what was asked. Nothing consumed that check: it was
                // a command an operator could run and skip, so a change could be approved with its probes unanswered and
                // a claim whose reading set was never planned. Asking it here is what makes the plan a plan.
                const { verifyAgainstRequest } = await import('../store/review-request.js');
                const requestGaps = (await verifyAgainstRequest({ root, changeId: taskId, sealedRead: approvalRevisionRead })).gaps;
                if (requestGaps.length > 0) {
                    const named = requestGaps.map((gap) => `${gap.claimId ?? 'request'}: ${gap.what}`);
                    return {
                        command: 'review', taskId, phase: 'review', success: false,
                        error: `Review approval requires the review request to be satisfied: ${named.join(' | ')}. `
                            + 'Run `kata-cli ledger request-check` for the same list, then record what is missing: evidence of the required type, a verdict for it, or the probe answers the request asked for.',
                        diagnostics: {
                            requestGaps,
                            nextAction: nextActionForTask(taskId, '/kata-build', 'implementer', 'satisfy_ledger_deficits'),
                        },
                    };
                }

                ledgerApproval = {
                    subjectRevision: ledger.subjectRevision,
                    tier: ledger.tier,
                    assurance: ledger.assurance,
                    claims: ledger.claims,
                    // **What this route does not establish, said out loud.** The ledger records what was verified, not who
                    // declared the claims: this approval rests on evidence kata ran and on a discovery floor, not on an
                    // independent session having written the record.
                    limits: ['the ledger records what was verified, not who wrote the claims'],
                };
            }

            if (ledgerApproval === null) {
                // **The old route is closed, and an approval now requires an evidence ledger.** The round-shaped pass was
                // the route for a change whose review was a document about a round; the ledger is the route for a change
                // whose review is claims and evidence kata verified itself. Keeping both meant two answers to "was this
                // reviewed" — the same defect class this repository has spent the session removing — and *which* answer a
                // change got depended on which files happened to exist.
                //
                // Measured before closing it: no change in flight needs the old route (the eleven tasks are archived, and
                // the three with ledger content were approved through it), so the effect today is zero and the statement
                // "the ledger is the gate" becomes a fact rather than a claim.
                return {
                    command: 'review', taskId, phase: 'review', success: false,
                    error: 'Review approval requires an evidence ledger: this change has claims and evidence recorded by '
                        + '`kata-cli ledger`, and an approval is decided by them. Record a subject, the claims and their '
                        + 'evidence first (`ledger freeze`, `ledger claim add`, `ledger evidence add|verify`, `ledger plan`, '
                        + '`ledger decide`), because a review that cannot be decided by evidence is not one this route can certify.',
                    diagnostics: {
                        ledger: { state: ledger.kind, decided: ledger.kind === 'decided' ? ledger.decision.verdict : null },
                        nextAction: nextActionForTask(taskId, '/kata-build', 'implementer', 'satisfy_ledger_deficits'),
                    },
                };
            }
            // **The ledger route reads the ledger, and only the ledger.** This branch used to consult the round-shaped
            // findings table and the obligation store beside the decision, so a change approved on its evidence could
            // still be blocked by a finding recorded against a *round* — the last place where one fact had two derivations
            // and the answer depended on which source was read first. An approval that rests on claims and evidence is
            // answered by `decide`, which reports every refusal as a reason with a message; a table about a pass that no
            // longer gates anything has nothing to add to it.
            //
            // The dead branch is deleted rather than left empty. An ordered list with nothing in it, checked for being
            // non-empty, is a guard that cannot fire — the class this repository has removed more times than any other,
            // and the code that reads it would be a reader wondering whether it ever did anything.
            //
            // Kept in the record rather than the code: this was the sixth call site repaired for reading a copy of "is
            // this finding disposed" (`cg-f1`, `kgsr7-f3`, `rba-r3-f3`, `wcc7-f3`, navigation, and this one), and the
            // repair that ends the class is the removal of the second copy, not a seventh patch.
            const { suggestedReviewedPaths, reviewScopeVerdict } = await import('../quality/review-scope.js');
            // **F5's verdict, on the route that records what a review read.** The property is "the change stayed inside the
            // paths the review declared reading"; the recorded `reviewedPaths` existed and nothing verdict it, so a review
            // could declare two paths, the change could grow to twelve, and the approval would not notice. The drift is
            // measured against the ledger's frozen subject, which is what "changed since the review" means here.
            if (options.reviewedPaths?.length) {
                const { ledgerDrift } = await import('../store/ledger.js');
                const drift = await ledgerDrift(root, taskId);
                if (drift && drift.changed.length + drift.added.length > 0) {
                    const scope = reviewScopeVerdict({
                        reviewedPaths: options.reviewedPaths,
                        changedPaths: [...drift.changed, ...drift.added],
                    });
                    if (!scope.withinScope) {
                        return {
                            command: 'review', taskId, phase: 'review', success: false,
                            error: `Review approval refused: ${scope.reason}. Re-run /kata-review — a review covers the paths it recorded reading, and this change now reaches others.`,
                            diagnostics: { reviewScope: { outside: scope.outside, conservative: scope.conservative } },
                        };
                    }
                }
            }
            const approvalTask = await readTask(root, taskId);
            const reviewPath = layoutReviewPath(root, taskId);
            const revisionId = revisionIdForEvidence(await readTaskEvidence(root, taskId, options));
            // **One reader, and it is the one that carries every binding field.** `readReview` returns no `manifestHash`,
            // so a binding built from it could never satisfy the manifest branch of `bindsToRevision` — the refusal below
            // promises "(or the same content)" and that branch was unreachable, while the bar above had already decided
            // the same question from a different read. `readReviewRecord` answers both from the record it read.
            const approvalRecord = await readReviewRecord(root, taskId, approvalRevisionRead);
            if (!approvalRecord.ok) {
                return {
                    command: 'review', taskId, phase: 'review', success: false,
                    error: `Review approval cannot be decided: ${approvalRecord.why}` ,
                };
            }
            const existing: VerdictBinding = {
                ...(typeof approvalRecord.record.revisionId === 'string' ? { revisionId: approvalRecord.record.revisionId } : {}),
                ...(typeof approvalRecord.record.manifestHash === 'string' ? { manifestHash: approvalRecord.record.manifestHash } : {}),
                ...(typeof approvalRecord.record.codeManifestHash === 'string' ? { codeManifestHash: approvalRecord.record.codeManifestHash } : {}),
                ...(typeof approvalRecord.record.governanceManifestHash === 'string' ? { governanceManifestHash: approvalRecord.record.governanceManifestHash } : {}),
                ...(typeof approvalRecord.record.instrumentManifestHash === 'string' ? { instrumentManifestHash: approvalRecord.record.instrumentManifestHash } : {}),
                ...(typeof approvalRecord.record.candidateFreezeSha256 === 'string' ? { candidateFreezeSha256: approvalRecord.record.candidateFreezeSha256 } : {}),
            };
            const approveBinding = await currentRevisionIdentityFrom(approvalRevisionRead, root, taskId);
            if (!approveBinding.revisionId || !approveBinding.manifestHash) {
                return {
                    command: 'review', taskId, phase: 'review', success: false,
                    error: 'Review approval requires a current sealed revision so its loop round can be bound to that revision.',
                };
            }
            if (revisionId && !bindsToRevision(existing, approveBinding)) {
                return {
                    command: 'review', taskId, phase: 'review', success: false,
                    error: 'Review approval requires findings recorded for the same sealed revision (or the same content) as current evidence. Re-run /kata-review before approving.',
                };
            }
            // **The severity refusal over `review.json`'s findings was deleted here once, and that deletion is what an
            // independent review falsified.** The argument was that the ledger route answers severity by itself — a claim's
            // severity decides the evidence strength it requires, `decide` applies it — and that the findings table is empty
            // for a governed change, so the branch could not fire. The second half was wrong: the table is not empty when a
            // record carries findings, and the distill gate reads them, so deleting the branch here did not end the class,
            // it moved the second answer to the surface that *does* read them.
            //
            // What is fixed is the cause rather than the branch: the question is asked by `readBlockingProblems` and by
            // nothing else, so a caller cannot assemble a different version of it. The refusal above is that reader's
            // answer, and it fires on exactly what the gate fires on.
            // F5: the reviewer may state which paths they read; absent, the review is read as covering the whole revision
            // (the conservative direction). When none was stated, the matrix's suggestion is *offered* in the result
            // rather than written behind the reviewer's back — the design's F5 rests on their honesty, not on kata's.
            const reviewedPaths = options.reviewedPaths?.length ? options.reviewedPaths : undefined;
            const suggestion = reviewedPaths
                ? []
                : suggestedReviewedPaths(
                    approvalTask.acceptanceMatrix,
                    approvalRecord.findings.map((finding) => finding.acceptanceId).filter((id): id is string => Boolean(id)),
                );
            // **The approval lands atomically and under the task lock.** It was a bare `writeFile`, so a crash could
            // leave a half-written `review.json` — the artefact the archive gate reads to decide whether a change was
            // reviewed — and two concurrent commands could interleave with the review transition beside it.
            const approvalBytes = `${JSON.stringify({ ...(revisionId ? { revisionId } : {}), ...revisionBindingFields(approveBinding), ...(reviewedPaths ? { reviewedPaths } : {}), findings: approvalRecord.findings, status: 'approved', reviewEvidence, reviewRoute: 'ledger', ledgerReview: ledgerApproval, approvedAt: new Date().toISOString() }, null, 2)}\n`;
            const committed = await commitReviewDecision(root, taskId, approvalSnapshot, async (lock) => {
                await mutateTaskArtefact(root, taskId, reviewPath, async () => approvalBytes, lock);
                // **The approval is a round of the loop, and it measured zero.** `review-rounds.jsonl` only gained a line when a
                // repair was entered, so an approval recorded nothing and the escalation read a history whose blocking count
                // rose (2 → 4 → 6) and never fell — firing on this change the moment its review passed with no findings. `0` and
                // `null` are now two facts: cleared, and nothing to measure.
                await appendReviewRound(root, taskId, {
                    at: new Date().toISOString(),
                    ...(approveBinding.revisionId ? { revisionId: approveBinding.revisionId } : {}),
                    ...(approveBinding.manifestHash ? { manifestHash: approveBinding.manifestHash } : {}),
                    blockingIds: [],
                    blockingCount: 0,
                }, lock);
            });
            if (committed.kind !== 'committed') {
                return { command: 'review', taskId, phase: 'review', success: false, error: 'Review approval could not be committed because the sealed revision moved or became unavailable. Re-run /kata-review.' };
            }
            return {
                command: 'review',
                taskId,
                phase: 'review',
                success: true,
                diagnostics: {
                    role: 'reviewer',
                    approval: true,
                    reviewEvidence,
                    ...(revisionId ? { revisionId } : {}),
                    ...(reviewedPaths ? { reviewedPaths } : {}),
                    ...(suggestion.length > 0
                        ? {
                            reviewScope: {
                                recorded: false,
                                suggestion,
                                note: 'No --reviewed-path was given, so this review is read as covering the whole revision (any change invalidates it). Pass --reviewed-path for each path you actually read to narrow that.',
                            },
                        }
                        : {}),
                },
            };
        }

        if (!options.confirmHostModel) {
            return {
                command: 'review', taskId, phase: 'hardVerify', success: false,
                error: 'Review requires explicit user confirmation at the review trust boundary.',
                diagnostics: { requiresUserConfirmation: true, trustBoundary: 'review_gate' },
            };
        }

        await guardTransition(options.guard, 'check', taskId, 'review');
        const state = await transition(taskId, 'review', actorFor(reviewerActor, options.platform), { root });
        await guardTransition(options.guard, 'apply', taskId, 'review');
        const reviewRecordPath = layoutReviewPath(root, taskId);
        const revisionId = revisionIdForEvidence(await readTaskEvidence(root, taskId, options));
        // **The placeholder is bound, because that is what makes it invalidatable.** Measured with a probe: this branch
        // wrote `{ findings: [], status: 'pending' }` with no binding fields, so a review entered for a revision stayed
        // `pending` and unbound across a later content change — the one state the binding exists to catch. The write below
        // carries the same binding fields the result path writes, through one derivation.
        // **The pointer is read once here, and both uses consume that one read.** This branch used to mint the identity
        // twice — `entryBinding` for the placeholder it stamps and a second `currentRevisionIdentity` for the
        // overwrite/archive decision below — and the pointer is written non-atomically, so a seal landing between the two
        // left the record stamped from one revision while the decision to replace it rested on another (measured by an
        // independent review; same invariant as the round writer in `repair-entry.ts`).
        const entrySnapshot = await readReviewDecisionSnapshot(root, taskId);
        const entryRevisionRead = entrySnapshot.revisionRead;
        const entryBinding = await currentRevisionIdentityFrom(entryRevisionRead, root, taskId);
        let committed;
        try {
            committed = await commitReviewDecision(root, taskId, entrySnapshot, async (lock) => {
                try {
                    const previous = JSON.parse(await readFile(reviewRecordPath, 'utf8')) as {
                        revisionId?: string;
                        findings?: ReviewFinding[];
                        status?: string;
                    };
                    const recordBinding = await currentRevisionIdentityFrom(entryRevisionRead, root, taskId);
                    if (revisionId && !bindsToRevision(previous, recordBinding)) {
                        if (!isReviewPlaceholder(previous)) {
                            const historyPath = join(taskDir(root, taskId), 'review-history.jsonl');
                            const historyEntry = JSON.stringify({
                                revisionId: previous.revisionId,
                                findings: previous.findings,
                                status: previous.status ?? 'pending',
                                archivedAt: new Date().toISOString(),
                            }) + '\n';
                            await appendFile(historyPath, historyEntry, 'utf8');
                        }
                        await mutateTaskArtefact(root, taskId, reviewRecordPath, async () => `${JSON.stringify({ ...(revisionId ? { revisionId } : {}), ...revisionBindingFields(entryBinding), findings: [], status: 'pending' }, null, 2)}\n`, lock);
                    } else if (isReviewPlaceholder(previous)) {
                        await mutateTaskArtefact(root, taskId, reviewRecordPath, async () => `${JSON.stringify({ ...(revisionId ? { revisionId } : {}), ...revisionBindingFields(entryBinding), findings: [], status: 'pending' }, null, 2)}\n`, lock);
                    }
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                    await mutateTaskArtefact(root, taskId, reviewRecordPath, async () => `${JSON.stringify({ ...(revisionId ? { revisionId } : {}), ...revisionBindingFields(entryBinding), findings: [], status: 'pending' }, null, 2)}\n`, lock);
                }
            });
        } catch (error) {
            return {
                command: 'review',
                taskId,
                phase: state.phase,
                success: false,
                error: `Review could not be entered: ${(error as Error).message}. `
                    + `The review record is at ${layoutReviewPath(root, taskId)}; repair or remove it and retry.`,
            };
        }
        if (committed.kind !== 'committed') {
            return {
                command: 'review',
                taskId,
                phase: state.phase,
                success: false,
                error: 'Review could not be entered because the sealed revision moved or became unavailable while the placeholder was being committed. Re-run /kata-review.',
            };
        }
        return { command: 'review', taskId, phase: state.phase, success: true, diagnostics: { role: 'reviewer', ...(revisionId ? { revisionId } : {}) } };
    } catch (error) { return { command: 'review', taskId, phase: 'hardVerify', success: false, error: `Review transition failed: ${(error as Error).message}` }; }
}


/**
 * Whether a review record is the enter-review placeholder rather than a recorded round.
 *
 * **One derivation, because two of them disagreed.** F-1 tightened the *result* face to "a placeholder is not a result",
 * so a second recording was no longer refused by the placeholder the enter-review step writes; but the *write* face kept
 * the older test (`findings` is empty), so re-entering review over a recorded round that legitimately had no findings —
 * `{ findings: [], declaredCoverage: ['C-1'], reviewRoute: 'adversarial' }` — rewrote it into a placeholder and the
 * `--result-file` guard then let a second round through. The fact is one fact; it is asked here and both faces call it.
 */
function isReviewPlaceholder(record: { reviewRoute?: unknown; findings?: unknown; declaredCoverage?: unknown }): boolean {
    return record.reviewRoute === undefined
        && (Array.isArray(record.findings) ? record.findings.length : 0) === 0
        && record.declaredCoverage === undefined;
}

async function cmdJudge(taskId: string, root: string, options: CommandOptions = {}): Promise<CommandResult> {
    const current = await readCurrentState(root, taskId);
    if (current.phase !== 'review') {
        return {
            command: 'judge',
            taskId,
            phase: current.phase,
            success: false,
            error: `Judge requires review phase; current phase is ${current.phase}. Run /kata-review first, then ask the user whether to keep this platform/model or switch before /kata-judge.`,
            diagnostics: {
                requiresUserConfirmation: true,
                trustBoundary: 'judge_gate',
                nextSkill: current.phase === 'hardVerify' ? '/kata-review' : '/kata',
                modelOrPlatformSwitchAllowed: true,
            },
        };
    }
    if (!options.confirmHostModel) {
        return {
            command: 'judge', taskId, phase: 'review', success: false,
            error: 'Judge requires explicit user confirmation at the judge trust boundary.',
            diagnostics: { requiresUserConfirmation: true, trustBoundary: 'judge_gate' },
        };
    }
    const taskRaw = await readFile(taskPath(root, taskId), 'utf8');
    const task = JSON.parse(taskRaw) as {
        acceptance: Array<{ id?: string; statement: string }>;
        acceptanceMatrix?: import('../core/task.js').AcceptanceMatrix;
        workflowProfile?: { reviewMode?: string };
    };
    const review = await readReview(root, taskId);
    if (review.status !== 'approved' || !review.reviewEvidence?.trim()) {
        return {
            command: 'judge', taskId, phase: 'review', success: false,
            error: review.status === 'pending'
                ? 'Review has no explicit evidence-backed conclusion. Approve review with /kata-review --approve --review-evidence <summary> or record findings before judge.'
                : 'Review has no explicit conclusion. Run /kata-review first.',
        };
    }
    const currentDiffHash = await computeDiffHash(root);
    const evidence = await readTaskEvidence(root, taskId, options);
    // **No `findings` input.** The judge used to take the round-shaped findings table and fail a criterion whose id a
    // blocking finding named. That table has no producer on this route — a claim's severity and evidence decide the same
    // question in `decide` — so the input is gone rather than left accepting a list nothing fills.
    let reportFailedCriteria: string[] = [];
    const evidenceRevisionId = revisionIdForEvidence(evidence);
    const reviewRevisionId = await readReviewRevisionId(root, taskId);
    if (evidenceRevisionId && reviewRevisionId !== evidenceRevisionId) {
        return {
            command: 'judge', taskId, phase: 'review', success: false,
            error: 'Judge requires the review conclusion bound to the same sealed revision as evidence. Re-run /kata-review for the current revision.',
            diagnostics: { revisionId: evidenceRevisionId, reviewRevisionId: reviewRevisionId ?? null, repairScope: 'cross_revision_review' },
        };
    }
    // **The same boundary refusal `verify` got, for the same reason.** `judge` computes the whole result and only then
    // reads the revision to stamp it — so a corrupted pointer threw at the stamp and `judge.json` was never written,
    // discarding a judgement that had already been computed. Measured: `runCommand('judge')` with a corrupted pointer threw
    // at `quality/judge.ts:138` (the write is at `:140`). A tool an operator runs while repairing a task directory has to
    // answer with something it can read.
    const judgeRevisionRead = (await readReviewDecisionSnapshot(root, taskId)).revisionRead;
    if (judgeRevisionRead.kind === 'unreadable') {
        return {
            command: 'judge',
            taskId,
            phase: 'review',
            success: false,
            error: `The judgement cannot be recorded: the current revision cannot be read (${judgeRevisionRead.detail}). `
                + 'The content it would speak for is unknown, so nothing is written. Repair or remove the artefact and run judge again.',
            diagnostics: { currentRevisionUnreadable: judgeRevisionRead.detail },
        };
    }
    const scopeHashes = await currentScopeHashes(root, evidence);
    const judgeResult = await judge({
        root,
        taskId,
        acceptance: task.acceptance,
        evidence,
        currentDiffHash,
        currentScopeHashes: scopeHashes,
        matrix: task.acceptanceMatrix,
        reviewMode: task.workflowProfile?.reviewMode,
        // **The read taken above, handed over.** Without it the stamp re-reads the non-atomic pointer, and the refusal
        // above becomes a check-then-use: measured by corrupting the file between the two reads, the command still threw
        // after computing the judgement and before writing it.
        revisionRead: judgeRevisionRead,
    } as import('../quality/judge.js').JudgeInput);

    // **A judge FAIL records no obligation, and the reason is that it cannot be reached without a ledger.**
    //
    // The obligation existed to carry the failure across the re-seal that follows its repair, because `judgeResult ===
    // 'FAIL'` is only read while the phase is `judge` and a repair moves the phase. That is now the ledger's job: the
    // failing criterion is a claim, the evaluation that failed is that claim's evidence verdict, and `decide` re-derives
    // "unsupported" on any revision — so the failure is carried by the same store that decides everything else.
    //
    // Measured before deleting it: the only production writer of an approved review is `review --approve` (line 1499),
    // and that refuses any change without an evidence ledger. Judge refuses a review that is not approved, so it cannot
    // be run on a ledger-less change — which makes the old branch unreachable rather than merely redundant. A guard that
    // cannot fire is the class this repository has removed more often than any other; keeping it would also have kept two
    // routes to the same repair (`repair_unresolved_obligations` and `repair_failed_judge`).
    if (judgeResult.result === 'FAIL') {
        const failed = judgeResult.acceptance.filter((a) => a.result === 'FAIL');
        // The list is still reported: it is what the caller acts on, and the repair is to make the claim hold.
        reportFailedCriteria = failed.map((criterion) => criterion.id);
    }

    let judgePhase: Phase = 'judge';
    let judgeTransitionError: string | null = null;
    try {
        await guardTransition(options.guard, 'check', taskId, 'judge');
        await transition(taskId, 'judge', actorFor(judgeActor, options.platform), { root });
        await guardTransition(options.guard, 'apply', taskId, 'judge');
    } catch (error) {
        judgePhase = 'review';
        judgeTransitionError = error instanceof Error ? error.message : String(error);
    }

    const ledgerProblems = await openLedgerProblems(root, taskId);
    return {
        command: 'judge',
        taskId,
        phase: judgeResult.result === 'PASS' && judgeTransitionError === null ? 'judge' : judgePhase,
        success: judgeResult.result === 'PASS' && judgeTransitionError === null,
        ...(judgeTransitionError ? { error: `Judge transition failed: ${judgeTransitionError}` } : {}),
        diagnostics: {
            judgeResult: judgeResult.result,
            acceptanceResults: judgeResult.acceptance.map((a) => ({
                id: a.id,
                result: a.result,
                repairScope: a.repairScope,
            })),
            // Named rather than only counted, because the repair is to make *these* claims hold and the ledger is where
            // they live (`ledger claim show <id>`, `ledger decide`).
            ...(reportFailedCriteria.length > 0 ? { failedCriteria: reportFailedCriteria } : {}),
            evidenceCount: evidence.length,
            // **Absent, not zero, when the ledger could not be read.** Publishing `0` beside a separate detail string
            // was the same substitution in a new costume: a consumer reading only `openProblems` sees "no problems" for a
            // ledger that said nothing of the kind. The field is omitted instead, and the reason is what carries the fact
            // — which is exactly how the envelope already reports a check it could not run.
            ...openProblemsReportFields(ledgerProblems),
        },
    };
}

/**
 * The ledger's open problems, for the two report surfaces (`verify`, `judge`).
 *
 * **This is where a reader that cannot fail silently is read, and the three answers stay three.** A ledger with problems
 * reports them; a ledger with none reports an empty list; a ledger that cannot be read reports *that*, rather than `0`
 * problems, which would be the claim that there are none — the substitution this change exists to remove. It replaced a
 * bare `(await openLedgerProblems(...)).length`, which is also why a corrupt `claims.json` used to become a stack trace
 * on these two commands instead of a refusal.
 */
async function readTaskEvidence(root: string, taskId: string, options: CommandOptions = {}): Promise<EvidenceEnvelope[]> {
    // The recorded set, read through the shared reader. Only a genuinely absent directory falls back to collecting now.
    try {
        return await readRecordedEvidence(root, taskId);
    } catch {
        return options.checks ? await collectEvidence(taskId, options.checks) : [];
    }
}



async function readReviewRevisionId(root: string, taskId: string): Promise<string | undefined> {
    try {
        const raw = await readFile(layoutReviewPath(root, taskId), 'utf8');
        return (JSON.parse(raw) as { revisionId?: string }).revisionId;
    } catch {
        return undefined;
    }
}

/**
 * The verify step's reading of the same question the Judge answers: is each acceptance criterion evidenced? The ladder
 * is the shared one in `quality/evidence-adequacy.ts`; verify's own inputs are the unresolved repair obligations, which
 * a Judge verdict cannot know about yet.
 */
function evaluateReadiness(
    taskId: string,
    acceptance: Array<{ id?: string; statement: string }>,
    evidence: EvidenceEnvelope[],
    currentDiffHash: string,
    scopeHashes: Map<string, string>,
    matrix?: import('../core/task.js').AcceptanceMatrix,
      reviewMode?: string,
): JudgeResult {
    const adequacy = evaluateAcceptanceAdequacy({
        acceptance,
        evidence,
        currentDiffHash,
        currentScopeHashes: scopeHashes,
        ...(matrix ? { matrix } : {}),
        ...(reviewMode ? { reviewMode } : {}),
        });
    return {
        taskId,
        result: adequacy.acceptance.every((item) => item.result === 'PASS') ? 'PASS' : 'FAIL',
        diffHash: currentDiffHash,
        acceptance: adequacy.acceptance,
        evidenceIds: adequacy.evidenceIds,
    };
}

function supersededReadiness(
    taskId: string,
    acceptance: Array<{ id?: string; statement: string }>,
    currentDiffHash: string,
    revisionId: string,
): JudgeResult {
    return {
        taskId,
        result: 'FAIL',
        diffHash: currentDiffHash,
        revisionId,
        acceptance: acceptance.map((criterion) => ({
            id: criterion.id ?? '',
            result: 'FAIL' as const,
            repairScope: 'revision_superseded' as const,
        })),
    };
}

function revisionIdForEvidence(evidence: EvidenceEnvelope[]): string | undefined {
    const revisionIds = [...new Set(evidence.map((item) => item.revisionId).filter((id): id is string => Boolean(id)))];
    if (revisionIds.length > 1) throw new Error('Evidence from multiple task revisions cannot be verified together');
    return revisionIds[0];
}

async function currentScopeHashes(root: string, evidence: EvidenceEnvelope[]): Promise<Map<string, string>> {
    const { computeScopeHash } = await import('../quality/evidence.js');
    return new Map(await Promise.all(evidence
        .filter((item) => item.scope)
        .map(async (item) => [item.id, await computeScopeHash(root, item.scope?.paths ?? [])] as const)));
}


/**
 * **Which worktrees an archive may consider removing, derived from the model.**
 *
 * Extracted so the decision is testable without passing the archive trust boundary, which refuses before the cleanup
 * branch runs — a criterion driven through `runCommand('archive')` would be green whatever this returned, and the first
 * version of that test was exactly that false negative.
 *
 * The shape it replaces is `join(worktreesDir(root), taskId)`: a directory named after the task. A worktree whose
 * directory name differs from the task it holds is then never looked at, and the guard it feeds is handed the same
 * derivation for `path` and `taskId` — so the guard judges the right kind of object, just not this one.
 *
 * A model that cannot answer is **not** an empty answer here either: the archive keeps every candidate rather than
 * guessing, because a guess in this direction deletes records.
 */
export async function archiveRemovalTargets(root: string, taskId: string): Promise<string[]> {
    const { existsSync } = await import('node:fs');
    const { worktreesDir } = await import('./worktree.js');
    const { uniqueCopies } = await import('../core/layout.js');
    const named = join(worktreesDir(root), taskId);
    const holding = await uniqueCopies({ root, taskId }).catch(() => undefined);
    if (holding === undefined) {
        // Undetermined: only the named directory is even a candidate, and the guard inside the removal is what refuses.
        return [];
    }
    const fromModel = [...new Set(holding.map((copy) => copy.worktreeRelative))].map((relative) => join(root, relative));
    if (fromModel.length > 0) return fromModel;
    // Nothing is unique to a worktree, so the ordinary case applies: the worktree named after the task, if it exists.
    return existsSync(named) ? [named] : [];
}

async function cmdArchive(taskId: string, root: string, options: CommandOptions = {}): Promise<CommandResult> {
    let archivePhase: Phase = 'distill';
    let archiveError: string | undefined;
    const current = await readCurrentState(root, taskId);

    if (!options.confirmHostModel) {
        return {
            command: 'archive', taskId, phase: current.phase, success: false,
            error: 'Archive requires explicit user confirmation at the archive trust boundary.',
            diagnostics: { requiresUserConfirmation: true, trustBoundary: 'archive_gate' },
        };
    }

    // Archive is a security boundary: a forged Judge PASS must not be enough to
    // cross it. Revalidate the Review artifact before changing state so that a
    // direct write of judge.json cannot bypass the evidence-backed Review gate.
    const review = await readReview(root, taskId);
    if (review.status !== 'approved' || !review.reviewEvidence?.trim()) {
        return {
            command: 'archive', taskId, phase: current.phase, success: false,
            error: 'Archive requires an evidence-backed Review approval before a Judge result can be archived.',
        };
    }

    if (current.phase === 'judge') {
        try {
            await guardTransition(options.guard, 'check', taskId, 'distill');
            await transition(taskId, 'distill', actorFor(defaultActor, options.platform), { root });
            await guardTransition(options.guard, 'apply', taskId, 'distill');
        } catch (error) {
            return {
                command: 'archive', taskId, phase: current.phase, success: false,
                error: `Archive requires a current-revision Judge PASS before transition: ${(error as Error).message}`,
            };
        }
    } else if (current.phase !== 'distill' && current.phase !== 'archive') {
        return { command: 'archive', taskId, phase: current.phase, success: false, error: `Archive cannot run from ${current.phase}` };
    }

    // F1.4: archiving with known problems is allowed, but it is a signed act — the problems are listed, and one that has
    // not been carried anywhere is refused until it is (I2: a silent disappearance is worse than a deferral).
    //
    // **Asked of the ledger, because the ledger is where a problem is recorded now.** These two checks used to read the
    // round-shaped findings table, the falsifier ledger and the obligation store — four readers of "which problems are
    // known and unanswered", on the gate that decides whether a change may be closed. The ledger answers the same question
    // in its own vocabulary: a claim that is not supported is a problem, and a claim the author has decided to live with is
    // a **waiver**, which requires a reason by the kernel's own rule (`waived_without_reason`).
    //
    // The two capabilities are preserved rather than dropped with the old readers: a problem nobody has decided about
    // blocks the archive (the repair is to make the claim hold, or to waive it with a reason), and a waiver that has not
    // been carried anywhere needs `--findings-carried-to`, because living with a known problem is a decision someone signs.
    const { readLedger: readArchiveLedger } = await import('../store/ledger.js');
    const { unsupportedClaims: unsupportedClaimsOf } = await import('../store/verdict.js');
    const archiveLedger = await readArchiveLedger(root, taskId);
    // The same reader the ladder and the change record ask, so the gate and the diagnostics cannot disagree about which
    // claims are open — the fifth consumer of this question, and the last one assembling its own copy of the input.
    const unsupportedClaims = unsupportedClaimsOf(archiveLedger);
    if (unsupportedClaims.length > 0) {
        return {
            command: 'archive',
            taskId,
            phase: current.phase,
            success: false,
            error: `Archive blocked; ${unsupportedClaims.length} claim(s) are not supported: ${unsupportedClaims.map((claim) => claim.claimId).join(', ')}. `
                + 'Make each one hold (`kata-cli ledger evidence add`, `ledger evidence verify`), or record the decision to live with it (`kata-cli ledger claim waive <id> --reason <why>`).',
            diagnostics: { unsupportedClaims: unsupportedClaims.map((claim) => ({ id: claim.claimId, statement: claim.statement, severity: claim.severity })) },
        };
    }
    const waivedClaims = archiveLedger.claims.filter((claim) => claim.status === 'waived');
    const carriedTo = options.findingsCarriedTo;
    if (waivedClaims.length > 0 && !carriedTo) {
        return {
            command: 'archive',
            taskId,
            phase: current.phase,
            success: false,
            error: `Archive blocked; ${waivedClaims.length} waived claim(s) were not carried anywhere: ${waivedClaims.map((claim) => claim.id).join(', ')}. `
                + `Close the task with \`kata-cli archive --change ${taskId} --findings-carried-to <task-or-ticket>\` so that living with a known problem is a recorded decision.`,
            diagnostics: { waivedClaims: waivedClaims.map((claim) => ({ id: claim.id, severity: claim.severity, reason: claim.waiver?.reason ?? null })) },
        };
    }

    const distillation = await distillPassedTaskKnowledge(root, taskId);
    const wikiClosure = await evaluateWikiClosure(root, taskId);
    if (!wikiClosure.valid) {
        const latest = await readCurrentState(root, taskId);
        return {
            command: 'archive',
            taskId,
            phase: latest.phase,
            success: false,
            error: `Archive blocked; complete Wiki closure (${wikiClosure.reason}).`,
            diagnostics: { wikiClosure, distillation },
        };
    }

    const taskRaw = await readFile(taskPath(root, taskId), 'utf8');
    const task = JSON.parse(taskRaw) as {
        title: string;
        acceptance: Array<{ id?: string; statement: string }>;
    };

    let judgeRaw: string | null = null;
    try {
        judgeRaw = await readFile(judgePath(root, taskId), 'utf8');
    } catch { /* judge result may not exist yet */ }

    let reviewRaw: string | null = null;
    try {
        reviewRaw = await readFile(layoutReviewPath(root, taskId), 'utf8');
    } catch { /* review may not exist yet */ }

    let evidenceIds: string[] = [];
    try {
        const { readdir } = await import('node:fs/promises');
        const files = await readdir(evidenceDir(root));
        evidenceIds = files.filter((f) => f.startsWith(`${taskId}-`));
    } catch { /* no evidence yet */ }

    try {
        await guardTransition(options.guard, 'check', taskId, 'archive');
        await transition(taskId, 'archive', actorFor(defaultActor, options.platform), { root });
        await guardTransition(options.guard, 'apply', taskId, 'archive');
        archivePhase = 'archive';
    } catch (error) {
        archivePhase = 'distill';
        // **The reason travels with the outcome.** This was an empty `catch` that set the phase and dropped the error, so a
        // caller received a structurally valid result at `distill` with no way to learn that the archive transition had
        // been refused: "the transition was refused" and "the task was already at distill" were the same answer.
        archiveError = (error as Error).message;
    }

    let codegraphRefresh: { ok: boolean; output?: string } | undefined;
    if (archivePhase === 'archive') {
        // The shared invocation: same binary resolution, environment and working directory as every other CodeGraph
        // call. This one used to pass neither the environment fix nor the workspace root.
        const { stat } = await import('node:fs/promises');
        const indexExists = await stat(join(root, '.codegraph/index.db')).then(() => true).catch(() => false);
        if (!indexExists) {
            codegraphRefresh = { ok: false, output: 'CodeGraph not initialized; skip index refresh.' };
        } else {
            const invocation = codeGraphInvocation(root);
            const refresh = await runProcess(invocation.command, ['index'], {
                cwd: invocation.cwd, env: invocation.env, timeoutMs: 30_000,
            });
            codegraphRefresh = refresh.ok
                ? { ok: true, output: refresh.stdout.trim() }
                : { ok: false, output: refresh.stderr.trim() || `codegraph index exited ${refresh.exitCode}` };
        }
    }

    // **A change's isolation ends where the change ends.** `kata-cli worktree create` puts a linked checkout under
    // `.kata/worktrees/<taskId>` and *nothing* ever removed one: not the seal, not the archive, not the ladder. Measured
    // on this repository, three archived changes had left three of them behind (38 MB of stale checkout), and they are not
    // inert — a stale worktree is a second copy of the source that every content scan walks, that `git worktree list`
    // reports, and that the earlier audits kept reading as current code. A dirty worktree is reported rather than deleted,
    // because removing a checkout with uncommitted work is the one outcome worse than leaving it.
    let worktreeCleanup: { removed?: string; kept?: string; reason?: string; worktreeOnlyRecords?: string[] } | undefined;
    try {
        const { existsSync } = await import('node:fs');
        const { worktreesDir, removeWorktreeSafely } = await import('./worktree.js');
        // **The worktrees the model says hold this task's only copy, not the one whose directory is named after it.**
        // The selector used to be `join(worktreesDir(root), taskId)`, so a worktree whose directory name differs from
        // the task it holds was never looked at — and it then passed the same derivation for `path` and `taskId`, so the
        // guard judged the right kind of object, just not this one. Measured on the frozen revision restored with
        // `git archive`: the removal returned `{"removed":true}` and the only copy was gone.
        const targets = await archiveRemovalTargets(root, taskId);
        for (const linked of targets) {
        if (archivePhase === 'archive' && existsSync(linked)) {
            try {
                // No `force`: a worktree with uncommitted work must not be destroyed by an archive, and git refuses it
                // for exactly that reason. The refusal is reported as `kept`, with git's own explanation.
                //
                // **And a worktree that holds the only copy of this change's records is not removed at all.** Task state is
                // written under whichever root resolved, so `.kata/worktrees/<taskId>` can be the only place the review, the
                // judge verdict and the change records exist — measured on this repository, four merged changes have 129 such
                // files, and this branch is what deletes them. The guard is inside the removal so no route reaches the
                // deletion without passing it; the refusal names the files, because the operator has to move them by hand.
                const removal = await removeWorktreeSafely({ root, path: linked, taskId });
                if (removal.refusedBecause === 'worktree-only-records') {
                    worktreeCleanup = {
                        kept: linked,
                        reason: `it holds the only copy of ${removal.worktreeOnlyRecords?.length ?? 0} governed record(s) for this change`,
                        worktreeOnlyRecords: removal.worktreeOnlyRecords ?? [],
                    };
                } else {
                    worktreeCleanup = removal.removed ? { removed: linked } : { kept: linked, reason: 'not removed' };
                }
            } catch (error) {
                worktreeCleanup = { kept: linked, reason: (error as Error).message };
            }
        }
        }
    } catch (error) {
        worktreeCleanup = { kept: join(root, '.kata/worktrees', taskId), reason: (error as Error).message };
    }

    return {
        command: 'archive',
        taskId,
        phase: archivePhase,
        success: archivePhase === 'archive',
        // **The refusal reason travels with the outcome.** This was an empty `catch` that set the phase and dropped the
        // error, so a caller received a structurally valid result at `distill` and no way to learn that the archive
        // transition had been refused — "the transition was refused" and "the task was already at distill" were one answer.
        ...(archiveError === undefined ? {} : { error: archiveError }),
        diagnostics: {
            taskTitle: task.title,
            acceptanceCount: task.acceptance.length,
            acceptance: task.acceptance.map((a) => ({ id: a.id, statement: a.statement })),
            evidenceFiles: evidenceIds,
            hasJudgeResult: judgeRaw !== null,
            hasReviewResult: reviewRaw !== null,
            distillation,
            distillationHint: 'Read task artifacts, acceptance criteria, review findings, and judge result. Synthesize decisions, constraints, and norms into a wiki record via proposeFromPassedTask() or kata-cli wiki ingest.',
            ...(worktreeCleanup ? { worktreeCleanup } : {}),
            ...(codegraphRefresh ? { codegraphRefresh } : {}),
        },
    };
}

async function cmdHotfix(
    taskId: string,
    root: string,
    options: CommandOptions,
): Promise<CommandResult> {
    const openResult = await cmdOpen(taskId, root, {
        title: options.title ?? `Hotfix ${taskId}`,
        acceptance: options.acceptance ?? [{ id: 'AC-1', statement: 'Fix is correct.' }],
        guard: options.guard,
        workflowProfile: options.workflowProfile,
        // **The declared contract travels with the aggregate.** Without this the caller's `--bootstrap-file` was read,
        // validated, and then dropped here: the task was created from the placeholder criterion with no matrix, and
        // `design` refused it while the file that would have satisfied it sat unused.
        ...(options.bootstrap ? { bootstrap: options.bootstrap } : {}),
    });
    if (!openResult.success) return openResult;

    const designResult = await cmdDesign(taskId, root, options);
    if (!designResult.success) return designResult;

    const buildResult = await cmdBuild(taskId, root, options);
    if (!buildResult.success) return buildResult;

    return buildResult;
}

async function cmdTweak(
    taskId: string,
    root: string,
    options: CommandOptions,
): Promise<CommandResult> {
    const openResult = await cmdOpen(taskId, root, {
        title: options.title ?? `Tweak ${taskId}`,
        acceptance: options.acceptance ?? [{ id: 'AC-1', statement: 'Tweak is correct.' }],
        guard: options.guard,
        workflowProfile: options.workflowProfile,
        ...(options.bootstrap ? { bootstrap: options.bootstrap } : {}),
    });
    if (!openResult.success) return openResult;

    await cmdDesign(taskId, root, options);
    const buildResult = await cmdBuild(taskId, root, options);
    if (!buildResult.success) return buildResult;

    return buildResult;
}
