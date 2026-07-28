export const isolationModes = ['current_worktree', 'isolated_worktree', 'git_flow', 'user_decides'] as const;
export const developmentModes = ['tdd', 'standard'] as const;
export const reviewModes = ['std', 'strict', 'security'] as const;
export const cometProjectInitStatuses = ['not_requested', 'initialized', 'skipped', 'failed'] as const;
export const cometOpenStatuses = ['required', 'acknowledged'] as const;

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
  comet: { projectInit: CometProjectInitStatus; openStatus: CometOpenStatus };
  gitFlow?: GitFlowState;
  strictClosure?: boolean;
}

export function defaultWorkflowProfile(): WorkflowProfile {
  return { version: 1, isolationMode: 'current_worktree', developmentMode: 'tdd', reviewMode: 'std', comet: { projectInit: 'not_requested', openStatus: 'required' } };
}

export function isWorkflowProfile(value: unknown): value is WorkflowProfile {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<WorkflowProfile>;
  return candidate.version === 1
    && isolationModes.includes(candidate.isolationMode as IsolationMode)
    && developmentModes.includes(candidate.developmentMode as DevelopmentMode)
    && reviewModes.includes(candidate.reviewMode as ReviewMode)
    && typeof candidate.comet === 'object'
    && candidate.comet !== null
    && cometProjectInitStatuses.includes(candidate.comet.projectInit as CometProjectInitStatus)
    && cometOpenStatuses.includes(candidate.comet.openStatus as CometOpenStatus)
    && (candidate.gitFlow === undefined || isGitFlowState(candidate.gitFlow));
}

export function profileGuardInstructions(profile: WorkflowProfile | undefined, role: string): string[] {
  if (!profile) return [];
  const instructions: string[] = [];
  if (profile.isolationMode === 'isolated_worktree') instructions.push('Use the selected isolated worktree; do not silently move or recreate the current session worktree.');
  if (profile.isolationMode === 'git_flow' && profile.gitFlow?.status === 'active') instructions.push(`Work on ${profile.gitFlow.branch}; do not start, finish, or switch Git Flow branches outside the recorded task action.`);
  if (profile.isolationMode === 'git_flow' && profile.gitFlow?.status !== 'active') instructions.push('Git Flow branch creation is pending or failed; do not start, finish, or switch branches until the recorded task action succeeds.');
  if (profile.isolationMode === 'user_decides') instructions.push('Ask the user to choose current versus isolated worktree before implementation changes.');
  if (role === 'implementer' && profile.developmentMode === 'tdd') instructions.push('Use TDD: write a focused failing test, verify RED, implement the minimum, then verify GREEN.');
  if (role === 'reviewer' && profile.reviewMode === 'strict') instructions.push('Strict review: inspect architecture boundaries, regression risk, and missing focused tests.');
  if (role === 'reviewer' && profile.reviewMode === 'security') instructions.push('Security review: inspect trust boundaries, secrets, dependency changes, input validation, and authorization effects.');
  return instructions;
}

export async function acknowledgeCometOpen(root: string, taskId: string): Promise<WorkflowProfile> {
  const { readFile, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const path = join(root, '.kata/tasks', taskId, 'task.json');
  const task = JSON.parse(await readFile(path, 'utf8')) as { workflowProfile?: unknown };
  const profile = isWorkflowProfile(task.workflowProfile) ? task.workflowProfile : defaultWorkflowProfile();
  const next: WorkflowProfile = { ...profile, comet: { ...profile.comet, openStatus: 'acknowledged' } };
  task.workflowProfile = next;
  await writeFile(path, `${JSON.stringify(task, null, 2)}\n`, 'utf8');
  return next;
}

export async function updateGitFlowProfile(root: string, taskId: string, gitFlow: GitFlowState): Promise<WorkflowProfile> {
  const { readFile, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const path = join(root, '.kata/tasks', taskId, 'task.json');
  const task = JSON.parse(await readFile(path, 'utf8')) as { workflowProfile?: unknown };
  const profile = isWorkflowProfile(task.workflowProfile) ? task.workflowProfile : defaultWorkflowProfile();
  const next: WorkflowProfile = { ...profile, gitFlow };
  task.workflowProfile = next;
  await writeFile(path, `${JSON.stringify(task, null, 2)}\n`, 'utf8');
  return next;
}

function isGitFlowState(value: unknown): value is GitFlowState {
  if (typeof value !== 'object' || value === null) return false;
  const state = value as Partial<GitFlowState>;
  return (state.strategy === 'git-flow' || state.strategy === 'manual')
    && typeof state.branch === 'string'
    && typeof state.baseBranch === 'string'
    && (state.status === 'active' || state.status === 'pending_confirmation' || state.status === 'failed')
    && (state.installation === undefined || isGitFlowInstallation(state.installation));
}

function isGitFlowInstallation(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const installation = value as { status?: unknown; command?: unknown; manualCommand?: unknown };
  return (installation.status === 'installed' || installation.status === 'failed' || installation.status === 'unsupported')
    && (installation.command === undefined || (Array.isArray(installation.command) && installation.command.every((part) => typeof part === 'string')))
    && (installation.manualCommand === undefined || (
      typeof installation.manualCommand === 'string'
      && installation.manualCommand.length <= 500
      && !/[\r\n]/.test(installation.manualCommand)
    ));
}
import type { GitFlowState } from './git-flow.js';
