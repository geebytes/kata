import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { buildContextManifest } from '../core/context.js';
import { currentGitBranch } from '../core/git.js';
import { hashContent } from '../core/hash.js';
import {
    currentStatePath,
    relationsRelativePath,
    resolveWorkspaceRoot,
    resolveWorkspaceRootForTask,
    skillsIndexRelativePath,
    taskPath,
    tasksDir,
} from '../core/layout.js';
import { recover, requiresRecovery } from '../core/recovery.js';
import { addTaskRelation, findKataRelations, readTaskRelations, resolveTerminalTask } from '../core/relations.js';
import { orderedPhases, readCurrentState, type Phase } from '../core/state.js';
import { readTask } from '../core/task.js';
import { readActiveHookTask, activateHookTask, deactivateHookTask, type ActiveHookTask } from '../hooks/runtime.js';
import {
    activeRoleForPhase,
    roleForPhase,
    nextActionForTask,
    nextSkillForPhase,
    readUpstreamSummary,
    statusActionPrompts,
    suggestCandidateAction,
    type NextActionReason,
    type UpstreamSummary,
} from '../workflow/navigation.js';
import { parseTaskRelationType } from './relations.js';
import { createContextPacket } from '../workflow/context-fabric.js';
import { createHandoff, type Role as HandoffRole } from '../workflow/handoff.js';
import { argValue, parseRootArg } from './invocation.js';

/**
 * The task/navigation family: which task am I on, what does the dispatcher recommend, and where do I go next.
 *
 * These are the commands almost every session runs first (`status`, `tasks`, `orient`, `hooks`, plus the handoff
 * surface's packeting helpers), and they are the ones that must agree about what a phase means — the shared tables live
 * in `workflow/navigation.ts` and `core/state.ts`, and this module turns them into output. Nothing here imports the
 * entry point.
 */

/**
 * The task/navigation family: which task am I on, what does the dispatcher recommend, and where do I go next.
 *
 * These are the commands almost every session runs first (`status`, `tasks`, `orient`, `hooks`, plus the handoff
 * surface's packeting helpers), and they are the ones that must agree about what a phase means — the shared tables live
 * in `workflow/navigation.ts` and `core/state.ts`, and this module turns them into output. Nothing here imports the
 * entry point.
 */

function statusDiagnostic(candidates: TaskCandidate[] = []): Record<string, unknown> {
    const recommended = recommendNextTask(candidates);
    const action = recommended
        ? nextActionForTask(recommended.taskId, recommended.nextSkill, recommended.suggestedRole, recommended.suggestedReason)
        : null;
    return {
        command: 'status',
        taskId: null,
        phase: 'dispatch',
        success: true,
        diagnostics: {
            message: candidates.length > 0
                ? 'Multiple same-branch Kata tasks were discovered. Pick the recommended task or pass --change explicitly.'
                : 'No same-branch Kata task was discovered. Provide a change id with --change, or open a new task.',
            usage: 'kata-cli <status|open|design|build|verify|archive|hotfix|tweak|next> --change <id>',
        },
        candidates,
        recommended: recommended
            ? {
                taskId: recommended.taskId,
                nextSkill: recommended.nextSkill,
                role: recommended.suggestedRole,
                reason: recommended.suggestedReason,
                slashCommand: action?.slashCommand,
                cliCommand: action?.cliCommand,
            }
            : null,
        nextAction: action,
        askUser: recommended
            ? [
                `发现 ${candidates.length} 个当前分支任务，建议处理：${recommended.taskId}`,
                `确认下一步：${action?.slashCommand ?? recommended.nextSkill}`,
            ]
            : ['请选择 Kata task，或输入要开启的新 change id。'],
    };
}

export type ResolvedTask = {
    taskId: string;
    source: 'active' | 'discovered';
    branch?: string;
    platform?: string;
    role?: string;
    origin?: ActiveHookTask['origin'];
};

export async function resolveTaskForCurrentBranch(root: string): Promise<ResolvedTask | null> {
    const active = await resolveActiveTaskForCurrentBranch(root);
    if (active) {
        return {
            taskId: active.taskId,
            source: 'active',
            ...(active.branch ? { branch: active.branch } : {}),
            ...(active.platform ? { platform: active.platform } : {}),
            ...(active.role ? { role: active.role } : {}),
            ...(active.origin ? { origin: active.origin } : {}),
        };
    }
    return discoverSingleTaskForCurrentBranch(root);
}

