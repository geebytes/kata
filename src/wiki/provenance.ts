import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { writeWikiRecord } from './store.js';
import { computeFileHash, type WikiRecord } from './record.js';
import { readWikiClosure, writeWikiClosure, type WikiClosure } from './closure.js';

export interface CandidateInput {
  statement: string;
  scope: string[];
  kind: string;
  sourceRefs: string[];
  sourceHashes?: Record<string, string>;
}

export type DistillKnowledgeResult =
  | { decision: 'captured'; candidateIds: string[]; records: WikiRecord[]; closure: WikiClosure }
  | { decision: 'not_applicable'; candidateIds: []; records: []; closure: WikiClosure }
  | { decision: 'deferred'; candidateIds: []; records: []; reason: string };

export async function proposeFromPassedTask(root: string, taskId: string, input: CandidateInput): Promise<WikiRecord[]> {
  const judgePath = join(root, '.kata/tasks', taskId, 'judge.json');
  const judgeRaw = await readFile(judgePath, 'utf8');
  const judge = JSON.parse(judgeRaw) as { taskId: string; result: string };

  if (judge.taskId !== taskId || judge.result !== 'PASS') {
    throw new Error(`Cannot generate Wiki candidate: task ${taskId} has not passed Judge (result: ${judge.result})`);
  }

  const statePath = join(root, '.kata/tasks', taskId, 'current-state.json');
  const stateRaw = await readFile(statePath, 'utf8');
  const state = JSON.parse(stateRaw) as { phase: string };

  if (state.phase !== 'distill' && state.phase !== 'archive') {
    throw new Error(`Cannot generate Wiki candidate: task ${taskId} must be in distill or archive phase (current: ${state.phase})`);
  }

  const evidencePath = join(root, `.kata/evidence/${taskId}-hard.json`);
  let evidenceIds: string[] = [];
  try {
    const evidenceRaw = await readFile(evidencePath, 'utf8');
    const parsed = JSON.parse(evidenceRaw) as { id?: string };
    if (parsed.id) evidenceIds = [parsed.id];
  } catch {
    const { readdir } = await import('node:fs/promises');
    const evidenceDir = join(root, '.kata/evidence');
    const files = await readdir(evidenceDir);
    const taskEvidenceFiles = files.filter((f) => f.startsWith(`${taskId}-`));
    for (const file of taskEvidenceFiles) {
      const raw = await readFile(join(evidenceDir, file), 'utf8');
      const parsed = JSON.parse(raw) as { id?: string };
      if (parsed.id) evidenceIds.push(parsed.id);
    }
  }

  const record: WikiRecord = {
    id: `wiki-${taskId}`,
    statement: input.statement,
    scope: [...input.scope],
    kind: input.kind,
    sourceRefs: [...input.sourceRefs],
    sourceHashes: { ...(input.sourceHashes ?? {}) },
    validationTaskId: taskId,
    evidenceIds,
    status: 'candidate',
    lastVerifiedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await writeWikiRecord(root, record);
  return [record];
}

export async function distillPassedTaskKnowledge(root: string, taskId: string): Promise<DistillKnowledgeResult> {
  const existing = await readWikiClosure(root, taskId);
  if (existing && existing.decision !== 'deferred' && existing.reason) {
    return existing.decision === 'captured'
      ? { decision: 'captured', candidateIds: existing.candidateIds, records: [], closure: existing }
      : { decision: 'not_applicable', candidateIds: [], records: [], closure: existing };
  }

  const task = await readTask(root, taskId).catch((error: unknown) => ({ error }));
  if ('error' in task) return { decision: 'deferred', candidateIds: [], records: [], reason: 'task artifact is missing or unreadable' };

  const judge = await readJson<{ taskId: string; result: string }>(root, `.kata/tasks/${taskId}/judge.json`).catch(() => null);
  if (!judge || judge.taskId !== taskId || judge.result !== 'PASS') {
    return { decision: 'deferred', candidateIds: [], records: [], reason: 'Judge PASS is required before Wiki distillation' };
  }

  const state = await readJson<{ phase: string }>(root, `.kata/tasks/${taskId}/current-state.json`).catch(() => null);
  if (!state || (state.phase !== 'distill' && state.phase !== 'archive')) {
    return { decision: 'deferred', candidateIds: [], records: [], reason: `Task must be in distill or archive phase before Wiki distillation (current: ${state?.phase ?? 'unknown'})` };
  }

  const design = await readText(root, `.kata/tasks/${taskId}/design.md`);
  const sourceRefs = await sourceRefsForTask(root, taskId, task.ownedPaths ?? []);
  const sourceHashes = await hashSources(root, sourceRefs).catch(() => null);
  if (!sourceHashes) {
    return { decision: 'deferred', candidateIds: [], records: [], reason: 'Could not compute source hashes for Wiki candidate provenance' };
  }

  if (!hasReusableKnowledge(task, design)) {
    const closure = await writeWikiClosure(root, taskId, {
      decision: 'not_applicable',
      reason: 'No reusable project knowledge detected from task title, acceptance criteria, design, or owned paths.',
    });
    return { decision: 'not_applicable', candidateIds: [], records: [], closure };
  }

  const records = await proposeFromPassedTask(root, taskId, {
    statement: statementFor(taskId, task, design),
    scope: [...new Set([...(task.ownedPaths ?? []), `.kata/tasks/${taskId}/task.json`, `.kata/tasks/${taskId}/design.md`])],
    kind: kindFor(task, design),
    sourceRefs,
    sourceHashes,
  });
  const candidateIds = records.map((record) => record.id);
  const closure = await writeWikiClosure(root, taskId, {
    decision: 'captured',
    reason: 'Automatically captured reusable project knowledge from Judge-PASS task artifacts.',
    candidateIds,
  });
  return { decision: 'captured', candidateIds, records, closure };
}

type TaskArtifact = {
  title: string;
  acceptance: Array<{ id?: string; statement: string }>;
  ownedPaths?: string[];
};

async function readTask(root: string, taskId: string): Promise<TaskArtifact> {
  return readJson<TaskArtifact>(root, `.kata/tasks/${taskId}/task.json`);
}

async function readJson<T>(root: string, path: string): Promise<T> {
  return JSON.parse(await readFile(join(root, path), 'utf8')) as T;
}

async function readText(root: string, path: string): Promise<string> {
  try {
    return await readFile(join(root, path), 'utf8');
  } catch {
    return '';
  }
}

async function sourceRefsForTask(root: string, taskId: string, ownedPaths: string[]): Promise<string[]> {
  const refs = [
    `.kata/tasks/${taskId}/task.json`,
    `.kata/tasks/${taskId}/design.md`,
    `.kata/tasks/${taskId}/review.json`,
    `.kata/tasks/${taskId}/judge.json`,
    ...ownedPaths,
  ];
  try {
    const evidenceFiles = await readdir(join(root, '.kata/evidence'));
    refs.push(...evidenceFiles.filter((file) => file.startsWith(`${taskId}-`)).map((file) => `.kata/evidence/${file}`));
  } catch { /* no evidence directory */ }
  const existing: string[] = [];
  for (const ref of refs) {
    try {
      await readFile(join(root, ref), 'utf8');
      existing.push(ref);
    } catch { /* optional artifact */ }
  }
  return [...new Set(existing)].sort();
}

async function hashSources(root: string, refs: string[]): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const ref of refs) {
    hashes[ref] = computeFileHash(await readFile(join(root, ref), 'utf8'));
  }
  return hashes;
}

