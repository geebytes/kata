import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertValidTaskId } from '../core/ids.js';
import { readValidated } from '../core/schema.js';
import { userChoiceGatePath, taskDir } from '../core/layout.js';
import { bindsToRevision, currentRevisionIdentity, type RevisionIdentity } from './verdict-binding.js';

export type UserChoiceBoundary = 'implementation_gate' | 'review_gate' | 'judge_gate' | 'archive_gate';

/** The boundaries, as a value — the vocabulary the path builder validates against. */
export const USER_CHOICE_BOUNDARIES = ['implementation_gate', 'review_gate', 'judge_gate', 'archive_gate'] as const;

/**
 * **A boundary name is validated where the path is built, because a cast was a path traversal.**
 *
 * `kata gate reset --boundary ../../src/a` cast the operator's string and `path.join(taskDir, `user-choice-${boundary}.json`)`
 * normalised it, so the `..` segments cancelled the first one and `rm` removed whatever the value resolved to (measured by an
 * independent round, `src/cli/workflow.ts:351`). Every reader and writer of a gate record goes through `pathFor`, so asking
 * the vocabulary here closes the traversal for all of them at once — the same reason `assertUserChoice` sits in the writer.
 */
/** A boundary name that is not a boundary. Typed, so a reader can tell a caller's mistake from a damaged record. */
export class UnknownBoundaryError extends Error {
  constructor(readonly boundary: string) {
    super(`Unknown gate boundary "${boundary}": it is not one of ${USER_CHOICE_BOUNDARIES.join(', ')}. Nothing was read or written.`);
    this.name = 'UnknownBoundaryError';
  }
}

export function assertUserChoiceBoundary(boundary: string): asserts boundary is UserChoiceBoundary {
  if (!(USER_CHOICE_BOUNDARIES as readonly string[]).includes(boundary)) throw new UnknownBoundaryError(boundary);
}

/**
 * **The command whose success creates each boundary's gate — one table, read in both directions.**
 *
 * `cli/workflow.ts` uses it to decide which gate a finished command should create, and the refusal below uses it to tell
 * an operator whose gate no longer speaks for the content how to rebuild one. The two used to be independent knowledge:
 * the creation rule was an inline chain, and the remedy appeared nowhere, so a refused gate said only that it was "not
 * bound" — which is true, and leaves the reader to discover the fixing command from experience.
 */
/**
 * Which command creates which boundary, and — only where the phase genuinely distinguishes it — the phase it is created in.
 *
 * **`review_gate` carries no phase, and that is the fix for a measured deadlock.** The entry used to read
 * `{ command: 'verify', phase: 'hardVerify' }`, and `boundaryCreatedBy` matches on the phase a command *reports* — while
 * `cmdVerify` reports the phase it *entered* with. So a verify run from a task already in `review` reported `review`, found
 * no entry, and never recreated the gate: the remedy every refusal prints ("run the command that creates this boundary's
 * gate") was inert in exactly the state that needed it, and the only way out was `build --seal`, which mints a revision for
 * content that did not change. A successful `verify` is what creates this boundary, whichever phase it entered from.
 */
export const GATE_CREATED_BY: Record<UserChoiceBoundary, { command: string; phase?: string }> = {
    // `design` moves a task into `plan`, and that is where the implementation gate is created.
    implementation_gate: { command: 'design', phase: 'plan' },
    review_gate: { command: 'verify' },
    // An approving `review` creates the judge gate.
    judge_gate: { command: 'review', phase: 'review' },
    // A `judge` that returns creates the archive gate.
    archive_gate: { command: 'judge', phase: 'judge' },
};

