import { splitFlag } from './invocation.js';
import { access, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { buildContextManifest, summarizeExcludedWiki } from '../core/context.js';
import { currentGitBranch } from '../core/git.js';
import { hashContent } from '../core/hash.js';
import {
    currentStatePath,
    relationsRelativePath,
    resolveWorkspaceRoot,
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

export interface StatusOptions {
    /**
     * Include the full context projection (`task`, `requiredReads`, `context`).
     *
     * Default false (L0-01). An explicitly anchored task used to build that projection here and build equivalent
     * context again inside the authoritative `orient` packet, so one invocation paid for two discovery passes over
     * the same task. `orient` answers "what is this task and what must I read"; `status` answers "which phase is
     * this and what runs next", and has to stay cheap enough to run before a confirmation prompt.
     */
    withContext?: boolean;
}

/** The engine stamp a task carries (C7), read without building the whole task context. */
async function readTaskEngine(root: string, change: string): Promise<{ version: string; stampedAt: string } | undefined> {
    try {
        const task = JSON.parse(await readFile(taskPath(root, change), 'utf8')) as { engine?: { version: string; stampedAt: string } };
        return task.engine;
    } catch {
        return undefined;
    }
}

export async function runLocalStatusCommand(
    change: string,
    resolved?: ResolvedTask | null,
    root = resolveWorkspaceRoot(),
    options: StatusOptions = {},
): Promise<Record<string, unknown>> {
    const terminal = await resolveTerminalTask(root, change);
    if (terminal.taskId !== change) {
        // A relation redirect is answerable without any context — the caller's next question is about the target.
        const targetStatus = await runLocalStatusCommand(terminal.taskId, resolved, root, options);
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
    // **The schema-validated reader.** `status` is the cross-platform resume entry point, so a state this command accepts
    // and a transition refuses is the worst place for the two to disagree; they now ask the same reader.
    const state = await readCurrentState(root, change);
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
    const withContext = options.withContext === true;
    // L0-01: build the context manifest only when it was asked for. `orient` is the packet that carries it, so a
    // status call that is about to be followed by an orient must not build it twice.
    const taskContext = withContext ? await readTaskContext(root, change) : null;
    const engine = taskContext?.engine ?? await readTaskEngine(root, change);
    // C7: a gate that asks for something it never asked for before is an engine change, not a mistake in this run, and
    // saying so costs one line where the absence of it cost a diagnostic cycle.
    const { engineChangeNote, engineVersion } = await import('../core/engine-version.js');
    const engineNote = engineChangeNote(engine);
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
        state,
        // `light` is stated rather than implied: a reader must be able to tell "no context because none was asked
        // for" from "no context because the task has none".
        ...(withContext ? {} : { light: true }),
        engine: { running: engineVersion(), ...(engine ? { task: engine } : {}) },
        ...(engineNote ? { engineNote } : {}),
        ...(taskContext
            ? {
                task: taskContext.task,
                requiredReads: taskContext.requiredReads,
                // Carried together, because "the list is shorter than you expected" is not something a reader can act on:
                // what was omitted, and the command that creates each, is the actionable half.
                ...(taskContext.absentRequiredReads.length === 0 ? {} : { absentRequiredReads: taskContext.absentRequiredReads }),
                context: taskContext.context,
            }
            : {}),
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

/** Whether a path exists, with anything other than "not found" allowed to surface rather than silently read as absent. */
async function pathExists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
    }
}

export async function readTaskContext(root: string, change: string): Promise<{
    task: { title: string; acceptance: Array<{ id?: string; statement: string }> };
    /** Only the paths that exist: a dispatch must not tell an agent to read a file that is not there. */
    requiredReads: string[];
    /** What was left out, why, and which command creates each. Empty when everything listed is present. */
    absentRequiredReads: Array<{ path: string; createdBy: string; note: string }>;
    context: Record<string, unknown>;
    engine?: { version: string; stampedAt: string };
}> {
    const taskRaw = await readFile(taskPath(root, change), 'utf8');
    const task = JSON.parse(taskRaw) as { title: string; acceptance: Array<{ id?: string; statement: string }>; engine?: { version: string; stampedAt: string } };
    let context: Awaited<ReturnType<typeof buildContextManifest>>;
    try {
        context = await buildContextManifest({ root, taskId: change, sourceRefs: [] });
    } catch {
        context = { taskId: change, sourceRefs: [], authoritativeWiki: [], excludedWiki: [], excludedWikiSummary: { relevant: [], unrelated: { count: 0, byReason: {} } }, warnings: [] };
    }
    return {
        ...(task.engine ? { engine: task.engine } : {}),
        task: {
            title: task.title,
            acceptance: task.acceptance,
        },
        // **A dispatch must not list a path it has not checked is there.** `.kata/skills-index.md` is written by
        // `kata-cli init`; in a repository that has never run it the file is absent, and the handoff named it anyway, so an
        // agent was told to read something that does not exist and nothing on the path said why. The answer already existed
        // — `adapters/doctor.ts` classifies it as a `support` check — it simply was not where the reader looks.
        requiredReads: await Promise.all(
            [
                'AGENTS.md',
                skillsIndexRelativePath,
                '.llmwiki/SCHEMA.md',
                '.llmwiki/index.md',
                '.llmwiki/log.md',
                `.kata/tasks/${change}/task.json`,
                `.kata/tasks/${change}/current-state.json`,
            ].map(async (path) => ({ path, present: await pathExists(join(root, path)) })),
        ).then((entries) => entries.filter((entry) => entry.present).map((entry) => entry.path)),
        /**
         * The reads the dispatch would have named and could not, with the reason and the command that creates each.
         *
         * Reported rather than dropped: an absent file the handoff silently stopped mentioning is the same omission in the
         * other direction — an agent cannot tell "this repository has no skills index" from "kata forgot to mention it".
         */
        absentRequiredReads: await Promise.all(
            [
                { path: skillsIndexRelativePath, createdBy: 'kata-cli init' },
                { path: '.llmwiki/SCHEMA.md', createdBy: 'kata-cli wiki ingest' },
                { path: '.llmwiki/index.md', createdBy: 'kata-cli wiki ingest' },
                { path: '.llmwiki/log.md', createdBy: 'kata-cli wiki ingest' },
            ].map(async (entry) => ({ ...entry, present: await pathExists(join(root, entry.path)) })),
        ).then((entries) => entries.filter((entry) => !entry.present).map(({ path, createdBy }) => ({ path, createdBy, note: `not present; ${createdBy} creates it` }))),
        context: {
            authoritativeWikiCount: context.authoritativeWiki.length,
            // L3-03: the relevant records keep their reasons; the rest is a count with a pointer at the Wiki's own audit,
            // so one task's handoff no longer carries the repository's whole history of drift. `excludedWikiCount` stays
            // as the total, because a caller comparing totals should not have to add the split back up.
            excludedWikiCount: context.excludedWiki.length,
            excludedWiki: context.excludedWikiSummary ?? summarizeExcludedWiki(context.excludedWiki),
            sourceRefs: context.sourceRefs,
            warnings: context.warnings,
        },
    };
}

export async function runTasksCommand(argv: string[]): Promise<Record<string, unknown>> {
    const [subcommand, ...rest] = argv;
    const args = parseTasksArgs(rest);
    const root = args.root ?? resolveWorkspaceRoot();
    if (subcommand === 'declare') {
        // **The entry point that was missing.** `upstreamCoverage` and `acceptanceMatrix` live in `task.json`, and until this
        // verb neither had a governed writer: `design` refused a change for an unmapped criterion and the only remedy
        // available to the author was editing the file by hand — outside every lock, with no record of who decided or why.
        // `ownedPaths` already had `scope change`; these two had nothing.
        if (!args.task || !args.field || !args.file || !args.reason) {
            throw new Error('Usage: kata-cli tasks declare --change <task-id> --field <upstreamCoverage|acceptanceMatrix> --file <json> --reason "<why>" [--by <actor>] [--root <path>]');
        }
        if (args.field !== 'upstreamCoverage' && args.field !== 'acceptanceMatrix') {
            throw new Error(`Unknown declaration field '${args.field}'; this command writes upstreamCoverage or acceptanceMatrix. A task's acceptance criteria are its contract and are not rewritten here.`);
        }
        const { declareTaskField } = await import('../quality/declaration-change.js');
        const value = JSON.parse(await readFile(args.file, 'utf8')) as unknown;
        const result = await declareTaskField({
            root,
            taskId: args.task,
            field: args.field,
            value,
            reason: args.reason,
            by: args.by ?? 'cli',
        });
        if (!result.ok) return { command: 'tasks declare', ok: false, error: result.refused };
        return {
            command: 'tasks declare',
            ok: true,
            taskId: args.task,
            field: result.field,
            summary: result.summary,
            record: 'declaration-changes.jsonl',
        };
    }
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
    // Validated like every other reader of this file. A corrupt state is surfaced here rather than falling back to
    // `intake`, which would present a task mid-review as one that has not started.
    const state = await readCurrentState(root, taskId).catch(() => null);
    const phase = state?.phase ?? 'intake';
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
    const state = await readCurrentState(root, change).catch(() => null) as Record<string, unknown> | null;
    const phase = (typeof state?.phase === 'string' ? state.phase : handoff.fromPhase) as Phase;
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
        ...(taskContext.absentRequiredReads.length === 0 ? {} : { absentRequiredReads: taskContext.absentRequiredReads }),
        // The packet's own read sets, so the receiver can see the split rather than guess which of thirteen paths is new.
        ...(contextPacket.context.continuedReads?.length
            ? {
                continuedReads: contextPacket.context.continuedReads,
                continuedReadsNote: 'Already acknowledged by this role at this content hash: listed for auditability, not required again.',
            }
            : {}),
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
        // R12-F13: both spellings and the flag-is-not-a-value guard, through the one reader.
        const { flag: arg, inline } = splitFlag(argv[index] ?? '');
        // **A flag is not the next flag's value.** Measured: `--root --dry-run` set a directory named `--dry-run` and wrote
        // 14 files into it, because the neighbour guard lived in `argValue` and not in the loop that called it (R12-F1).
        const neighbour = argv[index + 1];
        const value = inline ?? (neighbour === undefined || neighbour.startsWith('--') ? undefined : neighbour);
        if (arg === '--change' && value !== undefined && !value.startsWith('--')) {
            args.change = value;
            if (inline === undefined) index += 1;
        } else if (arg === '--root' && value !== undefined && !value.startsWith('--')) {
            args.root = value;
            if (inline === undefined) index += 1;
        } else if (arg === '--role' && value !== undefined && !value.startsWith('--')) {
            args.role = value;
            if (inline === undefined) index += 1;
        } else if (arg === '--platform' && value !== undefined && !value.startsWith('--')) {
            args.platform = value;
            if (inline === undefined) index += 1;
        } else if (arg === '--task-kind' && value !== undefined && !value.startsWith('--')) {
            args.taskKind = value;
            if (inline === undefined) index += 1;
        } else if ((arg === '--mode' || arg === '--routing-mode') && value !== undefined && !value.startsWith('--')) {
            args.routingMode = value;
            // An inline value consumes nothing (R12-F4): `index += 1` regardless of the spelling made two adjacent inline
            // flags swallow one another, silently dropping `--role=reviewer` next to `--mode=strict`.
            if (inline === undefined) index += 1;
        } else if ((arg === '--failures' || arg === '--failure-count') && value !== undefined && !value.startsWith('--')) {
            const parsed = Number.parseInt(value, 10);
            if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`Invalid failure count: ${value}`);
            args.failureCount = parsed;
            if (inline === undefined) index += 1;
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
    field?: string;
    file?: string;
    by?: string;
} {
    const args: { from?: string; to?: string; task?: string; type?: string; reason?: string; root?: string; field?: string; file?: string; by?: string } = {};
    for (let index = 0; index < argv.length; index += 1) {
        // R12-F13: both spellings and the flag-is-not-a-value guard, through the one reader.
        const { flag: arg, inline } = splitFlag(argv[index] ?? '');
        // **A flag is not the next flag's value.** Measured: `--root --dry-run` set a directory named `--dry-run` and wrote
        // 14 files into it, because the neighbour guard lived in `argValue` and not in the loop that called it (R12-F1).
        const neighbour = argv[index + 1];
        const value = inline ?? (neighbour === undefined || neighbour.startsWith('--') ? undefined : neighbour);
        if (arg === '--from' && value !== undefined && !value.startsWith('--')) {
            args.from = value;
            if (inline === undefined) index += 1;
        } else if (arg === '--to' && value !== undefined && !value.startsWith('--')) {
            args.to = value;
            if (inline === undefined) index += 1;
        } else if (arg === '--field' && value !== undefined && !value.startsWith('--')) {
            args.field = value;
            if (inline === undefined) index += 1;
        } else if (arg === '--file' && value !== undefined && !value.startsWith('--')) {
            args.file = value;
            if (inline === undefined) index += 1;
        } else if (arg === '--by' && value !== undefined && !value.startsWith('--')) {
            args.by = value;
            if (inline === undefined) index += 1;
        } else if ((arg === '--task' || arg === '--change') && value !== undefined && !value.startsWith('--')) {
            args.task = value;
            if (inline === undefined) index += 1;
        } else if (arg === '--type' && value !== undefined && !value.startsWith('--')) {
            args.type = value;
            if (inline === undefined) index += 1;
        } else if (arg === '--reason' && value !== undefined && !value.startsWith('--')) {
            args.reason = value;
            if (inline === undefined) index += 1;
        } else if (arg === '--root' && value !== undefined && !value.startsWith('--')) {
            args.root = value;
            if (inline === undefined) index += 1;
        } else if (arg?.startsWith('--')) {
            throw new Error(`Unknown tasks option: ${argv[index]}`);
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
        // R12-F13: both spellings and the flag-is-not-a-value guard, through the one reader.
        const { flag: arg, inline } = splitFlag(argv[index] ?? '');
        // **A flag is not the next flag's value.** Measured: `--root --dry-run` set a directory named `--dry-run` and wrote
        // 14 files into it, because the neighbour guard lived in `argValue` and not in the loop that called it (R12-F1).
        const neighbour = argv[index + 1];
        const value = inline ?? (neighbour === undefined || neighbour.startsWith('--') ? undefined : neighbour);
        if (arg === '--change' && value !== undefined && !value.startsWith('--')) {
            args.change = value;
            if (inline === undefined) index += 1;
        } else if (arg === '--root' && value !== undefined && !value.startsWith('--')) {
            args.root = value;
            if (inline === undefined) index += 1;
        } else if (arg === '--role' && value !== undefined && !value.startsWith('--')) {
            args.role = value;
            if (inline === undefined) index += 1;
        } else if (arg === '--platform' && value !== undefined && !value.startsWith('--')) {
            args.platform = value;
            if (inline === undefined) index += 1;
        } else {
            throw new Error(`Unknown hooks option: ${arg}`);
        }
    }
    return args;
}
