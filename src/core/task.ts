import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { appendStateEvent, writeCurrentState, type Phase, type StateRecord } from './state.js';
import { readValidated } from './schema.js';
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
  /**
   * Stable identity of this declaration. The runner resolves the declaration to a check carrying this id, and the
   * recorded evidence names it, so eligibility is structural rather than a substring match on the command text.
   */
  id?: string;
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

export interface RequirementItem {
  id: string;
  statement: string;
  source?: string;
  confirmedAt?: string;
}

export interface UpstreamRequirement {
  id: string;
  statement: string;
  mappedTo?: string | null;
  outOfScopeReason?: string | null;
  mappedAt?: string;
}

export interface UpstreamSource {
  ref: string;
  requirements: UpstreamRequirement[];
}

export interface UpstreamCoverage {
  version: 1;
  sources: UpstreamSource[];
}


export interface CreateTaskInput {
  root?: string;
  id?: string;
  title: string;
  acceptance: AcceptanceCriterionInput[];
  workflowProfile?: WorkflowProfile;
  ownedPaths?: string[];
  acceptanceMatrix?: AcceptanceMatrix;
  requirements?: RequirementItem[];
  upstreamCoverage?: UpstreamCoverage;
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
  requirements?: RequirementItem[];
  upstreamCoverage?: UpstreamCoverage;
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
    ...(input.requirements?.length ? { requirements: input.requirements } : {}),
    ...(input.upstreamCoverage ? { upstreamCoverage: input.upstreamCoverage } : {}),
  };

  const taskDirectory = join(root, '.kata/tasks', task.id);
  await mkdir(join(root, '.kata/tasks'), { recursive: true });
  try {
    await mkdir(taskDirectory);
  } catch (error) {
    if (isNodeError(error) && error.code === 'EEXIST') {
      throw new Error(`Task ${task.id} already exists; use kata status --change ${task.id} to resume it instead of kata open.`);
    }
    throw error;
  }
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}

/** Reads a task record against its schema. Every caller that used to parse task.json by hand should use this. */
export async function readTask(root: string, taskId: string): Promise<TaskRecord> {
  return readValidated<TaskRecord>('task', join(root, '.kata/tasks', taskId, 'task.json'));
}
