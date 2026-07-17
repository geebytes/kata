import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { lintLlmWiki } from './llmwiki.js';
import { verifySources } from './drift.js';
import { readWikiRecords } from './store.js';
import type { WikiRecord } from './record.js';

const reviewAfterDays = 90;
const maxCandidatesPerTask = 2;

type LifecycleReason =
  | 'source_changed'
  | 'source_missing'
  | 'semantic_superseded'
  | 'scope_changed'
  | 'conflict'
  | 'duplicate'
  | 'review_due'
  | 'candidate_over_budget';

type RecommendedAction = 'revalidate' | 'retire' | 'merge' | 'review_conflict' | 'review' | 'retire_duplicate';

export type WikiLifecycleAction = {
  id: string;
  status: WikiRecord['status'];
  reasons: LifecycleReason[];
  recommendedAction: RecommendedAction;
  confidence: 'low' | 'medium' | 'high';
  successorIds: string[];
  changedSources: string[];
};

export type WikiAudit = {
  generatedAt: string; pageCount: number; staleIds: string[]; reviewDueIds: string[]; duplicateGroups: string[][]; overBudgetTasks: Array<{ taskId: string; candidates: number; limit: number }>; lintOk: boolean; lintIssues: number; recommendedActions: WikiLifecycleAction[];
};

export async function auditWiki(root: string): Promise<WikiAudit> {
  const recordsBeforeDrift = await readWikiRecords(root);
  const sources = await verifySources(root);
  const lint = await lintLlmWiki({ root });
  const records = await readWikiRecords(root);
  const now = Date.now();
  const reviewDueIds = recordsBeforeDrift.filter((record) => record.status === 'verified' && now - Date.parse(record.lastVerifiedAt) > reviewAfterDays * 86_400_000).map((record) => record.id).sort();
  const duplicates = new Map<string, string[]>();
  for (const record of records.filter((item) => item.status === 'candidate' || item.status === 'verified')) {
    const key = record.statement.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    duplicates.set(key, [...(duplicates.get(key) ?? []), record.id]);
  }
  const candidatesByTask = new Map<string, number>();
  for (const record of recordsBeforeDrift.filter((item) => item.status === 'candidate')) candidatesByTask.set(record.validationTaskId, (candidatesByTask.get(record.validationTaskId) ?? 0) + 1);
  const pages = await countPages(join(root, '.llmwiki'));
  const duplicateGroups = [...duplicates.values()].filter((group) => group.length > 1).sort((a, b) => a[0].localeCompare(b[0]));
  const overBudgetTasks = [...candidatesByTask.entries()].filter(([, count]) => count > maxCandidatesPerTask).map(([taskId, candidates]) => ({ taskId, candidates, limit: maxCandidatesPerTask })).sort((a, b) => a.taskId.localeCompare(b.taskId));
  const recommendedActions = lifecycleActions(records, {
    sourceDrift: sources.stale,
    reviewDueIds,
    duplicateGroups,
    overBudgetTaskIds: new Set(overBudgetTasks.map((entry) => entry.taskId)),
    originalStatusById: new Map(recordsBeforeDrift.map((record) => [record.id, record.status])),
  });
  return { generatedAt: new Date().toISOString(), pageCount: pages, staleIds: sources.stale.map((entry) => entry.id).sort(), reviewDueIds, duplicateGroups, overBudgetTasks, lintOk: lint.ok, lintIssues: lint.issues.length, recommendedActions };
}

export async function createRefreshPacket(root: string, taskId: string): Promise<{ path: string; audit: WikiAudit }> {
  const audit = await auditWiki(root);
  const path = join(root, '.kata/tasks', taskId, 'wiki-refresh.json');
  await mkdir(join(root, '.kata/tasks', taskId), { recursive: true });
  await writeFile(path, `${JSON.stringify({ taskId, generatedAt: audit.generatedAt, staleIds: audit.staleIds, reviewDueIds: audit.reviewDueIds, duplicateGroups: audit.duplicateGroups, instructions: ['Revalidate code/document anchors before editing.', 'Update, merge, mark stale, or reject records; do not promote automatically.'] }, null, 2)}\n`);
  return { path: `.kata/tasks/${taskId}/wiki-refresh.json`, audit };
}

export async function relevantWiki(root: string, taskId: string, limit = 8): Promise<WikiRecord[]> {
  const task = JSON.parse(await readFile(join(root, '.kata/tasks', taskId, 'task.json'), 'utf8')) as { title?: string; acceptance?: Array<{ statement?: string }> };
  const terms = new Set(`${task.title ?? ''} ${(task.acceptance ?? []).map((item) => item.statement ?? '').join(' ')}`.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) ?? []);
  return (await readWikiRecords(root)).filter((record) => record.status === 'verified').map((record) => ({ record, score: score(record, terms) })).filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id)).slice(0, limit).map((item) => item.record);
}

