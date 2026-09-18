import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Phase, Actor } from '../core/state.js';
import { buildGuardInstructions, profileGuardInstructions } from '../policy/guard-instructions.js';
import type { WorkflowProfile } from '../core/workflow-profile.js';
import { taskPath, currentStatePath, evidenceDir as evidenceDirPath } from '../core/layout.js';

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
  const taskRaw = await readFile(taskPath(root, taskId), 'utf8');
  const task = JSON.parse(taskRaw) as {
    id: string;
    title: string;
    acceptance: Array<{ id?: string; statement: string }>;
    phase: string;
    workflowProfile?: WorkflowProfile;
  };

  const stateRaw = await readFile(currentStatePath(root, taskId), 'utf8');
  const state = JSON.parse(stateRaw) as { phase: Phase };

  const evidenceDir = evidenceDirPath(root);
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