/** The boundary a finished command creates, or nothing when that command concludes no boundary. */
export function boundaryCreatedBy(phase: string, command: string, approving = false): UserChoiceBoundary | null {
    for (const [boundary, entry] of Object.entries(GATE_CREATED_BY) as Array<[UserChoiceBoundary, { command: string; phase?: string }]>) {
        // A boundary with no phase is created by the command's success alone: the honest condition for a boundary whose
        // creating command does not conclude a phase transition.
        if (entry.command !== command) continue;
        if (entry.phase !== undefined && entry.phase !== phase) continue;
        // The judge gate is created only by an approving review: a review that records findings opens a repair, not a gate.
        if (boundary === 'judge_gate' && !approving) continue;
        return boundary;
    }
    return null;
}

/**
 * **What consumes each boundary, and what the operator runs after it — one table, for the same reason `GATE_CREATED_BY` exists.**
 *
 * Measured (I-37): a consumed `judge_gate` printed the command that *creates* it (`kata-cli review --approve`), which
 * requires the phase to be `review` — while a task whose `judge` succeeded sits in `judge`. So the refusal named a road that
 * is closed in exactly the state that printed it, `gate approve` refuses a consumed gate, and `judge` refuses without a fresh
 * choice: three roads, all closed, and the task was unlocked by hand-writing the record.
 *
 * The road for a consumed boundary is therefore not "recreate it": the boundary was **crossed**, and what comes next is the
 * next step of the ladder. Naming that step from a table is what makes the sentence checkable — the selector walks this table
 * and asserts every named verb is one the CLI knows.
 */
export const GATE_CONSUMED_BY: Record<UserChoiceBoundary, { command: string; next?: UserChoiceBoundary }> = {
    implementation_gate: { command: 'kata-cli build', next: 'review_gate' },
    review_gate: { command: 'kata-cli review', next: 'judge_gate' },
    judge_gate: { command: 'kata-cli judge', next: 'archive_gate' },
    // The last boundary has no next: the ladder ends here.
    archive_gate: { command: 'kata-cli archive' },
};

/**
 * What an operator is told when the boundary they are trying to approve was already crossed.
 *
 * **Facts, not a promised road.** The first version named a command to "continue with" — `kata-cli review --approve` for a
 * consumed `review_gate`, `kata-cli archive` for a consumed `judge_gate` — and an independent round measured both refused in
 * the very state the refusal is printed from (the first needs a fresh `review_gate`, the second needs an approved
 * `archive_gate`). A refusal that names a door it has not checked is the class this change exists to remove, so the sentence
 * now states what happened, which command did it, and where the *next* boundary's gate comes from — facts this module holds
 * in its own tables — and claims nothing about what will run now.
 */
