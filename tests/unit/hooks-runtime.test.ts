import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activateHookTask } from '../../src/hooks/runtime.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('hook task activation', () => {
  it('rejects a manually requested role that does not match the current phase', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kata-hook-runtime-'));
    roots.push(root);
    await mkdir(join(root, '.kata/tasks/task-1'), { recursive: true });
    await writeFile(
      join(root, '.kata/tasks/task-1/current-state.json'),
      JSON.stringify({ taskId: 'task-1', phase: 'implement' }),
    );

    await expect(activateHookTask({ root, taskId: 'task-1', role: 'judge' })).rejects.toThrow(
      'does not match current phase',
    );
  });
});