/**
 * The role a task in this phase is activated as, which is also the role the hook guard accepts. It is the phase table's
 * `activeRoleByPhase`, shared with the hook, so activation and enforcement cannot disagree.
 */


export async function resolveActiveTaskForCurrentBranch(root: string): Promise<ActiveHookTask | null> {
    const active = await readActiveHookTask(root);
    if (!active) return null;
    const branch = currentGitBranch(root);
    if (active.branch && branch && active.branch !== branch) {
        throw new Error(`Active task belongs to branch ${active.branch}; current branch is ${branch}. Pass --change explicitly or activate a task on this branch.`);
    }
    return active;
}
export async function discoverSingleTaskForCurrentBranch(root: string): Promise<ResolvedTask | null> {
    const branch = currentGitBranch(root);
    if (!branch) return null;
    let taskIds: string[];
    try {
        taskIds = await readdir(tasksDir(root));
    } catch {
        return null;
    }
    const matches: string[] = [];
    for (const taskId of taskIds) {
        try {
            const task = JSON.parse(await readFile(taskPath(root, taskId), 'utf8')) as {
                id?: string;
                branch?: string;
                phase?: Phase;
            };
            if (task.branch === branch && task.phase !== 'archive') matches.push(task.id ?? taskId);
        } catch {
            // Ignore partial/non-task directories; they should not block explicit --change usage.
        }
    }
    if (matches.length !== 1) return null;
    return { taskId: matches[0]!, source: 'discovered', branch };
}

export async function runLocalStatusCommand(change: string, resolved?: ResolvedTask | null, root = resolveWorkspaceRoot()): Promise<Record<string, unknown>> {
    const terminal = await resolveTerminalTask(root, change);
    if (terminal.taskId !== change) {
        const targetStatus = await runLocalStatusCommand(terminal.taskId, resolved, root);
        return {
            ...targetStatus,
            command: 'status',
            redirectedFrom: change,
            relationRedirects: terminal.redirects,
            askUser: [
                `任务 ${change} 已通过 ${terminal.redirects[0]?.type ?? 'relation'} 指向 ${terminal.taskId}；请继续处理 ${terminal.taskId}。`,
            ],
        };
    }
    // Status is the cross-platform resume entrypoint. Rebuild the mutable
    // projection from the append-only legal event chain before reporting it.
    if (await requiresRecovery(change, { root }).catch(() => false)) await recover(change, { root });
    const state = JSON.parse(await readFile(currentStatePath(root, change), 'utf8')) as {
        phase: Phase;
        updatedAt?: string;
        actor?: unknown;
        activeSession?: string;
    };
    const autoActive = resolved?.source === 'discovered'
        ? await activateHookTask({
            root,
            taskId: change,
            role: roleForPhase(state.phase),
            ...(resolved.platform ? { platform: resolved.platform } : {}),
            origin: 'discovered',
        }).catch(() => null)
        : null;
    const effectiveResolved: ResolvedTask | null | undefined = autoActive
        ? {
            taskId: autoActive.taskId,
            source: 'active',
            ...(autoActive.branch ? { branch: autoActive.branch } : {}),
            ...(autoActive.platform ? { platform: autoActive.platform } : {}),
            role: autoActive.role,
            ...(autoActive.origin ? { origin: autoActive.origin } : {}),
        }
        : resolved;
    const taskContext = await readTaskContext(root, change);
    // C7: a gate that asks for something it never asked for before is an engine change, not a mistake in this run, and
    // saying so costs one line where the absence of it cost a diagnostic cycle.
    const { engineChangeNote, engineVersion } = await import('../core/engine-version.js');
    const engineNote = engineChangeNote(taskContext.engine);
    const upstream = await readUpstreamSummary(root, change);
    const suggestion = suggestCandidateAction(state.phase, upstream);
    const phaseNextSkill = nextSkillForPhase(state.phase);
    const nextAction = nextActionForTask(change, suggestion.nextSkill, suggestion.role, suggestion.reason);
    const hasArtifactOverride = suggestion.nextSkill !== phaseNextSkill || suggestion.reason.startsWith('repair_');
    const shouldAskUser = hasArtifactOverride || nextAction.requiresUserConfirmation;
    return {
        command: 'status',
        taskId: change,
        phase: state.phase,
        nextSkill: suggestion.nextSkill,
        phaseNextSkill,
        recommended: {
            taskId: change,
            nextSkill: suggestion.nextSkill,
            role: suggestion.role,
            reason: suggestion.reason,
            slashCommand: nextAction.slashCommand,
            cliCommand: nextAction.cliCommand,
        },
        nextAction,
        upstream,
        ...(shouldAskUser
            ? {
                ...(hasArtifactOverride ? { artifactOverride: true } : {}),
                askUser: statusActionPrompts(suggestion),
            }
            : {}),
        ...(effectiveResolved?.source === 'active' && effectiveResolved.taskId === change ? { active: true } : {}),
        ...(effectiveResolved?.source === 'discovered' && effectiveResolved.taskId === change ? { discovered: true } : {}),
        ...(effectiveResolved?.source === 'active' && effectiveResolved.origin === 'discovered' ? { discovered: true } : {}),
        ...(autoActive ? { discovered: true, autoActivated: true } : {}),
        ...(effectiveResolved?.branch ? { branch: effectiveResolved.branch } : {}),
        ...(effectiveResolved?.platform ? { platform: effectiveResolved.platform } : {}),
        ...(effectiveResolved?.role ? { activeRole: effectiveResolved.role } : {}),
        ...(state.updatedAt ? { updatedAt: state.updatedAt } : {}),
        ...(state.actor ? { actor: state.actor } : {}),
        ...(state.activeSession ? { activeSession: state.activeSession } : {}),
        task: taskContext.task,
        state,
        engine: { running: engineVersion(), ...(taskContext.engine ? { task: taskContext.engine } : {}) },
        ...(engineNote ? { engineNote } : {}),
        requiredReads: taskContext.requiredReads,
        context: taskContext.context,
    };
}

