import type { TaskRecord } from '../core/task.js';
export interface Actor {
    id: string;
    role: string;
}
export type PermissionResult = {
    allowed: true;
} | {
    allowed: false;
    reason: PermissionDenialReason;
};
export type PermissionDenialReason = 'invalid_path' | 'protected_rules_or_verified_wiki' | 'role_scope_violation' | 'unknown_role' | 'task_scope_violation';
export declare function validateWrite(actor: Actor, path: string, task: TaskRecord): PermissionResult;
//# sourceMappingURL=permissions.d.ts.map