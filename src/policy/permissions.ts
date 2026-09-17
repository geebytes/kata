import { relative, resolve } from 'node:path';
import type { TaskRecord } from '../core/task.js';
import { evaluateHookWrite, normalizeHookPath, type PolicyActor } from './hook-policy.js';

export interface Actor extends PolicyActor {
    id: string;
}

export type PermissionResult = { allowed: true } | { allowed: false; reason: PermissionDenialReason };

export type PermissionDenialReason =
    | 'invalid_path'
    | 'phase_scope_violation'
    | 'protected_rules_or_verified_wiki'
    | 'role_scope_violation'
    | 'unknown_role'
    | 'task_scope_violation';

/**
 * The in-process half of the write policy. The rule itself lives in `hook-policy.ts`, which the emitted platform
 * hook embeds verbatim, so this function and the guard a developer actually runs cannot disagree.
 */
export function validateWrite(actor: Actor, path: string, task: TaskRecord, root: string = process.cwd()): PermissionResult {
    const normalizedPath = normalizeHookPath(root, path, { resolve, relative });
    const denial = evaluateHookWrite(actor, normalizedPath, { id: task.id, phase: task.phase });
    if (denial) return deny(denial as PermissionDenialReason);
    return { allowed: true };
}

function deny(reason: PermissionDenialReason): PermissionResult {
    return { allowed: false, reason };
}