export async function runDispatchStatusCommand(root: string): Promise<Record<string, unknown>> {
    const candidates = await listTaskCandidates(root);
    if (candidates.length === 1) {
        const active = await activateHookTask({
            root,
            taskId: candidates[0]!.taskId,
            role: candidates[0]!.suggestedRole,
            origin: 'discovered',
        }).catch(() => null);
        return {
            ...(await runLocalStatusCommand(candidates[0]!.taskId, active
                ? {
                    taskId: active.taskId,
                    source: 'active',
                    ...(active.branch ? { branch: active.branch } : {}),
                    ...(active.platform ? { platform: active.platform } : {}),
                    role: active.role,
                    ...(active.origin ? { origin: active.origin } : {}),
                }
                : { taskId: candidates[0]!.taskId, source: 'discovered', ...(candidates[0]!.branch ? { branch: candidates[0]!.branch } : {}) }, root)),
            autoDispatched: true,
            ...(active ? { autoActivated: true } : {}),
        };
    }
    return statusDiagnostic(candidates);
}

export async function readTaskContext(root: string, change: string): Promise<{
    task: { title: string; acceptance: Array<{ id?: string; statement: string }> };
    requiredReads: string[];
    context: Record<string, unknown>;
    engine?: { version: string; stampedAt: string };
}> {
    const taskRaw = await readFile(taskPath(root, change), 'utf8');
    const task = JSON.parse(taskRaw) as { title: string; acceptance: Array<{ id?: string; statement: string }>; engine?: { version: string; stampedAt: string } };
    let context: Awaited<ReturnType<typeof buildContextManifest>>;
    try {
        context = await buildContextManifest({ root, taskId: change, sourceRefs: [] });
    } catch {
        context = { taskId: change, sourceRefs: [], authoritativeWiki: [], excludedWiki: [], warnings: [] };
    }
    return {
        ...(task.engine ? { engine: task.engine } : {}),
        task: {
            title: task.title,
            acceptance: task.acceptance,
        },
        requiredReads: [
            'AGENTS.md',
            skillsIndexRelativePath,
            '.llmwiki/SCHEMA.md',
            '.llmwiki/index.md',
            '.llmwiki/log.md',
            `.kata/tasks/${change}/task.json`,
            `.kata/tasks/${change}/current-state.json`,
        ],
        context: {
            authoritativeWikiCount: context.authoritativeWiki.length,
            excludedWikiCount: context.excludedWiki.length,
            sourceRefs: context.sourceRefs,
            warnings: context.warnings,
        },
    };
}

