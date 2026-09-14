import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { appendStateEvent, transition, writeCurrentState, type Actor } from '../../src/core/state.js';
import { recover, requiresRecovery } from '../../src/core/recovery.js';

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

  it('ignores an illegal duplicate-open intake event when recovering state', async () => {
    const root = await tempRoot();
    const task = await createTask({ root, id: 'recover-duplicate-open', title: 'Recover plan', acceptance: [{ id: 'AC-1', statement: 'Keep legal phase.' }] });
    await transition(task.id, 'plan', { id: 'designer', role: 'designer' }, { root });
    await appendFile(join(root, '.kata/tasks', task.id, 'state-events.jsonl'), `${JSON.stringify({ taskId: task.id, from: null, to: 'intake', actor: { id: 'bad-open', role: 'system' }, at: new Date().toISOString() })}\n`);

    await expect(recover(task.id, { root })).resolves.toMatchObject({ phase: 'plan', actions: expect.arrayContaining(['ignored-1-invalid-state-events']) });
  });

  it.each(['hardVerify', 'review', 'judge'] as const)(
    'replays a %s → implement repair return instead of rewinding the phase',
    async (repairFrom) => {
      const root = await tempRoot();
      const task = await createTask({
        root,
        id: `recover-repair-${repairFrom}`.toLowerCase(),
        title: 'Repair return',
        acceptance: [{ id: 'AC-1', statement: 'Repair returns stay inside the recoverable chain.' }],
      });
      const designer: Actor = { id: 'designer', role: 'designer' };
      const reviewer: Actor = { id: 'kata-reviewer', role: 'reviewer' };

      const forwardChain = ['plan', 'implement', 'hardVerify', 'review', 'judge'] as const;
      for (const phase of forwardChain) {
        await transition(task.id, phase, phase === 'review' || phase === 'judge' ? reviewer : actor, { root });
        if (phase === repairFrom) break;
      }

      // The repair entrypoints (reenterImplementFor*) bypass transition() and append
      // the backward event directly; the replay must treat it as a legal chain link.
      const now = new Date().toISOString();
      await appendStateEvent(root, { taskId: task.id, from: repairFrom, to: 'implement', actor, at: now });
      await writeCurrentState(root, { taskId: task.id, phase: 'implement', actor, updatedAt: now });
      await transition(task.id, 'hardVerify', actor, { root });

      await expect(requiresRecovery(task.id, { root })).resolves.toBe(false);
      await expect(recover(task.id, { root })).resolves.toMatchObject({ phase: 'hardVerify' });
    },
  );
});
