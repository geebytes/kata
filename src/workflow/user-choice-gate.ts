import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertValidTaskId } from '../core/ids.js';
import { readValidated } from '../core/schema.js';
import { userChoiceGatePath, taskDir } from '../core/layout.js';
import { bindsToRevision, currentRevisionIdentity, type RevisionIdentity } from './verdict-binding.js';

export type UserChoiceBoundary = 'implementation_gate' | 'review_gate' | 'judge_gate' | 'archive_gate';

/**
 * **The command whose success creates each boundary's gate — one table, read in both directions.**
 *
 * `cli/workflow.ts` uses it to decide which gate a finished command should create, and the refusal below uses it to tell
 * an operator whose gate no longer speaks for the content how to rebuild one. The two used to be independent knowledge:
 * the creation rule was an inline chain, and the remedy appeared nowhere, so a refused gate said only that it was "not
 * bound" — which is true, and leaves the reader to discover the fixing command from experience.
 */
export const GATE_CREATED_BY: Record<UserChoiceBoundary, { command: string; phase: string }> = {
    // `design` moves a task into `plan`, and that is where the implementation gate is created.
    implementation_gate: { command: 'design', phase: 'plan' },
    // A passing `verify` in `hardVerify` creates the review gate; re-running it is also what rebuilds one.
    review_gate: { command: 'verify', phase: 'hardVerify' },
    // An approving `review` creates the judge gate.
    judge_gate: { command: 'review', phase: 'review' },
    // A `judge` that returns creates the archive gate.
    archive_gate: { command: 'judge', phase: 'judge' },
};

/** The boundary a finished command creates, or nothing when that command concludes no boundary. */
export function boundaryCreatedBy(phase: string, command: string, approving = false): UserChoiceBoundary | null {
    for (const [boundary, entry] of Object.entries(GATE_CREATED_BY) as Array<[UserChoiceBoundary, { command: string; phase: string }]>) {
        if (entry.phase !== phase || entry.command !== command) continue;
        // The judge gate is created only by an approving review: a review that records findings opens a repair, not a gate.
        if (boundary === 'judge_gate' && !approving) continue;
        return boundary;
    }
    return null;
}

/** How an operator rebuilds a gate that no longer speaks for the current content. */
export function gateRebuildInstruction(boundary: UserChoiceBoundary): string {
    const entry = GATE_CREATED_BY[boundary];
    const command = boundary === 'judge_gate' ? 'kata-cli review --approve' : `kata-cli ${entry.command}`;
    return `Run \`${command}\` — a successful ${command} recreates this boundary's gate against the current content — then approve it again.`;
}
export type UserChoice = 'continue_current' | 'switched' | 'delegated';

/** The answers a gate accepts, as a value rather than as a union with no runtime form. */
export const USER_CHOICES = ['continue_current', 'switched', 'delegated'] as const satisfies readonly UserChoice[];

/**
 * A choice the human made **for the whole task**, recorded only when they say so.
 *
 * Every trust boundary asks for the platform/model selection, which is right — it is a human decision — but the same
 * human answering the same question at four boundaries is the repetition the notes measured. `--for-task` records the
 * answer once; later boundaries reuse it, **report** that they did (`reusedFromTaskChoice`), and stay bound by content
 * (a re-seal that changes nothing does not re-ask, one that changes something does). The per-boundary gates are still
 * created and still recorded, so nothing is silently skipped.
 */
export type TaskChoice = {
  taskId: string;
  choice: UserChoice;
  revisionId?: string;
  manifestHash?: string;
  createdAt: string;
  approvedAt: string;
};

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
  reusedFromTaskChoice?: boolean;
};

