import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../../src/cli.js';

describe('non-interactive kata open', () => {
  const roots: string[] = [];

  async function tempRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-noninteractive-open-'));
    roots.push(root);
    return root;
  }

  afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

  it.each([
    ['--isolation', 'current_worktree'],
    ['--development', 'tdd'],
    ['--review', 'std'],
  ])('rejects an open with only %s', async (flag, value) => {
    const root = await tempRoot();

    await expect(main(['open', 'missing-profile', flag, value, '--root', root]))
      .rejects.toThrow('requires explicit --isolation, --development, and --review');
    await expect(stat(join(root, '.kata/tasks/missing-profile'))).rejects.toThrow();
  });

  it.each(['open', 'hotfix', 'tweak'] as const)(
    'rejects a new %s workflow when any workflow-profile choice is omitted',
    async (command) => {
      const root = await tempRoot();
      const taskId = `missing-profile-${command}`;

      await expect(main([
        command,
        taskId,
        '--isolation', 'current_worktree',
        '--development', 'tdd',
        '--root', root,
      ])).rejects.toThrow('requires explicit --isolation, --development, and --review');
      await expect(stat(join(root, '.kata/tasks', taskId))).rejects.toThrow();
    },
  );

  it.each(['hotfix', 'tweak'] as const)(
    'persists an explicitly selected profile for a new %s workflow',
    async (command) => {
      const root = await tempRoot();
      const taskId = `explicit-profile-${command}`;

      await main([
        command,
        taskId,
        '--isolation', 'isolated_worktree',
        '--development', 'standard',
        '--review', 'security',
        '--root', root,
      ]);

      const task = JSON.parse(await readFile(join(root, '.kata/tasks', taskId, 'task.json'), 'utf8'));
      expect(task.workflowProfile).toMatchObject({
        isolationMode: 'isolated_worktree',
        developmentMode: 'standard',
        reviewMode: 'security',
      });
    },
  );

  it('persists every explicitly selected workflow mode', async () => {
    const root = await tempRoot();

    await main([
      'open', 'explicit-profile',
      '--isolation', 'isolated_worktree',
      '--development', 'standard',
      '--review', 'security',
      '--root', root,
    ]);

    const task = JSON.parse(await readFile(join(root, '.kata/tasks/explicit-profile/task.json'), 'utf8'));
    expect(task.workflowProfile).toMatchObject({
      isolationMode: 'isolated_worktree',
      developmentMode: 'standard',
      reviewMode: 'security',
    });
  });
});
