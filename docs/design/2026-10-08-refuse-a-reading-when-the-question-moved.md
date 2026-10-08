# Refuse a reading when the question moved

**Date**: 2026-10-08
**Change**: `refuse-a-reading-when-the-question-moved` (current_worktree / tdd / strict)
**Source**: `docs/superpowers/reports/2026-10-08-ledger-evidence-add-invalidates-challenge.md` — a report from the `zenmpai`
checkout, verified against this repository before anything was written.

## What was verified, and what the report got wrong

The report claims `ledger evidence add` invalidates the frozen subject because it writes the submission's claims back, so a
just-frozen subject becomes an old question and the challenge resolution is filtered out of the discovery projection. Two
halves, one wrong and one right.

**Wrong half — `evidenceIds` is not part of the question.** `src/kernel/subject.ts:35-45` hashes the plan digest, the claim
`id`, its `statement` and its `dependsOn`. `evidenceIds`, `severity` and `status` are bookkeeping about the answer. Measured
(temporary fixture, deleted after the run): `claim add → freeze → evidence add` where the submission only fills in
`evidenceIds` leaves `declaredSubjectRevision` byte-identical, and the bound challenge's `resolution.subjectRevision` equals
the declared revision.

**Right half — the fixed point is real.** The trigger is a **claim declared after the freeze**:

```text
claim add C1 → freeze                       frozen   = rev:5a81669e28cccad7
evidence add (submission declares C2)       declared = rev:059aefc473180016
evidence verify                             verdict.subjectRevision = rev:5a81669e28cccad7
challenge add --claim C2 --falsifier E1     failsOn = rev:5a81669e28cccad7
challenge check ×2                          resolution.subjectRevision = rev:5a81669e28cccad7
ledger decide → insufficient / discovery_unverified
  need: "re-run the recorded challenge against the current revision …"
```

Re-running changes nothing, because the re-run stamps the same frozen value again. That is the report's own complaint — the
CLI names a command that cannot change the state — and it is the defect this change repairs.

## Root cause: two derivations of "the question"

- **The stamp.** `src/cli/ledger.ts` builds the verification context from `ledger.subject` — the **frozen** subject — for both
  `evidence verify` (`:544-562`) and the bound `challenge check` (`:799-835`). The verdicts and the resolution therefore carry
  the frozen revision.
- **The comparison.** `src/store/verdict.ts:67-83`'s `discoveryProjection` compares against `currentRevision`, which every
  caller takes from `readLedger`'s `subjectAsDeclared` — the question **as declared now**.

Both are individually right, and the disagreement is the defect: when a claim is declared after the freeze, the write path
can only ever produce a reading bound to a question the decision does not ask. `ledger freeze` re-derives the frozen subject
from the current declaration (`src/store/ledger.ts:1711`, `questionForComparison`), which is why the remedy works — and why
the operator has to be told to run it.

## Decision

**Refuse, by name, in the state where no reading can count — and name the remedy that clears it.** Not "stamp with the
declared question", which would change what `supported` means (one tree, two questions, two credited readings) and is a gate
semantics change that is not this change's to make.

One derivation, so no surface can disagree with another:

- `src/store/ledger.ts` gains the single derivation of the state — the frozen revision, the declared revision, whether they
  differ, and the remedy text naming the commands that clear it.
- `ledger evidence verify` refuses in that state instead of recording verdicts the decision will never credit.
- `ledger challenge check` refuses in the same state with the same text, so no surface asks for a command that cannot work.
- `ledger evidence add` reports when the claims it just wrote moved the declared question, so the drift is visible where it is
  created rather than only at `decide`.

**Why refusing is the honest answer and not a weakening.** A reading taken in that state is recorded, stamped with a question
the decision does not ask, and then silently ignored — the failure mode is "work that looks done and is not". The refusal
converts it into a state with a next step, which is what the project's own rule asks of every refusal.

**Boundary.** This does not make the frozen question and the declared question the same thing, and it does not change when a
subject moves: a restated claim, a changed plan or a newly declared claim still moves it. What changes is that the ledger
says so at the moment a reading would be taken, instead of crediting nothing later.

**Legacy behaviour preserved.** A subject that never hashed a question (`claimsDigest` absent — every ledger frozen before
that field existed, and every freeze that happened before the first claim) keeps the fallback where the declared subject is
the frozen one, so those ledgers never enter this state and their workflows are untouched.

## Acceptance criteria

| AC | What it asserts | Selector |
|----|-----------------|----------|
| AC-1 | `ledger evidence verify` refuses by name in the drifted state, naming both revisions and the complete remedy | `tests/unit/a-reading-is-refused-when-the-question-moved.test.ts` |
| AC-2 | `ledger challenge check` refuses in the same state with the same remedy — no surface asks for a command that cannot work | `tests/unit/no-surface-asks-for-a-command-that-cannot-work.test.ts` |
| AC-3 | The named remedy clears the state: after `ledger freeze`, verify and bound `challenge check` run and `decide` credits the challenge | `tests/unit/re-freezing-clears-the-discovery-gap.test.ts` |
| AC-4 | `ledger evidence add` reports when the claims it wrote moved the declared question | `tests/unit/evidence-add-reports-that-the-question-moved.test.ts` |

Each selector is its own file, because three acceptance criteria declaring one file collapse into one check under
`dedupeChecks` and the verification then reports `insufficient_evidence_level` — measured on this repository.

## Falsifiers (one reversible mutation per AC)

- **AC-1** — `if (moved !== null)` → `if (false && moved !== null)` in `evidence verify`: 2 of 3 cases red (`ok` false→true, and verdicts written).
- **AC-2** — the same mutation at `challenge check`: 3 of 3 cases red.
- **AC-3** — `const planDigestAtFreeze = await planDigestOf(…)` → `undefined` in the CLI freeze branch, so the re-frozen subject
  and the declared one can never be equal and the remedy stops clearing anything: the case reddens on
  `expected false to be true`.
- **AC-4** — `question?.moved === true` → `false && …` in `evidence add`: 1 of 2 cases red.

**Two falsifiers that did not redden, and what they changed.** Both were found by running the mutation rather than by reading
the test, and both are recorded because they are the failure mode this repository keeps paying for — a guard that cannot fail:

- Dropping the plan from the freeze (`planDigestAtFreeze = undefined`) left AC-3 **green**, because the fixture never ran
  `ledger plan`, so both sides of the comparison saw `undefined` and the plan half of the identity was not exercised at all.
  The fixture now records a plan first, and the same mutation reddens.
- Making `questionForComparison` return `{}` also left AC-3 green: the re-freeze then drops the question entirely, which makes
  the frozen subject equal to the declared one *by weakening identity* rather than by answering it. Two assertions were added
  for that: the frozen subject must keep a `claimsDigest`, and it must equal the declared one. (That mutation is not the
  remedy's path — the CLI freeze hashes the question itself — which is why the falsifier for AC-3 targets the freeze branch.)

## Ownership

`src/cli/ledger.ts`, `src/store/ledger.ts` and `docs/operations.md` are shared with active changes; the conflicts are recorded
as audit facts by `scope change` rather than narrowed away, which is this repository's standing practice.

## What this change does not do

- It does not touch `evidenceIds`' relationship to identity: that relationship is already correct, and the report's proposed
  fix A would be a no-op.
- It does not add a cross-revision recurrence reading (the `review-loop-never-converges` report's F1/F6), nor the severity
  vocabulary work (F2/F5), nor the identity/statement question (F3), nor `failingEvidence`'s two derivations (F4). Those stay
  in the successor list.
