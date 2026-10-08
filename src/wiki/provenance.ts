import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { writeWikiRecord } from './store.js';
import { computeFileHash, type WikiRecord } from './record.js';
import { readWikiClosure, writeWikiClosure, type WikiClosure } from './closure.js';
import { readRecordedEvidence } from '../quality/evidence.js';
import { judgePath as layoutJudgePath, currentStatePath as layoutCurrentStatePath, evidenceDir as layoutEvidenceDir } from '../core/layout.js';
import { answersCurrentQuestion, declaredSubjectRevision, questionBinding, readLedger } from '../store/ledger.js';

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
  const judgePath = layoutJudgePath(root, taskId);
  const judgeRaw = await readFile(judgePath, 'utf8');
  const judge = JSON.parse(judgeRaw) as { taskId: string; result: string; subjectRevision?: string };

  if (judge.taskId !== taskId || judge.result !== 'PASS') {
    throw new Error(`Cannot generate Wiki candidate: task ${taskId} has not passed Judge (result: ${judge.result})`);
  }
  // **The PASS has to be about the question the task now asks.** A judgement that answered a superseded question is not a
  // judgement of this content, and this reader used to accept it on `taskId` and `result` alone — the same gap the review
  // record closed, one reader over.
  const currentSubjectRevision = declaredSubjectRevision(await readLedger(root, taskId));
  if (!answersCurrentQuestion(questionBinding(judge.subjectRevision, currentSubjectRevision))) {
    throw new Error(`Cannot generate Wiki candidate: task ${taskId} Judge answered ${judge.subjectRevision}, not its current declared question (${currentSubjectRevision})`);
  }

  const statePath = layoutCurrentStatePath(root, taskId);
  const stateRaw = await readFile(statePath, 'utf8');
  const state = JSON.parse(stateRaw) as { phase: string };

  if (state.phase !== 'distill' && state.phase !== 'archive') {
    throw new Error(`Cannot generate Wiki candidate: task ${taskId} must be in distill or archive phase (current: ${state.phase})`);
  }

  // The evidence set the task recorded, not a single projection file: a candidate's back-links must name the evidence
  // that actually exists.
  const evidenceIds = (await readRecordedEvidence(root, taskId)).map((envelope) => envelope.id);

  const record: WikiRecord = {
    id: `wiki-${taskId}`,
    statement: input.statement,
    scope: [...input.scope],
    kind: input.kind,
    sourceRefs: [...input.sourceRefs],
    sourceHashes: { ...(input.sourceHashes ?? {}) },
    validationTaskId: taskId,
    // A task distilled this from sources it cites (L4-07): the provenance is the fact that makes it authority about
    // those sources, and stating it here is what the promotion gate reads.
    provenance: 'distilled',
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

  // **Absent, damaged and stale are three facts, and this is the archive/distill boundary.** The read used to fold all
  // three into `deferred('Judge PASS is required…')`, so a `judge.json` nobody could parse read as a task that had not been
  // judged, and a PASS that answered an earlier question read as a current one.
  let judge: { taskId?: string; result?: string; subjectRevision?: string } | null;
  try {
    judge = await readJson<{ taskId?: string; result?: string; subjectRevision?: string }>(root, `.kata/tasks/${taskId}/judge.json`);
  } catch (error) {
    return { decision: 'deferred', candidateIds: [], records: [], reason: `task ${taskId} has a judge record that cannot be read: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!judge || judge.taskId !== taskId || judge.result !== 'PASS') {
    return { decision: 'deferred', candidateIds: [], records: [], reason: 'Judge PASS is required before Wiki distillation' };
  }
  const declared = declaredSubjectRevision(await readLedger(root, taskId));
  if (!answersCurrentQuestion(questionBinding(judge.subjectRevision, declared))) {
    return { decision: 'deferred', candidateIds: [], records: [], reason: `task ${taskId} Judge answered ${judge.subjectRevision}, not its current declared question (${declared})` };
  }

  // **The sibling of the judge read above, and it had the same fold.** `.catch(() => null)` made a state record that cannot
  // be parsed the same `null` as a task that has no state, so the decision said `current: unknown` and the reason for that
  // unknown was lost — an independent round read the two reads side by side and only one of them named the damage.
  let state: { phase?: string } | null;
  try {
    state = await readJson<{ phase?: string }>(root, `.kata/tasks/${taskId}/current-state.json`);
  } catch (error) {
    return { decision: 'deferred', candidateIds: [], records: [], reason: `task ${taskId} has a state record that cannot be read: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (state.phase !== 'distill' && state.phase !== 'archive') {
    return { decision: 'deferred', candidateIds: [], records: [], reason: `Task must be in distill or archive phase before Wiki distillation (current: ${state.phase ?? 'unknown'})` };
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
    const evidenceFiles = await readdir(layoutEvidenceDir(root));
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
