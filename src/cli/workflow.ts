import { readdir, readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../core/config.js';
import { currentStatePath, handoffDir, resolveWorkspaceRoot } from '../core/layout.js';
import { readCurrentState, type Phase } from '../core/state.js';
import {
    developmentModes,
    defaultWorkflowProfile,
    isolationModes,
    reviewModes,
    isWorkflowProfile,
    updateGitFlowProfile,
    type WorkflowProfile,
} from '../core/workflow-profile.js';
import {
    approveUserChoiceGate,
    consumeUserChoiceGate,
    createUserChoiceGate,
    requireUserChoiceGate,
    type UserChoiceBoundary,
} from '../workflow/user-choice-gate.js';
import { inspectGitFlow, type GitFlowBranchKind } from '../core/git-flow.js';
import { runCommand } from '../workflow/orchestrator.js';
import { resolveWorkspaceRootForTask } from '../core/layout.js';
import {
    nextActionForTask,
    roleForPhase,
    nextSkillForPhase,
    type NextActionReason,
    phaseFallbackAction,
    readUpstreamSummary,
    statusActionPrompts,
    suggestCandidateAction,
    trustBoundaryFor,
} from '../workflow/navigation.js';
import { createContextPacket, requireAcknowledgedContextPacket } from '../workflow/context-fabric.js';
import { createWorkflowHandoff } from '../workflow/delegation-prompt.js';
import { activateHookTask } from '../hooks/runtime.js';
import { createPacketHash } from './tasks.js';
import { type KataCommand } from '../workflow/orchestrator.js';
import { validateWaivers, type Waiver } from '../quality/acceptance-matrix.js';
import { type Role as HandoffRole } from '../workflow/handoff.js';
import { argValue, parseChangeArg } from './invocation.js';
import { outputResult } from './output.js';

/**
 * The workflow family: the phase commands (`design` … `tweak`) and everything that decides whether one may run.
 *
 * What lives here is the *invocation* half — parsing the flags a phase command takes, enforcing the handoff receipt and
 * the repair-entry boundary, reading the workflow profile, and turning an orchestrator result into the completion and
 * next-action shape the skills consume. The orchestrator owns the phases themselves; nothing here re-implements them,
 * and nothing here imports the entry point.
 */

export function isWorkflowCommand(command: string): command is KataCommand {
    return ['open', 'design', 'build', 'review', 'judge', 'verify', 'archive', 'hotfix', 'tweak'].includes(command);
}

export function isResumableWorkflowCommand(command: string): boolean {
    return ['design', 'build', 'review', 'judge', 'verify', 'archive'].includes(command);
}

export async function runWorkflowCommand(command: KataCommand, change: string, root: string, platform?: string, argv: string[] = []): Promise<Record<string, unknown>> {
    const waivers = command === 'build' ? await readWaiversFile(argv) : undefined;
    const inputPhase = await readWorkflowPhase(root, change);
    const boundary = boundaryForCommand(command, inputPhase);
    if (boundary) await requireUserChoiceGate({ root, taskId: change, boundary });
    // hotfix/tweak and Git-Flow preparation can create or inspect an intake task
    // before an implementer handoff exists. They do not mutate an established
    // implementation phase, so receipt enforcement begins once a task has
    // crossed intake.
    if (command !== 'open' && inputPhase !== null && inputPhase !== 'intake') {
        await requireWorkflowReceipt(root, change, roleForCommand(command));
    }
    const explicitChange = parseChangeArg(argv.slice(1));
    let workflowProfile = requiresWorkflowProfile(command) ? await resolveWorkflowProfile(command, argv) : undefined;
    const abortController = command === 'build' ? new AbortController() : undefined;
    const onProgress = command === 'build' && argv.includes('--seal')
        ? (event: { type: string; check: string; state: string; timeoutMs: number; exitCode?: number | null }) => {
            process.stderr.write(`${JSON.stringify(event)}\n`);
        }
        : undefined;
    if (abortController) {
        const onSignal = () => { abortController.abort(); process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal); };
        process.on('SIGINT', onSignal);
        process.on('SIGTERM', onSignal);
    }
    // A hotfix/tweak aggregate would otherwise modify code before its Git Flow
    // branch exists. Establish the task and wait for the explicit branch action
    // first; the following phase is then selected from the persisted task state.
    const branchPreparationOnly = workflowProfile?.isolationMode === 'git_flow' && command !== 'open';
    const commandToRun: KataCommand = branchPreparationOnly ? 'open' : command;
    const openRequirements = command === 'open' ? await readRequirementsFile(argv.slice(1)) : undefined;
    const result = await runCommand(commandToRun, change, root, {
        title: openRequirements?.[0]?.statement.slice(0, 80) ?? (command === 'hotfix' ? `Hotfix ${change}` : command === 'tweak' ? `Tweak ${change}` : `Change ${change}`),
        ...(openRequirements ? { requirements: openRequirements } : command === 'hotfix' || command === 'tweak'
            ? { acceptance: [{ id: 'AC-1', statement: 'Implement the change.' }] }
            : {}),
        ...(platform ? { platform } : {}),
        ...(commandToRun === 'build' ? { seal: argv.includes('--seal') } : {}),
        // The frozen tier is opt-in per run: a seal defers `tier: 'frozen'` checks and names them unless asked.
        ...(commandToRun === 'build' ? { frozen: argv.includes('--frozen') } : {}),
        ...(command === 'review' ? { approve: argv.includes('--approve') } : {}),
        ...(command === 'review' && reviewEvidenceArg(argv) ? { reviewEvidence: reviewEvidenceArg(argv) } : {}),
        ...((command === 'review' || command === 'judge' || command === 'archive') ? { confirmHostModel: boundary !== null } : {}),
        // Closing a task with deferred findings names where they go (`finding-disposition`): the archive refuses an
        // uncarried deferral, so the decision to live with a known problem is recorded rather than implied.
        ...(command === 'archive' && valueAfter(argv, '--findings-carried-to')
            ? { findingsCarriedTo: valueAfter(argv, '--findings-carried-to') as string }
            : {}),
        ...((commandToRun === 'open' || commandToRun === 'build') ? { allowOwnershipConflicts: argv.includes('--allow-ownership-conflicts') } : {}),
        ...(commandToRun === 'build' ? { allowOutOfScopeRepair: argv.includes('--allow-out-of-scope-repair') } : {}),
        ...(commandToRun === 'build' ? { listChecks: argv.includes('--list-checks') } : {}),
        ...(commandToRun === 'build' && (argv.includes('--discover-checks') || argv.includes('--no-discover-checks'))
            ? { discoverChecks: argv.includes('--discover-checks') && !argv.includes('--no-discover-checks') }
            : {}),
        ...(waivers ? { waivers } : {}),
        ...((commandToRun === 'open' || commandToRun === 'build') && ownedPaths(argv).length ? { ownedPaths: ownedPaths(argv) } : {}),
        ...(workflowProfile ? { workflowProfile } : {}),
        ...(onProgress ? { onProgress, signal: abortController?.signal } : {}),
    });
    if (explicitChange && result.taskId !== change) {
        return { command, taskId: change, phase: 'intake', success: false, error: `Task ID mismatch: requested ${change} but result returned ${result.taskId}.` };
    }
    if (boundary && result.success) await consumeUserChoiceGate({ root, taskId: change, boundary });
    const nextBoundary = result.success
        ? result.phase === 'plan' ? 'implementation_gate'
            : result.phase === 'hardVerify' && command === 'verify' ? 'review_gate'
                : result.phase === 'review' && command === 'review' && argv.includes('--approve') ? 'judge_gate'
                    : result.phase === 'judge' && command === 'judge' ? 'archive_gate'
                        : null
        : null;
    if (nextBoundary) await createUserChoiceGate({ root, taskId: result.taskId, boundary: nextBoundary });
    if (result.success && workflowProfile?.isolationMode === 'git_flow') {
        const plan = inspectGitFlow(root, result.taskId, undefined, gitFlowBranchKindForCommand(command));
        workflowProfile = await updateGitFlowProfile(root, result.taskId, plan);
    }
    const upstream = await readUpstreamSummary(root, result.taskId).catch(() => null);
    const suggestion = workflowProfile ? null : upstream ? suggestCandidateAction(result.phase, upstream) : null;
    const gitFlowPending = workflowProfile?.gitFlow?.status === 'pending_confirmation';
    const gitFlowManualCommand = workflowProfile?.gitFlow?.installation?.status !== 'installed'
        ? workflowProfile?.gitFlow?.installation?.manualCommand
        : undefined;
    const phaseNextSkill = gitFlowPending ? '/kata' : nextSkillForPhase(result.phase);
    const nextAction = suggestion
        ? nextActionForTask(result.taskId, suggestion.nextSkill, suggestion.role, suggestion.reason)
        : null;
    const workflowNextAction = workflowProfile
        ? gitFlowPending
            ? {
                taskId: result.taskId,
                nextSkill: '/kata',
                slashCommand: '/kata',
                cliCommand: `kata-cli git-flow apply --change ${result.taskId} --confirm`,
                role: 'implementer',
                reason: 'git_flow_confirmation_required',
                requiresUserConfirmation: true,
                ...(gitFlowManualCommand ? { pauseInstruction: `Git Flow 自动安装未完成；请先手动执行：${gitFlowManualCommand}` } : {}),
            }
            : nextActionForTask(result.taskId, phaseNextSkill, phaseFallbackAction(result.phase).role, workflowNextReason(result.phase))
        : null;
    const completion = result.success
        ? workflowCompletion(result.phase, workflowNextAction ?? nextAction)
        : null;
    const effectiveAction = workflowNextAction ?? nextAction;
    const fromRole = roleForCompletedCommand(command);
    const toRole = effectiveAction ? handoffRole(effectiveAction.role) : null;
    const handoff = result.success && fromRole && toRole && fromRole !== toRole
        ? await createWorkflowHandoff({
            root,
            taskId: result.taskId,
            fromRole: fromRole as Exclude<HandoffRole, 'approver'>,
            toRole: toRole as Exclude<HandoffRole, 'approver'>,
        })
        : null;
    const shouldAskUser = suggestion !== null || workflowNextAction?.requiresUserConfirmation === true;
    const active = result.success
        ? await activateHookTask({
            root,
            taskId: result.taskId,
            role: roleForPhase(result.phase),
            ...(platform ? { platform } : {}),
            origin: 'workflow',
        }).catch(() => null)
        : null;
    return {
        command: result.command,
        taskId: result.taskId,
        phase: result.phase,
        success: result.success,
        execution: {
            workspaceRoot: realpathSync(root),
            executable: process.argv[1] ?? process.execPath,
            runtimeVersion: process.version,
            inputPhase,
            outputPhase: result.phase,
            ...(upstream?.currentRevisionId ? { revisionId: upstream.currentRevisionId } : {}),
            handoffValidated: command === 'open' ? false : true,
        },
        phaseNextSkill,
        ...(completion ? { completion } : {}),
        ...(handoff ? {
            handoff: {
                id: handoff.packet.id,
                path: `.kata/tasks/${result.taskId}/handoffs/${handoff.packet.id}.json`,
                sha256: createPacketHash(handoff.packet),
                packet: handoff.packet,
                targetPrompt: handoff.prompt,
            },
        } : {}),
        ...(workflowProfile && workflowNextAction ? { workflowProfile, nextAction: workflowNextAction } : {}),
        ...(suggestion
            ? {
                nextSkill: suggestion.nextSkill,
                recommended: {
                    taskId: result.taskId,
                    nextSkill: suggestion.nextSkill,
                    role: suggestion.role,
                    reason: suggestion.reason,
                    slashCommand: nextAction?.slashCommand,
                    cliCommand: nextAction?.cliCommand,
                },
                nextAction,
            }
            : {}),
        ...(upstream ? { upstream } : {}),
        ...(shouldAskUser
            ? { askUser: statusActionPrompts(suggestion ?? { nextSkill: phaseNextSkill, role: phaseFallbackAction(result.phase).role, reason: workflowNextReason(result.phase) }) }
            : {}),
        ...(active
            ? {
                activeTask: {
                    taskId: active.taskId,
                    role: active.role,
                    phase: active.phase,
                    ...(active.platform ? { platform: active.platform } : {}),
                    ...(active.branch ? { branch: active.branch } : {}),
                    ...(active.origin ? { origin: active.origin } : {}),
                    active: true,
                },
            }
            : {}),
        ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
        ...(result.error ? { error: result.error } : {}),
    };
}

