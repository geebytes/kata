import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Phase, Actor } from '../core/state.js';
import { profileGuardInstructions, type WorkflowProfile } from '../core/workflow-profile.js';

export type Role = 'designer' | 'implementer' | 'reviewer' | 'judge' | 'distiller' | 'approver';

export interface HandoffBundle {
  taskId: string;
  fromPhase: Phase;
  toRole: Role;
  context: {
    taskTitle: string;
    acceptance: Array<{ id?: string; statement: string }>;
    evidenceIds: string[];
    wikiRecordIds: string[];
    sourceRefs: string[];
  };
  guardInstructions: string[];
  createdAt: string;
}

export async function createHandoff(
  root: string,
  taskId: string,
  nextRole: Role,
): Promise<HandoffBundle> {
  const taskRaw = await readFile(join(root, '.kata/tasks', taskId, 'task.json'), 'utf8');
  const task = JSON.parse(taskRaw) as {
    id: string;
    title: string;
    acceptance: Array<{ id?: string; statement: string }>;
    phase: string;
    workflowProfile?: WorkflowProfile;
  };

  const stateRaw = await readFile(join(root, '.kata/tasks', taskId, 'current-state.json'), 'utf8');
  const state = JSON.parse(stateRaw) as { phase: Phase };

  const evidenceDir = join(root, '.kata/evidence');
  let evidenceIds: string[] = [];
  try {
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(evidenceDir);
    evidenceIds = files.filter((f) => f.startsWith(`${taskId}-`)).sort();
  } catch {
    evidenceIds = [];
  }

  const { readWikiRecords } = await import('../wiki/store.js');
  const wikiRecords = await readWikiRecords(root);
  const wikiRecordIds = wikiRecords
    .filter((r) => r.validationTaskId === taskId)
    .map((r) => r.id);

  const guardInstructions = [...buildGuardInstructions(state.phase, nextRole), ...profileGuardInstructions(task.workflowProfile, nextRole)];

  return {
    taskId,
    fromPhase: state.phase,
    toRole: nextRole,
    context: {
      taskTitle: task.title,
      acceptance: task.acceptance,
      evidenceIds,
      wikiRecordIds,
      sourceRefs: task.acceptance
        .filter((c) => c.id)
        .map((c) => `${c.id}`),
    },
    guardInstructions,
    createdAt: new Date().toISOString(),
  };
}

function buildGuardInstructions(phase: Phase, nextRole: Role): string[] {
  const instructions: string[] = [];

  if (nextRole === 'implementer') {
    instructions.push('Write only to src/, tests/, and task-owned .kata paths.');
    instructions.push('All acceptance criteria must have stable AC-[0-9]+ ids before implement.');
    instructions.push('Do not modify .kata/schemas/, docs/superpowers/rules/, or wiki/verified/.');
  }

  if (nextRole === 'designer') {
    instructions.push('Write only to task design artifacts, docs/, and task-owned .kata paths.');
    instructions.push('Clarify acceptance criteria before implementation.');
    instructions.push('Do not modify implementation files during design.');
  }

  if (nextRole === 'reviewer') {
    instructions.push('You may only write review findings to review.json.');
    instructions.push('Check that acceptance criteria are met by the implementation.');
    instructions.push('Assign severity: blocking (must fix), major, minor, note.');
  }

  if (nextRole === 'judge') {
    instructions.push('You may only write the judge result to judge.json.');
    instructions.push('Evaluate each acceptance criterion independently.');
    instructions.push('Return PASS only if all criteria have fresh passing test evidence and no blocking findings.');
  }

  if (nextRole === 'distiller') {
    instructions.push('You may only write Wiki candidates to .kata/wiki/.');
    instructions.push('Only promote candidates from tasks with Judge PASS.');
    instructions.push('Include source references, hashes, and evidence links.');
  }

  if (phase === 'hardVerify' && nextRole !== 'judge') {
    instructions.push('Fresh evidence must be collected after any repair.');
  }

  return instructions;
}
