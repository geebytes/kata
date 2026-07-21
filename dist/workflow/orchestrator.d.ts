import { type Phase } from '../core/state.js';
import { type CheckCommand } from '../quality/evidence.js';
import { CometGuard } from '../comet/guard.js';
import { type WorkflowProfile } from '../core/workflow-profile.js';
import { type Waiver } from '../quality/acceptance-matrix.js';
import type { CheckProgressEvent } from '../quality/evidence.js';
export type KataCommand = 'open' | 'design' | 'build' | 'review' | 'judge' | 'verify' | 'archive' | 'hotfix' | 'tweak';
export interface CommandResult {
    command: KataCommand;
    taskId: string;
    phase: Phase;
    success: boolean;
    diagnostics?: Record<string, unknown>;
    error?: string;
}
export interface CommandOptions {
    title?: string;
    acceptance?: Array<{
        id?: string;
        statement: string;
    }>;
    checks?: CheckCommand[];
    guard?: CometGuard;
    platform?: string;
    seal?: boolean;
    approve?: boolean;
    allowOwnershipConflicts?: boolean;
    workflowProfile?: WorkflowProfile;
    ownedPaths?: string[];
    waivers?: Waiver[];
    signal?: AbortSignal;
    onProgress?: (event: CheckProgressEvent) => void;
}
export declare function runCommand(command: KataCommand, taskId: string, root: string, options?: CommandOptions): Promise<CommandResult>;
//# sourceMappingURL=orchestrator.d.ts.map