export async function runTasksCommand(argv: string[]): Promise<Record<string, unknown>> {
    const [subcommand, ...rest] = argv;
    const args = parseTasksArgs(rest);
    const root = args.root ?? resolveWorkspaceRoot();
    if (subcommand === 'relate') {
        if (!args.from || !args.to || !args.type) {
            throw new Error('Usage: kata-cli tasks relate --from <task> --to <task> --type <superseded_by|covered_by|duplicate_of|merged_into|parent_of|spawned_from|related_to> [--reason <text>] [--root <path>]');
        }
        const record = await addTaskRelation({
            root,
            fromTaskId: args.from,
            toTaskId: args.to,
            type: parseTaskRelationType(args.type),
            ...(args.reason ? { reason: args.reason } : {}),
            createdBy: 'kata-cli',
        });
        const terminal = await resolveTerminalTask(root, args.from);
        return {
            command: 'tasks relate',
            fromTaskId: args.from,
            toTaskId: args.to,
            type: args.type,
            relationPath: relationsRelativePath,
            relations: record.relations,
            ...(terminal.taskId !== args.from ? { redirectsTo: terminal.taskId, relationRedirects: terminal.redirects } : {}),
            nextAction: {
                slashCommand: `/kata ${terminal.taskId}`,
                cliCommand: `kata-cli status --change ${terminal.taskId}`,
            },
        };
    }
    if (subcommand === 'relations' || subcommand === 'show') {
        if (!args.task && !args.from) throw new Error('Usage: kata-cli tasks relations --task <task> [--root <path>]');
        const taskId = args.task ?? args.from!;
        const record = await readTaskRelations(root, taskId);
        const terminal = await resolveTerminalTask(root, taskId);
        return {
            command: 'tasks relations',
            taskId,
            relations: record.relations,
            ...(terminal.taskId !== taskId ? { redirectsTo: terminal.taskId, relationRedirects: terminal.redirects } : {}),
        };
    }
    throw new Error(`Unknown tasks command: ${subcommand ?? ''}`);
}

export function createPacketHash(packet: unknown): string { return hashContent(JSON.stringify(packet)); }

export type TaskCandidate = {
    taskId: string;
    title: string;
    phase: string;
    nextSkill: string;
    branch?: string;
    suggestedRole: string;
    suggestedReason: NextActionReason;
    priority: number;
    upstream: UpstreamSummary;
};

export async function listTaskCandidates(root: string): Promise<TaskCandidate[]> {
    const tasksRoot = tasksDir(root);
    let entries: string[];
    try {
        entries = await readdir(tasksRoot);
    } catch {
        return [];
    }
    const branch = currentGitBranch(root) ?? undefined;
    const candidates = [];
    for (const entry of entries.sort()) {
        const candidate = await readTaskCandidate(root, entry).catch(() => null);
        if (!candidate) continue;
        if (branch && candidate.branch && candidate.branch !== branch) continue;
        candidates.push(candidate);
    }
    return candidates.sort((a, b) => b.priority - a.priority || a.taskId.localeCompare(b.taskId));
}

export async function readTaskCandidate(root: string, taskId: string): Promise<TaskCandidate> {
    const task = JSON.parse(await readFile(taskPath(root, taskId), 'utf8')) as { title?: string; branch?: string };
    const terminal = await resolveTerminalTask(root, taskId);
    if (terminal.taskId !== taskId) {
        throw new Error(`Task ${taskId} is redirected to ${terminal.taskId}`);
    }
    const state = JSON.parse(await readFile(currentStatePath(root, taskId), 'utf8')) as { phase?: Phase };
    const phase = state.phase ?? 'intake';
    const upstream = await readUpstreamSummary(root, taskId);
    const suggestion = suggestCandidateAction(phase, upstream);
    return {
        taskId,
        title: task.title ?? taskId,
        phase,
        nextSkill: suggestion.nextSkill,
        suggestedRole: suggestion.role,
        suggestedReason: suggestion.reason,
        priority: suggestion.priority,
        upstream,
        ...(task.branch ? { branch: task.branch } : {}),
    };
}

export function recommendNextTask(candidates: TaskCandidate[]): TaskCandidate | undefined {
    return candidates.find((task) => task.phase !== 'archive') ?? candidates[0];
}

