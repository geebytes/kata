import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout, resolveWorkspaceRootForTask } from '../../src/core/layout.js';

describe('Kata project layout', () => {
  const roots: string[] = [];

  async function tempRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-layout-'));
    roots.push(root);
    return root;
  }

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('creates the governed .kata directories and runtime gitignore entry', async () => {
    const root = await tempRoot();

    const result = await initLayout(root);

    expect(result.conflicts).toEqual([]);
    expect(result.created).toEqual([
      '.kata',
      '.kata/rules',
      '.kata/wiki',
      '.kata/tasks',
      '.kata/evidence',
      '.kata/schemas',
      '.kata/runtime',
    ]);
    for (const directory of result.created) {
      expect((await stat(join(root, directory))).isDirectory()).toBe(true);
    }
    await expect(readFile(join(root, '.gitignore'), 'utf8')).resolves.toContain('.kata/runtime/');
  });

  it('reports existing directories without recreating them', async () => {
    const root = await tempRoot();

    await initLayout(root);
    const second = await initLayout(root);

    expect(second.created).toEqual([]);
    expect(second.conflicts).toEqual([]);
    expect(second.existing).toEqual([
      '.kata',
      '.kata/rules',
      '.kata/wiki',
      '.kata/tasks',
      '.kata/evidence',
      '.kata/schemas',
      '.kata/runtime',
    ]);
  });

  it('reports a conflict instead of overwriting a modified generated schema copy', async () => {
    const root = await tempRoot();

    await initLayout(root);
    const schemaPath = join(root, '.kata/schemas/task.schema.json');
    const modifiedSchema = '{"user": "custom schema"}\n';
    await writeFile(schemaPath, modifiedSchema);

    const second = await initLayout(root);

    expect(second.conflicts).toContain('.kata/schemas/task.schema.json');
    await expect(readFile(schemaPath, 'utf8')).resolves.toBe(modifiedSchema);
  });

  it('reports a conflict instead of overwriting an unmanaged schema copy', async () => {
    const root = await tempRoot();
    const schemaDirectory = join(root, '.kata/schemas');
    await mkdir(schemaDirectory, { recursive: true });
    const schemaPath = join(schemaDirectory, 'task.schema.json');
    const unmanagedSchema = '{"user": "unmanaged schema"}\n';
    await writeFile(schemaPath, unmanagedSchema);

    const result = await initLayout(root);

    expect(result.conflicts).toContain('.kata/schemas/task.schema.json');
    await expect(readFile(schemaPath, 'utf8')).resolves.toBe(unmanagedSchema);
  });

  it('ignores retired model routing configuration before creating governed directories', async () => {
    const root = await tempRoot();
    await writeFile(join(root, '.kata-config.json'), '{"modelPolicy": "economy"}\n');

    await expect(initLayout(root)).resolves.toMatchObject({ conflicts: [] });
    await expect(stat(join(root, '.kata'))).resolves.toBeDefined();
  });

  it('selects the ancestor Kata root that owns an explicit task over a nested Git repository', async () => {
    const root = await tempRoot();
    const nested = join(root, 'nested');
    await mkdir(join(root, '.kata', 'tasks', 'outer-task'), { recursive: true });
    await writeFile(join(root, '.kata', 'tasks', 'outer-task', 'current-state.json'), '{}\n');
    await mkdir(join(nested, '.git'), { recursive: true });

    expect(resolveWorkspaceRootForTask('outer-task', nested)).toBe(root);
  });

  it('fails closed when two ancestor Kata roots claim an explicit task', async () => {
    const root = await tempRoot();
    const nested = join(root, 'nested');
    await mkdir(join(root, '.kata', 'tasks', 'duplicated-task'), { recursive: true });
    await mkdir(join(nested, '.kata', 'tasks', 'duplicated-task'), { recursive: true });
    await writeFile(join(root, '.kata', 'tasks', 'duplicated-task', 'current-state.json'), '{}\n');
    await writeFile(join(nested, '.kata', 'tasks', 'duplicated-task', 'current-state.json'), '{}\n');

    expect(() => resolveWorkspaceRootForTask('duplicated-task', nested)).toThrow('Ambiguous Kata task root');
  });

  it('discovers a descendant Git worktree that owns the task when no ancestor does', async () => {
    const root = await tempRoot();
    const child = join(root, 'subproject');
    await mkdir(join(child, '.kata', 'tasks', 'child-task'), { recursive: true });
    await writeFile(join(child, '.kata', 'tasks', 'child-task', 'current-state.json'), '{}\n');

    expect(resolveWorkspaceRootForTask('child-task', root)).toBe(child);
  });

  it('skips node_modules when scanning descendant directories', async () => {
    const root = await tempRoot();
    const real = join(root, 'real-project');
    const noise = join(root, 'node_modules', 'fake-project');
    await mkdir(join(real, '.kata', 'tasks', 'my-task'), { recursive: true });
    await writeFile(join(real, '.kata', 'tasks', 'my-task', 'current-state.json'), '{}\n');
    await mkdir(join(noise, '.kata', 'tasks', 'my-task'), { recursive: true });
    await writeFile(join(noise, '.kata', 'tasks', 'my-task', 'current-state.json'), '{}\n');

    expect(resolveWorkspaceRootForTask('my-task', root)).toBe(real);
  });

  it('skips .kata directories when scanning descendants', async () => {
    const root = await tempRoot();
    const real = join(root, 'real-project');
    const noise = join(root, '.kata', 'shadow');
    await mkdir(join(real, '.kata', 'tasks', 'my-task'), { recursive: true });
    await writeFile(join(real, '.kata', 'tasks', 'my-task', 'current-state.json'), '{}\n');
    await mkdir(join(noise, '.kata', 'tasks', 'my-task'), { recursive: true });
    await writeFile(join(noise, '.kata', 'tasks', 'my-task', 'current-state.json'), '{}\n');

    expect(resolveWorkspaceRootForTask('my-task', root)).toBe(real);
  });

  it('fails closed when multiple descendant directories own the same task', async () => {
    const root = await tempRoot();
    const first = join(root, 'project-a');
    const second = join(root, 'project-b');
    await mkdir(join(first, '.kata', 'tasks', 'shared-task'), { recursive: true });
    await writeFile(join(first, '.kata', 'tasks', 'shared-task', 'current-state.json'), '{}\n');
    await mkdir(join(second, '.kata', 'tasks', 'shared-task'), { recursive: true });
    await writeFile(join(second, '.kata', 'tasks', 'shared-task', 'current-state.json'), '{}\n');

    expect(() => resolveWorkspaceRootForTask('shared-task', root))
      .toThrow('Multiple descendant worktrees own task shared-task');
  });

  it('reports not found when neither ancestors nor descendants own the task', async () => {
    const root = await tempRoot();

    expect(() => resolveWorkspaceRootForTask('nonexistent-task', root))
      .toThrow('No Kata workspace owns task nonexistent-task');
  });

  it('ancestor match takes priority over descendant match', async () => {
    const root = await tempRoot();
    const nested = join(root, 'nested');
    await mkdir(join(root, '.kata', 'tasks', 'priority-task'), { recursive: true });
    await writeFile(join(root, '.kata', 'tasks', 'priority-task', 'current-state.json'), '{}\n');
    await mkdir(join(nested, '.kata', 'tasks', 'priority-task'), { recursive: true });
    await writeFile(join(nested, '.kata', 'tasks', 'priority-task', 'current-state.json'), '{}\n');

    expect(resolveWorkspaceRootForTask('priority-task', root)).toBe(root);
  });
});
