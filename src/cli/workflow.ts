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
    boundaryCreatedBy,
    consumeUserChoiceGate,
    createUserChoiceGate,
    requireUserChoiceGate,
    type UserChoiceBoundary,
} from '../workflow/user-choice-gate.js';
import { inspectGitFlow, toGitFlowState, type GitFlowBranchKind } from '../core/git-flow.js';
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
import { validateMatrix, validateWaivers, type Waiver } from '../quality/acceptance-matrix.js';
import type { AcceptanceMatrix, ClaimDeclaration, UpstreamCoverage } from '../core/task.js';
import { type Role as HandoffRole } from '../workflow/handoff.js';
import { argValue, flagPresent, paradeArgValue, parseChangeArg, readFlag, switchPresent } from './invocation.js';
export { flagPresent } from './invocation.js';
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
    const onProgress = command === 'build' && switchPresent(argv, '--seal')
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
    const bootstrap = command === 'open' ? await readBootstrapFile(argv.slice(1)) : undefined;
    const result = await runCommand(commandToRun, change, root, {
        // **`--title` is documented on `open`, `hotfix` and `tweak`, and nothing read it.** A documented flag that is
        // silently dropped is the shape this repository removes most often; the flag is honoured rather than deleted from
        // the usage text, because it is the only way to name a task whose requirements file is absent or whose first
        // statement is not a title. The fallback chain stays for the case where nobody passed one.
        title: argValue(argv, '--title')?.trim()
            || openRequirements?.[0]?.statement.slice(0, 80)
            || (command === 'hotfix' ? `Hotfix ${change}` : command === 'tweak' ? `Tweak ${change}` : `Change ${change}`),
        ...(openRequirements ? { requirements: openRequirements } : command === 'hotfix' || command === 'tweak'
            ? { acceptance: [{ id: 'AC-1', statement: 'Implement the change.' }] }
            : {}),
        ...(platform ? { platform } : {}),
        ...(commandToRun === 'build' ? { seal: switchPresent(argv, '--seal') } : {}),
        ...(commandToRun === 'build' && argValue(argv, '--judgement')
            ? { judgement: argValue(argv, '--judgement') as string }
            : {}),
        // The frozen tier is opt-in per run: a seal defers `tier: 'frozen'` checks and names them unless asked.
        ...(commandToRun === 'build' ? { frozen: switchPresent(argv, '--frozen') } : {}),
        ...(command === 'review' ? { approve: switchPresent(argv, '--approve') } : {}),
        ...(command === 'review' && reviewEvidenceArg(argv) ? { reviewEvidence: reviewEvidenceArg(argv) } : {}),
        // The flag's presence is what selects the result path: a malformed value must fail by name in the
        // orchestrator rather than silently degrade into the plain review route (F-5).
        ...(command === 'review' && resultFileRequested(argv) ? { reviewResultFile: reviewResultFileArg(argv) ?? '' } : {}),
        // F5: the review may state which paths it read. Repeated `--reviewed-path` flags; absent means "the whole
        // revision", which is the conservative reading and the behaviour that existed before the field did.
        ...(command === 'review' ? { reviewedPaths: repeatedValues(argv, '--reviewed-path') } : {}),
        ...((command === 'review' || command === 'judge' || command === 'archive') ? { confirmHostModel: boundary !== null } : {}),
        // Closing a task with deferred findings names where they go (`finding-disposition`): the archive refuses an
        // uncarried deferral, so the decision to live with a known problem is recorded rather than implied.
        ...(command === 'archive' && argValue(argv, '--findings-carried-to')
            ? { findingsCarriedTo: argValue(argv, '--findings-carried-to') as string }
            : {}),
        ...((commandToRun === 'open' || commandToRun === 'build') ? { allowOwnershipConflicts: switchPresent(argv, '--allow-ownership-conflicts') } : {}),
        ...(commandToRun === 'build' ? { allowOutOfScopeRepair: switchPresent(argv, '--allow-out-of-scope-repair') } : {}),
        ...(commandToRun === 'build' ? { listChecks: switchPresent(argv, '--list-checks') } : {}),
        ...(commandToRun === 'build' && (switchPresent(argv, '--discover-checks') || switchPresent(argv, '--no-discover-checks'))
            ? { discoverChecks: switchPresent(argv, '--discover-checks') && !switchPresent(argv, '--no-discover-checks') }
            : {}),
        ...(waivers ? { waivers } : {}),
        ...(commandToRun === 'open' && bootstrap ? { bootstrap } : {}),
        ...((commandToRun === 'open' || commandToRun === 'build') && ownedPaths(argv).length ? { ownedPaths: ownedPaths(argv) } : {}),
        ...(workflowProfile ? { workflowProfile } : {}),
        ...(onProgress ? { onProgress, signal: abortController?.signal } : {}),
    });
    if (explicitChange && result.taskId !== change) {
        return { command, taskId: change, phase: 'intake', success: false, error: `Task ID mismatch: requested ${change} but result returned ${result.taskId}.` };
    }
    if (boundary && result.success) await consumeUserChoiceGate({ root, taskId: change, boundary });
    // **One table, read in this direction too.** The chain that used to live here was the only statement of which command
    // creates which gate, so the refusal that tells an operator how to rebuild one had nothing to read from.
    const nextBoundary = result.success
        ? boundaryCreatedBy(result.phase, command, switchPresent(argv, '--approve'))
        : null;
    if (nextBoundary) await createUserChoiceGate({ root, taskId: result.taskId, boundary: nextBoundary });
    if (result.success && workflowProfile?.isolationMode === 'git_flow') {
        // Projected, not stored as inspected: `inspectGitFlow` returns a plan on all six of its returns, and persisting one
        // is what made every git_flow task invalid on the next read (`kata-cli design` refusing a record kata wrote).
        const plan = inspectGitFlow(root, result.taskId, undefined, gitFlowBranchKindForCommand(command));
        workflowProfile = await updateGitFlowProfile(root, result.taskId, toGitFlowState(plan));
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
        // **The schema-validated reader, not a bare `JSON.parse`.** Four call sites parsed `current-state.json` by hand
        // while `readCurrentState` validated it against the same schema, so one malformed state was refused in one entry
        // point and accepted in another — the same state, two answers, depending on which command a reader happened to run.
        const state = await readCurrentState(root, taskId);
        return typeof state.phase === 'string' ? state.phase : null;
    } catch {
        // A task with no state record yet is a state, not an error: this reader reports "no phase" rather than throwing,
        // which is what every caller wants from it.
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
    const task = argValue(argv, '--task');
    const boundary = argValue(argv, '--boundary') as UserChoiceBoundary | undefined;
    const choice = argValue(argv, '--choice') as 'continue_current' | 'switched' | 'delegated' | undefined;
    if (!task || !boundary || !choice) throw new Error('kata gate approve requires --task, --boundary, and --choice');
    // --for-task records the same answer for the whole task: the boundaries still exist and are still recorded, they
    // just stop asking the same human the same question (and they report when they reuse the answer).
    const forTask = switchPresent(argv, '--for-task');
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

/**
 * Every value a repeated flag carries, in order.
 *
 * R12-F7/F-12: the rule lives in `paradeArgValue` and this was a second copy of it — with no case asserting the inline
 * spelling, so disabling that branch left the suite green. One implementation, one case.
 */
export function repeatedValues(argv: string[], flag: string): string[] {
    const values = paradeArgValue(argv, flag);
    if (values.length === 0 && argv.some((token) => token === `${flag}=`)) {
        throw new Error(`Invalid value: ${flag} requires a value.`);
    }
    return values;
}

/**
 * The receipt a mutation needs, and **why the refusal says which of two situations this is.**
 *
 * The message used to be one sentence for both: no receipt exists, or a receipt exists and no longer describes the task. It
 * matters because the remedies differ — one is `handoff create` then `handoff acknowledge`, the other is to *re-acknowledge*
 * after whatever moved the task (a scope apply, an edit to a declared path) — and the reader had to diff the packet against
 * the working tree to discover which. Measured while walking a real change: two `scope apply` calls each invalidated the
 * receipt, and the third attempt was refused with a sentence that named neither the cause nor the command.
 */
export async function requireWorkflowReceipt(root: string, taskId: string, role: HandoffRole): Promise<void> {
    const handoffDirectory = handoffDir(root, taskId);
    let entries: string[];
    try {
        entries = await readdir(handoffDirectory);
    } catch {
        throw new Error(
            `Workflow mutation requires a current acknowledged handoff receipt for ${role}, and this task has none. `
            + `Create one: \`kata-cli handoff create --task ${taskId} --from <role> --to ${role}\`, then acknowledge it with \`kata-cli handoff acknowledge --task ${taskId} --id <handoff-id> --platform <name> --role ${role}\`.`,
        );
    }
    const ids = entries
        .filter((entry) => entry.startsWith('handoff-') && entry.endsWith('.receipt.json'))
        .map((entry) => entry.slice(0, -'.receipt.json'.length))
        .sort()
        .reverse();
    // The freshest refusal is the informative one: an older receipt's reason is usually the same reason it was superseded.
    let newestRefusal = '';
    for (const id of ids) {
        try {
            await requireAcknowledgedContextPacket({ root, taskId, id, role });
            return;
        } catch (error) {
            // An older or stale receipt cannot authorize this command; try only another receipt for the same task before
            // rejecting the mutation.
            if (newestRefusal === '') newestRefusal = (error as Error).message;
        }
    }
    if (ids.length === 0) {
        throw new Error(
            `Workflow mutation requires a current acknowledged handoff receipt for ${role}, and this task has packets but none acknowledged. `
            + `Acknowledge one: \`kata-cli handoff acknowledge --task ${taskId} --id <handoff-id> --platform <name> --role ${role}\`.`,
        );
    }
    throw new Error(
        `Workflow mutation requires a current acknowledged handoff receipt for ${role}, and none of this task's ${ids.length} receipt(s) is current. `
        + `A receipt describes the task as it stood when it was acknowledged, so changing the task's declared paths or scope supersedes it. `
        + `Last refusal: ${newestRefusal} `
        + `Re-acknowledge after the change: \`kata-cli handoff create --task ${taskId} --from <role> --to ${role}\` then \`kata-cli handoff acknowledge --task ${taskId} --id <handoff-id> --platform <name> --role ${role}\`.`,
    );
}

/**
 * Read the review result file path from argv.
 *
 * A flag whose value is missing or is another flag is a malformed invocation, not an absent flag: returning
 * `undefined` here would send the caller down the plain review path, where a reviewer cannot tell a typo from a
 * review that recorded nothing. The caller distinguishes the two with `resultFileRequested(argv)`.
 */
export function reviewResultFileArg(argv: string[]): string | undefined {
    const value = argValue(argv, '--result-file');
    return value?.trim() || undefined;
}

/**
 * Whether a flag was given at all, in either spelling — what tells "absent" from "present with a bad value".
 *
 * **The reader is shared, not copied.** R5-8: this change added a second, character-for-character copy of the `=`
 * handling beside `argValue`, so the rule lived in two places and only one of them would be updated next time — the
 * defect this repository removes most often, added by the fix for it — and R12-F10 found the same duplication inside
 * `invocation.ts` itself, so the implementation now lives there once and this file re-exports it.
 */

/** True when the invocation asked for result recording at all, however malformed the value is — either spelling. */
export function resultFileRequested(argv: string[]): boolean {
    return flagPresent(argv, '--result-file');
}

/**
 * Whether a flag was given at all, in either spelling — what tells "absent" from "present with a bad value".
 *
 * **The reader is shared, not copied.** R5-8: this change added a second, character-for-character copy of the `=`
 * handling beside `argValue`, so the rule lived in two places and only one of them would be updated next time — the
 * defect this repository removes most often, added by the fix for it.
 */

/** The value of a `--flag`, or undefined when the flag is absent or its next token is another flag. */
/**
 * The value a flag was given, in either spelling.
 *
 * **`--flag value` and `--flag=value` are the same flag and were not.** Measured by an independent review: the
 * `--result-file=result.json` spelling was not recognised, so the flag was treated as absent, the command fell into the
 * plain review route and returned success — silently, which is exactly what the malformed-shape refusal above exists to
 * prevent. Both spellings resolve here, and a spelling with no value at all returns `undefined` so the caller can refuse
 * by name instead of degrading.
 */


/** True when the invocation named an approval reason at all, however malformed — the companion to the value reader. */
export function reviewEvidenceRequested(argv: string[]): boolean {
    return flagPresent(argv, '--review-evidence');
}

export function reviewEvidenceArg(argv: string[]): string | undefined {
    return argValue(argv, '--review-evidence');
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
    // R9-F2/R10-F1: both spellings through the shared reader, and a present-but-empty value is refused rather than read as
    // "no declaration" — an empty declaration surface is the one silent failure a change must not have.
    if (argv.some((token) => token === '--owned-path=')) {
        throw new Error('Invalid owned path: --owned-path requires a path.');
    }
    return paradeArgValue(argv, '--owned-path');
}

export async function readWaiversFile(argv: string[]): Promise<Waiver[] | undefined> {
    // R9-F2: with the spaced form alone, `--waivers-file=x` was *silently ignored* — a waiver set the operator supplied
    // did not apply and nothing said so. Absent and malformed stay different facts (absent returns `undefined`, a
    // present-but-empty value throws), and the `=` spelling is no longer a third one.
    if (!flagPresent(argv, '--waivers-file')) return undefined;
    const path = argValue(argv, '--waivers-file');
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
    // Same rule as the waivers reader, and for the same reason: a requirements file that was supplied but silently
    // ignored would make the acceptance contract invisible while the command reports success.
    if (!flagPresent(argv, '--requirements-file')) return undefined;
    const path = argValue(argv, '--requirements-file');
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

/**
 * The declared contract a strict task is born with, read from `--bootstrap-file`.
 *
 * Shaped like `--requirements-file` on purpose: both take a path, both validate before anything is written, and both
 * fail loudly at the command that was given the bad input rather than at the gate three commands later. The
 * difference is that this one carries the matrix too — that is the record `design` refuses to proceed without, and
 * the reason `open` had no honest way to produce a strict task.
 */
export async function readBootstrapFile(argv: string[]): Promise<{
    acceptance: Array<{ id?: string; statement: string; claims?: ClaimDeclaration[] }>;
    acceptanceMatrix?: AcceptanceMatrix;
    upstreamCoverage?: UpstreamCoverage;
} | undefined> {
    // R12-F5: `--bootstrap-file=` returned `undefined` — a supplied declaration silently dropped — while the sibling
    // readers threw for the same input. Absent and present-but-empty are two facts, and this is the one that decides
    // whether a task is created with the declaration the operator supplied.
    if (!flagPresent(argv, '--bootstrap-file')) return undefined;
    const path = argValue(argv, '--bootstrap-file');
    if (!path) throw new Error('Invalid bootstrap file: --bootstrap-file requires a path.');

    let parsed: unknown;
    try {
        parsed = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid bootstrap file: ${detail}`);
    }
    if (!parsed || typeof parsed !== 'object') {
        throw new Error('Invalid bootstrap file: expected an object with an acceptance array.');
    }
    const body = parsed as { acceptance?: unknown; acceptanceMatrix?: unknown; upstreamCoverage?: unknown };
    if (!Array.isArray(body.acceptance) || body.acceptance.length === 0) {
        throw new Error('Invalid bootstrap file: acceptance must be a non-empty array, because a task without criteria has no contract.');
    }
    const acceptance = body.acceptance.map((item) => {
        const criterion = item as { id?: unknown; statement?: unknown; claims?: unknown };
        if (typeof criterion.statement !== 'string' || !criterion.statement.trim()) {
            throw new Error('Invalid bootstrap file: each acceptance criterion needs a non-empty statement.');
        }
        return {
            ...(typeof criterion.id === 'string' ? { id: criterion.id } : {}),
            statement: criterion.statement,
            ...(Array.isArray(criterion.claims) ? { claims: criterion.claims as ClaimDeclaration[] } : {}),
        };
    });

    const acceptanceMatrix = body.acceptanceMatrix as AcceptanceMatrix | undefined;
    const errors = validateMatrix(acceptance, acceptanceMatrix);
    if (errors.length > 0) {
        // Refused where it is written. A matrix that disagrees with its criteria is a contract nobody can satisfy,
        // and discovering that at `design` (or at seal) spends the author's time on the wrong question.
        throw new Error(`Invalid bootstrap file: ${errors.map((error) => error.message).join('; ')}`);
    }

    return {
        acceptance,
        ...(acceptanceMatrix ? { acceptanceMatrix } : {}),
        ...(body.upstreamCoverage ? { upstreamCoverage: body.upstreamCoverage as UpstreamCoverage } : {}),
    };
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
    // **Both spellings, through the shared reader.** R10-F3: this reader compared whole tokens while the same file had
    // already accepted `--flag=value` for other flags, so `open --isolation=git_flow --development=tdd --review=strict`
    // reached the profile resolver as "no choices given" and was refused — a caller who had made every choice told they
    // had made none.
    const flag = flags.find((candidate) => flagPresent(argv, candidate));
    if (!flag) return undefined;
    const value = argValue(argv, flag);
    if (!value) throw new Error(`Missing ${label} after ${flag}`);
    if (!(allowed as readonly string[]).includes(value)) {
        throw new Error(`Invalid ${label}: ${value}. Expected one of: ${allowed.join(', ')}`);
    }
    return value as T[number];
}
