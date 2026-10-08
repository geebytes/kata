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

## The first independent round, and what it changed

Round 1 (`adversarial`, `revision-6841dd6ab2340850`) returned **fail**: E1–E4 all `supported`, all four declared selectors
reddened under their declared single-point mutation, no green selector — and three findings, all in the class this change
claims to close. Each is repaired here, and each repair has its own falsifier (run, not assumed):

- **R1-F1 (major) — the decision asked a different question from the report.** `ledgerVerdict` handed `decide` the subject
  **as frozen** (`subject: ledger.subject`), so the kernel compared every reading against the frozen revision while
  `claimDecisions` and `discoveryProjection` compared against the declared one. Measured: after `claim restate`,
  `ledger status --cost` reported the claim `stale` and `ledger decide --tier standard` reported **`pass, reasons: []`** for
  the same ledger — a reading that answered another question, credited. Under `strict` the reading was still accepted at the
  claim layer; only the discovery floor kept it from a pass. **Repair:** the decision asks the question the ledger declares
  (`subject: ledger.subjectAsDeclared ?? ledger.subject`); the content digests are the same either way, so nothing about the
  content moves with it. **Guard:** `tests/unit/the-decision-asks-the-question-the-ledger-declares.test.ts` — a control (no
  drift ⇒ `pass`) plus two ways for the question to move (a restated claim; a plan that changed under the same claims).
  **Falsifier:** hand back the frozen subject → two of three cases redden.
- **R1-F2 (minor) — a refusal hid the move the command had just made.** The claims are written before the evidence, so a
  submission whose evidence write is refused has still moved the question; `evidence add` reported only the evidence conflict.
  **Repair:** one derivation (`movedQuestionFields`) spread into both the success result and the refusal, so the two cannot
  describe the same ledger differently. **Guard:** a third case in the AC-4 selector that drives the failure path.
  **Falsifier:** drop the spread from the refusal → that case reddens.
- **R1-F3 (minor) — the remedy named a flag that does not exist.** The refusal (and the new operations bullet, and the
  pre-existing example block) said `--path <p>…`, while `ledger freeze` reads only `--paths` (comma-separated): following the
  remedy literally silently freezes the task's declared paths. Measured: `ledger freeze --path /nonexistent` → `ok=true`, and
  the documented `evidence add --id … --command …` example → `--file <submission.json> is required`. **Repair:** the remedy
  names the bare command (which is the correct remedy — the state is the frozen question, and `ledger freeze` re-derives it
  from the declaration) and mentions `--paths a,b` only for a different set; the operations example now shows commands that
  were run and work. **Guard:** an assertion that the refusal names no `--path` in any form (negative lookahead, so `--paths`
  passes). **Falsifier:** restore the old string → that case reddens.
- **R1-F4 (note) — `ledger ask` is a third surface stamping the frozen subject** and does not refuse in the drifted state.
  Recorded, not repaired: probes are advisory history the request may withhold and no gate reads them. It becomes a real
  instance the day a probe answer becomes a gate input.

## The third independent round: the report moves to one place

Round 3 (`adversarial`, `revision-0319ec82de95205d`) returned **fail** on the same class, one layer further out, and it was
right: **`ledger policy --set-file` is a fifth writer.** A floor change writes `policy-floor:<pattern>` claims through the
same `appendClaim` every other writer uses, so it moves the declared question — and it reported nothing. The round proved it
with an executable reproduction (`rev:5a81669e28cccad7` → `rev:d3f22d8fca430097`, no `questionMoved`), enumerated every
command that can move the question, and confirmed the four that were wired. It also found the prose that still called
`ledger evidence add` "the write that creates the drift", and the test comment claiming there are four writers.

**The repair is structural, not a sixth call site.** Whether a command moved the question is a property of the command's
*effect*, so it is now answered once: `runLedgerCommand` reads `declaredSubjectRevision` before the dispatch and after it,
and attaches the report to whatever the command emitted (the family's output goes through one door, which buffers while a
command runs). Consequences, each of them a case in the AC-4 selector:

