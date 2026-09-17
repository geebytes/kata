import { readFile } from 'node:fs/promises';
import {
    addKataRelation,
    addTaskRelation,
    findKataRelations,
    readTaskRelations,
    resolveTerminalTask,
    type RelationEndpoint,
    type TaskRelationType,
} from '../core/relations.js';
import { taskPath } from '../core/layout.js';
import { isWorkflowProfile } from '../core/workflow-profile.js';
import {
    applyGitFlowPlan,
    inspectGitFlow,
    type GitFlowBranchKind,
    type GitFlowPlan as GitFlowPlanType,
} from '../core/git-flow.js';
import { relationsRelativePath, resolveWorkspaceRoot } from '../core/layout.js';
import { parseChangeArg } from './invocation.js';
import type { GitFlowPlan } from '../core/git-flow.js';
import { updateGitFlowProfile, type WorkflowProfile } from '../core/workflow-profile.js';

/**
 * The relations and Git Flow family.
 *
 * Relations are the task graph's edges (`relations add|list|resolve`), and Git Flow is the isolation mode that moves a
 * task onto its own branch (`git-flow apply`). Both are commands about *where a task sits*, so they travel together and
 * neither imports the entry point: the entry point parses the invocation, calls a handler here, and prints the result.
 */

export async function runGitFlowCommand(argv: string[], root: string): Promise<Record<string, unknown>> {
    if (argv[0] !== 'apply') throw new Error('Usage: kata-cli git-flow apply --change <task-id>');
    const taskId = parseChangeArg(argv.slice(1));
    if (!taskId) throw new Error('Usage: kata-cli git-flow apply --change <task-id>');
    const task = JSON.parse(await readFile(taskPath(root, taskId), 'utf8')) as { workflowProfile?: unknown };
    if (!isWorkflowProfile(task.workflowProfile) || task.workflowProfile.isolationMode !== 'git_flow') {
        throw new Error(`Task ${taskId} does not use Git Flow isolation`);
    }
    const inspected = inspectGitFlow(root, taskId, undefined, gitFlowBranchKindForProfile(task.workflowProfile));
    if (inspected.status === 'pending_confirmation' && !argv.includes('--confirm')) {
        return {
            command: 'git-flow apply', taskId, workflowProfile: task.workflowProfile,
            nextAction: {
                slashCommand: '/kata',
                cliCommand: `kata-cli git-flow apply --change ${taskId} --confirm`,
                reason: 'git_flow_confirmation_required',
                requiresUserConfirmation: true,
            },
        };
    }
    const state = inspected.status === 'pending_confirmation' ? applyGitFlowPlan(root, inspected) : inspected;
    const workflowProfile = await updateGitFlowProfile(root, taskId, state);
    return {
        command: 'git-flow apply', taskId, workflowProfile,
        nextAction: state.status === 'active'
            ? { slashCommand: `/kata-design ${taskId}`, cliCommand: `kata-cli design --change ${taskId}` }
            : { cliCommand: `kata-cli git-flow apply --change ${taskId} --confirm`, reason: (inspected as GitFlowPlan).reason ?? 'git_flow_setup_failed' },
    };
}

export async function runRelationsCommand(argv: string[]): Promise<Record<string, unknown>> {
    const [subcommand, ...rest] = argv;
    const args = parseRelationsArgs(rest);
    const root = args.root ?? resolveWorkspaceRoot();
    if (subcommand === 'add' || subcommand === 'relate') {
        if (!args.from || !args.to || !args.type) {
            throw new Error('Usage: kata-cli relations add --from <task:id|change:id> --to <task:id|change:id> --type <relation> [--reason <text>] [--root <path>]');
        }
        const from = parseRelationEndpoint(args.from);
        const to = parseRelationEndpoint(args.to);
        const graph = await addKataRelation({
            root,
            from,
            to,
            type: parseTaskRelationType(args.type),
            ...(args.reason ? { reason: args.reason } : {}),
            createdBy: 'kata-cli',
        });
        return {
            command: 'relations add',
            from,
            to,
            type: args.type,
            graphPath: relationsRelativePath,
            relation: graph.relations.at(-1) ?? null,
        };
    }
    if (subcommand === 'show' || subcommand === 'list') {
        if (!args.id) throw new Error('Usage: kata-cli relations show --id <task:id|change:id> [--root <path>]');
        const endpoint = parseRelationEndpoint(args.id);
        return {
            command: 'relations show',
            ...(await findKataRelations(root, endpoint)),
        };
    }
    throw new Error(`Unknown relations command: ${subcommand ?? ''}`);
}

function parseRelationsArgs(argv: string[]): {
    from?: string;
    to?: string;
    id?: string;
    type?: string;
    reason?: string;
    root?: string;
} {
    const args: { from?: string; to?: string; id?: string; type?: string; reason?: string; root?: string } = {};
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const value = argv[index + 1];
        if (arg === '--from' && value !== undefined) {
            args.from = value;
            index += 1;
        } else if (arg === '--to' && value !== undefined) {
            args.to = value;
            index += 1;
        } else if ((arg === '--id' || arg === '--endpoint') && value !== undefined) {
            args.id = value;
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
        } else {
            throw new Error(`Unknown relations option: ${arg}`);
        }
    }
    return args;
}

export function gitFlowBranchKindForProfile(profile: WorkflowProfile): GitFlowBranchKind {
    return profile.gitFlow?.branch.startsWith('hotfix/') ? 'hotfix' : 'feature';
}

export function parseRelationEndpoint(value: string): RelationEndpoint {
    const separator = value.indexOf(':');
    if (separator === -1) {
        return { type: 'task', id: value };
    }
    const type = value.slice(0, separator);
    const id = value.slice(separator + 1);
    if ((type === 'task' || type === 'change') && id.length > 0) return { type, id };
    throw new Error(`Invalid relation endpoint: ${value}`);
}

export function parseTaskRelationType(value: string): TaskRelationType {
    const allowed: TaskRelationType[] = [
        'superseded_by',
        'covered_by',
        'duplicate_of',
        'merged_into',
        'parent_of',
        'spawned_from',
        'related_to',
        'contains',
        'implements',
        'repairs',
        'depends_on',
        'blocked_by',
    ];
    if (allowed.includes(value as TaskRelationType)) return value as TaskRelationType;
    throw new Error(`Invalid task relation type: ${value}`);
}
