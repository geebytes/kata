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

## 8. Round 1's findings, and what the repair changed

The independent round **failed the change** (1 blocking, 2 major, 4 minor, 1 note) and falsified its central clause. It is
recorded here in full because the design's own §7.1 and §7.2 were both wrong in the same way: they described mechanisms
whose class was wider than the sites they fixed.

### 8.1 The blocking finding: the key was taken before the window was held (F1)

`withVerificationWindow` derived `lockKeyFor` — the file's `dev`+`ino` — **before** `mkdir(lockDir)` established exclusivity.
A check that lands its result with `mv` (an ordinary formatter, and the change's own comment calls it ordinary) moves the
inode inside the window, so a second cycle derived a *different* key, took a lock nobody held, and ran concurrently. It then
found the first cycle's journal by file name, restored the first cycle's original mid-flight, and the first cycle reported
`refuted … the check did not redden under its own defect` about a perfectly sensitive check — measured deterministically.

This is the **third** time in this mechanism that the key was not the thing it was supposed to name: a spelling (fixed by
`realpath`), a name for a file with several (fixed by `dev`+`ino`), and now an identity derived at a moment when the file was
still somebody else's to change. The repair is not another key — it is an **order and a pair**:

- the **path** lock (the resolved path) is taken first. It is what the cycle mutates and restores, and a check cannot change
  it by replacing its target;
- the **identity** lock (`dev`+`ino`, the alias-collapsing key) is derived *inside* that lock and held for the window.

Each cycle holds one path lock and waits for at most one identity lock, so the wait-for graph has no cycle. The journal is
now named by the **path** key, which is why a note nobody can parse is still attributable — and therefore quarantineable,
which is what §7.1's F4 comment claimed and did not do.

### 8.2 The class was wider than the sites (F2, F3, F6)

Seven more sites folded damage into absence, and two more readers of the judge record never bound it to the question it
answered:

| Site | What it said | What was true |
|---|---|---|
| `readTaskCandidate` | `intake`, under a comment claiming corruption was surfaced | the state file could not be read |
| the candidate listing | the task was absent | it could not be read, and it vanished from the only place that would have shown it |
| `runOrientCommand` | a phase from an older handoff packet | the state record could not be read |
| `src/cli/workflow.ts` | no next-action suggestion | the upstream summary could not be read |
| `src/store/baseline.ts` | "unmeasured" (the same as a change with no records) | the ledger file could not be read |
| `createHandoff` | a raw JSON syntax error | a schema-governed record was parsed by hand |
| `orchestrator.ts:1242` | the full check set, silently | the task record could not be read |
| `proposeFromPassedTask`, `distillPassedTaskKnowledge` | a PASS is a PASS | it answered a superseded question |
| `authorizeJudgeRepair` | a FAIL authorizes repair | it answered a superseded question |

`src/core/state.ts` gains `readCurrentStateOr` (three states, ENOENT only for `absent`) and `src/core/task.ts` the named
`UnreadableTaskRecord`, so a refusal carries the task and the file. The listing keeps its promise not to drop a task: it
lists it with `phase: 'unreadable'` and the reason.

### 8.3 The amended counterexample (X1), and why amending was the honest move

Round 1's challenge X1 recorded the defect correctly, but its **acceptance condition was satisfiable only by the defect**: it
awaited the second cycle to completion *while the first was parked inside its window*, which only a cycle that fails to
exclude the first can do. On the repaired tree it times out with no false reading — measured. So the challenge was amended
(`kata-cli ledger challenge amend`, which keeps the original command and the reason in the record) to assert the same
property in a form a correct implementation can satisfy: the first reading stays `supported`, the second cycle is either
served after it or refused by name, the file ends clean. The amended command was then measured **both ways**: it fails on the
pre-fix tree with `expected 'refuted' to be 'supported'` and passes on the repaired one.

### 8.4 Guards, and the third insensitive fixture

Seven cases were added to the four existing selectors, plus a quarantine case, and each was shown to redden under its own
single-point mutation (recorded in §7.4's table for the first batch; the second batch is M-AC1c, M-AC2c, M-AC4e–g, M-AC3c–e).
One of them — *"a stale FAIL authorizes a repair"* — **did not redden** on the first attempt: its fixture used
`repairScope: 'implementation'`, which is not a scope a Judge FAIL can authorize, so the branch under test was never
reached. That is the third time in this change that a guard did not reach the code it named, and the same class the wiki page
`a-test-that-never-reaches-the-code` records. The fixture now uses `failing_evidence`, and the mutation reddens.

The two challenge commands were then re-run and both **withdrawn** (`code: 0`), and `ledger decide` reports six claims, all
supported, with only the independent-challenge deficit remaining — which only a new round can supply.


## 9. C+ verification boundary (approved after round 5)

The verifier executes an arbitrary shell command in the real checkout. No in-place mutation protocol can prove the checkout
is unchanged against a command that is itself an adversary with the same filesystem authority: it can rename an ancestor,
replace topology after inspection, keep a detached writer alive, or modify unrelated paths after the cycle's last read.
Rounds 1–5 measured that this is not a theoretical distinction. We therefore preserve the existing **fail-closed mechanics**
for observable unsafe targets, but state the admissibility boundary explicitly rather than publish a broader promise than the
mechanism can prove.

An executable falsifier is admissible only when all of the following are true:

1. at injection, its target is a single-name regular file and every component from the checkout root to that target is a
   non-link directory; otherwise the verifier returns a named `inconclusive` **before** writing or journaling;
2. the command does not rename, remove, replace, or link the target or any of its ancestors while the verification cycle is
   active; it does not launch a writer that can outlive the command; and it does not intentionally alter files other than the
   declared target;
3. the command does not try to alter the verifier's out-of-tree control state. The state was moved to the OS temporary
   directory precisely because the command may edit every path inside the checkout.

This is **not** a waiver for an observed defect. It is the declared limit of a real-checkout evidence method. A target that is
already hard-linked is now refused before injection (not misreported as `UnrestoredMutation` after no write occurred), and
link/non-regular targets remain refused at both the restore and crash-repair doors. Under the boundary, `supported` means the
cycle restored and settled the declared target after an admissible command; it never claims that an arbitrary shell command
could not change a different checkout path.

The alternatives were considered explicitly. Copy-based mutation would remove this class, but changes the meaning of
`supported` from a result about the checkout to a result about a faithful replica; it requires an additional proof that the
command does not read the live checkout (some existing commands do). That is a gate-semantic redesign and belongs to the
successor change, not a silent alteration of this change's certified method.
