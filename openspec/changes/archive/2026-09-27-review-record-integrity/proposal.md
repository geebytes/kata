## Why

A governed change's review rounds produced findings about the author's *prose about their own work* rather than about the
deliverable, and the platform made that unavoidable.

Measured on one real change, thirteen review passes: thirty de-duplicated findings, of which **twenty** (and **seven of the
eleven `major`**) concerned a ledger row, a count, a pointer or a doc sentence. The mechanism has three links:

1. the definition of done **requires** a written record — the plan's batch-level DoD item is "land the batch's updates:
   audit-report rows → delivered; ledger rows; doc wording" — so each repair round writes new prose by construction;
2. that prose is the **one artefact with no verifier**. Code has tests, RED/GREEN evidence and `claims[]`; "is the ledger
   row true" had nothing, so it was the cheapest falsifiable surface an independent reviewer could attack;
3. repairing it **produces more prose**: fixing a row writes a sentence about the fix, which becomes the next round's
   cheapest target. Five rounds landed on the same paragraph.

An amplifier made it worse: the delta surface was computed from the *declared* `ownedPaths`, while a recorded scope change
never reached them, so the DoD requirement to keep the design and the contract in step forced edits outside the declared
surface and guaranteed a "the delta understates the change" `major` per round.

Three defects of the same family were found while implementing this, each blocking the work it was meant to enable:

- a strict task could not be **opened** into a designable state: `open` wrote a placeholder criterion while `design`
  refused to run without an acceptance matrix, and no input could supply one — so the only route was hand-editing
  `task.json`, the unverified hand-written surface this change exists to remove;
- a claim whose check declares no expected outcome **crashed** the resolver instead of being refused, so the documented
  "a check that cannot fail is not evidence" refusal was replaced by a `TypeError`;
- `scope change` recorded a decision that **never took effect**, and its own output named a `scope apply` subcommand that
  did not exist.

## What Changes

- A seal emits a **machine-generated change record**: changed paths from the working tree, checks from the sealed
  envelopes, claim failures, tracked findings, and derived counts. The record's factual half has no input channel — the
  builder takes no `changedPaths` — and `judgement` is the only prose field.
- A **governed record row** can declare a checkable claim, so a false row fails the seal and names the claim rather than
  waiting for the next review round.
- The **delta surface** measures the union of the base revision's owned paths and every path the working tree reports as
  changed, so a change outside the declaration is a fact rather than an omission.
- A recorded **scope change is applicable**, and applying it writes the resulting surface under the task lock.
- A **strict task can be bootstrapped**: one file declares its acceptance criteria, acceptance matrix and upstream
  coverage, validated at the command that was given the input.
- The adversarial **brief carries prior findings grouped by class** with each class's count and disposition, drawn from a
  durable source so it cannot move the brief's own hash.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `model-policy-and-evidence`: a revision's record is derived from the facts the machine holds; a governed record row may
  declare a checkable claim; the delta surface includes the paths the revision actually changed; a recorded scope change is
  applicable and applying it changes the audited surface.
- `workflow-runtime`: a strict task's declared contract is supplied at the command that creates the task and validated
  there; the adversarial brief's finding history is drawn only from sources a pass cannot write, so a brief is
  reproducible across the recording of its own answer.

## Impact

Affected code: `src/quality/change-record.ts` (new), `src/quality/scope-change.ts`, `src/quality/revision-delta.ts`,
`src/quality/adversarial.ts`, `src/cli/workflow.ts`, `src/cli/scope.ts`, `src/workflow/orchestrator.ts`,
`src/core/schema.ts`, `schemas/change-record.schema.json` (new).

Affected tests: `tests/unit/strict-bootstrap.test.ts`, `tests/unit/change-record.test.ts`,
`tests/unit/record-assertions.test.ts`, `tests/unit/delta-surface.test.ts`, `tests/unit/adversarial-history.test.ts` (all
new), plus `tests/unit/finding-disposition.test.ts` and `tests/unit/adversarial-progress.test.ts`, whose existing
reproducible-brief invariants caught a regression this change introduced.