- a writer added later cannot forget to report, because there is nothing to remember;
- a refusal cannot hide a move the command already made (round 1's R1-F2), because the report is attached to every payload;
- a pure read on an already-stale ledger reports **nothing** — it did not move anything — which is what keeps the report from
  becoming noise, and a `claim waive` (which writes the ledger and moves no question) is the control for it;
- the per-site spreads are gone, so there is no second derivation of the same report to drift.

**Falsifier for the class:** disable the comparison in the dispatcher and every writer case in the AC-4 selector reddens at
once. **Falsifier for the prose:** restore the old paragraph and the AC-1 selector's documentation guard reddens.

**What round 3 also confirmed:** E1–E9 all `supported`; every declared selector reddens under a single-point mutation (the
round reported the one spread that was reachable but undeclared, which this revision removes); R1-F1's repair still holds; and
the ledger itself decided `pass` while the review decided `fail` — because the fifth writer's drift is invisible to the
ledger's own claims, which is exactly why an independent round is the instrument and not the ledger.

**Where "every case" was an overclaim, corrected by round 4.** Not every *case* reddens under one mutation, and saying so was
wrong of this document. Of the AC-4 selector's nine cases, six redden together under the class-level mutation (the five
writers and the refusal path), and the three controls do not: two of them (`evidenceIds`-only submission, `claim waive`)
redden only under a mutation that makes the report fire unconditionally, and the third — "nothing frozen" — needs *two*
changes, because with no subject both the dispatcher's comparison (`null !== null`) and `movedQuestionFields`' own guard are
inert. Its single falsifier is removing that guard, which is a mutation of this change's code, so the case does have one; what
was wrong was the blanket claim, not the case.

## The second independent round, and what it changed

Round 2 (`adversarial`, `revision-a617472f79438117`) returned **fail**, and its verdict is the one this change had been
earning: *the R1-F1 repair could not be falsified, but the R1-F2 and R1-F3 repairs closed the instance rather than the class.*

- **R2-F2 (major) — three more writers move the question and none of them said so.** `movedQuestionFields` was wired into
  `evidence add` alone, while `ledger claim add`, `ledger claim restate` and `ledger plan` each move the declared question —
  which falsifies this change's own C4, whose first clause is *every* surface. Measured by the round: after a freeze,
  `claim add --id C2` moved the subject from `rev:5a81669e28cccad7` to `rev:a26738391e1e586d` and printed only
  `[ok, command, claim]`; `claim restate` likewise. **Repair:** one derivation, five call sites, and the note now names its
  cause. **Guards:** three new cases in the AC-4 selector, one per writer, plus a control that a claim added while nothing is
  frozen reports nothing. **Falsifiers:** removing the spread from any one of the three reddens exactly that case (three
  mutations, run).
- **R2-F1 (minor) — the class was still open in prose.** The flags table and the example block had been corrected to
  `--paths`, and the paragraph between them still said `--path`, repeated; `ledger freeze` reads only `--paths`, so following
  the prose silently re-freezes the declared paths. **Repair:** the paragraph now names `--paths a,b`. **Guard:** the AC-1
  selector reads `docs/operations.md`, slices the ledger section, asserts the slice really is that section, and asserts no
  `--path` in any form. **Falsifier:** restore the old paragraph → that case reddens.
- **R2-F3 (note) — two latent sites, recorded not repaired.** `orchestrator.ts:1970` stamps a review record with the frozen
  `subjectRevision` while `:2178` compares it against the declared one — unreachable while the ledger tier floor is `strict`
  (the round reached the precondition only by forcing `--tier standard`, which the approval path never passes); and
  `ledger status` (plain) prints the frozen revision while the same verb's `--cost` derives from the declared one. Both are
  successors, and the second is a reporting inconsistency rather than a gate.

**What round 2 also confirmed.** E1–E6 all `supported`; every declared selector and every case inside them could be reddened
by a single-point mutation (14/14, with the round constructing its own mutations for the controls); and R1-F1's repair held
under its attempts — the decision chain now derives the question once.

**Not repaired here, and why.** The deeper cause behind R1-F3 is that an unknown flag is silently ignored by every ledger
verb (`--path` was accepted and dropped). That is argument parsing across the whole CLI rather than this change's mechanism,
so it is recorded as a successor rather than half-fixed inside a ledger repair.

## Ownership

`src/cli/ledger.ts`, `src/store/ledger.ts` and `docs/operations.md` are shared with active changes; the conflicts are recorded
as audit facts by `scope change` rather than narrowed away, which is this repository's standing practice.

## What this change does not do

- It does not touch `evidenceIds`' relationship to identity: that relationship is already correct, and the report's proposed
  fix A would be a no-op.
- It does not add a cross-revision recurrence reading (the `review-loop-never-converges` report's F1/F6), nor the severity
  vocabulary work (F2/F5), nor the identity/statement question (F3), nor `failingEvidence`'s two derivations (F4). Those stay
  in the successor list.
