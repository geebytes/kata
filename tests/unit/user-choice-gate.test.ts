import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { approveUserChoiceGate, consumeUserChoiceGate, createUserChoiceGate, requireUserChoiceGate } from '../../src/workflow/user-choice-gate.js';

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
});
