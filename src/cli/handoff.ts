import { discoverPlatforms } from '../adapters/discovery.js';
import { resolveWorkspaceRoot, resolveWorkspaceRootForTask } from '../core/layout.js';
import { activateHookTask } from '../hooks/runtime.js';
import {
    acknowledgeContextPacket,
    createContextPacket,
    readContextPacket,
    verifyContextPacket,
} from '../workflow/context-fabric.js';
import { renderDelegationPrompt } from '../workflow/delegation-prompt.js';
import { type Role as HandoffRole } from '../workflow/handoff.js';
import { createPacketHash, listTaskCandidates, readTaskCandidate, type TaskCandidate } from './tasks.js';

/**
 * The handoff and delegation family: the two ways work crosses a boundary between agents.
 *
 * A handoff is the structured packet one role leaves for the next (create, show, verify, acknowledge); a delegation is
 * the prompt that tells another platform's agent to pick a task up. They travel together because a delegation ends in a
 * handoff, and they share the packet hashing, the candidate discovery and the platform recommendation.
 */

export async function runHandoffCommand(argv: string[]): Promise<Record<string, unknown>> {
    const [subcommand, ...rest] = argv;
    const args = parseHandoffArgs(rest);
    const root = args.root ?? (args.task ? resolveWorkspaceRootForTask(args.task) : resolveWorkspaceRoot());
    if (!args.task) throw new Error('Usage: kata-cli handoff <create|show|verify|acknowledge> --task <id>');
    if (subcommand === 'create') {
        if (!args.from || !args.to) throw new Error('Usage: kata-cli handoff create --task <id> --from <role> --to <role>');
        const packet = await createContextPacket({ root, taskId: args.task, fromRole: args.from as HandoffRole, toRole: args.to as HandoffRole, ...(args.platform ? { platform: args.platform } : {}) });
        return { command: 'handoff create', taskId: args.task, id: packet.id, path: `.kata/tasks/${args.task}/handoffs/${packet.id}.json`, sha256: createPacketHash(packet), packet };
    }
    if (!args.id) throw new Error('Usage: kata-cli handoff <show|verify|acknowledge> --task <id> --id <handoff-id>');
    if (subcommand === 'show') return { command: 'handoff show', packet: await readContextPacket(root, args.task, args.id) };
    if (subcommand === 'verify') return { command: 'handoff verify', ...(await verifyContextPacket({ root, taskId: args.task, id: args.id })) };
    if (subcommand === 'acknowledge') {
        if (!args.platform || !args.role) throw new Error('Usage: kata-cli handoff acknowledge --task <id> --id <handoff-id> --platform <name> --role <role>');
        const receipt = await acknowledgeContextPacket({ root, taskId: args.task, id: args.id, platform: args.platform, role: args.role as HandoffRole });
        const active = await activateHookTask({
            root,
            taskId: args.task,
            role: args.role,
            platform: args.platform,
            origin: 'handoff',
        }).catch((error: unknown) => {
            if (error instanceof Error && error.message.includes('does not match current phase')) return null;
            throw error;
        });
        return {
            command: 'handoff acknowledge',
            receipt,
            ...(active ? {
                activeTask: {
                    taskId: active.taskId,
                    role: active.role,
                    phase: active.phase,
                    ...(active.platform ? { platform: active.platform } : {}),
                    ...(active.branch ? { branch: active.branch } : {}),
                    ...(active.origin ? { origin: active.origin } : {}),
                    active: true,
                }
            } : {}),
        };
    }
    throw new Error(`Unknown handoff command: ${subcommand ?? ''}`);
}

