import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';

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
});
