import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../../src/cli.js';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { defaultWorkflowProfile } from '../../src/core/workflow-profile.js';
import { inspectGitFlow } from '../../src/core/git-flow.js';

describe('Git Flow CLI', () => {
  const roots: string[] = [];
  afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

  it('requires explicit confirmation before creating the Git Flow branch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kata-git-flow-cli-'));
    roots.push(root);
    execFileSync('git', ['init', '-b', 'develop'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'kata@example.test'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Kata Test'], { cwd: root });
    await writeFile(join(root, 'README.md'), '# fixture\n');
    execFileSync('git', ['add', 'README.md'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'fixture'], { cwd: root, stdio: 'ignore' });
    await initLayout(root);
    execFileSync('git', ['add', '.gitignore'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'configure kata runtime'], { cwd: root, stdio: 'ignore' });
    await createTask({
      root,
      id: 'cli-feature',
      title: 'CLI feature branch',
      acceptance: [{ id: 'AC-1', statement: 'Create the task branch.' }],
      workflowProfile: {
        ...defaultWorkflowProfile(),
        isolationMode: 'git_flow',
        gitFlow: { strategy: 'manual', branch: 'feature/cli-feature', baseBranch: 'develop', status: 'pending_confirmation' },
      },
    });

    const plan = inspectGitFlow(root, 'cli-feature');
    expect(plan.reason).toBeUndefined();
    expect(plan).toMatchObject({ status: 'pending_confirmation', strategy: 'manual' });
    await main(['git-flow', 'apply', '--change', 'cli-feature', '--root', root, '--quiet']);

    const pending = JSON.parse(await readFile(join(root, '.kata/tasks/cli-feature/task.json'), 'utf8'));
    expect(pending.workflowProfile.gitFlow.status).toBe('pending_confirmation');
    expect(execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim()).toBe('develop');

    await main(['git-flow', 'apply', '--change', 'cli-feature', '--confirm', '--root', root, '--quiet']);

    const active = JSON.parse(await readFile(join(root, '.kata/tasks/cli-feature/task.json'), 'utf8'));
    expect(active.workflowProfile.gitFlow.status).toBe('active');
    expect(execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim()).toBe('feature/cli-feature');
  });

  it('preserves a recorded hotfix branch kind when confirmation applies the plan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kata-git-flow-hotfix-cli-'));
    roots.push(root);
    execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'kata@example.test'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Kata Test'], { cwd: root });
    await writeFile(join(root, 'README.md'), '# fixture\n');
    execFileSync('git', ['add', 'README.md'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'fixture'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['flow', 'init', '-d'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'gitflow.branch.master', 'main'], { cwd: root });
    execFileSync('git', ['config', 'gitflow.branch.develop', 'develop'], { cwd: root });
    execFileSync('git', ['config', 'gitflow.prefix.hotfix', 'hotfix/'], { cwd: root });
    await initLayout(root);
    execFileSync('git', ['add', '.gitignore'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'configure kata runtime'], { cwd: root, stdio: 'ignore' });
    await createTask({
      root,
      id: 'cli-hotfix',
      title: 'CLI hotfix branch',
      acceptance: [{ id: 'AC-1', statement: 'Create the hotfix branch.' }],
      workflowProfile: {
        ...defaultWorkflowProfile(),
        isolationMode: 'git_flow',
        gitFlow: { strategy: 'git-flow', branch: 'hotfix/cli-hotfix', baseBranch: 'main', status: 'pending_confirmation' },
      },
    });

    await main(['git-flow', 'apply', '--change', 'cli-hotfix', '--confirm', '--root', root, '--quiet']);

    const active = JSON.parse(await readFile(join(root, '.kata/tasks/cli-hotfix/task.json'), 'utf8'));
    expect(active.workflowProfile.gitFlow).toMatchObject({ strategy: 'git-flow', branch: 'hotfix/cli-hotfix', baseBranch: 'main', status: 'active' });
    expect(execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim()).toBe('hotfix/cli-hotfix');
  });

  it('does not run a Git Flow hotfix build before the branch is explicitly confirmed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kata-git-flow-hotfix-start-'));
    roots.push(root);
    execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'kata@example.test'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Kata Test'], { cwd: root });
    await writeFile(join(root, 'README.md'), '# fixture\n');
    execFileSync('git', ['add', 'README.md'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'fixture'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['flow', 'init', '-d'], { cwd: root, stdio: 'ignore' });
    const branchBefore = execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim();
    await main([
      'hotfix', 'needs-confirmation', '--root', root, '--quiet',
      '--isolation', 'git_flow', '--development', 'standard', '--review', 'std',
    ]);

    const task = JSON.parse(await readFile(join(root, '.kata/tasks/needs-confirmation/task.json'), 'utf8'));
    expect(task.workflowProfile.gitFlow).toMatchObject({
      strategy: 'git-flow', branch: 'hotfix/needs-confirmation', status: 'pending_confirmation',
    });
    expect(execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim()).toBe(branchBefore);
    expect(JSON.parse(await readFile(join(root, '.kata/tasks/needs-confirmation/current-state.json'), 'utf8')).phase).toBe('intake');
  });
});