export async function runOrientCommand(argv: string[]): Promise<Record<string, unknown>> {
    const args = parseOrientArgs(argv);
    const root = args.root ?? resolveWorkspaceRoot();
    const resolved = args.change ? null : await resolveTaskForCurrentBranch(root);
    let change = args.change ?? resolved?.taskId;
    if (!change) {
        throw new Error('Usage: kata-cli orient [--change <id>] [--root <path>] [--role <role>] [--platform <name>] [--task-kind <kind>] [--mode <mode>] [--failures <n>]');
    }
    const terminal = await resolveTerminalTask(root, change);
    const relationRedirects = terminal.taskId !== change ? terminal.redirects : [];
    change = terminal.taskId;
    const role = (args.role ?? 'implementer') as HandoffRole;
    const handoff = await createHandoff(root, change, role);
    const contextPacket = await createContextPacket({ root, taskId: change, fromRole: role, toRole: role, ...(args.platform ? { platform: args.platform } : {}) });
    const taskContext = await readTaskContext(root, change);
    const state = JSON.parse(await readFile(currentStatePath(root, change), 'utf8')) as Record<string, unknown>;
    const phase = (typeof state.phase === 'string' ? state.phase : handoff.fromPhase) as Phase;
    const upstream = await readUpstreamSummary(root, change);
    const suggestion = suggestCandidateAction(phase, upstream);
    const phaseNextSkill = nextSkillForPhase(phase);
    const nextAction = nextActionForTask(change, suggestion.nextSkill, suggestion.role, suggestion.reason);
    const hasArtifactOverride = suggestion.nextSkill !== phaseNextSkill || suggestion.reason.startsWith('repair_');
    const shouldAskUser = hasArtifactOverride || nextAction.requiresUserConfirmation;

    return {
        command: 'orient',
        taskId: change,
        ...(relationRedirects.length > 0 ? { redirectedFrom: relationRedirects[0]?.fromTaskId, relationRedirects } : {}),
        phase: handoff.fromPhase,
        role,
        ...(args.platform ? { platform: args.platform } : {}),
        ...(resolved?.source === 'active' && resolved.taskId === change ? { active: true } : {}),
        ...(resolved?.source === 'discovered' && resolved.taskId === change ? { discovered: true } : {}),
        ...(resolved?.source === 'active' && resolved.origin === 'discovered' ? { discovered: true } : {}),
        ...(resolved?.branch ? { branch: resolved.branch } : {}),
        ...(resolved?.origin ? { origin: resolved.origin } : {}),
        ...(args.taskKind ? { taskKind: args.taskKind } : {}),
        nextSkill: suggestion.nextSkill,
        phaseNextSkill,
        recommended: {
            taskId: change,
            nextSkill: suggestion.nextSkill,
            role: suggestion.role,
            reason: suggestion.reason,
            slashCommand: nextAction.slashCommand,
            cliCommand: nextAction.cliCommand,
        },
        nextAction,
        upstream,
        ...(shouldAskUser
            ? {
                ...(hasArtifactOverride ? { artifactOverride: true } : {}),
                askUser: statusActionPrompts(suggestion),
            }
            : {}),
        task: taskContext.task,
        state,
        requiredReads: taskContext.requiredReads,
        context: taskContext.context,
        guardInstructions: handoff.guardInstructions,
        handoff: { id: contextPacket.id, path: `.kata/tasks/${change}/handoffs/${contextPacket.id}.json`, sha256: createPacketHash(contextPacket), verificationCommand: `kata-cli handoff verify --task ${change} --id ${contextPacket.id}` },
        legacyHandoff: handoff,
        reminders: [
            'Wiki reduces project-context mistakes; CI, tests, Reviewer, and Judge prevent code-correctness mistakes.',
            'Use the suggested /kata-* skill after reading required project and Wiki files.',
        ],
    };
}