export async function readWorkflowPhase(root: string, taskId: string): Promise<string | null> {
    try {
        const state = JSON.parse(await readFile(currentStatePath(root, taskId), 'utf8')) as { phase?: unknown };
        return typeof state.phase === 'string' ? state.phase : null;
    } catch {
        return null;
    }
}

export function roleForCommand(command: KataCommand): HandoffRole {
    if (command === 'review' || command === 'verify') return 'reviewer';
    if (command === 'judge') return 'judge';
    if (command === 'archive') return 'distiller';
    return 'implementer';
}

export function boundaryForCommand(command: KataCommand, phase: string | null): UserChoiceBoundary | null {
    if (command === 'build' && phase === 'plan') return 'implementation_gate';
    if (command === 'review' && phase === 'hardVerify') return 'review_gate';
    if (command === 'judge' && phase === 'review') return 'judge_gate';
    if (command === 'archive' && (phase === 'judge' || phase === 'distill')) return 'archive_gate';
    return null;
}

export async function runGateCommand(argv: string[], root: string): Promise<Record<string, unknown>> {
    if (argv[0] !== 'approve') throw new Error('Usage: kata gate approve --task <id> --boundary <implementation_gate|review_gate|judge_gate|archive_gate> --choice <continue_current|switched|delegated> [--for-task]');
    const task = valueAfter(argv, '--task');
    const boundary = valueAfter(argv, '--boundary') as UserChoiceBoundary | undefined;
    const choice = valueAfter(argv, '--choice') as 'continue_current' | 'switched' | 'delegated' | undefined;
    if (!task || !boundary || !choice) throw new Error('kata gate approve requires --task, --boundary, and --choice');
    // --for-task records the same answer for the whole task: the boundaries still exist and are still recorded, they
    // just stop asking the same human the same question (and they report when they reuse the answer).
    const forTask = argv.includes('--for-task');
    await approveUserChoiceGate({ root, taskId: task, boundary, choice, forTask });
    return {
        command: 'gate approve',
        taskId: task,
        boundary,
        choice,
        approved: true,
        ...(forTask ? { recordedForTask: true } : {}),
    };
}

