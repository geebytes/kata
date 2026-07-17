import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { transition, type Actor } from '../../src/core/state.js';
import { recover } from '../../src/core/recovery.js';

describe('Kata recovery', () => {
  const roots: string[] = [];
  const actor: Actor = { id: 'agent-1', role: 'implementer' };

  async function tempRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-recovery-'));
    roots.push(root);
    await initLayout(root);
    return root;
  }

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('recovers the active-session pointer deterministically from the latest state event', async () => {
    const root = await tempRoot();
    const task = await createTask({
      root,
      id: 'task-recover',
      title: 'Recover active session',
      acceptance: [{ id: 'AC-1', statement: 'Recovery chooses the latest durable session.' }],
    });

    await transition(task.id, 'plan', actor, { root, activeSession: 'session-a' });
    await transition(task.id, 'implement', actor, { root, activeSession: 'session-b' });

    await mkdir(join(root, '.kata/runtime'), { recursive: true });
    await writeFile(
      join(root, '.kata/runtime/active-session.json'),
      `${JSON.stringify({ taskId: task.id, activeSession: 'stale-session' }, null, 2)}\n`,
    );

    const diagnostic = await recover(task.id, { root });

    expect(diagnostic.recoveredActiveSession).toBe('session-b');
    expect(diagnostic.actions).toContain('rewrote-active-session-pointer');
    await expect(readFile(join(root, '.kata/runtime/active-session.json'), 'utf8')).resolves.toContain('session-b');
  });
});
