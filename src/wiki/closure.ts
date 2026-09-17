import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readWikiRecords, readWikiRecordsTolerant } from './store.js';
import { wikiClosurePath as layoutWikiClosurePath, taskDir } from '../core/layout.js';

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
  | { valid: false; reason: WikiClosureFailureReason; closure?: WikiClosure };

/** Why a closure is not complete yet. Each one has a remedy `wikiClosureRemedy` can name. */
export type WikiClosureFailureReason = 'missing' | 'deferred' | 'reason_required' | 'candidate_required' | 'candidate_missing' | 'unevaluatable_records';

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

/**
 * What to run next, for each way a closure can be incomplete.
 *
 * The reasons used to reach the user as a bare token inside a sentence ("complete Wiki closure (candidate_required)
 * before review/judge"), which left the remedy to be recovered from the bundle — the measured cost of a gate that knows
 * the answer and does not say it.
 */
export function wikiClosureRemedy(reason: WikiClosureFailureReason, taskId: string): string {
  switch (reason) {
    case 'candidate_required':
      return `Record the candidate this task captured: \`kata-cli wiki closure --task ${taskId} --decision captured --candidate <wiki-record-id> --reason "<what it taught>"\` (register the page first with \`kata-cli wiki register\`).`;
    case 'candidate_missing':
      return 'One recorded candidate id is not a registered Wiki record. List them with `kata-cli wiki list` and re-record the closure with an id that exists.';
    case 'reason_required':
      return `Record why: \`kata-cli wiki closure --task ${taskId} --decision <captured|not_applicable|deferred> --reason "<why>"\`.`;
    case 'deferred':
      return `The closure is still deferred. Decide it: \`kata-cli wiki closure --task ${taskId} --decision <captured|not_applicable> --reason "<why>"\`.`;
    case 'missing':
      return `No closure recorded yet: \`kata-cli wiki closure --task ${taskId} --decision <captured|not_applicable|deferred> --reason "<why>"\`.`;
    case 'unevaluatable_records':
      return 'The closure names records that could not be read. `kata-cli wiki validate` lists them with the fields the schema does not allow.';
    default:
      return '';
  }
}

export async function evaluateWikiClosure(root: string, taskId: string): Promise<WikiClosureEvaluation> {
  const closure = await readWikiClosure(root, taskId);
  if (!closure) return { valid: false, reason: 'missing' };
  if (!closure.reason) return { valid: false, reason: 'reason_required', closure };
  if (closure.decision === 'deferred') return { valid: false, reason: 'deferred', closure };
  if (closure.decision === 'not_applicable') return { valid: true, decision: 'not_applicable', closure };
  if (closure.candidateIds.length === 0) return { valid: false, reason: 'candidate_required', closure };
  // Tolerant read: an unrelated invalid record must not decide this task's closure, but a candidate the closure names
  // that cannot be read is a real gap and fails closed.
  const { records, invalid } = await readWikiRecordsTolerant(root);
  const validIds = new Set(records.filter((record) => record.status === 'candidate' || record.status === 'verified').map((record) => record.id));
  const unreadableIds = new Set(invalid.map((entry) => entry.path.replace(/^.*\//, '').replace(/\.json$/, '')));
  if (closure.candidateIds.some((id) => unreadableIds.has(id))) return { valid: false, reason: 'unevaluatable_records', closure };
  if (closure.candidateIds.some((id) => !validIds.has(id))) return { valid: false, reason: 'candidate_missing', closure };
  return { valid: true, decision: 'captured', closure };
}

function pathFor(root: string, taskId: string): string {
  return layoutWikiClosurePath(root, taskId);
}

async function persist(root: string, closure: WikiClosure): Promise<void> {
  await mkdir(taskDir(root, closure.taskId), { recursive: true });
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