export function valueAfter(argv: string[], flag: string): string | undefined {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
}

export async function requireWorkflowReceipt(root: string, taskId: string, role: HandoffRole): Promise<void> {
    const handoffDirectory = handoffDir(root, taskId);
    let entries: string[];
    try {
        entries = await readdir(handoffDirectory);
    } catch {
        throw new Error(`Workflow mutation requires a current acknowledged handoff receipt for ${role}.`);
    }
    const ids = entries
        .filter((entry) => entry.startsWith('handoff-') && entry.endsWith('.receipt.json'))
        .map((entry) => entry.slice(0, -'.receipt.json'.length))
        .sort()
        .reverse();
    for (const id of ids) {
        try {
            await requireAcknowledgedContextPacket({ root, taskId, id, role });
            return;
        } catch {
            // An older or stale receipt cannot authorize this command; try only
            // another receipt for the same task before rejecting the mutation.
        }
    }
    throw new Error(`Workflow mutation requires a current acknowledged handoff receipt for ${role}.`);
}

export function reviewEvidenceArg(argv: string[]): string | undefined {
    const index = argv.indexOf('--review-evidence');
    const value = index >= 0 ? argv[index + 1] : undefined;
    return value?.trim() || undefined;
}

export function roleForCompletedCommand(command: KataCommand): HandoffRole | null {
    if (command === 'design') return 'designer';
    if (command === 'build') return 'implementer';
    if (command === 'verify' || command === 'review') return 'reviewer';
    if (command === 'judge') return 'judge';
    if (command === 'archive') return 'distiller';
    return null;
}

