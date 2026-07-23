import { describe, expect, it } from 'vitest';
import { applyGitFlowPlan, initializeGitFlowProject, inspectGitFlow, type GitCommandRunner, type GitFlowInstaller } from '../../src/core/git-flow.js';

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

  it('uses the Git Flow hotfix command and master base for hotfix tasks', () => {
    const plan = inspectGitFlow('/repo', 'urgent-parser-fix', runner({
      'status --porcelain': { ok: true },
      'branch --show-current': { ok: true, stdout: 'develop' },
      'config --get gitflow.branch.master': { ok: true, stdout: 'main' },
      'show-ref --verify --quiet refs/heads/hotfix/urgent-parser-fix': { ok: false },
      'flow version': { ok: true, stdout: '1.12.3' },
    }), 'hotfix');

    expect(plan).toMatchObject({
      strategy: 'git-flow', branch: 'hotfix/urgent-parser-fix', baseBranch: 'main',
      status: 'pending_confirmation', command: ['flow', 'hotfix', 'start', 'urgent-parser-fix'],
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

  it('tries to install Git Flow before falling back when the repository is initialized', () => {
    let installed = false;
    const install: GitFlowInstaller = () => {
      installed = true;
      return { status: 'installed', command: ['brew', 'install', 'git-flow-avh'] };
    };
    const plan = inspectGitFlow('/repo', 'sample-task', (_root, args) => {
      const command = args.join(' ');
      if (command === 'status --porcelain') return { ok: true, stdout: '' };
      if (command === 'branch --show-current') return { ok: true, stdout: 'develop' };
      if (command === 'config --get gitflow.branch.develop') return { ok: true, stdout: 'develop' };
      if (command === 'show-ref --verify --quiet refs/heads/feature/sample-task') return { ok: false, stdout: '' };
      if (command === 'flow version') return { ok: installed, stdout: installed ? '1.12.3' : '' };
      return { ok: false, stdout: '' };
    }, 'feature', install);

    expect(plan).toMatchObject({
      strategy: 'git-flow', command: ['flow', 'feature', 'start', 'sample-task'],
      installation: { status: 'installed', command: ['brew', 'install', 'git-flow-avh'] },
    });
  });

  it('returns a manual installation suggestion when automatic installation fails', () => {
    const install: GitFlowInstaller = () => ({
      status: 'failed', command: ['apt-get', 'install', '-y', 'git-flow'], manualCommand: 'sudo apt-get install -y git-flow',
    });
    const plan = inspectGitFlow('/repo', 'sample-task', runner({
      'status --porcelain': { ok: true },
      'branch --show-current': { ok: true, stdout: 'develop' },
      'config --get gitflow.branch.develop': { ok: true, stdout: 'develop' },
      'show-ref --verify --quiet refs/heads/feature/sample-task': { ok: false },
      'flow version': { ok: false },
    }), 'feature', install);

    expect(plan).toMatchObject({
      strategy: 'manual',
      installation: { status: 'failed', manualCommand: 'sudo apt-get install -y git-flow' },
    });
  });

  it('initializes Git Flow once and uses defaults only for non-interactive init', async () => {
    let initialized = false;
    const calls: string[][] = [];
    const run: GitCommandRunner = (_root, args) => {
      if (args.join(' ') === 'rev-parse --is-inside-work-tree') return { ok: true, stdout: 'true' };
      if (args.join(' ') === 'config --get gitflow.branch.master') return { ok: initialized, stdout: initialized ? 'main' : '' };
      if (args.join(' ') === 'config --get gitflow.branch.develop') return { ok: initialized, stdout: initialized ? 'develop' : '' };
      if (args.join(' ') === 'flow version') return { ok: true, stdout: '1.12.3' };
      return { ok: false, stdout: '' };
    };

    const first = await initializeGitFlowProject('/repo', {
      interactive: false,
      run,
      execute: (_root, args) => { calls.push(args); initialized = true; },
    });
    const second = await initializeGitFlowProject('/repo', { interactive: false, run });

    expect(first).toMatchObject({ status: 'initialized', command: ['flow', 'init', '-d'] });
    expect(calls).toEqual([['flow', 'init', '-d']]);
    expect(second).toEqual({ status: 'already_initialized' });
  });

  it('passes the interactive Git Flow init prompt through without default arguments', async () => {
    const calls: string[][] = [];
    const run: GitCommandRunner = (_root, args) => {
      if (args.join(' ') === 'rev-parse --is-inside-work-tree') return { ok: true, stdout: 'true' };
      if (args.join(' ') === 'config --get gitflow.branch.master') return { ok: false, stdout: '' };
      if (args.join(' ') === 'config --get gitflow.branch.develop') return { ok: false, stdout: '' };
      if (args.join(' ') === 'flow version') return { ok: true, stdout: '1.12.3' };
      return { ok: false, stdout: '' };
    };

    const result = await initializeGitFlowProject('/repo', {
      interactive: true,
      run,
      executeInteractive: async (_root, args) => { calls.push(args); },
    });

    expect(result).toMatchObject({ status: 'initialized', command: ['flow', 'init'] });
    expect(calls).toEqual([['flow', 'init']]);
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
