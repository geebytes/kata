import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { hashContent } from './hash.js';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { appendStateEvent, writeCurrentState, type Phase, type StateRecord } from './state.js';
import { readValidated, validate } from './schema.js';
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
  /** See `TaskRecord['instruments']`. Accepted at creation so a task can be born knowing what it is allowed to build. */
  instruments?: string[];
  /** See `TaskRecord['boundaries']`. */
  boundaries?: Array<{ instrument: string; covers: string[]; doesNotCover: Array<{ dimension: string; reason: string }>; canonicalStatement: string }>;
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
  /**
   * Verification tooling this task wrote to check its own deliverables (§21.1).
   *
   * Declared, never inferred. A task that has not decided whether a path is an instrument has not yet had the conversation
   * that stops the arms race — and five consecutive rounds of one real task were that arms race.
   */
  instruments?: string[];
  /** Per-instrument coverage boundaries (§21.2), which is what gives an adversarial search a terminating condition. */
  boundaries?: Array<{ instrument: string; covers: string[]; doesNotCover: Array<{ dimension: string; reason: string }>; canonicalStatement: string }>;
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
  /** A strict-matrix migration note (L2-02). Optional, so a task that never had a gap still validates. */
  acceptanceMatrixMigration?: AcceptanceMatrixMigrationNote;
}


/** The classification decision attached to a task and carried unchanged into its review request. */
export interface TaskClassificationRecord {
  version: 1;
  taskId: string;
  by: 'agent' | 'floor';
  tier: string;
  floor: string;
  reasons: string[];
  riskClasses: string[];
  facts: {
    declaredPaths: string[];
    matched: Array<{ pattern: string; path: string; floor: string }>;
    wideChange: boolean;
  };
  lane: string;
  laneTier: string;
  laneBelow: boolean;
}

export type TaskClassificationRead =
  | { kind: 'absent' }
  | { kind: 'usable'; record: TaskClassificationRecord }
  | { kind: 'unreadable'; reason: string };

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
    ...(input.instruments?.length ? { instruments: [...new Set(input.instruments)].sort() } : {}),
    ...(input.boundaries?.length ? { boundaries: input.boundaries } : {}),
    ...(input.ownedPaths?.length ? { ownedPaths: [...new Set(input.ownedPaths)].sort() } : {}),
    ...(input.acceptanceMatrix ? { acceptanceMatrix: input.acceptanceMatrix } : {}),
    ...(input.requirements?.length ? { requirements: input.requirements } : {}),
    ...(input.upstreamCoverage ? { upstreamCoverage: input.upstreamCoverage } : {}),
  };

  // **The record this writer is about to create must be one its own reader accepts.** Measured on the bootstrap path: a
  // bootstrap whose `upstreamCoverage.sources[0]` lacked `ref` was accepted here, and the invalid task.json it wrote was
  // refused by the *next* command — `design` — while `status` and `orient` kept working, because they read the file
  // without the schema. A writer that can persist a record its reader rejects is the defect whatever the input's origin;
  // the field hint in the message now names the failing object's fields, so the bootstrap author is told what to change.
  //
  // **And it is checked before anything exists on disk, because the refusal says nothing was written.** Measured: the
  // directory was created first and validated second, so a bootstrap whose record failed its own schema left an empty
  // `.kata/tasks/<id>` behind while the message claimed nothing was written — and the next `open` was refused with "Task
  // <id> already exists; use kata status --change <id> to resume it", a remedy that could not run because there was no
  // state record to resume. A refusal that creates state, misdescribes it, and names an unexecutable remedy is three
  // defects in one message; validating first removes all three.
  try {
    validate('task', task);
  } catch (error) {
    throw new Error(`refusing to create task ${task.id}: the record would not match its schema, so every later read would fail. ${(error as Error).message} Nothing was written.`);
  }
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

/**
 * A task strict verification cannot judge structurally, and why (L2-02).
 *
 * Reported rather than refused: a task sealed before strict rows required declared check ids must keep verifying, or the
 * rule would retroactively invalidate every binding it holds. The note is what makes the migration visible instead of
 * leaving the next reader to rediscover why one task's evidence set behaves differently from another's.
 */
export interface AcceptanceMatrixMigrationNote {
    taskId: string;
    gapCount: number;
    acceptanceIds: string[];
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}

/** Reads a task record against its schema. Every caller that used to parse task.json by hand should use this. */
export async function readTask(root: string, taskId: string): Promise<TaskRecord> {
  return readValidated<TaskRecord>('task', taskPath(root, taskId));
}

