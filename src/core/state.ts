import { appendFile, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { checkFreshness, computeDiffHash } from '../quality/evidence.js';
import { readTaskRevision, revisionStatus } from '../workflow/revision.js';
import { assertValidTaskId } from './ids.js';

export const orderedPhases = [
  'intake',
  'plan',
  'implement',
  'hardVerify',
  'review',
  'judge',
  'distill',
  'archive',
] as const;

export type Phase = (typeof orderedPhases)[number];

export interface Actor {
  id: string;
  role: string;
  platform?: string;
}

export interface TransitionOptions {
  root?: string;
  activeSession?: string;
}

export interface StateRecord {
  taskId: string;
  phase: Phase;
  actor: Actor;
  updatedAt: string;
  activeSession?: string;
}

export interface StateEvent {
  taskId: string;
  from: Phase | null;
  to: Phase;
  actor: Actor;
  at: string;
  activeSession?: string;
}

interface TaskRecordOnDisk {
  id: string;
  acceptance?: Array<{ id?: string; statement?: string }>;
}

export function isLegalPhaseTransition(from: Phase, to: Phase): boolean {
  return orderedPhases.indexOf(to) === orderedPhases.indexOf(from) + 1;
}

export async function transition(
  taskId: string,
  to: Phase,
  actor: Actor,
  options: TransitionOptions = {},
): Promise<StateRecord> {
  const root = options.root ?? process.cwd();
  assertValidTaskId(taskId);
  const current = await readCurrentState(root, taskId);

  if (!isLegalPhaseTransition(current.phase, to)) {
    throw new Error(`Illegal transition from ${current.phase} to ${to}`);
  }
  if (to === 'implement') await assertAcceptanceIds(root, taskId);
  if (to === 'distill') await assertDistillGates(root, taskId);

  const now = new Date().toISOString();
  const next: StateRecord = {
    taskId,
    phase: to,
    actor,
    updatedAt: now,
    ...(options.activeSession ? { activeSession: options.activeSession } : {}),
  };

  await appendStateEvent(root, {
    taskId,
    from: current.phase,
    to,
    actor,
    at: now,
    ...(options.activeSession ? { activeSession: options.activeSession } : {}),
  });
  await writeCurrentState(root, next);

  return next;
}

export async function appendStateEvent(root: string, event: StateEvent): Promise<void> {
  await appendFile(stateEventsPath(root, event.taskId), `${JSON.stringify(event)}\n`, 'utf8');
}

export async function writeCurrentState(root: string, state: StateRecord): Promise<void> {
  await writeFileAtomic(currentStatePath(root, state.taskId), `${JSON.stringify(state, null, 2)}\n`);
}

export async function readStateEvents(root: string, taskId: string): Promise<StateEvent[]> {
  const raw = await readFile(stateEventsPath(root, taskId), 'utf8');
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as StateEvent);
}

async function readCurrentState(root: string, taskId: string): Promise<StateRecord> {
  return JSON.parse(await readFile(currentStatePath(root, taskId), 'utf8')) as StateRecord;
}

async function assertAcceptanceIds(root: string, taskId: string): Promise<void> {
  const task = JSON.parse(await readFile(join(root, '.kata/tasks', taskId, 'task.json'), 'utf8')) as TaskRecordOnDisk;
  if (!task.acceptance?.length || task.acceptance.some((criterion) => !/^AC-[0-9]+$/.test(criterion.id ?? ''))) {
    throw new Error('Cannot enter implement until every acceptance criterion has a stable acceptance id');
  }
}

async function assertDistillGates(root: string, taskId: string): Promise<void> {
  const currentDiffHash = await computeDiffHash(root);
  const freshEvidence = await getFreshPassingEvidence(root, taskId, currentDiffHash);
  const gates = await Promise.all([
    Promise.resolve(freshEvidence !== null),
    hasReviewerClearance(root, taskId, freshEvidence?.revisionId),
    hasJudgePass(root, taskId, currentDiffHash, freshEvidence),
  ]);
  if (!gates.every(Boolean)) {
    throw new Error('Cannot enter distill until fresh evidence, reviewer clearance, and judge PASS are present');
  }
}

