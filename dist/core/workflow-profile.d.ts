export declare const isolationModes: readonly ["current_worktree", "isolated_worktree", "git_flow", "user_decides"];
export declare const developmentModes: readonly ["tdd", "standard"];
export declare const reviewModes: readonly ["std", "strict", "security"];
export declare const cometProjectInitStatuses: readonly ["not_requested", "initialized", "skipped", "failed"];
export declare const cometOpenStatuses: readonly ["required", "acknowledged"];
export type IsolationMode = (typeof isolationModes)[number];
export type DevelopmentMode = (typeof developmentModes)[number];
export type ReviewMode = (typeof reviewModes)[number];
export type CometProjectInitStatus = (typeof cometProjectInitStatuses)[number];
export type CometOpenStatus = (typeof cometOpenStatuses)[number];
export interface WorkflowProfile {
    version: 1;
    isolationMode: IsolationMode;
    developmentMode: DevelopmentMode;
    reviewMode: ReviewMode;
    comet: {
        projectInit: CometProjectInitStatus;
        openStatus: CometOpenStatus;
    };
    gitFlow?: GitFlowState;
    strictClosure?: boolean;
}
export declare function defaultWorkflowProfile(): WorkflowProfile;
export declare function isWorkflowProfile(value: unknown): value is WorkflowProfile;
export declare function profileGuardInstructions(profile: WorkflowProfile | undefined, role: string): string[];
export declare function acknowledgeCometOpen(root: string, taskId: string): Promise<WorkflowProfile>;
export declare function updateGitFlowProfile(root: string, taskId: string, gitFlow: GitFlowState): Promise<WorkflowProfile>;
import type { GitFlowState } from './git-flow.js';
//# sourceMappingURL=workflow-profile.d.ts.map