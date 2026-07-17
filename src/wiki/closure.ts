import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readWikiRecords } from './store.js';

export type WikiClosureDecision = 'captured' | 'not_applicable' | 'deferred';

export interface WikiClosure {
  taskId: string;
  decision: WikiClosureDecision;
  reason: string;
  candidateIds: string[];
  updatedAt: string;
}

export type WikiClosureEvaluation =
  | { valid: true; decision: 'captured' | 'not_applicable'; closure: WikiClosure }
  | { valid: false; reason: 'missing' | 'deferred' | 'reason_required' | 'candidate_required' | 'candidate_missing'; closure?: WikiClosure };

export async function ensureWikiClosure(root: string, taskId: string): Promise<WikiClosure> {
  const existing = await readWikiClosure(root, taskId);
  if (existing) return existing;
  const closure: WikiClosure = { taskId, decision: 'deferred', reason: 'Awaiting a knowledge-closure decision.', candidateIds: [], updatedAt: new Date().toISOString() };
  await persist(root, closure);
  return closure;
}

export async function readWikiClosure(root: string, taskId: string): Promise<WikiClosure | null> {
  try {
    const parsed = JSON.parse(await readFile(pathFor(root, taskId), 'utf8')) as unknown;
    return isWikiClosure(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeWikiClosure(root: string, taskId: string, input: { decision: WikiClosureDecision; reason: string; candidateIds?: string[] }): Promise<WikiClosure> {
  const closure: WikiClosure = {
    taskId,
    decision: input.decision,
    reason: input.reason.trim(),
    candidateIds: [...new Set(input.candidateIds ?? [])].sort(),
    updatedAt: new Date().toISOString(),
  };
  await persist(root, closure);
  return closure;
}

export async function evaluateWikiClosure(root: string, taskId: string): Promise<WikiClosureEvaluation> {
  const closure = await readWikiClosure(root, taskId);
  if (!closure) return { valid: false, reason: 'missing' };
  if (!closure.reason) return { valid: false, reason: 'reason_required', closure };
  if (closure.decision === 'deferred') return { valid: false, reason: 'deferred', closure };
  if (closure.decision === 'not_applicable') return { valid: true, decision: 'not_applicable', closure };
  if (closure.candidateIds.length === 0) return { valid: false, reason: 'candidate_required', closure };
  const records = await readWikiRecords(root);
  const validIds = new Set(records.filter((record) => record.status === 'candidate' || record.status === 'verified').map((record) => record.id));
  if (closure.candidateIds.some((id) => !validIds.has(id))) return { valid: false, reason: 'candidate_missing', closure };
  return { valid: true, decision: 'captured', closure };
}

function pathFor(root: string, taskId: string): string {
  return join(root, '.kata/tasks', taskId, 'wiki-closure.json');
}

async function persist(root: string, closure: WikiClosure): Promise<void> {
  await mkdir(join(root, '.kata/tasks', closure.taskId), { recursive: true });
  await writeFile(pathFor(root, closure.taskId), `${JSON.stringify(closure, null, 2)}\n`, 'utf8');
}

function isWikiClosure(value: unknown): value is WikiClosure {
  if (typeof value !== 'object' || value === null) return false;
  const closure = value as Partial<WikiClosure>;
  return typeof closure.taskId === 'string'
    && (closure.decision === 'captured' || closure.decision === 'not_applicable' || closure.decision === 'deferred')
    && typeof closure.reason === 'string'
    && Array.isArray(closure.candidateIds)
    && closure.candidateIds.every((id) => typeof id === 'string')
    && typeof closure.updatedAt === 'string';
}
