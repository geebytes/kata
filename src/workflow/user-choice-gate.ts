import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertValidTaskId } from '../core/ids.js';
import { readValidated } from '../core/schema.js';
import { userChoiceGatePath, taskDir } from '../core/layout.js';
import { bindsToRevision, currentRevisionIdentity, type RevisionIdentity } from './verdict-binding.js';

export type UserChoiceBoundary = 'implementation_gate' | 'review_gate' | 'judge_gate' | 'archive_gate';
export type UserChoice = 'continue_current' | 'switched' | 'delegated';

type UserChoiceGate = {
  taskId: string;
  boundary: UserChoiceBoundary;
  revisionId?: string;
  /** The content identity of the revision this choice was made about; see `verdict-binding.ts`. */
  manifestHash?: string;
  createdAt: string;
  choice?: UserChoice;
  approvedAt?: string;
  consumedAt?: string;
};

export async function createUserChoiceGate(input: { root: string; taskId: string; boundary: UserChoiceBoundary; revisionId?: string }): Promise<void> {
  assertValidTaskId(input.taskId);
  // The caller's revision id stays (it knows which revision the choice belongs to, and a gate is often created before
  // the seal it belongs to). The **content** identity is added from the current revision: the id alone expired the gate
  // on every re-seal of unchanged content, which asked the user for the same platform/model choice again, phase after
  // phase. Either binding is enough to keep it valid (`verdict-binding.ts`).
  const identity = await currentRevisionIdentity(input.root, input.taskId);
  const gate: UserChoiceGate = {
    taskId: input.taskId,
    boundary: input.boundary,
    ...(input.revisionId ? { revisionId: input.revisionId } : {}),
    ...(identity.manifestHash ? { manifestHash: identity.manifestHash } : {}),
    createdAt: new Date().toISOString(),
  };
  await mkdir(taskDir(input.root, input.taskId), { recursive: true });
  await writeFile(pathFor(input.root, input.taskId, input.boundary), `${JSON.stringify(gate, null, 2)}\n`);
}

export async function approveUserChoiceGate(input: { root: string; taskId: string; boundary: UserChoiceBoundary; choice: UserChoice; revisionId?: string }): Promise<void> {
  const gate = await readGate(input.root, input.taskId, input.boundary);
  assertRevision(gate, input.revisionId, (await currentRevisionIdentity(input.root, input.taskId)).manifestHash);
  if (gate.consumedAt) throw new Error(`User choice gate ${input.boundary} has already been consumed.`);
  gate.choice = input.choice;
  gate.approvedAt = new Date().toISOString();
  await writeFile(pathFor(input.root, input.taskId, input.boundary), `${JSON.stringify(gate, null, 2)}\n`);
}

export async function requireUserChoiceGate(input: { root: string; taskId: string; boundary: UserChoiceBoundary; revisionId?: string }): Promise<UserChoiceGate> {
  const gate = await readGate(input.root, input.taskId, input.boundary).catch(() => undefined);
  if (!gate || !gate.choice || gate.consumedAt) throw new Error(`${input.boundary} requires an explicit user choice before continuing.`);
  assertRevision(gate, input.revisionId, (await currentRevisionIdentity(input.root, input.taskId)).manifestHash);
  return gate;
}

export async function consumeUserChoiceGate(input: { root: string; taskId: string; boundary: UserChoiceBoundary; revisionId?: string }): Promise<void> {
  const gate = await requireUserChoiceGate(input);
  gate.consumedAt = new Date().toISOString();
  await writeFile(pathFor(input.root, input.taskId, input.boundary), `${JSON.stringify(gate, null, 2)}\n`);
}

async function readGate(root: string, taskId: string, boundary: UserChoiceBoundary): Promise<UserChoiceGate> {
  assertValidTaskId(taskId);
  return readValidated<UserChoiceGate>('user-choice-gate', pathFor(root, taskId, boundary));
}

/**
 * The caller's revision id is the one to compare against (that is the gate's contract, and a gate may be created around
 * a seal); the sealed content is the second, broader binding, so a re-seal of unchanged content does not re-ask.
 */
function assertRevision(gate: UserChoiceGate, revisionId: string | undefined, manifestHash: string | null): void {
  if (!bindsToRevision(gate, { revisionId: revisionId ?? null, manifestHash })) {
    throw new Error(`User choice gate ${gate.boundary} is not bound to the current revision or its content.`);
  }
}

function pathFor(root: string, taskId: string, boundary: UserChoiceBoundary): string {
  return userChoiceGatePath(root, taskId, boundary);
}
