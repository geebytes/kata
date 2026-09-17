import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { approveUserChoiceGate, consumeUserChoiceGate, createUserChoiceGate, requireUserChoiceGate } from '../../src/workflow/user-choice-gate.js';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { createTaskRevision } from '../../src/workflow/revision.js';

describe('user choice gates', () => {
  const roots: string[] = [];
  afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

  it('rejects a phase crossing until the user has selected a continuation choice, then consumes that choice once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kata-choice-gate-'));
    roots.push(root);
    await createUserChoiceGate({ root, taskId: 'choice-task', boundary: 'review_gate', revisionId: 'revision-1' });

    await expect(requireUserChoiceGate({ root, taskId: 'choice-task', boundary: 'review_gate', revisionId: 'revision-1' }))
      .rejects.toThrow('requires an explicit user choice');

    await approveUserChoiceGate({ root, taskId: 'choice-task', boundary: 'review_gate', choice: 'continue_current', revisionId: 'revision-1' });
    await expect(requireUserChoiceGate({ root, taskId: 'choice-task', boundary: 'review_gate', revisionId: 'revision-1' }))
      .resolves.toMatchObject({ choice: 'continue_current' });
    await consumeUserChoiceGate({ root, taskId: 'choice-task', boundary: 'review_gate', revisionId: 'revision-1' });
    await expect(requireUserChoiceGate({ root, taskId: 'choice-task', boundary: 'review_gate', revisionId: 'revision-1' }))
      .rejects.toThrow('requires an explicit user choice');
  });

  it('consumes a gate idempotently: double-consume rejects, consumedAt is recorded', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kata-consume-once-'));
    roots.push(root);
    await createUserChoiceGate({ root, taskId: 'consume-once-task', boundary: 'implementation_gate' });
    await approveUserChoiceGate({ root, taskId: 'consume-once-task', boundary: 'implementation_gate', choice: 'continue_current' });

    await consumeUserChoiceGate({ root, taskId: 'consume-once-task', boundary: 'implementation_gate' });

    const { readFile } = await import('node:fs/promises');
    const gatePath = join(root, '.kata/tasks', 'consume-once-task', 'user-choice-implementation_gate.json');
    const raw = await readFile(gatePath, 'utf8');
    const gate = JSON.parse(raw);
    expect(gate.consumedAt).toBeTypeOf('string');
    expect(gate.choice).toBe('continue_current');

    await expect(consumeUserChoiceGate({ root, taskId: 'consume-once-task', boundary: 'implementation_gate' }))
      .rejects.toThrow('requires an explicit user choice');
  });

  it('refuses approval of an already-consumed gate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kata-consumed-approve-'));
    roots.push(root);
    await createUserChoiceGate({ root, taskId: 'consumed-approve-task', boundary: 'review_gate' });
    await approveUserChoiceGate({ root, taskId: 'consumed-approve-task', boundary: 'review_gate', choice: 'switched' });
    await consumeUserChoiceGate({ root, taskId: 'consumed-approve-task', boundary: 'review_gate' });

    await expect(approveUserChoiceGate({ root, taskId: 'consumed-approve-task', boundary: 'review_gate', choice: 'continue_current' }))
      .rejects.toThrow('has already been consumed');
  });

    it('reuses a choice the human recorded for the whole task, and says so at the boundary', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-task-choice-'));
        roots.push(root);
        const taskId = 'task-choice-task';
        // The answer a human gives once, with --for-task.
        await createUserChoiceGate({ root, taskId, boundary: 'implementation_gate' });
        await approveUserChoiceGate({ root, taskId, boundary: 'implementation_gate', choice: 'continue_current', forTask: true });

        // A later boundary has no gate of its own yet — and does not ask again.
        const gate = await requireUserChoiceGate({ root, taskId, boundary: 'review_gate' });

        expect(gate).toMatchObject({ choice: 'continue_current', reusedFromTaskChoice: true });
        // The boundary records the reuse, so the audit trail says where the answer came from.
        const recorded = await readFile(join(root, '.kata/tasks', taskId, 'user-choice-review_gate.json'), 'utf8');
        expect(JSON.parse(recorded)).toMatchObject({ boundary: 'review_gate', reusedFromTaskChoice: true });
    });

    it('asks again when the content the choice was made about has changed', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-task-choice-stale-'));
        roots.push(root);
        const taskId = 'task-choice-stale';
        await initLayout(root);
        await createTask({ root, id: taskId, title: 'Changed content', acceptance: [{ id: 'AC-1', statement: 'A choice is about content.' }] });
        await mkdir(join(root, 'src'), { recursive: true });
        await writeFile(join(root, 'src/owned.ts'), 'export const value = 1;\n', 'utf8');
        await createTaskRevision({ root, taskId, ownedPaths: ['src'], checkIds: ['test'] });

        // A task-level choice speaking about different content than the sealed revision cannot authorise a boundary.
        await writeFile(join(root, '.kata/tasks', taskId, 'user-choice-task.json'), JSON.stringify({
            taskId, choice: 'continue_current', manifestHash: 'ff'.repeat(32),
            createdAt: new Date().toISOString(), approvedAt: new Date().toISOString(),
        }), 'utf8');

        await expect(requireUserChoiceGate({ root, taskId, boundary: 'review_gate' }))
            .rejects.toThrow(/requires an explicit user choice/);
    });
});
