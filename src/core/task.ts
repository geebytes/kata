import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { appendStateEvent, writeCurrentState, type Phase, type StateRecord } from './state.js';
import { assertValidTaskId } from './ids.js';
import { currentGitBranch } from './git.js';
import type { TaskRelation } from './relations.js';
import type { WorkflowProfile } from './workflow-profile.js';

export interface AcceptanceCriterionInput {
  id?: string;
  statement: string;
}

export interface AcceptanceCriterion {
  id?: string;
  statement: string;
}

export type VerificationLevel = 'unit' | 'integration' | 'entrypoint';

export interface MatrixEvidenceItem {
  kind: 'test' | 'lint' | 'typecheck' | 'integration' | 'entrypoint';
  command: string;
  testSelector?: string;
}

export interface AcceptanceMatrixRow {
  acceptanceId: string;
  designRefs?: string[];
  implementationPaths: string[];
  testPaths: string[];
  evidence: MatrixEvidenceItem[];
  verificationLevel: VerificationLevel;
}

export interface AcceptanceMatrix {
  version: 1;
  rows: AcceptanceMatrixRow[];
}

export interface CreateTaskInput {
  root?: string;
  id?: string;
  title: string;
  acceptance: AcceptanceCriterionInput[];
  workflowProfile?: WorkflowProfile;
  ownedPaths?: string[];
  acceptanceMatrix?: AcceptanceMatrix;
}

export interface TaskRecord {
  id: string;
  title: string;
  phase: Phase;
  acceptance: AcceptanceCriterion[];
  relations?: TaskRelation[];
  branch?: string;
  createdAt: string;
  updatedAt: string;
  workflowProfile?: WorkflowProfile;
  ownedPaths?: string[];
  acceptanceMatrix?: AcceptanceMatrix;
}

export async function createTask(input: CreateTaskInput): Promise<TaskRecord> {
  const root = input.root ?? process.cwd();
  const now = new Date().toISOString();
  const id = input.id ?? `task-${randomUUID()}`;
  assertValidTaskId(id);
  const branch = currentGitBranch(root);
  const task: TaskRecord = {
    id,
    title: input.title,
    phase: 'intake',
    acceptance: input.acceptance.map((criterion) => ({ ...criterion })),
    ...(branch ? { branch } : {}),
    createdAt: now,
    updatedAt: now,
    ...(input.workflowProfile ? { workflowProfile: input.workflowProfile } : {}),
    ...(input.ownedPaths?.length ? { ownedPaths: [...new Set(input.ownedPaths)].sort() } : {}),
    ...(input.acceptanceMatrix ? { acceptanceMatrix: input.acceptanceMatrix } : {}),
  };

  const taskDirectory = join(root, '.kata/tasks', task.id);
  await mkdir(taskDirectory, { recursive: true });
  await writeFile(join(taskDirectory, 'task.json'), `${JSON.stringify(task, null, 2)}\n`, 'utf8');

  const state: StateRecord = {
    taskId: task.id,
    phase: 'intake',
    actor: { id: 'system', role: 'system' },
    updatedAt: now,
  };
  await appendStateEvent(root, {
    taskId: task.id,
    from: null,
    to: 'intake',
    actor: state.actor,
    at: now,
  });
  await writeCurrentState(root, state);

  return task;
}