export async function runDelegateCommand(argv: string[]): Promise<Record<string, unknown>> {
    const args = parseDelegationArgs(argv);
    const root = args.root ?? resolveWorkspaceRoot();
    const candidates = await listTaskCandidates(root);
    const selected = args.change ? candidates.find((task) => task.taskId === args.change) ?? await readTaskCandidate(root, args.change) : undefined;
    const recommendedTask = selected ?? recommendDelegationTask(candidates);
    const targetRole = args.role ?? inferDelegationRole(recommendedTask?.phase);
    const fromRole = args.from ?? inferCurrentRole(recommendedTask?.phase);
    const platforms = await discoverPlatforms({ root });
    const recommendedPlatform = args.to ?? recommendPlatform(platforms.map((platform) => platform.platform), targetRole);

    const base = {
        command: 'delegate',
        mode: args.create && selected ? 'create' : 'interactive',
        selectedTask: selected ?? null,
        candidates,
        recommended: {
            taskId: recommendedTask?.taskId ?? null,
            role: targetRole,
            platform: recommendedPlatform,
        },
        options: {
            roles: ['implementer', 'reviewer', 'judge', 'distiller'],
            platforms: platforms.map((platform) => ({
                platform: platform.platform,
                detected: platform.detected,
                scope: platform.scope,
                capabilities: platform.capabilities,
            })),
        },
        askUser: [
            selected ? `确认委托任务：${selected.taskId}` : '请选择要委托的 Kata task，或输入 task id。',
            `确认目标角色：${targetRole}`,
            recommendedPlatform ? `确认目标平台：${recommendedPlatform}` : '请选择目标平台，或输入自定义平台名。',
        ],
    };

    if (!args.create || !selected) return base;
    const packet = await createContextPacket({
        root,
        taskId: selected.taskId,
        fromRole: fromRole as HandoffRole,
        toRole: targetRole as HandoffRole,
        ...(recommendedPlatform ? { platform: recommendedPlatform } : {}),
    });
    const verification = await verifyContextPacket({ root, taskId: selected.taskId, id: packet.id });
    return {
        ...base,
        handoff: {
            id: packet.id,
            path: `.kata/tasks/${selected.taskId}/handoffs/${packet.id}.json`,
            sha256: createPacketHash(packet),
            verification,
        },
        targetPrompt: renderDelegationPrompt(selected.taskId, packet.id, recommendedPlatform ?? '<platform>', targetRole, packet.context.designRefs),
    };
}

export type DelegationArgs = { change?: string; to?: string; role?: string; from?: string; root?: string; create?: boolean };

export function parseDelegationArgs(argv: string[]): DelegationArgs {
    const args: DelegationArgs = {};
    for (let index = 0; index < argv.length; index += 1) {
        const key = argv[index];
        const value = argv[index + 1];
        if (key === '--change' || key === '--task') {
            if (value === undefined) throw new Error(`${key} requires a value`);
            args.change = value; index += 1; continue;
        }
        if (key === '--to' || key === '--platform') {
            if (value === undefined) throw new Error(`${key} requires a value`);
            args.to = value; index += 1; continue;
        }
        if (key === '--role') {
            if (value === undefined) throw new Error(`${key} requires a value`);
            args.role = value; index += 1; continue;
        }
        if (key === '--from') {
            if (value === undefined) throw new Error(`${key} requires a value`);
            args.from = value; index += 1; continue;
        }
        if (key === '--root') {
            if (value === undefined) throw new Error(`${key} requires a value`);
            args.root = value; index += 1; continue;
        }
        if (key === '--create') {
            args.create = true; continue;
        }
        if (key?.startsWith('--')) throw new Error(`Unknown delegation option: ${key}`);
        if (!args.change) args.change = key;
    }
    return args;
}

export function inferDelegationRole(phase?: string): string {
    if (phase === 'hardVerify') return 'reviewer';
    if (phase === 'review') return 'judge';
    if (phase === 'judge' || phase === 'distill') return 'distiller';
    return 'implementer';
}

export function inferCurrentRole(phase?: string): string {
    if (phase === 'hardVerify') return 'implementer';
    if (phase === 'review') return 'reviewer';
    if (phase === 'judge' || phase === 'distill') return 'judge';
    return 'designer';
}

export function recommendDelegationTask(candidates: Array<{ phase: string }>): { phase: string; taskId?: string } | undefined {
    return candidates.find((task) => task.phase === 'plan' || task.phase === 'implement')
        ?? candidates.find((task) => task.phase === 'hardVerify' || task.phase === 'review')
        ?? candidates.find((task) => task.phase !== 'archive')
        ?? candidates[0];
}

export function recommendPlatform(platforms: string[], role: string): string | undefined {
    const preferred = role === 'implementer'
        ? ['opencode', 'codex', 'claude-code', 'github-copilot', 'pi']
        : ['codex', 'claude-code', 'github-copilot', 'opencode', 'pi'];
    return preferred.find((platform) => platforms.includes(platform)) ?? platforms.find((platform) => platform !== 'generic') ?? platforms[0];
}

export function parseHandoffArgs(argv: string[]): { task?: string; id?: string; from?: string; to?: string; role?: string; platform?: string; root?: string } {
    const args: { task?: string; id?: string; from?: string; to?: string; role?: string; platform?: string; root?: string } = {};
    for (let index = 0; index < argv.length; index += 1) {
        const key = argv[index]; const value = argv[index + 1];
        const target = key === '--task' ? 'task' : key === '--id' ? 'id' : key === '--from' ? 'from' : key === '--to' ? 'to' : key === '--role' ? 'role' : key === '--platform' ? 'platform' : key === '--root' ? 'root' : undefined;
        if (!target || value === undefined) throw new Error(`Unknown handoff option: ${key}`);
        args[target] = value; index += 1;
    }
    return args;
}