export function handoffRole(role: string): HandoffRole | null {
    return ['designer', 'implementer', 'reviewer', 'judge', 'distiller'].includes(role)
        ? role as HandoffRole
        : null;
}

export function workflowCompletion(
    phase: Phase,
    nextAction: {
        slashCommand: string;
        cliCommand: string;
        requiresUserConfirmation?: boolean;
        pauseInstruction?: string;
    } | null,
): Record<string, unknown> | null {
    if (!nextAction) return null;
    const archiveNote = phase === 'archive' ? '\n归档已完成。建议使用 git 提交本轮工作流涉及的所有更改，并推送到远端。' : '';
    return {
        phase,
        nextAction,
        userMessage: [
            `当前阶段：${phase}。`,
            `下一步：${nextAction.slashCommand}`,
            `CLI 备用：${nextAction.cliCommand}`,
            ...(nextAction.requiresUserConfirmation && nextAction.pauseInstruction ? [nextAction.pauseInstruction] : []),
            ...(archiveNote ? [archiveNote] : []),
        ].join('\n'),
    };
}

export function workflowNextReason(phase: Phase): NextActionReason {
    return phaseFallbackAction(phase).reason;
}

export function ownedPaths(argv: string[]): string[] {
    return argv.flatMap((value, index) => value === '--owned-path' && argv[index + 1] ? [argv[index + 1]!] : []);
}

