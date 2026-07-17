import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initLayout } from '../core/layout.js';
import { createTask, type AcceptanceCriterion } from '../core/task.js';
import { transition, type Actor, type Phase } from '../core/state.js';
import { collectEvidence, computeDiffHash, type CheckCommand } from '../quality/evidence.js';
import { recordFinding } from '../quality/reviewer.js';
import { judge } from '../quality/judge.js';

const actor: Actor = { id: 'eval-agent', role: 'implementer' };

export interface WorkflowFixture {
  root: string;
  taskId: string;
  cleanup: () => Promise<void>;
}

export async function createOpenFixture(taskId: string, acceptance?: AcceptanceCriterion[]): Promise<WorkflowFixture> {
  const root = await mkdtemp(join(tmpdir(), `kata-eval-${taskId}-`));
  await initLayout(root);

  const task = await createTask({
    root,
    id: taskId,
    title: `Evaluation fixture: ${taskId}`,
    acceptance: acceptance ?? [{ id: 'AC-1', statement: 'Evaluation acceptance criterion.' }],
  });

  return {
    root,
    taskId: task.id,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

export async function advanceTo(root: string, taskId: string, targetPhase: Phase): Promise<void> {
  const ordered: Phase[] = ['plan', 'implement', 'hardVerify', 'review', 'judge', 'distill', 'archive'];
  for (const phase of ordered) {
    if (ordered.indexOf(phase) > ordered.indexOf(targetPhase)) break;
    if (phase === 'distill') {
      const diffHash = await computeDiffHash(root);
      const { writeFile } = await import('node:fs/promises');
      await writeFile(
        join(root, `.kata/evidence/${taskId}-hard.json`),
        `${JSON.stringify({ id: `${taskId}-hard`, taskId, kind: 'test', command: 'eval', exitCode: 0, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), diffHash }, null, 2)}\n`,
      );
      await writeFile(join(root, `.kata/tasks/${taskId}/review.json`), `${JSON.stringify({ findings: [] }, null, 2)}\n`);
      await writeFile(join(root, `.kata/tasks/${taskId}/judge.json`), `${JSON.stringify({ taskId, result: 'PASS', acceptance: [{ id: 'AC-1', result: 'PASS' }], evidenceIds: [`${taskId}-hard`] }, null, 2)}\n`);
    }
    await transition(taskId, phase, actor, { root });
  }
}

export async function runImplementFixture(
  taskId: string,
  checks?: CheckCommand[],
): Promise<WorkflowFixture & { evidence: Awaited<ReturnType<typeof collectEvidence>> }> {
  const root = await mkdtemp(join(tmpdir(), `kata-eval-impl-${taskId}-`));
  await initLayout(root);
  await createTask({
    root,
    id: taskId,
    title: 'Implement fixture',
    acceptance: [{ id: 'AC-1', statement: 'Implementation passes checks.' }],
  });

  await advanceTo(root, taskId, 'implement');
  const evidence = await collectEvidence(taskId, checks ?? [
    { kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root },
  ]);

  return {
    root,
    taskId,
    evidence,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

export async function runVerifyFixture(taskId: string): Promise<WorkflowFixture & { judgeResult: Awaited<ReturnType<typeof judge>> }> {
  const root = await mkdtemp(join(tmpdir(), `kata-eval-verify-${taskId}-`));
  await initLayout(root);
  const task = await createTask({
    root,
    id: taskId,
    title: 'Verify fixture',
    acceptance: [{ id: 'AC-1', statement: 'Verification passes.' }],
  });

  await advanceTo(root, taskId, 'hardVerify');
  const evidence = await collectEvidence(taskId, [
    { kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root },
  ]);

  const judgeResult = await judge({
    root,
    taskId,
    acceptance: task.acceptance,
    evidence,
    findings: [],
    currentDiffHash: evidence[0].diffHash,
  });

  return { root, taskId, judgeResult, cleanup: () => rm(root, { recursive: true, force: true }) };
}

export async function runRepairFixture(taskId: string): Promise<WorkflowFixture> {
  const root = await mkdtemp(join(tmpdir(), `kata-eval-repair-${taskId}-`));
  await initLayout(root);
  await createTask({
    root,
    id: taskId,
    title: 'Repair fixture',
    acceptance: [{ id: 'AC-1', statement: 'Repair is bounded.' }],
  });

  await advanceTo(root, taskId, 'hardVerify');
  const evidence = await collectEvidence(taskId, [
    { kind: 'test', command: process.execPath, args: ['-e', 'process.exit(1)'], cwd: root },
  ]);
  const finding = await recordFinding({
    root,
    taskId,
    acceptanceId: 'AC-1',
    severity: 'blocking',
    message: 'Intentionally failing for eval.',
  });

  return {
    root,
    taskId,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