interface HardEvidenceOnDisk {
  id?: string;
  taskId?: string;
  kind?: string;
  command?: string;
  exitCode?: number;
  startedAt?: string;
  finishedAt?: string;
  diffHash?: string;
  revisionId?: string;
}

async function getFreshPassingEvidence(root: string, taskId: string, currentDiffHash: string): Promise<HardEvidenceOnDisk | null> {
  try {
    const evidence = JSON.parse(await readFile(join(root, `.kata/evidence/${taskId}-hard.json`), 'utf8')) as HardEvidenceOnDisk;
    if (evidence.taskId !== taskId || evidence.exitCode !== 0 || !evidence.diffHash) return null;
    if (evidence.revisionId) {
      const revision = await readTaskRevision(root, taskId, evidence.revisionId);
      if ((await revisionStatus(root, revision)).status !== 'current') return null;
      return evidence;
    }
    const freshness = checkFreshness(
      {
        id: evidence.id ?? `${taskId}-hard`,
        taskId,
        kind: 'test',
        command: evidence.command ?? 'hard verification',
        exitCode: evidence.exitCode,
        startedAt: evidence.startedAt ?? '',
        finishedAt: evidence.finishedAt ?? '',
        diffHash: evidence.diffHash,
      },
      currentDiffHash,
    );
    return freshness.fresh ? evidence : null;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function hasReviewerClearance(root: string, taskId: string, revisionId?: string): Promise<boolean> {
  try {
    const review = JSON.parse(await readFile(join(root, '.kata/tasks', taskId, 'review.json'), 'utf8')) as {
      findings?: Array<{ severity?: string }>;
      revisionId?: string;
    };
    return Array.isArray(review.findings)
      && review.findings.every((finding) => finding.severity !== 'blocking')
      && (!revisionId || review.revisionId === revisionId);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function hasJudgePass(
  root: string,
  taskId: string,
  currentDiffHash: string,
  freshEvidence: HardEvidenceOnDisk | null,
): Promise<boolean> {
  try {
    const judge = JSON.parse(await readFile(join(root, '.kata/tasks', taskId, 'judge.json'), 'utf8')) as {
      taskId?: string;
      result?: string;
      diffHash?: string;
      acceptance?: Array<{ id?: string; result?: string; evidenceIds?: string[] }>;
      evidenceIds?: string[];
      revisionId?: string;
    };
    if (judge.taskId !== taskId || judge.result !== 'PASS') return false;
    if (freshEvidence?.revisionId) {
      if (judge.revisionId !== freshEvidence.revisionId) return false;
    } else if (judge.diffHash !== currentDiffHash) return false;
    if (!freshEvidence?.id) return false;
    if (!Array.isArray(judge.acceptance) || judge.acceptance.length === 0) return false;
    if (judge.acceptance.some((criterion) => criterion.result !== 'PASS')) return false;

    const acceptedEvidenceIds = new Set([...(judge.evidenceIds ?? []), ...judge.acceptance.flatMap((criterion) => criterion.evidenceIds ?? [])]);
    return acceptedEvidenceIds.has(freshEvidence.id);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

function currentStatePath(root: string, taskId: string): string {
  assertValidTaskId(taskId);
  return join(root, '.kata/tasks', taskId, 'current-state.json');
}

function stateEventsPath(root: string, taskId: string): string {
  assertValidTaskId(taskId);
  return join(root, '.kata/tasks', taskId, 'state-events.jsonl');
}

async function writeFileAtomic(path: string, content: string): Promise<void> {
  const temporaryPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temporaryPath, content, 'utf8');
  await rename(temporaryPath, path);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