/**
 * **A record that exists and cannot be read is not an absent one, and a caller has to be able to tell.**
 *
 * It lives beside the reader whose damage it names, and it carries the task and the file rather than a bare message: the
 * remedy is always "look at that file", and the identity is what lets a caller that has to keep going — the candidate
 * listing, which must not drop a task because one record is damaged — say *which* task it could not read.
 *
 * The class exists because an independent round found three readers folding the two facts into one: `readTaskCandidate`
 * reported a task mid-review as `intake`, `runOrientCommand` took the phase from an older handoff packet, and the check
 * derivation silently widened to the full set. In each case a fact about the reader was reported as a fact about the change.
 */
export class UnreadableTaskRecord extends Error {
  constructor(readonly taskId: string, readonly path: string, readonly reason: string) {
    super(`task '${taskId}' has a record that cannot be read (${path}): ${reason}`);
    this.name = 'UnreadableTaskRecord';
  }
}
// **`stampEngineVersion` was deleted: it was a second implementation of one write.** `core/state.ts` stamps the version
// inside `withTaskLock` (`stampEngineUnlocked`, called as a task advances), and this copy stamped `task.engine` without the
// lock — one fact, two derivations, and the unused one could have raced the used one. The wiring check reported it as having
// no consumer but the test written for it, which is the same finding in its own vocabulary.


function classificationRecord(value: unknown, taskId: string): TaskClassificationRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Partial<TaskClassificationRecord>;
  const facts = record.facts;
  if (record.version !== 1 || record.taskId !== taskId || (record.by !== 'agent' && record.by !== 'floor')) return null;
  if (typeof record.tier !== 'string' || typeof record.floor !== 'string' || typeof record.lane !== 'string' || typeof record.laneTier !== 'string') return null;
  if (!Array.isArray(record.reasons) || !record.reasons.every((item) => typeof item === 'string')) return null;
  if (!Array.isArray(record.riskClasses) || !record.riskClasses.every((item) => typeof item === 'string')) return null;
  if (typeof record.laneBelow !== 'boolean' || typeof facts !== 'object' || facts === null) return null;
  if (!Array.isArray(facts.declaredPaths) || !facts.declaredPaths.every((item) => typeof item === 'string')) return null;
  if (typeof facts.wideChange !== 'boolean' || !Array.isArray(facts.matched)) return null;
  if (!facts.matched.every((item) => typeof item === 'object' && item !== null
    && typeof item.pattern === 'string' && typeof item.path === 'string' && typeof item.floor === 'string')) return null;
  return record as TaskClassificationRecord;
}

/** Read the task-attached classification as absent / usable / unreadable; never invent a tier when its record is damaged. */
export async function readTaskClassification(root: string, taskId: string): Promise<TaskClassificationRead> {
  const path = join(taskDir(root, taskId), 'classification.json');
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'unreadable', reason: error instanceof Error ? error.message : String(error) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { kind: 'unreadable', reason: error instanceof Error ? error.message : String(error) };
  }
  const record = classificationRecord(parsed, taskId);
  return record ? { kind: 'usable', record } : { kind: 'unreadable', reason: 'classification record does not match its schema or task id' };
}

/** Persist a classification once. Re-running open must not silently replace the judgement already attached to a task. */
export async function writeTaskClassification(root: string, taskId: string, value: TaskClassificationRecord): Promise<void> {
  assertValidTaskId(taskId);
  const record = classificationRecord(value, taskId);
  if (!record) throw new Error(`classification record for '${taskId}' does not match its schema`);
  const path = join(taskDir(root, taskId), 'classification.json');
  await mutateTaskArtefact(root, taskId, path, async (current) => {
    if (current.length > 0) {
      const existing = classificationRecord(JSON.parse(current), taskId);
      if (!existing || JSON.stringify(existing) !== JSON.stringify(record)) {
        throw new Error(`classification record for '${taskId}' already exists and differs; refusing to replace it`);
      }
      return current;
    }
    return `${JSON.stringify(record, null, 2)}\n`;
  });
}

/**
 * **The acceptance contract as one value: the criteria and the matrix, which is what a certification is about.**
 *
 * This is the hash a revision freezes, so a contract that has since been amended is detectable the same way moved content
 * is — and it is deliberately the *same* serialization the candidate freeze has used since the freeze existed
 * (`review-ir.ts`), extracted here rather than restated there: two hashes of one contract would be two answers to "did the
 * contract move", and the one the gate never reads is the one that would be wrong.
 *
 * The argument is the pair rather than the task so a caller that has already read the record does not re-read it.
 */
export function acceptanceContractHashOf(
    acceptance: AcceptanceCriterion[] | undefined,
    matrix: AcceptanceMatrix | undefined,
): string {
    return hashContent(JSON.stringify({ acceptance, matrix: matrix ?? null }));
}
