# Machine-verifiable review records

**2026-09-21 · change `review-record-integrity`**

## The measurement this answers

A real change, thirteen review passes, thirty de-duplicated findings (2 blocking / 11 major / 13 minor / 4 nit). Twenty of
the thirty — and **seven of the eleven `major`** — were not about the deliverable but about *the author's prose about their
own work*: a ledger row, a count, a pointer, a sentence in the docs. Five rounds landed on the same paragraph
(`r35 "two places"` → `r36 "three places… complete list"` → `r37 "only two do not come from the diff"` → the author
deleted every count and pointed at git).

That is structural, not carelessness, and the report named the three links:

1. the definition-of-done **requires** a written record — the plan's batch-level DoD item 4 is "land the batch's updates:
   audit-report rows → delivered; ledger rows; doc wording" — so every repair round necessarily writes new prose;
2. the prose is the **one artefact with no verifier**: code has tests, RED/GREEN, mutation evidence and `claims[]`, while
   "is the ledger row true" had nothing, so it was the cheapest falsifiable surface a reviewer could attack;
3. repairing it **produces more prose** — fixing one row writes a sentence about the fix, which becomes the next round's
   cheapest target.

Plus an amplifier: the delta surface was computed from the *declared* `ownedPaths`, and a recorded scope change never
reached it, so the DoD's instruction to keep "design and contract" in step forced edits outside the declared surface —
guaranteeing one "the delta understates the change" `major` per round.

## What this change does

**A — records are machine-generated; the author writes judgement.** `src/quality/change-record.ts` derives the factual half
of a round's record from what the machine already holds: the working tree's changed paths (`git status`), the sealed
envelopes, the claim outcomes, the tracked findings — plus counts, so nobody derives one by hand and gets it wrong. The one
non-derivable field is `judgement`: why this fix, what was traded away. `buildChangeRecord` deliberately takes **no**
`changedPaths` argument: a caller that could pass one could pass a wrong one.

`changedOutsideOwnership` is the field that retires a whole `major` class — the difference between "the surface is the
declaration" and "the surface is what changed" becomes a list instead of a claim.

**B — record rows can declare themselves checkable.** `claims[]` reached acceptance statements only; a governed ledger row
had nothing. The seal's claim mechanism is now wired to the rows the definition of done requires, so a false row turns the
seal red and names the claim (`claim:AC-1:row`).

**C — the delta surface follows the facts.** `changeSurfaceAgainstWorkspace` measured only the base revision's owned set,
so a round that edited docs, tests or tooling outside its declaration was told `unchanged`. It now measures the union of
the base's owned paths **and** every path git reports as changed.

**D — the brief carries the class history.** Prior findings are grouped by class with each class's count and disposition
(`repaired` / `not repaired`), so a reviewer attacks the repair instead of re-deriving a class an earlier round already
named. The class is derived (`acceptance:<id>` / `path:<file>` / `record:<source>`) rather than declared, so it cannot be
gamed by writing a different name.

## Three real defects found by implementing it

1. **A strict task could not be opened into a designable state.** `kata-cli open --review strict` wrote the placeholder
   `AC-1: Implement the change successfully.`, while `cmdDesign` refuses to run without an `acceptanceMatrix` — and
   `CreateTaskInput` had no field to supply one. The only route was hand-editing `task.json`, which is precisely the
   unverified hand-written surface this change exists to remove. Fixed by `--bootstrap-file`: one file declares the
   criteria, the matrix and the upstream coverage, and `open` validates and writes all three, refusing a matrix that does
   not cover its criteria **at the command that was given the bad input**.

2. **A claim with no expected outcome crashed instead of being refused.** `resolveSealChecks` dereferenced
   `claim.check.expect.exitCode` *before* `validateClaims` refused it, so the documented "a check that cannot fail is not
   evidence" message was replaced by `Cannot read properties of undefined (reading 'exitCode')`. The guard now runs before
   the resolver.

3. **A recorded scope change never took effect.** `kata-cli scope change` wrote the decision into `scope-changes.json` and
   changed `ownedPaths` nowhere — while the CLI's own output told the operator to run `kata-cli scope apply`, a subcommand
   that did not exist. Six scope changes on the measured task left every revision carrying the same owned-path digest
   (`4522af1eaa…`). `applyScopeChange` and `scope apply` now exist and write the recorded surface through the task lock.

## One regression this change caused, and the invariant that caught it

Reading the *live* tracked findings for the class history put the pass being recorded into its own brief, moving the hash
the gate recomputes. Two existing tests failed immediately — `a pass does not change the brief it answered` and `the brief
is reproducible, which is what makes a partial pass resumable` — and both were right. `BRIEF_VOLATILE_INPUTS` in
`src/quality/adversarial.ts` already lists "the adversarial record of the pass being recorded (its `mode`, its attempts,
its dispositions)" as volatile; the history is now filtered to the other node's record, i.e. a durable source.

## Verification

- `npx tsc --noEmit` clean.
- Full suite **935 passed / 0 failed** (129 files).
- New tests: `strict-bootstrap` (3), `change-record` (4), `record-assertions` (2), `delta-surface` (4),
  `adversarial-history` (3) — each written RED first and failing for the defect it names.
