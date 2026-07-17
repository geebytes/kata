import { describe, expect, it } from 'vitest';
import { applyGitFlowPlan, inspectGitFlow, type GitCommandRunner } from '../../src/core/git-flow.js';

function runner(responses: Record<string, { ok: boolean; stdout?: string }>, calls: string[][] = []): GitCommandRunner {
  return (_root, args) => {
    calls.push(args);
    const response = responses[args.join(' ')] ?? { ok: false };
    return { ok: response.ok, stdout: response.stdout ?? '' };
  };
}

describe('Git Flow isolation', () => {
  it('prefers git flow when it is installed and initialized', () => {
    const plan = inspectGitFlow('/repo', 'sample-task', runner({
      'status --porcelain': { ok: true },
      'branch --show-current': { ok: true, stdout: 'develop' },
      'config --get gitflow.branch.develop': { ok: true, stdout: 'develop' },
      'show-ref --verify --quiet refs/heads/feature/sample-task': { ok: false },
      'flow version': { ok: true, stdout: '1.12.3' },
    }));

    expect(plan).toMatchObject({
      strategy: 'git-flow', branch: 'feature/sample-task', baseBranch: 'develop',
      status: 'pending_confirmation', command: ['flow', 'feature', 'start', 'sample-task'],
    });
  });

  it('falls back to native Git when git flow is unavailable', () => {
    const plan = inspectGitFlow('/repo', 'sample-task', runner({
      'status --porcelain': { ok: true },
      'branch --show-current': { ok: true, stdout: 'develop' },
      'config --get gitflow.branch.develop': { ok: false },
      'rev-parse --verify --quiet develop': { ok: true },
      'show-ref --verify --quiet refs/heads/feature/sample-task': { ok: false },
      'flow version': { ok: false },
    }));

    expect(plan).toMatchObject({
      strategy: 'manual', branch: 'feature/sample-task', baseBranch: 'develop',
      status: 'pending_confirmation', command: ['switch', '-c', 'feature/sample-task', 'develop'],
    });
  });

  it('refuses a dirty worktree without executing a branch command', () => {
    const calls: string[][] = [];
    const plan = inspectGitFlow('/repo', 'sample-task', runner({
      'status --porcelain': { ok: true, stdout: ' M src/file.ts' },
    }, calls));

    expect(plan).toMatchObject({ status: 'failed', reason: 'worktree_dirty', command: [] });
    expect(calls).toEqual([['status', '--porcelain']]);
  });

  it('executes only a pending plan and reports an active branch', () => {
    const calls: string[][] = [];
    const commandRunner = runner({ 'switch -c feature/sample-task develop': { ok: true } }, calls);
    const execution = applyGitFlowPlan('/repo', {
      strategy: 'manual', branch: 'feature/sample-task', baseBranch: 'develop',
      status: 'pending_confirmation', command: ['switch', '-c', 'feature/sample-task', 'develop'],
    }, commandRunner);

    expect(execution).toMatchObject({ status: 'active', strategy: 'manual', branch: 'feature/sample-task' });
    expect(calls).toEqual([['switch', '-c', 'feature/sample-task', 'develop']]);
  });
});