export async function recordTaskChoice(input: {
  root: string;
  taskId: string;
  choice: UserChoice;
  revisionId?: string;
}): Promise<TaskChoice> {
  assertValidTaskId(input.taskId);
  const identity = await currentRevisionIdentity(input.root, input.taskId);
  const now = new Date().toISOString();
  const record: TaskChoice = {
    taskId: input.taskId,
    choice: input.choice,
    ...(input.revisionId ? { revisionId: input.revisionId } : {}),
    ...(identity.manifestHash ? { manifestHash: identity.manifestHash } : {}),
    createdAt: now,
    approvedAt: now,
  };
  await mkdir(taskDir(input.root, input.taskId), { recursive: true });
  await writeFile(taskChoicePath(input.root, input.taskId), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return record;
}

async function readTaskChoice(root: string, taskId: string): Promise<TaskChoice | null> {
  try {
    return await readValidated<TaskChoice>('task-choice', taskChoicePath(root, taskId));
  } catch {
    // No task-level choice (or an unreadable one): the boundary gate has to be answered on its own.
    return null;
  }
}

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

export async function approveUserChoiceGate(input: {
  root: string;
  taskId: string;
  boundary: UserChoiceBoundary;
  choice: UserChoice;
  revisionId?: string;
  /** Record the choice for the whole task as well, so later boundaries reuse it instead of asking again. */
  forTask?: boolean;
}): Promise<void> {
  const gate = await readGate(input.root, input.taskId, input.boundary);
  const identity = await currentRevisionIdentity(input.root, input.taskId);
  // The caller's id when it names one; otherwise the sealed revision, so "current" means the same thing here as it does
  // in every other gate. The content identity is the second, broader binding.
  assertRevision(gate, input.revisionId, identity);
  if (gate.consumedAt) throw new Error(`User choice gate ${input.boundary} has already been consumed.`);
  gate.choice = input.choice;
  gate.approvedAt = new Date().toISOString();
  await writeFile(pathFor(input.root, input.taskId, input.boundary), `${JSON.stringify(gate, null, 2)}\n`);
  if (input.forTask) {
    await recordTaskChoice({
      root: input.root,
      taskId: input.taskId,
      choice: input.choice,
      ...(input.revisionId ? { revisionId: input.revisionId } : {}),
    });
  }
}

export async function requireUserChoiceGate(input: { root: string; taskId: string; boundary: UserChoiceBoundary; revisionId?: string }): Promise<UserChoiceGate> {
  const gate = await readGate(input.root, input.taskId, input.boundary).catch(() => undefined);
  const identity = await currentRevisionIdentity(input.root, input.taskId);
  if (gate?.choice && !gate.consumedAt) {
    assertRevision(gate, input.revisionId, identity);
    return gate;
  }

  // No decision at this boundary: reuse the task-level one if the human recorded it and it still speaks for this
  // content. Reported, not silent — the caller (and the operator reading the result) can see that it was reused.
  const taskChoice = await readTaskChoice(input.root, input.taskId);
  if (taskChoice && bindsToRevision(taskChoice, { ...identity, revisionId: input.revisionId ?? identity.revisionId })) {
    const reused: UserChoiceGate = {
      taskId: input.taskId,
      boundary: input.boundary,
      ...(taskChoice.revisionId ? { revisionId: taskChoice.revisionId } : {}),
      ...(taskChoice.manifestHash ? { manifestHash: taskChoice.manifestHash } : {}),
      createdAt: taskChoice.createdAt,
      choice: taskChoice.choice,
      approvedAt: taskChoice.approvedAt,
      reusedFromTaskChoice: true,
    };
    // Materialised at this boundary too: the gate file is the audit trail, and "this boundary reused the task choice"
    // belongs in it rather than only in a status message.
    await mkdir(taskDir(input.root, input.taskId), { recursive: true });
    await writeFile(pathFor(input.root, input.taskId, input.boundary), `${JSON.stringify(reused, null, 2)}\n`);
    return reused;
  }
  throw new Error(`${input.boundary} requires an explicit user choice before continuing.`);
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
 * Whether a gate speaks for this boundary: by the revision the caller names, by the revision that is sealed, or by the
 * content the gate was answered about.
 *
 * The case worth spelling out is the one the whole change is about — a re-seal of unchanged content issues a new
 * revision id, so an id-only comparison asks the human again; matching the content identity instead does not. A gate
 * that names neither (it was approved around the first seal) still authorises, which is what it did before.
 */
function assertRevision(gate: UserChoiceGate, callerRevisionId: string | undefined, identity: RevisionIdentity): void {
  if (!gate.revisionId && !gate.manifestHash && !callerRevisionId) return;
  const idMatches = Boolean(gate.revisionId)
    && gate.revisionId === (callerRevisionId ?? identity.revisionId);
  const contentMatches = Boolean(gate.manifestHash) && gate.manifestHash === identity.manifestHash;
  if (idMatches || contentMatches) return;
  // **The refusal carries the next step.** It said only that the gate "is not bound to the current revision or its
  // content", which is a true statement about the state and no statement at all about the remedy — and the remedy is not
  // guessable: the gate has to be *recreated*, by the command whose success creates this boundary's gate.
  throw new Error(
    `User choice gate ${gate.boundary} is not bound to the current revision or its content. `
    + `${gateRebuildInstruction(gate.boundary)}`,
  );
}

function pathFor(root: string, taskId: string, boundary: UserChoiceBoundary): string {
  return userChoiceGatePath(root, taskId, boundary);
}

function taskChoicePath(root: string, taskId: string): string {
  return join(taskDir(root, taskId), 'user-choice-task.json');
}
