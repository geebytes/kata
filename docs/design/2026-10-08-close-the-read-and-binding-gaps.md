# Design — close the read and binding gaps

One change for four defects that are separate mechanisms but one family: **a reader that cannot tell
"absent" from "damaged", and a record that does not carry the question it answered.** They were found by
independent rounds on two changes and were each carried as a recorded finding; this change closes them
together so that one design, one seal and one review round cover the family.

| AC | What it fixes | Where it was measured |
|---|---|---|
| AC-1 | The verification window is exclusive **and honest to observers** | `serialize-the-verification-cycle` rounds 1–5 (R1-F1 … R5-F1) |
| AC-2 | The lock/journal identity is derived once per cycle | `serialize-the-verification-cycle` round 5 (R5-F2) |
| AC-3 | A judge record carries the question it judged | `the-review-record-answers-a-request` (R1-F5/F6, carried) |
| AC-4 | Every caller tells absence from damage | `publish-every-unreadable-record` (carried), plus five measured sites |
| — | Carried minors: the reference's tie-break, and observation distinguishability | `the-review-record-answers-a-request` R11-F2/F3 |

## 1. What was measured, not assumed

**AC-1/AC-2 (`src/producers/verifiers.ts`, `src/store/verify-context.ts`).** `ledger evidence verify`
proves a falsifier by injecting a defect into the working tree, running the check, and restoring the
file. Five rounds found, in order: an exclusivity guard that was itself flaky (6 of 30 runs), a lock keyed
on path *spelling* (so `a.ts` and `./a.ts` took two locks and left the defect on disk), crash recovery
that was dead code (`recordMutation` imported but never called, tree-shaken out of the bundle), a
containment hole (`../outside.txt` wrote outside the workspace), reclamation that stole a live holder's
lock, a hard link taking a second lock, an `original` read *before* the lock (a waiting run wrote the
other run's injection back and the defect stayed on disk with both verdicts `supported`, 12/12), and a
`before` run outside the lock (a run measured another cycle's injected tree and reported "the check was
already failing before any mutation" — the misdiagnosis the change exists to remove). Round 5 then found
the two that remain:

* the `after` run happens **after** the lock is released, so it can sample another cycle's injected tree
  and downgrade a valid evidence item to `inconclusive` while the checkout is byte-identical to clean;
* the lock and journal keys are recomputed independently at three sites (`withVerificationLock`,
  `recordMutation`, `clearMutation`), so an inode change inside the window (an atomic rename by the check
  itself) orphans the journal — a killed run's defect is then not repaired by the next run, and a
  successful cycle leaves a stale journal behind.

**AC-3 (`judge-result` record).** The review record now carries `subjectRevision` (the change
`the-review-record-answers-a-request`), so a round that answered a *different* question no longer blocks
the answer to this one. The judge record does not: `schemas/judge-result.schema.json` has no such field,
and the three readers (`src/workflow/distill-gates.ts`, `src/workflow/navigation.ts`,
`src/wiki/provenance-gate.ts`) treat any readable record as current. Measured consequence: a judge verdict
that answered an earlier question keeps reading as the answer to the current one after a restatement.

**AC-4 (five callers).** `readValidatedOptional` and `readCurrentTaskRevisionState` already return three
states (`absent | usable/current | unreadable`), and `readLedger`/`navigation` publish an unreadable
record with its own name. Five callers still collapse the distinction with `.catch(() => null)`:

| Site | What it reads |
|---|---|
| `src/wiki/provenance-gate.ts:37` | the judge result (wiki closure) |
| `src/quality/change-record.ts:327` | the change record |
| `src/quality/review-ir.ts:273` | the task record |
| `src/workflow/verdict-binding.ts:106` | the task record |
| `src/workflow/revision.ts:110` | a stored revision |

Each turns "damaged" into "nothing there", which is the shape `publish-every-unreadable-record` removed
from `navigation.ts` one layer up.

## 2. Who feeds whom (the audit that keeps this from repeating)

The four preceding rounds of `the-review-record-answers-a-request` were all one mistake: **an identity
whose inputs were derived from the identity.** This design states the rule it will hold itself to, so the
same shape is caught before the seal rather than by a review round:

> **Nothing derived from a snapshot, a pointer, a previous run or a store's history may feed a value that
> is hashed into an identity.** An identity's inputs are content and declaration only.

Applied to this change:

* **AC-1/AC-2 touch no identity.** `verify-context.ts` and `verifiers.ts` are not inputs of the revision,
  the subject or the plan; the lock key is derived from a file's identity (`dev`+`ino`) and is carried,
  not recomputed. Checked by `grep -rn "verify-context" src/kernel src/store/ledger.ts` → no reader.
* **AC-3 adds one field to the judge record** (`subjectRevision`), read from the ledger's declared subject
  — the same value the review record already carries. The judge record is *not* hashed into any identity
  (it is a verdict, not an input), so no cycle is possible.
* **AC-4 changes only how a caller reports a read.** No new derivation.
* **Carried R11-F2** (the reference's tie-break) touches `mostRecentDifferentContent`, which *is* an input
  of the plan: the fix is a deterministic secondary sort key, which removes filesystem dependence without
  adding an input.

## 3. Decisions

**D1 — one window for the whole cycle, and the window is observable as "not evidence".** AC-1 is not
"extend the lock to the `after` run" alone: a concurrent *observer* can read the tree at any moment, so
the honest answer is a marker. `withVerificationWindow(root, relativePath, action)` holds the per-file
lock for the entire cycle (initial check, read, journal, inject, run, restore, closing check) **and**
publishes a window marker for its duration; a reader that sees a live window reports **"a verification is
in progress for this file"** instead of a verdict. Consequences: a valid evidence item can no longer be
downgraded by another cycle, and a run can no longer measure another cycle's injection and call it a
refutation. The marker is removed when the window closes; a crashed window is repaired by the existing
journal path (which is why D2 matters).

*Rejected:* "make the `after` run take the lock" — it closes the `after` hole but not the general case
(the `before` hole was the same shape), and it leaves the *observer* unable to tell a window from a real
refutation.

**D2 — the key is derived once and carried.** `withVerificationWindow` computes the key (the file's
`dev`+`ino`, or the resolved path when the file does not exist yet) and passes it to the journal write and
the journal clear, so the three sites cannot disagree. If the file's identity changes inside the window
(an atomic rename), the journal is written under the *original* key and the next run finds it.

**D3 — the judge record carries the question, and a reader refuses by name.** `subjectRevision` is added
to `schemas/judge-result.schema.json` (it is not required, so historical records stay readable) and
written by the judge command from `readLedger(...).subjectAsDeclared?.revision`. The three readers treat a
record whose `subjectRevision` differs from the current declared subject as **not the answer to this
question**: `distill-gates.ts` refuses the archive with the reason, `navigation.ts` publishes it as a
blocking problem with its own id, and `provenance-gate.ts` refuses the wiki closure. A record with no
`subjectRevision` (written before this field) keeps its current meaning — we cannot know what it answered,
and pretending to know is how a stale verdict would pass as a current one. (This mirrors the review
record's rule exactly; the two records should not disagree about what "answers the same question" means.)

**D4 — absence and damage are told apart at every caller.** Each of the five sites is changed from
`.catch(() => null)` to the three-way read, and decides explicitly: `absent` → today's behaviour;
`unreadable` → a named refusal that says which file and what to do. `src/workflow/revision.ts:110` reads a
*stored revision* for reuse: an unreadable record there must not be reused as an identity, and must not be
silently replaced either — it refuses and names the path.

**D5 — the reference's tie-break is deterministic (R11-F2).** `mostRecentDifferentContent` sorts by
`createdAt` only; two revisions with an identical timestamp resolve by `readdir` order, which is
filesystem-dependent. Add the revision id as a secondary key.

**D6 — the recorded observation distinguishes its reading (R11-F3).** `ledger evidence verify` persists
`{"before":0,"mutated":1,"after":0}` for every falsifier, so four readings are indistinguishable in the
store. The observed string gains the evidence id and the mutation's file, so a reader can tell which
mutation ran. This is a reporting fix (no gate reads `observed`), and it is in scope because a store whose
readings cannot be told apart is the same family as a record that does not carry its question.

## 4. Falsifiers (one per AC, single-point and reversible)

Every selector below must be shown to redden under its own mutation and restore byte-identically. The mutations that
were actually applied and observed are in §7.4; this table is the design's intent and §7.4 is the record.

| AC | Selector | Mutation (single point) |
|---|---|---|
| AC-1 | `tests/unit/the-verification-window-is-honest.test.ts` | (a) give every window its own lock, so two cycles do not exclude each other → the closing-check case reports `inconclusive`; (b) drop the `VerificationWindowLive` rethrow → the honesty case resolves instead of being told |
| AC-2 | `tests/unit/the-cycle-key-is-derived-once.test.ts` | (a) key the repair on a recomputed key → the killed run is not repaired; (b) key the clear on a recomputed key → the stale journal survives |
| AC-3 | `tests/unit/a-judge-record-answers-a-question.test.ts` | (a) navigation drops the stale-subject check → a stale judgement is published as current; (b) `provenance-gate` ignores the answered question → it accepts a record that answered another one |
| AC-4 | `tests/unit/an-unreadable-record-is-not-an-absent-one.test.ts` | restore `.catch(() => null)` at any one of the four readers → that reader's case reddens (one case per site); dropping the `unreadable` arm in `provenance-gate` reddens the fifth |
| D5 | same file as AC-4 or the planner guard | drop the secondary sort key → the equal-timestamp case reddens |
| D6 | `tests/unit/the-reading-names-its-falsifier.test.ts` | drop the id from the observed string → the case reddens |

Each case must fail **for its own reason**: the mutation is applied alone, the failure message is read,
and the file is restored by byte comparison (`cmp`).

## 5. Ownership

**Twenty-seven** paths are declared (sixteen at design time; see §7.3 for the three reasons the surface grew). Two ownership conflicts were recorded as audit facts when the scope was
applied (`src/producers/verifiers.ts` is also owned by `verdict-readings-per-run`; the rest by the changes
this one supersedes or continues). Recording a conflict does not weaken a gate: seal and scope still
require the explicit flag, and the conflict is visible in `scope-changes.json`.

## 6. Verification notes

* The suite must stay green in full (`npm test`) and `tsc --noEmit` must be clean; `dist/cli.js` is
  rebuilt, because the CLI is what the review rounds drive.
* The `after`/window change is exercised through the **real** `verifyAll` (not a synthetic context): the
  two earlier guards in this area were written with a single declared path and a single mutation, and both
  were blind to the defect they were meant to catch. The lesson is recorded here so it is not repeated:
  **a guard for a diff-shaped defect must construct a real subset, and a guard for an interleaving must
  arrange the interleaving.**
* Round-9's audit table (`the-review-record-answers-a-request`) is the reference for the "who feeds whom"
  question; this change's AC-3 must not add an identity input.

## 7. What was built (implementation record)

### 7.1 The window (AC-1, AC-2)

`src/store/verify-context.ts` now exports `withVerificationWindow(root, file, action, { deadlineMs })` and a
`VerificationWindow { root, file, key }`. `withVerificationLock`, `recordMutation(root, file, …)` and
`clearMutation(root, file)` are **gone**: each was a site that derived the identity again, which is the defect AC-2 names.
`recordMutation(window, …)` and `clearMutation(window)` take the window, so the name a cycle writes and the name it clears
are the same by construction.

`executableFalsifier.verify` is now one window around the whole cycle: opening check → read → journal → inject → mutated run
→ restore → **closing check**. Two consequences, both measured in the guards:

* The closing check cannot land inside another cycle's injection. Before, it ran after the lock was released.
* A run that cannot get the window is told, not handed a verdict: `withVerificationWindow` throws
  `VerificationWindowLive`, and the falsifier **propagates** it instead of converting it into `inconclusive` — a verdict
  about a tree the run never owned is exactly the misdiagnosis this mechanism exists to remove.

Two things fell out of the restructure and are recorded because they are decisions, not accidents:

* `MutationNotAttempted` is deleted. It existed because the original content was read *outside* the lock; with the read
  inside the window nothing can change the file between the read and the injection, so the guard became unreachable. A
  guard for an impossible state is worse than no guard: it makes the reachable one look covered.
* The repair a later cycle performs finds a journal **by the file the note names**, not by a key derived now. That is what
  makes a killed run's defect repairable after the check replaced its own target atomically (new inode, same path).

### 7.2 The five read sites (AC-4) and the fixture drift they exposed

Each site was fixed at the reader and falsified one at a time: `candidateFreezeHashFor` (`review-ir.ts`),
`currentRevisionIdentityFrom` (`verdict-binding.ts`), `readChangeRecord` (`change-record.ts`), `judgePassedFor`
(`provenance-gate.ts`, which also gains `validation_task_judge_unreadable`), and the verify envelope's consumer in
`orchestrator.ts`, which published a damaged record as "no record" one layer above the reader that had just been fixed.

**Removing the catch-alls exposed fifteen failures across seven test files, and every one of them was the fixture's fault.**
Those fixtures hand-rolled a `task.json` that did not satisfy the store's schema (no `phase`; and one layer deeper, a
`workflowProfile` with one of its seven required fields). Nothing had noticed, because a reader that answers "no task" for a
record that does not match its schema makes drift invisible — which is the same defect one layer down. The fix is
`tests/helpers/task-fixture.ts`, one writer that mints a valid record, with `workflowProfile` merged over
`defaultWorkflowProfile()` rather than substituted for it. `scope-changes.json` records the nine paths this added, with the
reason, and the one ownership conflict (the shared gate fixture).

### 7.3 Scope growth, recorded as fact

Declared surface: **16 → 27 paths.** Three reasons, all in `scope-changes.json`: the migrated fixtures and their shared
writer (AC-4's blast radius), the two verification-lock guards whose API changed with AC-2, and `src/producers/port.ts` for
the one optional field AC-1 needs (`windowDeadlineMs` — the caller's bound on how long a cycle waits for the window, so a
run that cannot get one is *told* rather than handed a verdict).

### 7.4 The mechanical self-audit, before the round

Every declared selector was mutated on its own, the failure message was read, and the file was restored and compared
byte-for-byte (`cmp`). Eight mutations, eight reddened guards, each for its own reason:

| # | Mutation | Guard that reddened |
|---|---|---|
| M-AC1a | every window takes its own lock (no mutual exclusion) | the closing-check case: `inconclusive` instead of `supported` |
| M-AC1b | drop the `VerificationWindowLive` rethrow | the honesty case: the run resolves instead of being told |
| M-AC2a | recovery keyed on the recomputed key | the killed run's defect is not repaired |
| M-AC2b | clear keyed on the recomputed key | the stale journal survives a successful cycle |
| M-AC3 | navigation drops the stale-subject check | a stale judgement is published as current |
| M-AC4a–d | restore the catch-all at each of four readers | that reader's case |

This is the step that was missing in the two changes this one continues (`serialize-the-verification-cycle` and
`the-review-record-answers-a-request` each spent five to eleven rounds on guards that a five-second local mutation check
would have caught). Doing it here first is the reason the round should not have to find it.

### 7.5 Measured result

`282 files / 1679 tests` PASS, `tsc --noEmit` clean, `dist/` rebuilt.