export async function readWaiversFile(argv: string[]): Promise<Waiver[] | undefined> {
    const index = argv.indexOf('--waivers-file');
    if (index === -1) return undefined;
    const path = argv[index + 1];
    if (!path) throw new Error('Invalid waivers file: --waivers-file requires a path.');

    let parsed: unknown;
    try {
        parsed = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid waivers file: ${detail}`);
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { waivers?: unknown }).waivers)) {
        throw new Error('Invalid waivers file: expected an object with a waivers array.');
    }
    const waivers = (parsed as { waivers: Waiver[] }).waivers;
    const errors = validateWaivers(waivers);
    if (errors.length > 0) throw new Error(`Invalid waivers file: ${errors.join('; ')}`);
    return waivers;
}

export async function readRequirementsFile(argv: string[]): Promise<Array<{ id?: string; statement: string; source?: string }> | undefined> {
    const index = argv.indexOf('--requirements-file');
    if (index === -1) return undefined;
    const path = argv[index + 1];
    if (!path) throw new Error('Invalid requirements file: --requirements-file requires a path.');

    let parsed: unknown;
    try {
        parsed = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid requirements file: ${detail}`);
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { requirements?: unknown }).requirements)) {
        throw new Error('Invalid requirements file: expected an object with a requirements array.');
    }
    const items = (parsed as { requirements: Array<{ id?: string; statement?: unknown; source?: unknown }> }).requirements;
    return items.map((item) => {
        if (typeof item.statement !== 'string' || !item.statement.trim()) {
            throw new Error('Invalid requirements file: each requirement needs a non-empty statement.');
        }
        return {
            ...(item.id ? { id: item.id } : {}),
            statement: item.statement,
            ...(typeof item.source === 'string' ? { source: item.source } : {}),
        };
    });
}

export function gitFlowBranchKindForCommand(command: KataCommand): GitFlowBranchKind {
    return command === 'hotfix' ? 'hotfix' : 'feature';
}

export function requiresWorkflowProfile(command: KataCommand): command is 'open' | 'hotfix' | 'tweak' {
    return command === 'open' || command === 'hotfix' || command === 'tweak';
}

export async function resolveWorkflowProfile(command: 'open' | 'hotfix' | 'tweak', argv: string[] = []): Promise<WorkflowProfile> {
    const explicit = parseWorkflowProfileArgs(argv);
    if (!explicit.isolationMode || !explicit.developmentMode || !explicit.reviewMode) {
        throw new Error(`kata-cli ${command} requires explicit --isolation, --development, and --review choices; use /kata-${command} to collect user confirmation first.`);
    }
    return {
        ...defaultWorkflowProfile(),
        isolationMode: explicit.isolationMode,
        developmentMode: explicit.developmentMode,
        reviewMode: explicit.reviewMode,
    };
}

export function parseWorkflowProfileArgs(argv: string[]): Partial<Pick<WorkflowProfile, 'isolationMode' | 'developmentMode' | 'reviewMode'>> {
    return {
        isolationMode: parseEnumArg(argv, ['--isolation', '--isolation-mode'], isolationModes, 'isolation mode'),
        developmentMode: parseEnumArg(argv, ['--development', '--development-mode'], developmentModes, 'development mode'),
        reviewMode: parseEnumArg(argv, ['--review', '--review-mode'], reviewModes, 'review mode'),
    };
}

function parseEnumArg<const T extends readonly string[]>(
    argv: string[],
    flags: readonly string[],
    allowed: T,
    label: string,
): T[number] | undefined {
    const flag = flags.find((candidate) => argv.includes(candidate));
    if (!flag) return undefined;
    const value = argv[argv.indexOf(flag) + 1];
    if (!value) throw new Error(`Missing ${label} after ${flag}`);
    if (!(allowed as readonly string[]).includes(value)) {
        throw new Error(`Invalid ${label}: ${value}. Expected one of: ${allowed.join(', ')}`);
    }
    return value as T[number];
}
