import { execFileSync } from 'node:child_process';

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

export interface GitCommandResult { ok: boolean; stdout: string; }
export type GitCommandRunner = (root: string, args: string[]) => GitCommandResult;

const runGit: GitCommandRunner = (root, args) => {
  try {
    return { ok: true, stdout: execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() };
  } catch {
    return { ok: false, stdout: '' };
  }
};

export function inspectGitFlow(root: string, taskId: string, run: GitCommandRunner = runGit): GitFlowPlan {
  const dirty = run(root, ['status', '--porcelain']);
  if (!dirty.ok) return failed('repository_unavailable');
  const unmanagedChanges = (dirty.stdout ?? '').split('\n').filter((line) => line.trim() && !line.slice(3).startsWith('.kata/'));
  if (unmanagedChanges.length > 0) return failed('worktree_dirty');

  const currentBranch = run(root, ['branch', '--show-current']);
  const configuredBase = run(root, ['config', '--get', 'gitflow.branch.develop']);
  const baseBranch = configuredBase.ok && configuredBase.stdout
    ? configuredBase.stdout
    : run(root, ['rev-parse', '--verify', '--quiet', 'develop']).ok
      ? 'develop'
      : currentBranch.ok && currentBranch.stdout
        ? currentBranch.stdout
        : '';
  if (!baseBranch) return failed('base_branch_unresolved');

  const branch = `feature/${taskId}`;
  const existing = run(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).ok;
  const gitFlowAvailable = configuredBase.ok && run(root, ['flow', 'version']).ok;
  const strategy: GitFlowStrategy = gitFlowAvailable ? 'git-flow' : 'manual';
  if (existing) {
    if (currentBranch.stdout === branch) return { strategy, branch, baseBranch, status: 'active', command: [] };
    return { strategy, branch, baseBranch, status: 'failed', command: [], reason: 'target_branch_exists' };
  }
  return {
    strategy,
    branch,
    baseBranch,
    status: 'pending_confirmation',
    command: strategy === 'git-flow' ? ['flow', 'feature', 'start', taskId] : ['switch', '-c', branch, baseBranch],
  };
}

export function applyGitFlowPlan(root: string, plan: GitFlowPlan, run: GitCommandRunner = runGit): GitFlowState {
  if (plan.status !== 'pending_confirmation' || plan.command.length === 0) return { ...plan, status: 'failed' };
  const result = run(root, plan.command);
  return { strategy: plan.strategy, branch: plan.branch, baseBranch: plan.baseBranch, status: result.ok ? 'active' : 'failed' };
}

function failed(reason: string): GitFlowPlan {
  return { strategy: 'manual', branch: '', baseBranch: '', status: 'failed', command: [], reason };
}