export async function runHooksCommand(argv: string[]): Promise<Record<string, unknown>> {
    const [subcommand, ...rest] = argv;
    const args = parseHooksArgs(rest);
    const root = args.root ?? resolveWorkspaceRoot();
    if (subcommand === 'activate') {
        if (!args.change) throw new Error('Usage: kata-cli hooks activate --change <id> [--role <role>] [--platform <name>] [--root <path>]');
        const active = await activateHookTask({
            root,
            taskId: args.change,
            role: args.role ?? 'implementer',
            ...(args.platform ? { platform: args.platform } : {}),
        });
        return {
            command: 'hooks activate',
            taskId: active.taskId,
            role: active.role,
            phase: active.phase,
            ...(active.platform ? { platform: active.platform } : {}),
            ...(active.branch ? { branch: active.branch } : {}),
            ...(active.origin ? { origin: active.origin } : {}),
            activatedAt: active.activatedAt,
            active: true,
        };
    }
    if (subcommand === 'deactivate') {
        await deactivateHookTask(root);
        return { command: 'hooks deactivate', active: false };
    }
    if (subcommand === 'status') {
        const active = await readActiveHookTask(root);
        return active
            ? {
                command: 'hooks status',
                active: true,
                taskId: active.taskId,
                role: active.role,
                phase: active.phase,
                ...(active.platform ? { platform: active.platform } : {}),
                ...(active.branch ? { branch: active.branch } : {}),
                ...(active.origin ? { origin: active.origin } : {}),
                activatedAt: active.activatedAt,
            }
            : { command: 'hooks status', active: false };
    }
    throw new Error(`Unknown hooks command: ${subcommand ?? ''}. Usage: kata-cli hooks <activate|deactivate|status>`);
}

export function parseOrientArgs(argv: string[]): {
    change?: string;
    root?: string;
    role?: string;
    platform?: string;
    taskKind?: string;
    routingMode?: string;
    failureCount?: number;
} {
    const args: {
        change?: string;
        root?: string;
        role?: string;
        platform?: string;
        taskKind?: string;
        routingMode?: string;
        failureCount?: number;
    } = {};
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const value = argv[index + 1];
        if (arg === '--change' && value !== undefined) {
            args.change = value;
            index += 1;
        } else if (arg === '--root' && value !== undefined) {
            args.root = value;
            index += 1;
        } else if (arg === '--role' && value !== undefined) {
            args.role = value;
            index += 1;
        } else if (arg === '--platform' && value !== undefined) {
            args.platform = value;
            index += 1;
        } else if (arg === '--task-kind' && value !== undefined) {
            args.taskKind = value;
            index += 1;
        } else if ((arg === '--mode' || arg === '--routing-mode') && value !== undefined) {
            args.routingMode = value;
            index += 1;
        } else if ((arg === '--failures' || arg === '--failure-count') && value !== undefined) {
            const parsed = Number.parseInt(value, 10);
            if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`Invalid failure count: ${value}`);
            args.failureCount = parsed;
            index += 1;
        } else {
            throw new Error(`Unknown orient option: ${arg}`);
        }
    }
    return args;
}

export function parseTasksArgs(argv: string[]): {
    from?: string;
    to?: string;
    task?: string;
    type?: string;
    reason?: string;
    root?: string;
} {
    const args: { from?: string; to?: string; task?: string; type?: string; reason?: string; root?: string } = {};
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const value = argv[index + 1];
        if (arg === '--from' && value !== undefined) {
            args.from = value;
            index += 1;
        } else if (arg === '--to' && value !== undefined) {
            args.to = value;
            index += 1;
        } else if ((arg === '--task' || arg === '--change') && value !== undefined) {
            args.task = value;
            index += 1;
        } else if (arg === '--type' && value !== undefined) {
            args.type = value;
            index += 1;
        } else if (arg === '--reason' && value !== undefined) {
            args.reason = value;
            index += 1;
        } else if (arg === '--root' && value !== undefined) {
            args.root = value;
            index += 1;
        } else if (arg?.startsWith('--')) {
            throw new Error(`Unknown tasks option: ${arg}`);
        } else if (!args.task) {
            args.task = arg;
        } else {
            throw new Error(`Unexpected tasks argument: ${arg}`);
        }
    }
    return args;
}

export function parseHooksArgs(argv: string[]): { change?: string; root?: string; role?: string; platform?: string } {
    const args: { change?: string; root?: string; role?: string; platform?: string } = {};
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const value = argv[index + 1];
        if (arg === '--change' && value !== undefined) {
            args.change = value;
            index += 1;
        } else if (arg === '--root' && value !== undefined) {
            args.root = value;
            index += 1;
        } else if (arg === '--role' && value !== undefined) {
            args.role = value;
            index += 1;
        } else if (arg === '--platform' && value !== undefined) {
            args.platform = value;
            index += 1;
        } else {
            throw new Error(`Unknown hooks option: ${arg}`);
        }
    }
    return args;
}