export function gateConsumedInstruction(boundary: UserChoiceBoundary): string {
    const entry = GATE_CONSUMED_BY[boundary];
    if (entry.next === undefined) {
        return `This boundary was already crossed by \`${entry.command}\`, so there is nothing to approve here: the ladder ends at `
            + `\`${boundary}\`. \`kata-cli status\` reports where the task stands.`;
    }
    const next = GATE_CREATED_BY[entry.next];
    const nextCommand = entry.next === 'judge_gate' ? 'kata-cli review --approve' : `kata-cli ${next.command}`;
    return `This boundary was already crossed by \`${entry.command}\`, so there is nothing to approve here. The next boundary `
        + `(\`${entry.next}\`) gets its gate from \`${nextCommand}\`${next.phase ? `, which runs in phase \`${next.phase}\`` : ''}.`;
}

/** How an operator rebuilds a gate that no longer speaks for the current content. */
/**
 * Where a gate comes from, for a refusal that has to say how one is rebuilt.
 *
 * **The phase is stated, because it is what makes the road checkable.** A refusal used to say "run `kata-cli review --approve`"
 * about a boundary whose gate can only be recreated in phase `review` — and a task whose `judge` succeeded sits in `judge`, so
 * the printed road was refused where it was printed (measured by two independent rounds: the consumed branch and then
 * `assertRevision`'s). The sentence names the command and the phase it runs in, both read from `GATE_CREATED_BY`, and a
 * boundary whose entry carries no phase says so rather than implying one.
 */
export function gateRebuildInstruction(boundary: UserChoiceBoundary): string {
    const entry = GATE_CREATED_BY[boundary];
    const command = boundary === 'judge_gate' ? 'kata-cli review --approve' : `kata-cli ${entry.command}`;
    // **"Creates this boundary when it concludes in phase X", not "runs in phase X".** The phase in the table is the phase a
    // command *reports* when its success creates the boundary, and a command can report another phase when it concludes
    // differently (`judge` reports `review` on a FAIL and creates no archive gate) — so "runs in phase judge" was a claim the
    // table cannot support (measured by the second round).
    return `This boundary's gate is created by \`${command}\``
        + `${entry.phase ? ` when it concludes in phase \`${entry.phase}\`` : ''}`
        + `; run it against the current content and approve the gate again.`;
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

/**
 * The task-level choice, in the same three states as a boundary's record — because folding them was the defect one function
 * over (measured by the first round: an absent task-choice, one that is not JSON, and one whose `choice` its schema refuses
 * all produced the identical "requires an explicit user choice" refusal, so a damaged file sent the operator to answer a
 * boundary whose reuse was sitting there unreadable).
 */
/** A boundary the caller must supply, refused by name when it is missing. */
function requireBoundary(boundary: UserChoiceBoundary | undefined): UserChoiceBoundary {
  if (boundary === undefined) throw new Error('A boundary record needs --boundary; only the task-level choice is addressed without one.');
  assertUserChoiceBoundary(boundary);
  return boundary;
}

/** The task-level choice in the three states, read for the reset verb (which must not go through the binding logic). */
async function readTaskChoiceStateForReset(root: string, taskId: string): Promise<TaskChoiceState> {
  return readTaskChoice(root, taskId);
}

/**
 * A record that may be removed is a **regular file**: anything else is refused by name, before it is read.
 *
 * Measured by the second round, one errno apart each time: a directory threw a raw EISDIR; a symlink made the audit's digest
 * describe the *target* while the removal took the link (so the audit and the tree disagreed about what was removed); a FIFO
 * made the reader block forever; and a mode-000 file threw a raw EACCES. The check happens before the read, so no shape can
 * hang or throw out of the command.
 */
function assertResettableRecord(path: string, what: string): void {
  // **`lstat`, not `stat`.** `stat` follows a link, so a symlink to a file answered `isFile()` and the removal took the link
  // while the audit described the target — measured, and the same distinction an earlier change in this repository paid for.
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    throw new Error(`The ${what} record cannot be examined at ${path} (${(error as Error).message}), so nothing was removed.`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    const shape = stat.isSymbolicLink() ? 'a symbolic link' : stat.isDirectory() ? 'a directory' : 'not a regular file';
    throw new Error(
      `The ${what} path is ${shape}, not a record: ${path}. This command removes records only, so nothing was removed.`,
    );
  }
}

/** The task-level choice in three states, the shape `GateState` has for a boundary's record. */
type TaskChoiceState =
  | { kind: 'absent' }
  | { kind: 'damaged'; why: string }
  | { kind: 'usable'; choice: TaskChoice };

async function readTaskChoice(root: string, taskId: string): Promise<TaskChoiceState> {
  try {
    return { kind: 'usable', choice: await readValidated<TaskChoice>('task-choice', taskChoicePath(root, taskId)) };
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
      || (typeof cause === 'object' && cause !== null && (cause as NodeJS.ErrnoException).code === 'ENOENT');
    if (missing) return { kind: 'absent' };
    return { kind: 'damaged', why: (error as Error).message };
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

/**
 * **The write side asks the same vocabulary the read side enforces — because it did not, and that asymmetry deadlocked a
 * task.**
 *
 * Measured (I-36): `kata-cli gate approve --boundary archive_gate --choice archive` returned `approved: true` and wrote the
 * record, and the schema rejects `archive` — so every later read of that record failed (`$.choice must be one of …`),
 * `gate approve` refused, the phase command refused ("requires an explicit user choice"), a missing file did not read as
 * "no gate" either, and no command removed or rewrote it. The task was stuck on that boundary until the record was restored
 * to its creation-time shape by hand.
 *
 * The refusal names the value and the vocabulary, and it happens **before anything is read or written**, so a rejected
 * value cannot leave a record behind. `asserts` narrows the caller's string to the union in the same step, which is why
 * the CLI can pass what the operator typed instead of casting it.
 */
export function assertUserChoice(choice: string): asserts choice is UserChoice {
  if (!(USER_CHOICES as readonly string[]).includes(choice)) {
    throw new Error(
      `User choice gate refuses the choice "${choice}": it is not one of ${USER_CHOICES.join(', ')}. Nothing was written.`,
    );
  }
}

export async function approveUserChoiceGate(input: {
  root: string;
  taskId: string;
  boundary: UserChoiceBoundary;
  /**
   * **What the operator typed, not a narrowed type.** The parameter used to be `UserChoice`, so the only way the CLI could
   * pass a string was a cast — and the cast is what let `--choice archive` reach the record. Accepting the string and
   * narrowing it here keeps the validation in exactly one place: a second assertion in the CLI would be one rule in two
   * places, which is the class this repository keeps measuring (and the mutation audit proved it: removing the CLI's copy
   * changed nothing, because the writer's copy was still there).
   */
  choice: string;
  revisionId?: string;
  /** Record the choice for the whole task as well, so later boundaries reuse it instead of asking again. */
  forTask?: boolean;
}): Promise<void> {
  // **Before the read**, so a refused value cannot be recorded even when the record on disk is damaged or absent. This is
  // the only place the vocabulary is enforced on the write side.
  assertUserChoice(input.choice);
  const gate = await readGate(input.root, input.taskId, input.boundary);
  const identity = await currentRevisionIdentity(input.root, input.taskId);
  // The caller's id when it names one; otherwise the sealed revision, so "current" means the same thing here as it does
  // in every other gate. The content identity is the second, broader binding.
  assertRevision(gate, input.revisionId, identity);
  // **The same remedy sentence the stale branch prints.** A consumed gate is the normal state after a phase command
  // succeeded, and the way forward is not guessable: the gate has to be *recreated*, by the command whose success creates
  // this boundary. Reported from another checkout: this branch answered "has already been consumed" and stopped, so the
  // operator had nothing to act on.
  if (gate.consumedAt) {
    throw new Error(`User choice gate ${input.boundary} has already been consumed. ${gateConsumedInstruction(input.boundary)}`);
  }
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
  // **Absence is not damage.** The read used to swallow every failure, so a damaged record answered the message for a
  // boundary nobody had answered — and the operator's next move was to approve it, which failed on the same schema error.
  const state = await readGateState(input.root, input.taskId, input.boundary);
  if (state.kind === 'damaged') {
    throw new Error(
      `The ${input.boundary} record is damaged and cannot be read (${state.why}). Remove it with `
      + `\`kata-cli gate reset --task ${input.taskId} --boundary ${input.boundary} --reason <why>\`, then answer this boundary again.`,
    );
  }
  const gate = state.kind === 'usable' ? state.gate : undefined;
  const identity = await currentRevisionIdentity(input.root, input.taskId);
  if (gate?.choice && !gate.consumedAt) {
    assertRevision(gate, input.revisionId, identity);
    return gate;
  }

  // No decision at this boundary: reuse the task-level one if the human recorded it and it still speaks for this
  // content. Reported, not silent — the caller (and the operator reading the result) can see that it was reused.
  const taskChoiceState = await readTaskChoice(input.root, input.taskId);
  if (taskChoiceState.kind === 'damaged') {
    // **Named rather than folded into "no choice yet".** A damaged task-choice is a file somebody wrote and the reader cannot
    // use, and the road is to remove it (`gate reset`), not to answer the boundary again and again.
    throw new Error(
      `The task-level choice record is damaged and cannot be read (${taskChoiceState.why}). Remove it with `
      + `\`kata-cli gate reset --task ${input.taskId} --record task-choice --reason <why>\`, then answer this boundary again.`,
    );
  }
  const taskChoice = taskChoiceState.kind === 'usable' ? taskChoiceState.choice : null;
  if (taskChoice && bindsToRevision(taskChoice, { ...identity, revisionId: input.revisionId ?? identity.revisionId })) {
    // **No second validation here, deliberately.** The task-choice record was read through its own schema, whose `choice`
    // enum is the same vocabulary (`tests/unit/an-out-of-vocabulary-gate-choice-is-refused.test.ts` compares them), so a
    // value reaching this line is already legal and an assertion would be unreachable defence — measured: the mutation that
    // removed it changed no reading, which is how an unobservable guard is found. What *was* reachable is the record this
    // materialises: it carries `reusedFromTaskChoice`, a field the gate schema did not list while the writer wrote it, so
    // the record failed its own reader's schema (round-1 blocking finding). The schema lists it now, and the case that
    // proves it round-trips is the instrument for that.
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

/**
 * **The three states of a boundary's record, told apart.** `absent` (nothing was ever answered here), `damaged` (a record
 * exists and cannot be read) and `usable`.
 *
 * The reader used to collapse the first two: every failure became "no gate", so a record whose `choice` its own schema
 * rejects answered `requires an explicit user choice before continuing` — the message for a boundary nobody has answered
 * (measured, I-36). The two have different remedies, and the road for `damaged` is `gate reset`, which is why the state has
 * to be nameable rather than inferred from an exception.
 */
export type GateState =
  | { kind: 'absent' }
  | { kind: 'damaged'; why: string }
  | { kind: 'usable'; gate: UserChoiceGate };

export async function readGateState(root: string, taskId: string, boundary: UserChoiceBoundary): Promise<GateState> {
  assertValidTaskId(taskId);
  try {
    return { kind: 'usable', gate: await readValidated<UserChoiceGate>('user-choice-gate', pathFor(root, taskId, boundary)) };
  } catch (error) {
    // **A boundary name that is not a boundary is the caller's error, not a damaged record.** The vocabulary is asserted in
    // the one place the path is built, which is inside the `try` above — so without this, a bad argument was reported as a
    // corrupt file on disk (measured by this change's own case). One assert, and the reader tells the two apart.
    if (error instanceof UnknownBoundaryError) throw error;
    // Only "the file is not there" is absence — read the way `readValidatedOptional` reads it, from the cause, because
    // `readValidated` wraps the filesystem error in a message of its own. A parse or schema failure is a damaged record,
    // and answering "no decision" about one is the fold this change exists to refuse.
    const cause = (error as { cause?: unknown }).cause;
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
      || (typeof cause === 'object' && cause !== null && (cause as NodeJS.ErrnoException).code === 'ENOENT');
    if (missing) return { kind: 'absent' };
    return { kind: 'damaged', why: (error as Error).message };
  }
}

/**
 * **Remove a gate record the mechanism cannot read — and nothing else.**
 *
 * The measured deadlock had no road at all: the damaged record failed every read, `gate approve` refused it, the phase
 * command refused for want of a choice, and no command removed or rewrote it, so the task was stuck until the record was
 * restored by hand. This is the narrow repair: it acts **only** on `damaged`, so a valid record — approved, consumed, or
 * waiting to be answered — is a decision somebody made and cannot be erased by a command in this change.
 */
export async function resetUserChoiceGate(input: {
  root: string;
  taskId: string;
  /**
   * Which record to reset: a boundary's gate, or the task-level choice the boundaries reuse.
   *
   * **The task-level record needed this road, and the refusal printed a command that could not walk it.** A damaged
   * `user-choice-task.json` was answered with `gate reset --boundary <boundary>`, and the reset acts on
   * `user-choice-<boundary>.json` — so the file the refusal named was never touched (measured by the second round: the
   * shape of the first round's F3, one function over).
   */
  record: 'boundary' | 'task-choice';
  boundary?: UserChoiceBoundary;
  /** Why the record is being removed. Stored beside it: a removal without a recorded reason is not auditable. */
  reason: string;
}): Promise<{ removed: boolean; path: string; auditPath: string; removedBecause?: string }> {
  if (input.reason.trim() === '') {
    throw new Error('A gate record is removed only with a stated reason, so the removal can be read back.');
  }
  const path = input.record === 'task-choice' ? taskChoicePath(input.root, input.taskId) : pathFor(input.root, input.taskId, requireBoundary(input.boundary));
  const auditPath = `${path}.removed.json`;
  const state = input.record === 'task-choice'
    ? await readTaskChoiceStateForReset(input.root, input.taskId)
    : await readGateState(input.root, input.taskId, requireBoundary(input.boundary));
  const what = input.record === 'task-choice' ? 'task-level choice' : `${input.boundary}`;
  if (state.kind === 'absent') {
    throw new Error(`There is no ${what} record to reset: nothing was ever answered there.`);
  }
  if (state.kind === 'usable') {
    throw new Error(
      `The ${what} record is readable, so it is a decision rather than damage, and this command refuses to remove one. `
      + `If it no longer speaks for the content, the road is to recreate it${input.boundary ? ` (${gateRebuildInstruction(input.boundary)})` : ''}.`,
    );
  }
  // **Only a regular file is a record.** A symlink, a directory, a FIFO or an unreadable file is not one: a symlink made the
  // audit's digest describe the target while the removal took the link, a FIFO made the reader block forever, and an
  // unreadable file threw a raw EACCES out of the command (all three measured by the second round). Each is refused by name,
  // and the shape is checked before anything is read so a reader cannot block on it either.
  assertResettableRecord(path, what);
  const removedSha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
  // **The audit is written before the removal.** Written after, a failure left the record gone with no trace and a raw
  // filesystem error out of the command (measured by the second round: a directory at the audit path did exactly that). If
  // this write fails, nothing has been removed yet, so the state is unchanged and the operator sees a refusal.
  try {
    await writeFile(auditPath, `${JSON.stringify({
      taskId: input.taskId,
      record: input.record,
      ...(input.boundary ? { boundary: input.boundary } : {}),
      removedAt: new Date().toISOString(),
      reason: input.reason,
      removedSha256,
    }, null, 2)}\n`, { flag: 'wx' });
  } catch (error) {
    throw new Error(
      `The removal was not performed because its audit record could not be written at ${auditPath} `
      + `(${(error as Error).message}). Nothing was removed.`,
    );
  }
  await rm(path, { force: true });
  return { removed: true, path, auditPath, removedBecause: state.why };
}

async function readGate(root: string, taskId: string, boundary: UserChoiceBoundary): Promise<UserChoiceGate> {
  const state = await readGateState(root, taskId, boundary);
  if (state.kind === 'usable') return state.gate;
  if (state.kind === 'absent') {
    // The caller distinguishes absence by the code, so the error keeps it: `requireUserChoiceGate` answers "no decision
    // yet" from it, and every other reader reports it as an unreadable record.
    const missing = new Error(`No ${boundary} record exists at ${pathFor(root, taskId, boundary)}.`) as NodeJS.ErrnoException;
    missing.code = 'ENOENT';
    throw missing;
  }
  throw new Error(
    `The ${boundary} record is damaged and cannot be read (${state.why}). Nothing that reads it can proceed, and no decision `
    + `can be recorded over it: remove the damaged record with \`kata-cli gate reset --task ${taskId} --boundary ${boundary} --reason <why>\`, `
    + `then answer this boundary again.`,
  );
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
  // **The one place a gate path is built, so the one place the vocabulary is enforced on it** (F2 of the first round:
  // a cast boundary reached `path.join` and cancelled the first segment).
  assertUserChoiceBoundary(boundary);
  return userChoiceGatePath(root, taskId, boundary);
}

function taskChoicePath(root: string, taskId: string): string {
  return join(taskDir(root, taskId), 'user-choice-task.json');
}
