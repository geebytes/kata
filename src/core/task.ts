import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { appendStateEvent, writeCurrentState, type Phase, type StateRecord } from './state.js';
import { readValidated } from './schema.js';
import { mutateTaskArtefact } from './state.js';
import { assertValidTaskId } from './ids.js';
import { engineVersion, type EngineStamp } from './engine-version.js';
import { currentGitBranch } from './git.js';
import type { TaskRelation } from './relations.js';
import type { WorkflowProfile } from './workflow-profile.js';
import { taskDir, tasksDir, taskPath } from './layout.js';

export interface AcceptanceCriterionInput {
  id?: string;
  statement: string;
  /** Checkable clauses of the statement (C3). Optional: a statement with no claims is simply prose, as before. */
  claims?: ClaimDeclaration[];
}

export interface AcceptanceCriterion {
  id?: string;
  statement: string;
  claims?: ClaimDeclaration[];
}

export type VerificationLevel = 'unit' | 'integration' | 'entrypoint';

/**
 * A clause of an acceptance statement that a command can check (C3 of the pass-cost proposal).
 *
 * Twice in one day a false sentence in the acceptance text passed the seal *and* verify, because prose has no test. The
 * declaration keeps the statement and the command together on purpose: editing the sentence is editing the thing the check
 * is attached to, so the two cannot drift.
 */
export interface ClaimDeclaration {
    /** Stable within its acceptance item: the claim's check carries `claim:<acceptanceId>:<claimId>` as its id. */
    id: string;
    statement: string;
    check: {
        command: string;
        args?: string[];
        /** What the check must do for the sentence to be true. A claim without one is refused — it could not fail. */
        expect: { exitCode: number };
        timeoutMs?: number;
    };
}

export interface MatrixEvidenceItem {
  /**
   * Stable identity of this declaration. The runner resolves the declaration to a check carrying this id, and the
   * recorded evidence names it, so eligibility is structural rather than a substring match on the command text.
   */
  id?: string;
  kind: 'test' | 'lint' | 'typecheck' | 'integration' | 'entrypoint';
  command: string;
  testSelector?: string;
  /**
   * The id of a check that already covers this declaration — the project's full suite, typically.
   *
   * Several acceptance rows re-run files the suite already runs, and the notes measured that as roughly a third of one
   * seal's evidence time. Naming the covering check records the pointer instead: the covering check still runs (it is a
   * real check), and the row is credited with **its** evidence, so nothing is verified less — only run once.
   */
  coveredBy?: string;
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
  /**
   * The kata version this task last ran under (C7).
   *
   * "Last seen", not "first seen": it is restamped as the task advances, so a reader asking why a gate suddenly wants
   * something new gets the answer the field exists for — *did the engine change since I last ran this?* Absent on tasks
   * created before it existed, which is reported as "unknown" rather than as a change.
   */
  engine?: EngineStamp;
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
    // C7: the engine version travels with the task from the moment it exists, so a mid-task change is comparable later.
    engine: { version: engineVersion(), stampedAt: now },
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

  const taskDirectory = taskDir(root, task.id);
  await mkdir(tasksDir(root), { recursive: true });
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
  return readValidated<TaskRecord>('task', taskPath(root, taskId));
}

/**
 * Restamps a task with the running engine version (C7).
 *
 * Called as a task advances rather than on every read: the field answers "did the engine change since I last ran this?",
 * so it has to move with the runs. A no-op when the version is already current, so it costs nothing on the common path.
 */
export async function stampEngineVersion(root: string, taskId: string): Promise<{ changed: boolean; previous?: string; running: string }> {
  const running = engineVersion();
  let changed = false;
  let previous: string | undefined;
  await mutateTaskArtefact(root, taskId, taskPath(root, taskId), async (current) => {
    const task = JSON.parse(current) as TaskRecord;
    previous = task.engine?.version;
    changed = Boolean(previous) && previous !== running;
    if (task.engine?.version === running) return current;
    task.engine = { version: running, stampedAt: new Date().toISOString() };
    return `${JSON.stringify(task, null, 2)}\n`;
  });
  return { changed, ...(previous ? { previous } : {}), running };
}
