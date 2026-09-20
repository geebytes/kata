import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Phase, Actor } from '../core/state.js';
import { buildGuardInstructions, profileGuardInstructions } from '../policy/guard-instructions.js';
import type { WorkflowProfile } from '../core/workflow-profile.js';
import { taskPath, currentStatePath, evidenceDir as evidenceDirPath, handoffDir, handoffReceiptPath } from '../core/layout.js';
import { readValidatedOptional } from '../core/schema.js';
import type { HandoffReceipt } from './context-fabric.js';

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



/**
 * The hashes a role last acknowledged for this task, or an empty map when it has acknowledged nothing yet.
 *
 * Empty is the conservative answer: with no record, every read is required, which is the behaviour that existed before
 * the memo did. The newest receipt wins, because acknowledgement is per handoff and an older one describes older
 * content.
 */
export async function readAcknowledgedHashes(root: string, taskId: string, role: Role): Promise<Record<string, string>> {
    const receipts = await readContextReceipts(root, taskId);
    const mine = receipts
        .filter((receipt) => receipt.role === role && receipt.contextMemo)
        .sort((left, right) => right.acknowledgedAt.localeCompare(left.acknowledgedAt));
    return mine[0]?.contextMemo?.hashes ?? {};
}

/**
 * Every receipt this task has, read tolerantly.
 *
 * The only other receipt reader needs a handoff id, and the memo question is "what did *this role* last acknowledge",
 * which is a scan. `readValidatedOptional` is the right reader — a receipt being written by another process is an
 * absent one, not a corrupt one — and an unreadable receipt is skipped rather than failing the caller, the same
 * tolerance the Wiki reader uses.
 */
async function readContextReceipts(root: string, taskId: string): Promise<HandoffReceipt[]> {
    const { readdir } = await import('node:fs/promises');
    const directory = handoffDir(root, taskId);
    const entries = await readdir(directory).catch(() => [] as string[]);
    const receipts: HandoffReceipt[] = [];
    for (const entry of entries.filter((name) => name.endsWith('.receipt.json'))) {
        const id = entry.slice(0, -'.receipt.json'.length);
        const receipt = await readValidatedOptional<HandoffReceipt>('handoff-receipt', handoffReceiptPath(root, taskId, id)).catch(() => null);
        if (receipt) receipts.push(receipt);
    }
    return receipts;
}
