import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertValidTaskId } from '../core/ids.js';
import { readValidated, readValidatedOptional } from '../core/schema.js';
import { userChoiceGatePath, taskDir, taskPath } from '../core/layout.js';
import { computeManifestHash } from './revision.js';
import { currentRevisionIdentity, recordSpeaksForCurrentContent, type RevisionIdentity } from './verdict-binding.js';

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
    // **"Concludes in phase X", not "runs in phase X".** The phase in the table is the phase the creating command *reports* on
    // success, and a command runs from a different phase than it concludes in — measured: `kata-cli judge` is refused from
    // phase `judge` ("Judge requires review phase"), so "which runs in phase judge" was a false statement about the very
    // command the sentence names (round 3's F1; the same correction had been made in `gateRebuildInstruction` one function
    // over, and leaving it here is exactly the half-fix this repository keeps measuring).
    return `This boundary was already crossed by \`${entry.command}\`, so there is nothing to approve here. The next boundary `
        + `(\`${entry.next}\`) gets its gate from \`${nextCommand}\`${next.phase ? ` when it concludes in phase \`${next.phase}\`` : ''}.`;
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
export function gateRebuildInstruction(boundary: UserChoiceBoundary, taskId?: string): string {
    const entry = GATE_CREATED_BY[boundary];
    const command = boundary === 'judge_gate' ? 'kata-cli review --approve' : `kata-cli ${entry.command}`;
    // **"Creates this boundary when it concludes in phase X", not "runs in phase X".** The phase in the table is the phase a
    // command *reports* when its success creates the boundary, and a command can report another phase when it concludes
    // differently (`judge` reports `review` on a FAIL and creates no archive gate) — so "runs in phase judge" was a claim the
    // table cannot support (measured by the second round).
    // **Facts, not an imperative that may be closed.** The sentence ended "run it against the current content and
    // approve the gate again" — an instruction refused in exactly the state that prints it: a stale `archive_gate` is
    // reported from the `judge` phase (where the gate is read back), while `kata-cli judge` requires phase `review`
    // (measured by round 3, which read the sentence through `kata-cli archive` from phase `judge`). Which phase a command
    // *runs from* is a fact this table does not hold, so the sentence promises no phase: it states what creates the
    // boundary and where the task's own phase is reported.
    // **The road, now that one exists.** The sentence used to name the creating command as the thing to run, which is
    // refused in the phase that prints it; round 4 then measured the state itself: nothing ran — `judge` needs `review`,
    // `gate approve` refuses a consumed record, `gate reset` refused every readable one, and `status` pointed back here.
    // `gate reset` now removes a record that no longer speaks for the content, which is the repair this sentence reports,
    // so the sentence names it, names the verb that answers the boundary again, and keeps the creation fact as a fact.
    const reset = taskId === undefined
        ? '`kata-cli gate reset --task <id> --boundary ' + boundary + ' --reason <why>`'
        : `\`kata-cli gate reset --task ${taskId} --boundary ${boundary} --reason <why>\``;
    // **The sequence, in the order it runs.** Removing the obsolete record leaves the boundary unanswered, and the command
    // that reports it is the one that asks the boundary again — measured: `gate approve` refuses to invent a record
    // ("No ... record exists"), so naming it here would name a road that is closed until the reporter has asked.
    const approve = taskId === undefined
        ? '`kata-cli gate approve --task <id> --boundary ' + boundary + ' --choice <choice>`'
        : `\`kata-cli gate approve --task ${taskId} --boundary ${boundary} --choice <choice>\``;
    // **Two roads, both of which run where the sentence is printed** (measured, round 5's F2: naming the command that
    // reports the refusal was not a road — it refuses there).
    return `This boundary's gate is created by \`${command}\``
        + `${entry.phase ? ` when it concludes in phase \`${entry.phase}\`` : ''}`
        + `, and it no longer speaks for the current content, so the decision it holds does not apply to this content: the obsolete record goes with ${reset} (the reason is recorded beside it), and the boundary is then answered with ${approve}.`;
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
  // **The same vocabulary check the boundary writer makes** (round 8's F8): this writer could store a value its own reader
  // rejects, which is a record that reads as damaged.
  assertUserChoice(input.choice);
  // **The same binding a boundary's answer gets** (round 7's F2, an `one-fact-derived-twice` defect): this path called
  // `currentRevisionIdentity` directly, so a `--for-task` answer given before the first seal carried no content binding and
  // `bindsToRevision`'s unbound answer let a later boundary reuse it after the content had moved. Both writers ask `contentIdentityFor`.
  const identity = await currentContentIdentity(input.root, input.taskId);
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
/** The first free audit path: `<record>.removed.json`, then `.removed.2.json`, … so an earlier audit is never lost. */
async function freeAuditPathFor(base: string): Promise<string> {
  for (let index = 1; index < 100; index += 1) {
    const candidate = index === 1 ? base : base.replace(/\.json$/u, `.${index}.json`);
    try {
      await readFile(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return candidate;
      throw error;
    }
  }
  throw new Error(`No free audit path beside ${base}: 99 removals are already recorded there.`);
}

/**
 * The state a record path's **shape** implies, before any read: `undefined` when it is a regular file (or absent), and a
 * `damaged` answer otherwise.
 *
 * A record that is not a regular file cannot be read as one: a directory, a symlink, a FIFO, a socket or an unreadable file
 * each get their own sentence, so the operator is told which shape is there instead of waiting on a `readFile` that never
 * returns (round 3's F2 measured the hang through the CLI, for both `gate reset` and `gate approve`).
 */
/** What the entry at a record path is, in the vocabulary both readers share: a regular file is readable, and anything
 * else is not a record, with the shape named.
 *
 * **Both readers ask this, and that is the rule.** The task-level choice and a boundary's record are the same kind of file
 * under the same directory, so a shape rule applied to one of them is a rule the other does not have — measured (round 3's
 * F2): a FIFO at the task-level path hung `gate reset --record task-choice`, a directory let a raw `EISDIR` out of the
 * command, and a symlink was removed while the audit named its target's content.
 */
type RecordShape =
  | { kind: 'absent' }
  | { kind: 'damaged'; why: string; regular: false; shape: string };

/**
 * **The road for an entry that is not a record at all** — the operator's own shell, by shape.
 *
 * Measured (round 6's F1): every sentence about a damaged record named `gate reset`, and that verb refuses a non-regular
 * entry by design (it removes records, not links or directories) — so the road printed for a symlink, a directory, a FIFO or
 * a socket was closed where it was printed, and the boundary could only be unlocked by a hand-written removal nobody named.
 * `rm` on a link removes the link, never the target.
 */
function shapeRoad(path: string, shape: string): string {
  return shape === 'a directory'
    ? `\`rmdir ${path}\` (it is empty) or \`rm -r ${path}\` (it is not)`
    : `\`rm ${path}\``;
}
function recordShape(path: string): RecordShape | undefined {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return { kind: 'damaged', why: `the record at ${path} cannot be examined (${(error as Error).message})`, regular: false, shape: 'an entry that cannot be examined' };
  }
  if (stat.isFile()) return undefined;
  // **Each shape by its own name.** A FIFO was reported as "not a regular file", which is true and useless to an operator
  // looking at a path that is neither a directory nor a link (round 4's F6).
  const shape = stat.isSymbolicLink() ? 'a symbolic link'
    : stat.isDirectory() ? 'a directory'
      : stat.isFIFO() ? 'a FIFO'
        : stat.isSocket() ? 'a socket'
          : 'not a regular file';
  return { kind: 'damaged', why: `the record at ${path} is ${shape}, not a regular file, so it cannot be read as a record`, regular: false, shape };
}

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

