import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertValidTaskId } from '../core/ids.js';

export type UserChoiceBoundary = 'implementation_gate' | 'review_gate' | 'judge_gate' | 'archive_gate';
export type UserChoice = 'continue_current' | 'switched' | 'delegated';

type UserChoiceGate = {
  taskId: string;
  boundary: UserChoiceBoundary;
  revisionId?: string;
  createdAt: string;
  choice?: UserChoice;
  approvedAt?: string;
  consumedAt?: string;
};

export async function createUserChoiceGate(input: { root: string; taskId: string; boundary: UserChoiceBoundary; revisionId?: string }): Promise<void> {
  assertValidTaskId(input.taskId);
  const gate: UserChoiceGate = { taskId: input.taskId, boundary: input.boundary, ...(input.revisionId ? { revisionId: input.revisionId } : {}), createdAt: new Date().toISOString() };
  await mkdir(join(input.root, '.kata/tasks', input.taskId), { recursive: true });
  await writeFile(pathFor(input.root, input.taskId, input.boundary), `${JSON.stringify(gate, null, 2)}\n`);
}

export async function approveUserChoiceGate(input: { root: string; taskId: string; boundary: UserChoiceBoundary; choice: UserChoice; revisionId?: string }): Promise<void> {
  const gate = await readGate(input.root, input.taskId, input.boundary);
  assertRevision(gate, input.revisionId);
  if (gate.consumedAt) throw new Error(`User choice gate ${input.boundary} has already been consumed.`);
  gate.choice = input.choice;
  gate.approvedAt = new Date().toISOString();
  await writeFile(pathFor(input.root, input.taskId, input.boundary), `${JSON.stringify(gate, null, 2)}\n`);
}

export async function requireUserChoiceGate(input: { root: string; taskId: string; boundary: UserChoiceBoundary; revisionId?: string }): Promise<UserChoiceGate> {
  const gate = await readGate(input.root, input.taskId, input.boundary).catch(() => undefined);
  if (!gate || !gate.choice || gate.consumedAt) throw new Error(`${input.boundary} requires an explicit user choice before continuing.`);
  assertRevision(gate, input.revisionId);
  return gate;
}

export async function consumeUserChoiceGate(input: { root: string; taskId: string; boundary: UserChoiceBoundary; revisionId?: string }): Promise<void> {
  const gate = await requireUserChoiceGate(input);
  gate.consumedAt = new Date().toISOString();
  await writeFile(pathFor(input.root, input.taskId, input.boundary), `${JSON.stringify(gate, null, 2)}\n`);
}

async function readGate(root: string, taskId: string, boundary: UserChoiceBoundary): Promise<UserChoiceGate> {
  assertValidTaskId(taskId);
  return JSON.parse(await readFile(pathFor(root, taskId, boundary), 'utf8')) as UserChoiceGate;
}

function assertRevision(gate: UserChoiceGate, revisionId: string | undefined): void {
  if (gate.revisionId !== revisionId) throw new Error(`User choice gate ${gate.boundary} is not bound to the current revision.`);
}

function pathFor(root: string, taskId: string, boundary: UserChoiceBoundary): string {
  return join(root, '.kata/tasks', taskId, `user-choice-${boundary}.json`);
}