function hasReusableKnowledge(task: TaskArtifact, design: string): boolean {
  const text = `${task.title}\n${task.acceptance.map((item) => item.statement).join('\n')}\n${design}\n${(task.ownedPaths ?? []).join('\n')}`;
  if (/(mechanical|formatting|typo|spelling|pure test|fixture only|局部|机械|拼写|格式)/i.test(text)) return false;
  return /(workflow|architecture|contract|convention|lifecycle|wiki|evidence|handoff|revision|policy|archive|distill|governance|自动|规则|流程|架构|约束)/i.test(text);
}

function kindFor(task: TaskArtifact, design: string): string {
  const text = `${task.title}\n${design}`.toLowerCase();
  if (/workflow|archive|distill|lifecycle|handoff|流程/.test(text)) return 'workflow-convention';
  if (/architecture|架构/.test(text)) return 'architecture-note';
  if (/policy|governance|治理/.test(text)) return 'governance-rule';
  return 'implementation-note';
}

function statementFor(taskId: string, task: TaskArtifact, design: string): string {
  const acceptanceSummary = task.acceptance.map((item) => item.id ? `${item.id}: ${item.statement}` : item.statement).join(' ');
  const durableHint = design.match(/(?:## 目标|## 方案|## 决策)([\s\S]{0,360})/)?.[1]?.replace(/\s+/g, ' ').trim();
  return [
    `Task ${taskId} established reusable ${kindFor(task, design)} knowledge: ${task.title}.`,
    `Acceptance covered ${acceptanceSummary}.`,
    durableHint ? `Durable rule: ${durableHint}` : 'Durable rule applies to the task-owned implementation scope and gate artifacts.',
  ].join(' ');
}
