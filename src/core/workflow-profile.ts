import { taskPath } from './layout.js';
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



export async function acknowledgeCometOpen(root: string, taskId: string): Promise<WorkflowProfile> {
  const { readFile, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const path = taskPath(root, taskId);
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
  const path = taskPath(root, taskId);
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

export { profileGuardInstructions } from '../policy/guard-instructions.js';