function score(record: WikiRecord, terms: Set<string>): number { const text = `${record.statement} ${record.scope.join(' ')} ${record.sourceRefs.join(' ')}`.toLowerCase(); return [...terms].reduce((total, term) => total + (text.includes(term) ? 1 : 0), 0); }
async function countPages(root: string): Promise<number> { try { const entries = await readdir(root, { withFileTypes: true }); const counts = await Promise.all(entries.map((entry) => entry.isDirectory() ? countPages(join(root, entry.name)) : entry.name.endsWith('.md') ? 1 : 0)); return counts.reduce((a, b) => a + b, 0); } catch { return 0; } }

function lifecycleActions(
  records: WikiRecord[],
  context: {
    sourceDrift: Array<{ id: string; reason: 'source_changed' | 'source_missing'; changedSources: string[] }>;
    reviewDueIds: string[];
    duplicateGroups: string[][];
    overBudgetTaskIds: Set<string>;
    originalStatusById: Map<string, WikiRecord['status']>;
  },
): WikiLifecycleAction[] {
  const actions = new Map<string, WikiLifecycleAction>();
  const driftById = new Map(context.sourceDrift.map((entry) => [entry.id, entry]));
  const duplicateIds = new Set(context.duplicateGroups.flat());
  const reviewDueIds = new Set(context.reviewDueIds);

  for (const record of records.filter((item) => item.status !== 'rejected')) {
    const reasons: LifecycleReason[] = [];
    const changedSources: string[] = [];
    const drift = driftById.get(record.id);
    if (drift) {
      reasons.push(drift.reason);
      changedSources.push(...drift.changedSources);
    }
    if (duplicateIds.has(record.id)) reasons.push('duplicate');
    if (reviewDueIds.has(record.id)) reasons.push('review_due');
    const originalStatus = context.originalStatusById.get(record.id) ?? record.status;
    if (originalStatus === 'candidate' && context.overBudgetTaskIds.has(record.validationTaskId)) reasons.push('candidate_over_budget');

    const successors = records
      .filter((candidate) => candidate.id !== record.id
        && candidate.status !== 'rejected'
        && candidate.kind === record.kind
        && overlaps(candidate.scope, record.scope)
        && hasSuccessorLanguage(candidate.statement))
      .map((candidate) => candidate.id)
      .sort();
    if (successors.length > 0) reasons.push('semantic_superseded');

    if (usesAbsoluteLanguage(record.statement) && records.some((candidate) => candidate.id !== record.id && overlaps(candidate.scope, record.scope) && (hasConditionalLanguage(candidate.statement) || hasSuccessorLanguage(candidate.statement)))) {
      reasons.push('scope_changed');
    }

    if (records.some((candidate) => candidate.id !== record.id && candidate.kind === record.kind && overlaps(candidate.scope, record.scope) && conflicts(record.statement, candidate.statement))) {
      reasons.push('conflict');
    }

    const uniqueReasons = [...new Set(reasons)];
    if (uniqueReasons.length === 0) continue;

    actions.set(record.id, {
      id: record.id,
      status: record.status,
      reasons: uniqueReasons,
      recommendedAction: chooseAction(record, uniqueReasons, successors),
      confidence: confidence(uniqueReasons, successors),
      successorIds: successors,
      changedSources: [...new Set(changedSources)].sort(),
    });
  }

  return [...actions.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function chooseAction(record: WikiRecord, reasons: LifecycleReason[], successors: string[]): RecommendedAction {
  if (reasons.includes('semantic_superseded') && successors.length > 0) return 'retire';
  if (reasons.includes('conflict')) return 'review_conflict';
  if (reasons.includes('source_missing') && record.status !== 'verified') return 'retire';
  if (reasons.includes('duplicate') && record.status === 'candidate') return reasons.includes('candidate_over_budget') ? 'merge' : 'retire_duplicate';
  if (reasons.includes('source_changed') || reasons.includes('scope_changed')) return 'revalidate';
  return 'review';
}

function confidence(reasons: LifecycleReason[], successors: string[]): 'low' | 'medium' | 'high' {
  if ((reasons.includes('source_missing') || reasons.includes('semantic_superseded')) && successors.length > 0) return 'high';
  if (reasons.includes('source_changed') || reasons.includes('duplicate')) return 'medium';
  return 'low';
}

function overlaps(a: string[], b: string[]): boolean {
  return a.some((left) => b.includes(left));
}

function hasSuccessorLanguage(statement: string): boolean {
  return /replace|replaces|supersede|supersedes|no longer|instead|自动|不再|替代/i.test(statement);
}

function hasConditionalLanguage(statement: string): boolean {
  return /legacy|current_worktree|mode|profile|revision-bound|revision scoped|条件|模式/i.test(statement);
}

function usesAbsoluteLanguage(statement: string): boolean {
  return /\ball\b|\balways\b|\bnever\b|\bmust\b|所有|必须/i.test(statement);
}

function conflicts(a: string, b: string): boolean {
  const text = `${a}\n${b}`.toLowerCase();
  return [
    ['manual', 'automatic'],
    ['required', 'optional'],
    ['repository-wide', 'revision-scoped'],
    ['promote', 'reject'],
    ['手动', '自动'],
    ['全仓', 'revision'],
  ].some(([left, right]) => text.includes(left) && text.includes(right));
}
