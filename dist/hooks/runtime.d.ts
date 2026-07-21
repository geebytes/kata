import type { Phase } from '../core/state.js';
import { currentGitBranch } from '../core/git.js';
export type ActiveHookTask = {
    taskId: string;
    role: string;
    phase: Phase;
    platform?: string;
    branch?: string;
    origin?: 'manual' | 'discovered' | 'handoff' | 'workflow';
    activatedAt: string;
};
export declare function activateHookTask(input: {
    root: string;
    taskId: string;
    role: string;
    platform?: string;
    origin?: ActiveHookTask['origin'];
}): Promise<ActiveHookTask>;
export { currentGitBranch };
export declare function deactivateHookTask(root: string): Promise<void>;
export declare function readActiveHookTask(root: string): Promise<ActiveHookTask | null>;
//# sourceMappingURL=runtime.d.ts.map