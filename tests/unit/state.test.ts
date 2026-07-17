import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { transition, type Actor, type Phase } from '../../src/core/state.js';
import { computeDiffHash } from '../../src/quality/evidence.js';
import { createTaskRevision } from '../../src/workflow/revision.js';

describe('Kata task state transitions', () => {
  const roots: string[] = [];
  const actor: Actor = { id: 'agent-1', role: 'implementer' };

  async function tempRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-state-'));
    roots.push(root);
    await initLayout(root);
    return root;
  }

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('persists the legal intake to archive flow as append-only events plus current projection', async () => {
    const root = await tempRoot();
    const task = await createTask({
      root,
      id: 'task-flow',
      title: 'Exercise the complete state machine',
      acceptance: [{ id: 'AC-1', statement: 'Every governed phase is reachable in order.' }],
    });

    expect(task.phase).toBe('intake');

    const flow: Phase[] = ['plan', 'implement', 'hardVerify', 'review', 'judge', 'distill', 'archive'];
    for (const phase of flow) {
      if (phase === 'distill') await writePassingQualityGates(root, task.id);
      await transition(task.id, phase, actor, { root });
    }

    const current = JSON.parse(await readFile(join(root, '.kata/tasks/task-flow/current-state.json'), 'utf8')) as {
      phase: Phase;
    };
    expect(current.phase).toBe('archive');

    const events = (await readFile(join(root, '.kata/tasks/task-flow/state-events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { to: Phase });

    expect(events.map((event) => event.to)).toEqual([
      'intake',
      'plan',
      'implement',
      'hardVerify',
      'review',
      'judge',
      'distill',
      'archive',
    ]);
  });

  it('rejects direct implement to archive transitions', async () => {
    const root = await tempRoot();
    const task = await createTask({
      root,
      id: 'task-illegal',
      title: 'Reject skipped gates',
      acceptance: [{ id: 'AC-1', statement: 'Archive requires all intermediate gates.' }],
    });

    await transition(task.id, 'plan', actor, { root });
    await transition(task.id, 'implement', actor, { root });

    await expect(transition(task.id, 'archive', actor, { root })).rejects.toThrow(/illegal transition/i);
  });

  it('rejects task ids that would escape the .kata task directory', async () => {
    const root = await tempRoot();

    await expect(
      createTask({
        root,
        id: '../escape',
        title: 'Path traversal task',
        acceptance: [{ id: 'AC-1', statement: 'Task ids are safe.' }],
      }),
    ).rejects.toThrow(/task id/i);

    await expect(
      createTask({
        root,
        id: 'nested/task',
        title: 'Nested path task',
        acceptance: [{ id: 'AC-1', statement: 'Task ids are safe.' }],
      }),
    ).rejects.toThrow(/task id/i);
  });

  it('requires stable acceptance ids before entering implement', async () => {
    const root = await tempRoot();
    const task = await createTask({
      root,
      id: 'task-no-acceptance',
      title: 'Acceptance gated implementation',
      acceptance: [{ statement: 'This criterion has no stable id yet.' }],
    });

    await transition(task.id, 'plan', actor, { root });

    await expect(transition(task.id, 'implement', actor, { root })).rejects.toThrow(/acceptance id/i);
  });

  it('requires hard evidence, reviewer clearance, and judge pass before distill', async () => {
    const root = await tempRoot();
    const task = await createTask({
      root,
      id: 'task-distill-gates',
      title: 'Distill only after quality gates',
      acceptance: [{ id: 'AC-1', statement: 'Distill waits for evidence, reviewer, and judge.' }],
    });

    for (const phase of ['plan', 'implement', 'hardVerify', 'review', 'judge'] as const) {
      await transition(task.id, phase, actor, { root });
    }

    await expect(transition(task.id, 'distill', actor, { root })).rejects.toThrow(/evidence.*reviewer.*judge/i);

    await writePassingQualityGates(root, task.id);

    await expect(transition(task.id, 'distill', actor, { root })).resolves.toMatchObject({ phase: 'distill' });
  });

  it('rejects stale judge pass even when fresh hard evidence is present', async () => {
    const root = await tempRoot();
    const task = await createTask({
      root,
      id: 'task-stale-judge',
      title: 'Judge pass is tied to current evidence',
      acceptance: [{ id: 'AC-1', statement: 'Judge pass must match current diff.' }],
    });

    for (const phase of ['plan', 'implement', 'hardVerify', 'review', 'judge'] as const) {
      await transition(task.id, phase, actor, { root });
    }
    await writePassingQualityGates(root, task.id, { judgeDiffHash: 'a'.repeat(64) });

    await expect(transition(task.id, 'distill', actor, { root })).rejects.toThrow(/judge/i);
  });

  it('allows Archive gates to consume one current revision despite unrelated workspace drift', async () => {
    const root = await tempRoot();
    await writeFile(join(root, 'owned.txt'), 'sealed\n', 'utf8');
    const task = await createTask({
      root,
      id: 'task-revision-gates',
      title: 'Revision gates ignore unrelated drift',
      acceptance: [{ id: 'AC-1', statement: 'One revision owns the gate chain.' }],
    });
    const revision = await createTaskRevision({ root, taskId: task.id, ownedPaths: ['owned.txt'] });
    for (const phase of ['plan', 'implement', 'hardVerify', 'review', 'judge'] as const) {
      await transition(task.id, phase, actor, { root });
    }
    const diffHash = await computeDiffHash(root);
    await writeFile(join(root, `.kata/evidence/${task.id}-hard.json`), `${JSON.stringify({
      id: `${task.id}-hard`, taskId: task.id, kind: 'test', command: 'vitest run', exitCode: 0,
      startedAt: '2026-07-14T00:00:00.000Z', finishedAt: '2026-07-14T00:00:01.000Z', diffHash,
      revisionId: revision.id, scope: { paths: revision.ownedPaths, hash: revision.manifestHash },
    }, null, 2)}\n`);
    await writeFile(join(root, `.kata/tasks/${task.id}/review.json`), `${JSON.stringify({ revisionId: revision.id, findings: [] }, null, 2)}\n`);
    await writeFile(join(root, `.kata/tasks/${task.id}/judge.json`), `${JSON.stringify({
      taskId: task.id, result: 'PASS', diffHash, revisionId: revision.id,
      acceptance: [{ id: 'AC-1', result: 'PASS', evidenceIds: [`${task.id}-hard`] }], evidenceIds: [`${task.id}-hard`],
    }, null, 2)}\n`);
    await writeFile(join(root, 'unrelated.txt'), 'another task changed\n', 'utf8');

    await expect(transition(task.id, 'distill', actor, { root })).resolves.toMatchObject({ phase: 'distill' });
  });

});

async function writePassingQualityGates(
  root: string,
  taskId: string,
  options: { judgeDiffHash?: string } = {},
): Promise<void> {
  const diffHash = await computeDiffHash(root);
  await writeFile(
    join(root, `.kata/evidence/${taskId}-hard.json`),
    `${JSON.stringify(
      {
        id: `${taskId}-hard`,
        taskId,
        kind: 'test',
        command: 'vitest run',
        exitCode: 0,
        startedAt: '2026-07-11T00:00:00.000Z',
        finishedAt: '2026-07-11T00:00:01.000Z',
        diffHash,
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(root, `.kata/tasks/${taskId}/review.json`),
    `${JSON.stringify({ findings: [] }, null, 2)}\n`,
  );
  await writeFile(
    join(root, `.kata/tasks/${taskId}/judge.json`),
    `${JSON.stringify(
      {
        taskId,
        result: 'PASS',
        diffHash: options.judgeDiffHash ?? diffHash,
        acceptance: [{ id: 'AC-1', result: 'PASS' }],
        evidenceIds: [`${taskId}-hard`],
      },
      null,
      2,
    )}\n`,
  );
}