/** The task-level choice in three states, the shape `GateState` has for a boundary's record. */
type TaskChoiceState =
  | { kind: 'absent' }
  | { kind: 'damaged'; why: string; regular: boolean; shape?: string }
  | { kind: 'usable'; choice: TaskChoice };

async function readTaskChoice(root: string, taskId: string): Promise<TaskChoiceState> {
  // **The shape is asked before the file is opened, here as well.** The same rule as `readGateState`: a FIFO would block
  // this read forever, a directory would fail with its own errno, and a symlink would be read through and then removed.
  const shape = recordShape(taskChoicePath(root, taskId));
  if (shape !== undefined) return shape;
  try {
    return { kind: 'usable', choice: await readValidated<TaskChoice>('task-choice', taskChoicePath(root, taskId)) };
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
      || (typeof cause === 'object' && cause !== null && (cause as NodeJS.ErrnoException).code === 'ENOENT');
    if (missing) return { kind: 'absent' };
    return { kind: 'damaged', why: (error as Error).message, regular: true };
  }
}

export async function createUserChoiceGate(input: { root: string; taskId: string; boundary: UserChoiceBoundary; revisionId?: string }): Promise<void> {
  assertValidTaskId(input.taskId);
  // The caller's revision id stays (it knows which revision the choice belongs to, and a gate is often created before
  // the seal it belongs to). The **content** identity is added from the current revision: the id alone expired the gate
  // on every re-seal of unchanged content, which asked the user for the same platform/model choice again, phase after
  // phase. Either binding is enough to keep it valid (`verdict-binding.ts`).
  // **The same derivation as every other writer** (round 8's F3: this one still called `currentRevisionIdentity`, so a gate
  // created before the first seal carried no binding while the answer given to it did).
  const identity = await currentContentIdentity(input.root, input.taskId);
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

/**
 * The binding an answer carries, taken from the identity the caller has already derived.
 *
 * **It used to derive that identity itself, and that is round 9's F2.** One `approve` read the current-revision pointer for
 * its own decision and then read it again in here, and the pointer is written non-atomically, so the two reads can answer
 * differently inside one decision — the contract `verdict-binding.ts` states for exactly this file. The identity now
 * arrives already widened by `currentContentIdentity`.
 */
function answerBinding(identity: RevisionIdentity): { manifestHash?: string } {
  return identity.manifestHash ? { manifestHash: identity.manifestHash } : {};
}

/**
 * **The content identity a gate answer is about, sealed or not — one derivation, asked by the writer and the reader.**
 *
 * The sealed identity when there is one; otherwise the digest of the task's declared content, which is the same fact
 * `computeManifestHash` gives a seal. Every verb's binding question goes through here: comparing
 * a declaration-bound record against an empty sealed identity refused every answer given before the first seal, which is the
 * normal order for `implementation_gate` (the human answers before `build` seals).
 */
async function contentIdentityFor(root: string, taskId: string, identity: RevisionIdentity): Promise<RevisionIdentity> {
  if (identity.manifestHash) return identity;
  const task = await readValidatedOptional<{ ownedPaths?: string[] }>('task', taskPath(root, taskId));
  const declared = task?.ownedPaths ?? [];
  if (declared.length === 0) return identity;
  return { ...identity, manifestHash: await computeManifestHash(root, declared) };
}

/**
 * **The identity one verb's decision is about: one pointer read, widened to the declared content when nothing is sealed.**
 *
 * Every verb that asks whether a record still speaks derives the identity through here and hands it to every reader that
 * needs it, so the pointer is read once per decision — round 9's F2 measured one `approve` and one `require` each reading
 * it twice, the second time inside a predicate that derived it again.
 */
async function currentContentIdentity(root: string, taskId: string): Promise<RevisionIdentity> {
  return contentIdentityFor(root, taskId, await currentRevisionIdentity(root, taskId));
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
  const state = await readGateState(input.root, input.taskId, input.boundary);
  const identity = await currentContentIdentity(input.root, input.taskId);
  // **A boundary with no record is an unanswered boundary, and the operator's answer is the gate** (the user's decision,
  // 2026-10-14, taken against the alternative of a mechanism-issued re-ask). Measured (round 5's F1): making `gate reset`
  // remove an obsolete record left the boundary *unanswerable* — approve refused "No ... record exists" and the creating
  // command is refused in the phase that asks, so the operator moved from a stale record to no road at all. What a boundary
  // needs is the human's choice; the phase command's refusal is the ask, and a human who has already decided may answer.
  // The ordering fact is recorded rather than implied: a record may now exist before the phase command asked for it.
  if (state.kind === 'damaged') {
    // **The road depends on the shape, because `gate reset` refuses what is not a record** (round 6's F1).
    const road = state.regular === false
      ? `the path is not a record at all, so remove the entry with ${shapeRoad(pathFor(input.root, input.taskId, input.boundary), state.shape ?? 'not a regular file')}`
      : `remove it with \`kata-cli gate reset --task ${input.taskId} --boundary ${input.boundary} --reason <why>\``;
    throw new Error(`The ${input.boundary} record is damaged and cannot be read (${state.why}). ${road}, then answer this boundary again.`);
  }
  // **An answer binds to the content under consideration, from the first seal or from the declaration** (round 6's F3).
  const binding = answerBinding(identity);
  const gate: UserChoiceGate = state.kind === 'usable'
    ? state.gate
    : {
        taskId: input.taskId,
        boundary: input.boundary,
        createdAt: new Date().toISOString(),
        // **The content this answer is about, even before the first seal** (round 6's F3). A record written before any
        // revision existed carried neither binding, and `assertRevision` accepts an unbound record forever — so the human's
        // answer authorised content they had never seen and kept authorising after it changed. The declared content hash is
        // the same fact the seal records, computed by the same function.
        ...binding,
        ...(input.revisionId ? { revisionId: input.revisionId } : {}),
      };
  // A record that carried no binding of its own is bound by this answer.
  if (state.kind === 'usable' && !gate.revisionId && !gate.manifestHash) Object.assign(gate, binding);
  // The caller's id when it names one; otherwise the sealed revision, so "current" means the same thing here as it does
  // in every other gate. The content identity is the second, broader binding.
  assertRevision(gate, input.revisionId, identity, input.taskId);
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
    // **The road depends on the shape, because `gate reset` refuses what is not a record** (round 6's F1).
    const road = state.regular === false
      ? `the path is not a record at all, so remove the entry with ${shapeRoad(pathFor(input.root, input.taskId, input.boundary), state.shape ?? 'not a regular file')}`
      : `remove it with \`kata-cli gate reset --task ${input.taskId} --boundary ${input.boundary} --reason <why>\``;
    throw new Error(`The ${input.boundary} record is damaged and cannot be read (${state.why}). ${road}, then answer this boundary again.`);
  }
  const gate = state.kind === 'usable' ? state.gate : undefined;
  const identity = await currentContentIdentity(input.root, input.taskId);
  if (gate?.choice && !gate.consumedAt) {
    assertRevision(gate, input.revisionId, identity, input.taskId);
    return gate;
  }

  // No decision at this boundary: reuse the task-level one if the human recorded it and it still speaks for this
  // content. Reported, not silent — the caller (and the operator reading the result) can see that it was reused.
  const taskChoiceState = await readTaskChoice(input.root, input.taskId);
  if (taskChoiceState.kind === 'damaged') {
    // **Named rather than folded into "no choice yet", and by shape** (round 7's F1: this branch still printed `gate reset`
    // for a symlink or a directory, which that verb refuses). `gate reset --record task-choice` runs only where the entry is
    // a record the mechanism cannot read; anything else is the operator's shell road.
    const road = taskChoiceState.regular === false
      ? `the path is not a record at all, so remove the entry with ${shapeRoad(taskChoicePath(input.root, input.taskId), taskChoiceState.shape ?? 'not a regular file')}`
      : `remove it with \`kata-cli gate reset --task ${input.taskId} --record task-choice --reason <why>\``;
    throw new Error(`The task-level choice record is damaged and cannot be read (${taskChoiceState.why}). ${road}, then answer this boundary again.`);
  }
  const taskChoice = taskChoiceState.kind === 'usable' ? taskChoiceState.choice : null;
  // **The reader asks the writer's derivation** (round 7's F2): comparing a task-level answer against the bare sealed
  // identity let a pre-seal answer be reused after the declared content moved.
  // **The reuse rule, before a seal as well as after it** (round 7's F2). `bindsToRevision` answers `!artifact.revisionId`
  // when there is no current revision — true for every record written before the first seal — so leaning on it alone let a
  // task-level answer be reused after the declared content moved. The content hash is the binding while nothing is sealed,
  // and an answer that carries no binding at all authorises nothing: the operator answers this boundary instead.
  // **One answer to "does this record still speak?"** (round 9's F1). `assertRevision` accepted an unbound record while
  // this rule refused it and the removal rule asked a third predicate — three answers to one fact, across a repository
  // whose older records are exactly that shape. The one predicate is `recordSpeaksForCurrentContent`, asked with the
  // identity this verb has already read: a record that names no binding speaks only while nothing is sealed.
  if (taskChoice && recordSpeaksForCurrentContent(taskChoice, identity)) {
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
  // **The refusal names the command, because a refusal without a road is a dead end.** Measured while running the D/C pilot
  // through the real CLI: `build --seal` answered `implementation_gate requires an explicit user choice before continuing.`
  // and stopped there — the operator was left to discover `kata-cli gate approve`, whose flag is `--task` while every other
  // command in the vocabulary spells it `--change`. Both facts are in the sentence now, together with the choice vocabulary
  // taken from the same constant the writer validates against, so a reader cannot be sent to a value the schema refuses.
  throw new Error(
    `${input.boundary} requires an explicit user choice before continuing. Record it with `
    + `\`kata-cli gate approve --task ${input.taskId} --boundary ${input.boundary} --choice <${USER_CHOICES.join('|')}>\`, `
    + `then re-run this command.`,
  );
}

/**
 * **Consume the gate that admitted the command — the one that was already asked.**
 *
 * This used to re-ask, and the second ask is a different question: it compares the record against the world *after* the
 * command ran. A `build` that gives a task the owned paths (and so the revision) its implementation gate was created
 * without — the legacy "scoped at seal time" flow the CLI supports with `--owned-path` — therefore had its own gate read as
 * obsolete at the moment it succeeded, and the command failed after doing its work. One boundary, one asking, one answer:
 * the caller hands in what `requireUserChoiceGate` admitted. `input.admitted` is optional only because consuming a gate
 * directly (a test, a script) has no admission of its own to hand in.
 */
export async function consumeUserChoiceGate(input: {
  root: string;
  taskId: string;
  boundary: UserChoiceBoundary;
  revisionId?: string;
  /** The gate `requireUserChoiceGate` admitted for this crossing, when the caller has it. */
  admitted?: UserChoiceGate;
}): Promise<void> {
  const gate = input.admitted ?? await requireUserChoiceGate(input);
  gate.consumedAt = new Date().toISOString();
  await writeFile(pathFor(input.root, input.taskId, gate.boundary), `${JSON.stringify(gate, null, 2)}\n`);
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
  /**
   * `regular` is the fact the **removal** needs and the read cannot supply: a damaged record that is a regular file may be
   * removed (that is the road out of the deadlock this change exists for), while a record that is a symlink, a directory or
   * a FIFO is not a record at all and removing it would take something else (measured: the reader refuses all of them, and
   * without this distinction the reset removed a symlink while the audit described its target).
   */
  | { kind: 'damaged'; why: string; regular: boolean; shape?: string }
  | { kind: 'usable'; gate: UserChoiceGate };

export async function readGateState(root: string, taskId: string, boundary: UserChoiceBoundary): Promise<GateState> {
  assertValidTaskId(taskId);
  // **The shape is asked before the file is opened.** A FIFO at the record path makes `readFile` block forever: measured
  // through the CLI, `gate reset` and `gate approve` both hung until they were killed, printing nothing (round 3's F2). The
  // round-2 repair put this check in the reset, but *after* the reader had already opened the file, so the hang remained —
  // the check belongs on the read path, which is where every consumer goes.
  const shape = recordShape(pathFor(root, taskId, boundary));
  if (shape !== undefined) return shape;
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
    return { kind: 'damaged', why: (error as Error).message, regular: true };
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
    // **A live decision is refused; an obsolete one is damage, and removing it is the road.** The rule this repository
    // keeps paying for is "a repair may only touch damage": a record that still binds to the current content is somebody's
    // decision and stays, while one bound to a revision the task has left no longer decides anything — and the refusal that
    // reports the stale state names this command (round 4's F1 measured that no other road runs where it is printed).
    // **The record's own shape decides which binding is asked** (`in` narrowing, not the caller's flag): the two readers
    // return different usable states, so the discriminator has to be the state itself.
    // **The same identity, derived once for this verb** (round 9's F2): the record's own shape decides which binding is
    // asked, and both askings are given the identity read for this decision rather than reading the pointer again.
    const identity = await currentContentIdentity(input.root, input.taskId);
    const speaks = 'gate' in state
      ? recordSpeaksForCurrentContent(state.gate, identity)
      : recordSpeaksForCurrentContent(state.choice, identity);
    if (speaks) {
      throw new Error(
        `The ${what} record is readable and still speaks for the current content, so it is a live decision rather than damage, and this command refuses to remove one. `
        + `If the content moves, this record stops binding by itself and this command becomes the road.`,
      );
    }
  }
  // **The shape is a fact the reader supplies, not a second check.** It refuses a non-regular file before reading, and the
  // state carries that decision, so this function asks it rather than re-deriving it — the two copies that existed before
  // each masked the other's falsifier (the harness reported both as `refuted`).
  // **A stale record is removed the way a damaged one is**, so the shape rule is asked only of a state that is a
  // record at all: a `usable` state carries no shape fact of its own, and it reached this line only by being obsolete.
  if ('regular' in state && !state.regular) {
    // **The road, here as well** (round 8's F1: `shapeRoad` was called by three sentences and this one — the verb every
    // other sentence names — refused without showing one).
    throw new Error(`The ${what} path is not a regular file, so it is not a record and nothing was removed: ${path}. ${state.why}. Remove the entry with ${shapeRoad(path, state.shape ?? 'not a regular file')} and answer this boundary again.`);
  }
  // **A record that exists and cannot be read is damage with a road, not a raw errno.** Measured (round 3's F3): mode
  // 000 on the record made this line throw `EACCES: permission denied, open '…'` out of the command — the record stayed and
  // the operator got a filesystem error from the one verb whose purpose is to remove a record they cannot read. The two
  // roads named below run for the operator: the mode is theirs to change, and the entry is theirs to remove.
  let removedSha256: string;
  try {
    removedSha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch (error) {
    throw new Error(
      `The ${what} record at ${path} exists and cannot be read (${(error as Error).message}), so its content cannot be summarised and nothing was removed. `
      + `Make it readable (\`chmod +r ${path}\`), or remove the entry yourself (\`rm ${path}\`) and answer this boundary again.`,
    );
  }
  // **A previous removal's audit must not block this one.** `{ flag: 'wx' }` refuses to overwrite, so a record reset twice
  // left the second reset permanently refused — a new deadlock created by the repair (measured by round 3). The audit is
  // written to the first free name instead, so both removals stay readable and no state is unreachable.
  const freeAuditPath = await freeAuditPathFor(auditPath);
  // **The audit is written before the removal.** Written after, a failure left the record gone with no trace and a raw
  // filesystem error out of the command (measured by the second round: a directory at the audit path did exactly that). If
  // this write fails, nothing has been removed yet, so the state is unchanged and the operator sees a refusal.
  try {
    await writeFile(freeAuditPath, `${JSON.stringify({
      taskId: input.taskId,
      record: input.record,
      ...(input.boundary ? { boundary: input.boundary } : {}),
      removedAt: new Date().toISOString(),
      reason: input.reason,
      removedSha256,
    }, null, 2)}\n`, { flag: 'wx' });
  } catch (error) {
    throw new Error(
      `The removal was not performed because its audit record could not be written at ${freeAuditPath} `
      + `(${(error as Error).message}). Nothing was removed.`,
    );
  }
  await rm(path, { force: true });
  return { removed: true, path, auditPath: freeAuditPath, removedBecause: 'why' in state ? state.why : undefined };
}



function assertRevision(gate: UserChoiceGate, callerRevisionId: string | undefined, identity: RevisionIdentity, taskId?: string): void {
  // **The one predicate, asked with the identity the caller already read.** There is no unbound exemption here any more: a
  // record that names no binding is answered by `recordSpeaksForCurrentContent` — the same symbol the reuse rule and the
  // removal rule ask — and round 9's F1 measured the three of them giving three different answers while no instrument could
  // redden the exemption itself. Round 9's F2 measured the second reason this function changed: it used to ask a predicate
  // that derived the identity again, so one decision read a non-atomic pointer twice.
  if (recordSpeaksForCurrentContent(gate, identity)) return;
  const idMatches = Boolean(gate.revisionId)
    && gate.revisionId === (callerRevisionId ?? identity.revisionId);
  if (idMatches) return;
  // **The refusal carries the next step.** It said only that the gate "is not bound to the current revision or its
  // content", which is a true statement about the state and no statement at all about the remedy — and the remedy is not
  // guessable: the gate has to be *recreated*, by the command whose success creates this boundary's gate.
  throw new Error(
    `User choice gate ${gate.boundary} is not bound to the current revision or its content. `
    + `${gateRebuildInstruction(gate.boundary, taskId)}`,
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
