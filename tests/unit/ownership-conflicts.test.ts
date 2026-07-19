import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { transition } from '../../src/core/state.js';
import { runCommand } from '../../src/workflow/orchestrator.js';

describe('Task ownership conflict warnings', () => {
  const roots: string[] = [];

  async function tempRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-owner-'));
    roots.push(root);
    await initLayout(root);
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'kata@example.test'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Kata Test'], { cwd: root });
    return root;
  }

  async function addOtherTask(root: string, taskId: string, ownedPaths: string[], phase = 'implement'): Promise<void> {
    await mkdir(join(root, '.kata/tasks', taskId), { recursive: true });
    await writeFile(join(root, '.kata/tasks', taskId, 'task.json'), `${JSON.stringify({ ownedPaths })}\n`);
    await writeFile(
      join(root, '.kata/tasks', taskId, 'current-state.json'),
      `${JSON.stringify({ taskId, phase, actor: { id: 'tester', role: 'implementer' }, updatedAt: '2026-07-18T00:00:00.000Z' })}\n`,
    );
  }

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
  });

  // AC-1: cmdOpen with overlapping ownedPaths returns warning without blocking
  it('AC-1: cmdOpen warns on ownership conflicts without blocking', async () => {
    const root = await tempRoot();
    await addOtherTask(root, 'other-task', ['shared.ts']);

    const result = await runCommand('open', 'new-task', root, {
      title: 'New task with conflict',
      acceptance: [{ id: 'AC-1', statement: 'Open warns on conflict.' }],
      ownedPaths: ['shared.ts'],
    });

    expect(result.success).toBe(true);
    expect(result.phase).toBe('intake');
    expect(result.diagnostics?.ownershipConflicts).toEqual([
      { taskId: 'other-task', path: 'shared.ts' },
    ]);
    expect(result.diagnostics?.warnings).toContain('Ownership conflicts detected: other-task:shared.ts');
  });

  // AC-1: cmdOpen without conflicts shows no ownershipConflicts
  it('AC-1: cmdOpen without conflicts returns no ownershipConflicts', async () => {
    const root = await tempRoot();
    await addOtherTask(root, 'other-task', ['other.ts']);

    const result = await runCommand('open', 'new-task', root, {
      title: 'New task without conflict',
      acceptance: [{ id: 'AC-1', statement: 'Open without conflict.' }],
      ownedPaths: ['shared.ts'],
    });

    expect(result.success).toBe(true);
    expect(result.diagnostics?.ownershipConflicts).toBeUndefined();
  });

  // AC-1: cmdBuild unsealed warns on ownership conflicts without blocking
  it('AC-1: cmdBuild unsealed warns on ownership conflicts without blocking', async () => {
    const root = await tempRoot();
    await addOtherTask(root, 'other-task', ['shared.ts']);
    await writeFile(join(root, 'shared.ts'), 'content\n', 'utf8');
    await writeFile(join(root, 'main.ts'), 'content\n', 'utf8');
    execFileSync('git', ['add', 'shared.ts', 'main.ts'], { cwd: root });
    execFileSync('git', ['commit', '--quiet', '-m', 'baseline'], { cwd: root });

    await runCommand('open', 'build-task', root, {
      title: 'Build task',
      acceptance: [{ id: 'AC-1', statement: 'Build warns on conflict.' }],
    });
    const taskPath = join(root, '.kata/tasks/build-task/task.json');
    const task = JSON.parse(await readFile(taskPath, 'utf8')) as Record<string, unknown>;
    await writeFile(taskPath, `${JSON.stringify({ ...task, ownedPaths: ['shared.ts'] }, null, 2)}\n`);
    await runCommand('design', 'build-task', root);

    const result = await runCommand('build', 'build-task', root, { seal: false });

    expect(result.success).toBe(true);
    expect(result.phase).toBe('implement');
    expect(result.diagnostics?.mode).toBe('implement');
    expect(result.diagnostics?.ownershipConflicts).toEqual([
      { taskId: 'other-task', path: 'shared.ts' },
    ]);
  });

  // AC-1: cmdBuild unsealed without conflicts shows no ownershipConflicts
  it('AC-1: cmdBuild unsealed without conflicts returns no ownershipConflicts', async () => {
    const root = await tempRoot();
    await addOtherTask(root, 'other-task', ['other.ts']);
    await writeFile(join(root, 'main.ts'), 'content\n', 'utf8');
    execFileSync('git', ['add', 'main.ts'], { cwd: root });
    execFileSync('git', ['commit', '--quiet', '-m', 'baseline'], { cwd: root });

    await runCommand('open', 'clean-build', root, {
      title: 'Clean build',
      acceptance: [{ id: 'AC-1', statement: 'Build without conflict.' }],
    });
    await runCommand('design', 'clean-build', root);

    const result = await runCommand('build', 'clean-build', root, { seal: false });

    expect(result.success).toBe(true);
    expect(result.diagnostics?.ownershipConflicts).toBeUndefined();
  });

  // AC-2: cmdBuild --seal rejects on conflicts without --allow-ownership-conflicts
  it('AC-2: cmdBuild --seal rejects ownership conflicts with guidance', async () => {
    const root = await tempRoot();
    await addOtherTask(root, 'other-task', ['shared.ts']);
    await writeFile(join(root, 'shared.ts'), 'content\n', 'utf8');
    execFileSync('git', ['add', 'shared.ts'], { cwd: root });
    execFileSync('git', ['commit', '--quiet', '-m', 'baseline'], { cwd: root });

    const taskId = 'seal-conflict-reject';
    await runCommand('open', taskId, root, {
      title: 'Seal conflict reject',
      acceptance: [{ id: 'AC-1', statement: 'Seal rejects conflict.' }],
    });
    const taskPath = join(root, '.kata/tasks', taskId, 'task.json');
    const task = JSON.parse(await readFile(taskPath, 'utf8')) as Record<string, unknown>;
    await writeFile(taskPath, `${JSON.stringify({ ...task, ownedPaths: ['shared.ts'] }, null, 2)}\n`);
    await runCommand('design', taskId, root);

    const result = await runCommand('build', taskId, root, {
      seal: true,
      checks: [{ kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root }],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('--allow-ownership-conflicts');
    expect(result.diagnostics?.ownershipConflicts).toEqual([
      { taskId: 'other-task', path: 'shared.ts' },
    ]);
  });

  // AC-2: cmdBuild --seal succeeds with conflicts when --allow-ownership-conflicts is set
  it('AC-2: cmdBuild --seal succeeds with conflicts when allowOwnershipConflicts is set', async () => {
    const root = await tempRoot();
    await addOtherTask(root, 'other-task', ['shared.ts']);
    await writeFile(join(root, 'shared.ts'), 'content\n', 'utf8');
    execFileSync('git', ['add', 'shared.ts'], { cwd: root });
    execFileSync('git', ['commit', '--quiet', '-m', 'baseline'], { cwd: root });

    const taskId = 'seal-conflict-allow';
    await runCommand('open', taskId, root, {
      title: 'Seal with allowed conflict',
      acceptance: [{ id: 'AC-1', statement: 'Seal with allowed conflict.' }],
    });
    const taskPath = join(root, '.kata/tasks', taskId, 'task.json');
    const task = JSON.parse(await readFile(taskPath, 'utf8')) as Record<string, unknown>;
    await writeFile(taskPath, `${JSON.stringify({ ...task, ownedPaths: ['shared.ts'] }, null, 2)}\n`);
    await runCommand('design', taskId, root);

    const result = await runCommand('build', taskId, root, {
      seal: true,
      allowOwnershipConflicts: true,
      checks: [{ kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root }],
    });

    expect(result.success).toBe(true);
    expect(result.phase).toBe('hardVerify');
    expect(result.diagnostics?.ownershipConflicts).toEqual([
      { taskId: 'other-task', path: 'shared.ts' },
    ]);
  });

  // AC-3: Allowed revision persists ownership conflicts
  it('AC-3: allowed revision persists ownership conflict data', async () => {
    const root = await tempRoot();
    await addOtherTask(root, 'other-task', ['shared.ts']);
    await writeFile(join(root, 'shared.ts'), 'content\n', 'utf8');
    execFileSync('git', ['add', 'shared.ts'], { cwd: root });
    execFileSync('git', ['commit', '--quiet', '-m', 'baseline'], { cwd: root });

    const taskId = 'persist-conflict';
    await runCommand('open', taskId, root, {
      title: 'Persist conflict revision',
      acceptance: [{ id: 'AC-1', statement: 'Persist in revision.' }],
    });
    const taskPath = join(root, '.kata/tasks', taskId, 'task.json');
    const task = JSON.parse(await readFile(taskPath, 'utf8')) as Record<string, unknown>;
    await writeFile(taskPath, `${JSON.stringify({ ...task, ownedPaths: ['shared.ts'] }, null, 2)}\n`);
    await runCommand('design', taskId, root);
    await runCommand('build', taskId, root, {
      seal: true,
      allowOwnershipConflicts: true,
      checks: [{ kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root }],
    });

    const currentRevisionRaw = await readFile(
      join(root, '.kata/tasks', taskId, 'current-revision.json'), 'utf8',
    );
    const revision = JSON.parse(currentRevisionRaw) as {
      ownedPaths: string[];
      ownershipConflicts?: Array<{ taskId: string; path: string }>;
      ownershipConflictsAcknowledged?: boolean;
    };
    expect(revision.ownedPaths).toEqual(['shared.ts']);
    expect(revision.ownershipConflicts).toEqual([
      { taskId: 'other-task', path: 'shared.ts' },
    ]);
    expect(revision.ownershipConflictsAcknowledged).toBe(true);
  });

  it('AC-3: clean revision without conflicts has no acknowledgment marker', async () => {
    const root = await tempRoot();
    await writeFile(join(root, 'main.ts'), 'content\n', 'utf8');
    execFileSync('git', ['add', 'main.ts'], { cwd: root });
    execFileSync('git', ['commit', '--quiet', '-m', 'baseline'], { cwd: root });

    const taskId = 'clean-revision';
    await runCommand('open', taskId, root, {
      title: 'Clean revision',
      acceptance: [{ id: 'AC-1', statement: 'No conflicts.' }],
    });
    const taskPath = join(root, '.kata/tasks', taskId, 'task.json');
    const task = JSON.parse(await readFile(taskPath, 'utf8')) as Record<string, unknown>;
    await writeFile(taskPath, `${JSON.stringify({ ...task, ownedPaths: ['main.ts'] }, null, 2)}\n`);
    await runCommand('design', taskId, root);
    await runCommand('build', taskId, root, {
      seal: true,
      checks: [{ kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root }],
    });

    const currentRevisionRaw = await readFile(
      join(root, '.kata/tasks', taskId, 'current-revision.json'), 'utf8',
    );
    const revision = JSON.parse(currentRevisionRaw) as {
      ownershipConflictsAcknowledged?: boolean;
    };
    expect(revision.ownershipConflictsAcknowledged).toBeUndefined();
  });

  // AC-3: Archived tasks are excluded from conflict detection
  it('AC-3: archived tasks are excluded from ownership conflict detection', async () => {
    const root = await tempRoot();
    await addOtherTask(root, 'archived-task', ['shared.ts'], 'archive');

    const result = await runCommand('open', 'new-task', root, {
      title: 'No conflict with archived',
      acceptance: [{ id: 'AC-1', statement: 'Archive excludes conflict.' }],
      ownedPaths: ['shared.ts'],
    });

    expect(result.success).toBe(true);
    expect(result.diagnostics?.ownershipConflicts).toBeUndefined();
  });

  // AC-3: Terminal-redirected tasks are excluded from conflict detection
  it.each(['superseded_by', 'covered_by', 'duplicate_of', 'merged_into'] as const)(
    'AC-3: terminally redirected tasks (%s) are excluded from conflict detection',
    async (relationType) => {
      const root = await tempRoot();
      await addOtherTask(root, 'terminal-task', ['shared.ts'], 'implement');
      await writeFile(
        join(root, '.kata/tasks/terminal-task/task-relations.json'),
        `${JSON.stringify({
          taskId: 'terminal-task',
          relations: [{ type: relationType, targetTaskId: 'active-target', createdAt: '2026-07-18T00:00:00.000Z' }],
        })}\n`,
      );
      await addOtherTask(root, 'active-target', []);

      const result = await runCommand('open', 'new-task', root, {
        title: 'No conflict with terminal',
        acceptance: [{ id: 'AC-1', statement: 'Terminal excludes conflict.' }],
        ownedPaths: ['shared.ts'],
      });

      expect(result.success).toBe(true);
      expect(result.diagnostics?.ownershipConflicts).toBeUndefined();
    },
  );
});
