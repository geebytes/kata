import { taskPath } from './layout.js';
import { mutateTaskArtefact } from './state.js';
import { validate } from './schema.js';
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
  return updateProfile(root, taskId, (profile) => ({
    ...profile,
    comet: { ...profile.comet, openStatus: 'acknowledged' },
  }));
}

/**
 * Persist a git-flow **state**, refusing anything that would leave a record its own reader rejects.
 *
 * **Two halves, and the writer needed both.** The parameter is a `GitFlowState`, but `GitFlowPlan extends GitFlowState`, so
 * the type does not stop a caller handing over a plan — measured downstream, where `command: []` reached `task.json` on
 * every git_flow `open` and made the next `readTask` refuse the file kata had just written. Projecting at the call sites is
 * the first half (`toGitFlowState`); validating the result here is the second, and it is the one that cannot be forgotten by
 * a future call site: a writer that can persist a schema-invalid artefact is the defect, whatever the argument's type says.
 *
 * Same shape as `quality/declaration-change.ts`, which validates the task a declaration would produce before writing it.
 */
export async function updateGitFlowProfile(root: string, taskId: string, gitFlow: GitFlowState): Promise<WorkflowProfile> {
  return updateProfile(root, taskId, (profile) => ({ ...profile, gitFlow }), (task) => validate('task', task));
}

/**
 * The one way a profile change reaches `task.json`: read, change and write inside the task lock, atomically.
 *
 * The two writers above used to be plain read-modify-writes outside any lock, so two commands on one task could lose an
 * update (L3-09). The lock has to cover the read as well as the write, which is why the change is expressed as a
 * function rather than as the new profile.
 */
async function updateProfile(
  root: string,
  taskId: string,
  change: (profile: WorkflowProfile) => WorkflowProfile,
  /**
   * Run against the whole task before it is written, so the write and the read agree about what a task is.
   *
   * Optional because most profile changes cannot make a record invalid, and required at the one writer that could: the
   * git-flow profile was the only place a value the schema forbids could arrive, and it arrived from a type that claimed to
   * be something it was not.
   */
  check?: (task: Record<string, unknown>) => void,
): Promise<WorkflowProfile> {
  const { readFile } = await import('node:fs/promises');
  const path = taskPath(root, taskId);
  let next: WorkflowProfile = defaultWorkflowProfile();
  await mutateTaskArtefact(root, taskId, path, async () => {
    const task = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown> & { workflowProfile?: unknown };
    const profile = isWorkflowProfile(task.workflowProfile) ? task.workflowProfile : defaultWorkflowProfile();
    next = change(profile);
    task.workflowProfile = next;
    // Before the write, inside the lock: an invalid record must never reach the disk, because every reader validates and
    // the failure then surfaces one command later, at a step someone else was told to take.
    try {
      check?.(task);
    } catch (error) {
      throw new Error(
        `refusing to persist a workflow profile this task's own schema rejects: ${(error as Error).message}. `
        + 'Nothing was written: the file on disk is unchanged.',
      );
    }
    return `${JSON.stringify(task, null, 2)}\n`;
  });
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
