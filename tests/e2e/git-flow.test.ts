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
});
