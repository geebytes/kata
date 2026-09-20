import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTask, type CreateTaskInput } from '../core/task.js';
import { readCurrentState, appendStateEvent, transition, transitionForRepair, withTaskLock, writeCurrentState, type Phase, type Actor } from '../core/state.js';
import { buildContextManifest, type ContextManifest } from '../core/context.js';
import { checkFreshness, collectEvidence, computeDiffHash, isPassing, readRecordedEvidence, type CheckCommand, type EvidenceEnvelope } from '../quality/evidence.js';
import { planCheckReuse, type CheckReusePlan } from '../quality/check-reuse.js';
import { findMatrixDeclarationGaps } from '../quality/acceptance-matrix.js';
import { type ReviewFinding } from '../quality/reviewer.js';
import { judge, type JudgeAcceptanceResult, type JudgeResult } from '../quality/judge.js';
import { createHandoff } from './handoff.js';
import { CometGuard } from '../comet/guard.js';
import { assertValidAcceptanceId, assertValidTaskId, requirementIdPattern } from '../core/ids.js';
import { loadConfig } from '../core/config.js';
import { resolveBuildChecks } from '../quality/project-checks.js';
import { describeClaimFailure, evaluateClaims, resolveClaimChecks, validateClaims } from '../quality/claims.js';
import { collectSealPreflight } from './seal-preflight.js';
import { bindsToRevision, currentRevisionIdentity, revisionBindingFields } from './verdict-binding.js';
import { matrixChecks, dedupeChecks as dedupeCheckCommands, sanitizeCheckName } from '../quality/check-resolver.js';
import { acknowledgeCometOpen, defaultWorkflowProfile, isWorkflowProfile, type WorkflowProfile } from '../core/workflow-profile.js';
import { ensureWikiClosure, evaluateWikiClosure, wikiClosureRemedy } from '../wiki/closure.js';
import { distillPassedTaskKnowledge } from '../wiki/provenance.js';
import { nextActionForTask, readUpstreamSummary, suggestCandidateAction } from './navigation.js';
import { computeManifestHash, createTaskRevisionIfChanged, findOwnershipConflicts, inferOwnedPathsFromWorkspace, readCurrentTaskRevision, readTaskRevision, revisionStatus, workspaceDrift } from './revision.js';
import { classifyCodeGraphCandidates, discoverCodeGraphCandidates, readWaivers, validateMatrix, validatePathCoverage, validateUpstreamCoverage, findRequirementsWithoutEvidence, findOrphanAcs, validateWaivers, writeWaivers, requiresMatrix, requiresUpstreamCoverage, getMatrixRowForAc, acceptanceIdsByCheckId, evidenceMatchesRow, isEntrypointEvidenceKind, type CodeGraphCandidate, type CodeGraphCandidateDisposition, type Waiver } from '../quality/acceptance-matrix.js';
import { outOfScopeRepairPaths, repairScopePaths, type RepairReason, type RepairRecordShape } from '../quality/repair.js';
import { authorizeRepair } from './repair-entry.js';
import { isRepairableScope, repairableJudgeScopes, repairableVerifyScopes, type RepairScope } from '../quality/judge.js';
import { evaluateAcceptanceAdequacy } from '../quality/evidence-adequacy.js';
import { adversarialGateFor, adversarialNodes, adversarialReasonFor, blockingAdversarialFindings, requiredAdversarialNodes } from '../quality/adversarial.js';
import { readReview } from './review-read.js';
import { codeGraphInvocation } from '../codegraph/runtime.js';
import { runProcess } from '../process/run.js';
import { readValidated, readValidatedOptional, validate } from '../core/schema.js';
import { ensureWorkspaceHygiene } from '../core/layout.js';
import { readTask } from '../core/task.js';
import { readObligations, hasUnresolvedObligations, persistBlockingFindings, persistBlockingJudgeResult, resolveObligationsForRevision } from '../quality/repair-obligations.js';
import type { CheckProgressEvent } from '../quality/evidence.js';
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
    acceptance?: Array<{ id?: string; statement: string }>;
    requirements?: Array<{ id?: string; statement: string; source?: string }>;
    checks?: CheckCommand[];
    guard?: CometGuard;
    platform?: string;
    seal?: boolean;
    approve?: boolean;
    reviewEvidence?: string;
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
    const acceptance = options.acceptance?.length
        ? options.acceptance
        : requirements.length > 0
            ? requirements.map((r, i) => ({ id: `AC-${i + 1}`, statement: r.statement }))
            : [{ id: 'AC-1', statement: 'Implement the change successfully.' }];
    const input: CreateTaskInput = {
        root,
        id: taskId,
        title: options.title ?? (requirements[0]?.statement.slice(0, 80) ?? `Change ${taskId}`),
        acceptance,
        workflowProfile: options.workflowProfile ?? defaultWorkflowProfile(),
        ...(requirements.length > 0 ? { requirements: requirements.map((r, i) => ({ id: r.id ?? `REQ-${i + 1}`, statement: r.statement, ...(r.source ? { source: r.source } : {}), confirmedAt: new Date().toISOString() })) } : {}),
        ...(options.ownedPaths?.length ? { ownedPaths: options.ownedPaths } : {}),
    };

    const task = await createTask(input);
    let context: ContextManifest;
    try {
        context = await buildContextManifest({ root, taskId, sourceRefs: [] });
    } catch {
        context = { taskId, sourceRefs: [], authoritativeWiki: [], excludedWiki: [], excludedWikiSummary: { relevant: [], unrelated: { count: 0, byReason: {} } }, warnings: [] };
    }

    const ownershipConflicts = options.ownedPaths?.length
        ? await findOwnershipConflicts(root, taskId, options.ownedPaths)
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
async function sealProgressWriter(
    root: string,
    taskId: string,
): Promise<((event: CheckProgressEvent) => void) & { finish: () => Promise<void> }> {
    const { appendFile, mkdir } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    const { sealProgressPath } = await import('../core/layout.js');
    const path = sealProgressPath(root, taskId);
    const startedAt = new Map<string, number>();
    const write = async (line: Record<string, unknown>): Promise<void> => {
        try {
            await mkdir(dirname(path), { recursive: true });
            await appendFile(path, `${JSON.stringify(line)}\n`, 'utf8');
        } catch {
            // Observation only: never let the log decide the seal.
        }
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
    } else if (current.phase === 'hardVerify') {
        await reenterImplementForRepairEntry('hardVerify', taskId, root, actorFor(defaultActor, options.platform));
    } else if (current.phase === 'review') {
        await reenterImplementForRepairEntry('review', taskId, root, actorFor(defaultActor, options.platform));
        enteredRepairAwaitingSeal = true;
    } else if (current.phase === 'judge') {
        await reenterImplementForRepairEntry('judge', taskId, root, actorFor(defaultActor, options.platform));
        enteredRepairAwaitingSeal = true;
    } else if (current.phase !== 'implement') {
        throw new Error(`Build cannot run from ${current.phase}`);
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

    const sealed = ownedPaths.length
        ? await createTaskRevisionIfChanged({
            root,
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
    const evidence = await collectEvidence(taskId, checksToRun, {
        ...(revision ? { revision } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.frozen === true ? { includeFrozen: true } : {}),
        acceptanceByCheckId: acceptanceIdsByCheckId(task.acceptanceMatrix),
        // L4-02: the bounded capture drops the middle of a noisy check's output, so give it a place to write the whole
        // thing. The envelope keeps the reference and the bounded excerpt; a reader who needs the transcript reads the
        // file instead of finding a truncated log and no way to tell.
        checkLogDir: evidenceDir(root),
        onProgress: (event) => {
            progress(event);
            options.onProgress?.(event);
        },
    });
    await progress.finish();
    await writeEvidence(root, taskId, evidence);
    // C3: what the claims did, against the evidence just collected. A claim whose evidence is absent counts as failed —
    // the sentence declared itself checkable, and nothing checked it.
    const claimSummary = evaluateClaims(task.acceptance ?? [], evidence);
    // C1: a successful seal is what ends a repair batch — its contract is one seal and one delta round per node per batch.
    // The base revision was stamped when the batch opened, so nothing here supplies one.
    if (evidence.every(isPassing)) {
        const { closeBatchAfterSeal } = await import('../quality/repair-batch.js');
        await closeBatchAfterSeal(root, taskId).catch(() => null);
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

    if (revision && task.acceptanceMatrix) {
        const acIds = task.acceptanceMatrix.rows.map((r) => r.acceptanceId);
        await resolveObligationsForRevision(
            root, taskId, revision.id, acIds,
            evidence.filter((e) => isPassing(e)).map((e) => e.id),
            task.acceptanceMatrix,
            evidence,
        );
    }
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
    const matrixDerivedChecks = !options.checks?.length && task.acceptanceMatrix ? matrixChecks(root, task.acceptanceMatrix) : [];
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
    if (task.ownedPaths?.length) {
        const cliPaths = options.ownedPaths?.length ? options.ownedPaths : [];
        const merged = cliPaths.length
            ? [...new Set([...task.ownedPaths, ...cliPaths])].sort()
            : task.ownedPaths;
        if (merged.length > task.ownedPaths.length) {
            await persistTaskOwnedPaths(root, taskId, task, merged);
        }
        return merged;
    }
    if (!options.ownedPaths?.length) {
        throw new Error('seal requires at least one --owned-path when the task has no ownedPaths');
    }
    const ownedPaths = [...new Set(options.ownedPaths)].sort();
    await persistTaskOwnedPaths(root, taskId, task, ownedPaths);
    return ownedPaths;
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
async function writeEvidence(root: string, taskId: string, evidence: EvidenceEnvelope[]): Promise<void> {
    const evidenceDirectory = evidenceDir(root);
    await mkdir(evidenceDirectory, { recursive: true });

    const { readdir, rename } = await import('node:fs/promises');
    try {
        const files = (await readdir(evidenceDirectory)).filter((file) => file.startsWith(`${taskId}-`) && file.endsWith('.json'));
        if (files.length > 0) {
            // The revision the outgoing set was collected for, read from the envelope rather than guessed.
            const previous = JSON.parse(await readFile(join(evidenceDirectory, files[0]!), 'utf8')) as { revisionId?: string };
            const archiveDir = join(evidenceDirectory, 'superseded', previous.revisionId ?? 'unsealed');
            await mkdir(archiveDir, { recursive: true });
            for (const file of files) {
                await rename(join(evidenceDirectory, file), join(archiveDir, file)).catch(() => { });
            }
        }
    } catch { }

    for (const envelope of evidence) {
        await writeFile(
            join(evidenceDirectory, `${taskId}-${evidenceFileSuffix(envelope)}.json`),
            `${JSON.stringify(envelope, null, 2)}\n`,
            'utf8',
        );
    }
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
    const repair = await readValidated<RepairRecordShape>('repair', repairRecordPath);
    await writeFile(repairRecordPath, `${JSON.stringify({
        ...repair,
        resolvedAt: new Date().toISOString(),
        resolvedRevisionId: revisionId,
    }, null, 2)}\n`, 'utf8');
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
): Promise<void> {
    const authorization = await authorizeRepair(entryPhase, root, taskId);
    if (!authorization.authorized) {
        throw new Error(authorization.denial ?? `Build cannot re-enter implementation from ${entryPhase}`);
    }
    await transitionForRepair({ taskId, actor, entryPhase, repair: authorization.repair, root });
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
    revision: { id: string; pathDigests?: Record<string, string> } | null,
    options: CommandOptions,
): Promise<{ checks?: CheckCommand[]; derivation?: Record<string, unknown> }> {
    // Only a re-seal can be narrowed: the first seal has nothing to compare against, and the freeze points must see
    // everything regardless.
    if (options.frozen === true || options.fullChecks === true) return {};
    const { readCurrentTaskRevision } = await import('./revision.js');
    const previous = revision ? null : await readCurrentTaskRevision(root, taskId).catch(() => null);
    const base = revision ?? previous;
    if (!base?.pathDigests) return {};
    const { changeSurfaceAgainstWorkspace } = await import('../quality/revision-delta.js');
    const surface = await changeSurfaceAgainstWorkspace(root, base as never);
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
    const ignoredReviewFindings = revisionId && !bindsToRevision(review, await currentRevisionIdentity(root, taskId)) ? review.findings.length : 0;
    const findings = ignoredReviewFindings > 0 ? [] : review.findings;
    const revision = revisionId ? await readTaskRevision(root, taskId, revisionId) : undefined;
    const status = revision ? await revisionStatus(root, revision) : undefined;
    const drift = revision ? await workspaceDrift(root, revision.ownedPaths) : [];
    const obligations = await readObligations(root, taskId);
    const unresolvedObligations = obligations.filter((o) => !o.resolvedAt);
    const matrix = task.acceptanceMatrix;
    // F1.4: what has already been decided about this task's findings is printed here, so "known and deferred" is visible
    // at the node that concludes the implementation. It changes nothing about the gates: severity decides those (I1).
    const { deferredFindings: deferred, readTrackedFindings } = await import('../quality/finding-disposition.js');
    const deferredForDiagnostics = deferred(await readTrackedFindings(root, taskId));
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
    const verifyResult = status?.status === 'superseded'
        ? supersededReadiness(taskId, task.acceptance, currentDiffHash, revision!.id)
        : evaluateReadiness(taskId, task.acceptance, evidence, findings, currentDiffHash, scopeHashes, matrix, unresolvedObligations, task.workflowProfile?.reviewMode);
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
    const verifyBinding = await currentRevisionIdentity(root, taskId);
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

    // The verify node does not conclude on the author's own reading of the evidence: an independent adversarial pass
    // over this revision has to have been recorded (or explicitly waived). This gate runs only when everything else
    // passed — a failing verification is repaired first, and the adversarial pass attacks the revision that survives.
    // L2-03: Verify answers a deterministic question — is the evidence current, complete and attributable — and Review is
    // the independent look. `strict`/`security` buy Verify's pass back, so the assurance level is a profile choice.
    const reviewMode = task.workflowProfile?.reviewMode;
    const requiredNodes = requiredAdversarialNodes({ ...(reviewMode ? { reviewMode } : {}) });
    const verifyNodeRequired = requiredNodes.includes('verify');
    const adversarial = verifyNodeRequired && verifyResult.result === 'PASS' && implementationReady
        ? await adversarialGateFor(root, taskId, 'verify')
        : null;
    // A strict matrix declaration gap is reported, not blocked: a task sealed before strict rows required declared check
    // ids must keep verifying, or the rule would retroactively invalidate every binding it holds.
    const matrixGaps = findMatrixDeclarationGaps(task.acceptanceMatrix, reviewMode === 'strict');
    if (matrixGaps.length > 0) {
        const { writeAcceptanceMatrixMigration } = await import('../core/task.js');
        await writeAcceptanceMatrixMigration(root, taskId, {
            gapCount: matrixGaps.length,
            acceptanceIds: [...new Set(matrixGaps.map((gap) => gap.acceptanceId))].sort(),
        }).catch(() => null);
    }
    if (adversarial && !adversarial.satisfied) {
        return {
            command: 'verify',
            taskId,
            phase: current.phase,
            success: false,
            error: `Verify is held by the independent adversarial pass: ${adversarialReasonFor(adversarial.reason)}`,
            diagnostics: {
                verifyResult: verifyResult.result,
                acceptanceResults: verifyResult.acceptance.map((a) => ({ id: a.id, result: a.result, repairScope: a.repairScope })),
                evidenceCount: evidence.length,
                implementationReady,
                governanceReady: wikiClosure.valid,
                adversarial: { node: 'verify', required: true, satisfied: false, reason: adversarial.reason ?? null },
                adversarialNodesRequired: requiredNodes,
                adversarialNodesNotRequired: adversarialNodes
                    .filter((node) => !requiredNodes.includes(node))
                    .map((node) => ({ node, reason: 'not_required' })),
                ...(matrixGaps.length > 0 ? { acceptanceMatrixDeclarationGaps: matrixGaps } : {}),
                ...(deferredForDiagnostics.length > 0 ? { deferredFindings: deferredForDiagnostics } : {}),
                nextAction: nextActionForTask(taskId, '/kata-verify', 'reviewer', 'adversarial_verify_pending'),
            },
        };
    }
    const adversarialFindings = adversarial?.satisfied ? blockingAdversarialFindings(adversarial.record ?? null) : [];
    if (adversarialFindings.length > 0) {
        // C1: same producer, on the verify node.
        const { recordFindingsForBatching } = await import('../quality/repair-batch.js');
        await recordFindingsForBatching(
            root,
            taskId,
            adversarialFindings.map((finding) => ({ id: finding.id, severity: finding.severity, message: finding.message })),
            'adversarial-verify',
        ).catch(() => null);
        return {
            command: 'verify',
            taskId,
            phase: current.phase,
            success: false,
            error: `The independent adversarial pass confirmed ${adversarialFindings.length} defect(s) at blocking or major severity; repair them before review/judge.`,
            diagnostics: {
                verifyResult: verifyResult.result,
                evidenceCount: evidence.length,
                implementationReady,
                adversarial: {
                    node: 'verify',
                    required: true,
                    satisfied: true,
                    findings: adversarialFindings.map((finding) => ({ id: finding.id, severity: finding.severity, message: finding.message, path: finding.path })),
                },
                ...(deferredForDiagnostics.length > 0 ? { deferredFindings: deferredForDiagnostics } : {}),
                nextAction: nextActionForTask(taskId, '/kata-build', 'implementer', 'repair_blocking_review_findings'),
            },
        };
    }

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
            findingCount: findings.length,
            blockingFindings: findings.filter((f) => f.severity === 'blocking').length,
            implementationReady,
            governanceReady: wikiClosure.valid,
            ...(adversarial?.satisfied ? { adversarial: { node: 'verify', required: true, satisfied: true, waived: adversarial.reason === 'waived' } } : {}),
            adversarialNodesRequired: requiredNodes,
            adversarialNodesNotRequired: adversarialNodes
                .filter((node) => !requiredNodes.includes(node))
                .map((node) => ({ node, reason: 'not_required' })),
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
            ...(unresolvedObligations.length > 0 ? { unresolvedObligations: unresolvedObligations.length } : {}),
            ...(revisionId ? { revisionId } : {}),
            ...(status ? { revisionStatus: status.status } : {}),
            ...(revision ? { workspaceDrift: drift } : {}),
            ...(ignoredReviewFindings > 0 ? {
                ignoredReviewFindings,
                ignoredReviewRevisionId: review.revisionId ?? null,
            } : {}),
            nextAction,
        },
    };
}

async function cmdReview(taskId: string, root: string, options: CommandOptions = {}): Promise<CommandResult> {
    try {
        const isApprove = options.approve === true;
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
            // An approval is the review's conclusion, so the independent adversarial pass belongs here: the reviewer
            // may not certify a change their own context authored and read.
            const adversarial = await adversarialGateFor(root, taskId, 'review');
            if (!adversarial.satisfied) {
                return {
                    command: 'review', taskId, phase: 'review', success: false,
                    error: `Review approval is held by the independent adversarial pass: ${adversarialReasonFor(adversarial.reason)}`,
                    diagnostics: {
                        adversarial: { node: 'review', required: true, satisfied: false, reason: adversarial.reason ?? null },
                        nextAction: nextActionForTask(taskId, '/kata-review', 'reviewer', 'adversarial_review_pending'),
                    },
                };
            }
            const adversarialFindings = blockingAdversarialFindings(adversarial.record ?? null);
            if (adversarialFindings.length > 0) {
                // C1: findings that gate a node belong to a repair batch, opened when they are recorded (not when they are
                // repaired) — which is what lets C4 narrow the round after the batch closes.
                const { recordFindingsForBatching } = await import('../quality/repair-batch.js');
                await recordFindingsForBatching(
                    root,
                    taskId,
                    adversarialFindings.map((finding) => ({ id: finding.id, severity: finding.severity, message: finding.message })),
                    'adversarial-review',
                ).catch(() => null);
                return {
                    command: 'review', taskId, phase: 'review', success: false,
                    error: `The independent adversarial pass confirmed ${adversarialFindings.length} defect(s) at blocking or major severity; resolve them before approving.`,
                    diagnostics: {
                        adversarial: {
                            node: 'review',
                            required: true,
                            satisfied: true,
                            findings: adversarialFindings.map((finding) => ({ id: finding.id, severity: finding.severity, message: finding.message, path: finding.path })),
                        },
                        nextAction: nextActionForTask(taskId, '/kata-build', 'implementer', 'repair_blocking_review_findings'),
                    },
                };
            }
            const { suggestedReviewedPaths } = await import('../quality/review-scope.js');
            const approvalTask = await readTask(root, taskId);
            const reviewPath = layoutReviewPath(root, taskId);
            const revisionId = revisionIdForEvidence(await readTaskEvidence(root, taskId, options));
            const existing = await readReview(root, taskId);
            const approveBinding = await currentRevisionIdentity(root, taskId);
            if (revisionId && !bindsToRevision(existing, approveBinding)) {
                return {
                    command: 'review', taskId, phase: 'review', success: false,
                    error: 'Review approval requires findings recorded for the same sealed revision (or the same content) as current evidence. Re-run /kata-review before approving.',
                };
            }
            if (existing.findings.some((f) => f.severity === 'blocking' || f.severity === 'major')) {
                return {
                    command: 'review', taskId, phase: 'review', success: false,
                    error: 'Cannot approve review with blocking or major findings; resolve findings first.',
                };
            }
            // F5: the reviewer may state which paths they read; absent, the review is read as covering the whole revision
            // (the conservative direction). When none was stated, the matrix's suggestion is *offered* in the result
            // rather than written behind the reviewer's back — the design's F5 rests on their honesty, not on kata's.
            const reviewedPaths = options.reviewedPaths?.length ? options.reviewedPaths : undefined;
            const suggestion = reviewedPaths
                ? []
                : suggestedReviewedPaths(
                    approvalTask.acceptanceMatrix,
                    existing.findings.map((finding) => finding.acceptanceId).filter((id): id is string => Boolean(id)),
                );
            await writeFile(reviewPath, `${JSON.stringify({ ...(revisionId ? { revisionId } : {}), ...revisionBindingFields(approveBinding), ...(reviewedPaths ? { reviewedPaths } : {}), findings: existing.findings, status: 'approved', reviewEvidence, approvedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
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
        try {
            const previous = JSON.parse(await readFile(reviewRecordPath, 'utf8')) as {
                revisionId?: string;
                findings?: ReviewFinding[];
                status?: string;
            };
            const recordBinding = await currentRevisionIdentity(root, taskId);
            if (revisionId && !bindsToRevision(previous, recordBinding)) {
                if (previous.findings?.length) {
                    const historyPath = join(taskDir(root, taskId), 'review-history.jsonl');
                    const historyEntry = JSON.stringify({
                        revisionId: previous.revisionId,
                        findings: previous.findings,
                        status: previous.status ?? 'pending',
                        archivedAt: new Date().toISOString(),
                    }) + '\n';
                    await appendFile(historyPath, historyEntry, 'utf8');
                }
                await writeFile(reviewRecordPath, `${JSON.stringify({ revisionId, findings: [], status: 'pending' }, null, 2)}\n`, 'utf8');
            } else if ((previous.findings ?? []).length === 0) {
                await writeFile(reviewRecordPath, `${JSON.stringify({ ...(revisionId ? { revisionId } : {}), findings: [], status: 'pending' }, null, 2)}\n`, 'utf8');
            }
        } catch {
            await writeFile(reviewRecordPath, `${JSON.stringify({ ...(revisionId ? { revisionId } : {}), findings: [], status: 'pending' }, null, 2)}\n`, 'utf8');
        }
        return { command: 'review', taskId, phase: state.phase, success: true, diagnostics: { role: 'reviewer', ...(revisionId ? { revisionId } : {}) } };
    } catch (error) { return { command: 'review', taskId, phase: 'hardVerify', success: false, error: `Review transition failed: ${(error as Error).message}` }; }
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
    const findings = review.findings;
    const evidenceRevisionId = revisionIdForEvidence(evidence);
    const reviewRevisionId = await readReviewRevisionId(root, taskId);
    if (evidenceRevisionId && reviewRevisionId !== evidenceRevisionId) {
        return {
            command: 'judge', taskId, phase: 'review', success: false,
            error: 'Judge requires review findings bound to the same sealed revision as evidence. Re-run /kata-review for the current revision.',
            diagnostics: { revisionId: evidenceRevisionId, reviewRevisionId: reviewRevisionId ?? null, repairScope: 'cross_revision_review' },
        };
    }
    const scopeHashes = await currentScopeHashes(root, evidence);
    const obligations = await readObligations(root, taskId);
    const judgeResult = await judge({
        root,
        taskId,
        acceptance: task.acceptance,
        evidence,
        findings,
        currentDiffHash,
        currentScopeHashes: scopeHashes,
        matrix: task.acceptanceMatrix,
        reviewMode: task.workflowProfile?.reviewMode,
    } as import('../quality/judge.js').JudgeInput);

    if (judgeResult.result === 'FAIL') {
        const failed = judgeResult.acceptance.filter((a) => a.result === 'FAIL');
        await persistBlockingJudgeResult(root, taskId, failed.map((a) => ({ id: a.id, result: a.result })));
        // C1: a Judge FAIL gates the node for the same reason a blocking finding does, and it belongs to the same batch.
        const { recordFindingsForBatching } = await import('../quality/repair-batch.js');
        await recordFindingsForBatching(
            root,
            taskId,
            failed.map((criterion) => ({
                id: `judge-fail-${criterion.id}`,
                severity: 'blocking',
                message: `Judge FAIL on ${criterion.id}`,
                acceptanceId: criterion.id,
            })),
            'judge',
        ).catch(() => null);
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
            evidenceCount: evidence.length,
            findingCount: findings.length,
            blockingFindings: findings.filter((f) => f.severity === 'blocking').length,
        },
    };
}

async function readTaskEvidence(root: string, taskId: string, options: CommandOptions = {}): Promise<EvidenceEnvelope[]> {
    // The recorded set, read through the shared reader. Only a genuinely absent directory falls back to collecting now.
    try {
        return await readRecordedEvidence(root, taskId);
    } catch {
        return options.checks ? await collectEvidence(taskId, options.checks) : [];
    }
}

async function readReviewFindings(root: string, taskId: string): Promise<ReviewFinding[]> {
    return (await readReview(root, taskId)).findings;
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
    findings: ReviewFinding[],
    currentDiffHash: string,
    scopeHashes: Map<string, string>,
    matrix?: import('../core/task.js').AcceptanceMatrix,
    unresolvedObligations: Array<{ acceptanceId?: string; id: string; message: string }> = [],
    reviewMode?: string,
): JudgeResult {
    const adequacy = evaluateAcceptanceAdequacy({
        acceptance,
        evidence,
        findings,
        currentDiffHash,
        currentScopeHashes: scopeHashes,
        ...(matrix ? { matrix } : {}),
        ...(reviewMode ? { reviewMode } : {}),
        unresolvedObligations,
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


async function cmdArchive(taskId: string, root: string, options: CommandOptions = {}): Promise<CommandResult> {
    let archivePhase: Phase = 'distill';
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

    // F1.4: archiving with known problems is allowed, but it is a signed act — the findings are listed, and a deferral
    // that has not been carried anywhere is refused until it is (I2: a silent disappearance is worse than a deferral).
    const { readTrackedFindings: readFindings, unfixed: unfixedFindings } = await import('../quality/finding-disposition.js');
    const tracked = await readFindings(root, taskId);
    const stillUnfixed = unfixedFindings(tracked);
    const openBlocking = stillUnfixed.filter((finding) => finding.disposition === 'open'
        && (finding.severity === 'blocking' || finding.severity === 'major'));
    if (openBlocking.length > 0) {
        return {
            command: 'archive',
            taskId,
            phase: current.phase,
            success: false,
            error: `Archive blocked; ${openBlocking.length} unfixed blocking/major finding(s) remain: ${openBlocking.map((finding) => finding.id).join(', ')}. Repair them, or record evidence that they do not hold.`,
            diagnostics: { openFindings: openBlocking.map((finding) => ({ id: finding.id, severity: finding.severity, message: finding.message, source: finding.source })) },
        };
    }
    const carriedTo = options.findingsCarriedTo;
    const deferredUncarried = stillUnfixed.filter((finding) => finding.disposition === 'deferred' || finding.disposition === 'accepted');
    if (deferredUncarried.length > 0 && !carriedTo) {
        return {
            command: 'archive',
            taskId,
            phase: current.phase,
            success: false,
            error: `Archive blocked; ${deferredUncarried.length} known finding(s) were not carried anywhere: ${deferredUncarried.map((finding) => finding.id).join(', ')}. Close the task with \`kata-cli findings carry --change ${taskId} --to <task-or-ticket>\` (or with --findings-carried-to) so that living with a known problem is a recorded decision.`,
            diagnostics: { deferredFindings: deferredUncarried.map((finding) => ({ id: finding.id, severity: finding.severity, disposition: finding.disposition, message: finding.message, source: finding.source })) },
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
    } catch {
        archivePhase = 'distill';
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

    return {
        command: 'archive',
        taskId,
        phase: archivePhase,
        success: archivePhase === 'archive',
        diagnostics: {
            taskTitle: task.title,
            acceptanceCount: task.acceptance.length,
            acceptance: task.acceptance.map((a) => ({ id: a.id, statement: a.statement })),
            evidenceFiles: evidenceIds,
            hasJudgeResult: judgeRaw !== null,
            hasReviewResult: reviewRaw !== null,
            distillation,
            distillationHint: 'Read task artifacts, acceptance criteria, review findings, and judge result. Synthesize decisions, constraints, and norms into a wiki record via proposeFromPassedTask() or kata-cli wiki ingest.',
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
    });
    if (!openResult.success) return openResult;

    await cmdDesign(taskId, root, options);
    const buildResult = await cmdBuild(taskId, root, options);
    if (!buildResult.success) return buildResult;

    return buildResult;
}
