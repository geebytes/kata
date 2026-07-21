export type GitFlowStrategy = 'git-flow' | 'manual';
export type GitFlowStatus = 'active' | 'pending_confirmation' | 'failed';
export interface GitFlowState {
    strategy: GitFlowStrategy;
    branch: string;
    baseBranch: string;
    status: GitFlowStatus;
}
export interface GitFlowPlan extends GitFlowState {
    command: string[];
    reason?: string;
}
export interface GitCommandResult {
    ok: boolean;
    stdout: string;
}
export type GitCommandRunner = (root: string, args: string[]) => GitCommandResult;
export declare function inspectGitFlow(root: string, taskId: string, run?: GitCommandRunner): GitFlowPlan;
export declare function applyGitFlowPlan(root: string, plan: GitFlowPlan, run?: GitCommandRunner): GitFlowState;
//# sourceMappingURL=git-flow.d.ts.map