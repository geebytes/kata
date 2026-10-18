# The gates can be repaired, and a finding is closed by the fact that closed it

**Status:** design (2026-10-13) · profile `current_worktree / tdd / strict`

## 1. The measured problem

Three defects were measured while closing two changes on 2026-10-12/13. They share one shape: **a record the mechanism
writes cannot be repaired by the mechanism, and a field the mechanism reads is written by nobody.**

### 1.1 `gate approve` accepts a choice its own schema refuses (I-36)

```
$ kata-cli gate approve --task <id> --boundary archive_gate --choice archive
{"command":"gate approve","boundary":"archive_gate","choice":"archive","approved":true}
```

`archive` is not in the vocabulary — `schemas/user-choice-gate.schema.json` accepts
`continue_current | switched | delegated` — and `runGateCommand` (`src/cli/workflow.ts:344-350`) casts the string while
`approveUserChoiceGate` (`src/workflow/user-choice-gate.ts:164-166`) writes it without validating. From then on **every**
read of that record fails its schema (`$.choice must be one of …`), so:

- `gate approve` refuses (schema mismatch), and
- `archive` refuses ("requires an explicit user choice"), and
- deleting the file does not help: `readGate` treats a missing file as an error, not as "no gate", and
- **no command removes or rewrites a gate record.**

The task was deadlocked on that boundary until the record was restored to its creation-time shape by hand.

### 1.2 A consumed gate can only be rebuilt by a command the current phase refuses (I-37)

`GATE_CREATED_BY` (`src/workflow/user-choice-gate.ts:32`) states which command creates each boundary, and the refusal for
a consumed gate prints that command as the remedy. Measured: `judge_gate` is created by `review --approve`, which requires
the phase to be `review` — and after `judge` succeeds the task is in `judge`. So the remedy is inert in exactly the state
that prints it, while `gate approve` refuses a consumed gate and `judge` refuses without a fresh choice. Three roads, all
closed.

### 1.3 No supported command can dispose of a recorded finding (I-35)

`schemas/review-finding.schema.json:96` says the disposition is "set by a disposition command (`findings defer|accept|rout`)
or by the closure rule marking a finding fixed", and `isOpenFinding` (`src/quality/review-ladder.ts:32`) closes a finding
only on `fixed`. Measured:

- `kata-cli findings` → `Unknown command: findings`;
- `grep -rn "disposition:" src/` shows **no writer** of `disposition: 'fixed'` anywhere.

So a recorded blocking/major finding stays open forever, `change-record.openFindings` never falls, and `review --approve`
refuses on findings that were repaired in the very revision being approved. The only road the mechanism offers is *another
review round bound to a newer revision* — which is why one change in this repository spent three rounds buying rounds it
did not need, and why the loop's own escalation (I-38) points back at `/kata-review`.

## 2. The rule this change adopts

**A record the mechanism writes must be repairable by the mechanism, and a field the mechanism reads must be written from
a fact it already records.**

Three consequences, one per defect:

1. **Validate where you write.** The write side refuses an out-of-vocabulary value by name, before anything lands. (The
   read side already validates; the asymmetry is what produced a deadlock.)
2. **A remedy must run where it is printed.** The table that says which command creates a boundary is checked against the
   phases that command accepts, so a refusal cannot name a road that is closed in the state that prints it.
3. **A declaration must not name a mechanism that is not there.** `schemas/review-finding.schema.json` described a
   `findings defer|accept|rout` command that the dispatcher does not have, and its vocabulary was a second copy of the
   ladder's. The vocabulary is one value now, shared by both artefacts and compared by a selector.

Point 3 was first written as "a disposition is derived from the recorded repair", and **that premise was refuted by the
code before anything was implemented** (§3, AC-4): what refuses approval after a repair is the record's binding, not an
undisposed finding, and `openFindings` has no gate consumer. The wider form stays queued as part of I-35, to be
implemented only after a reproduction shows a gate that refuses on it. A free-form `findings dispose` command would let
an operator close a blocking finding by assertion, which is exactly the gate-strength change this repository refuses to
make unilaterally (memory #1036/#1285).

## 3. Acceptance criteria

**AC-1 — an out-of-vocabulary gate choice is refused by name, and nothing is written.**
`kata-cli gate approve --boundary <b> --choice <c>` validates `c` against the gate vocabulary — **one global vocabulary**, the same set every boundary accepts, because the
schema declares one `choice` enum and no boundary-scoped rule exists; a refusal names the value and lists the vocabulary. A control asserts the three legal values still
approve, and a second control asserts that the *same* validation is what the reader applies (so write and read cannot
drift again).
Selector: `tests/unit/an-out-of-vocabulary-gate-choice-is-refused.test.ts`.

**AC-2 — a record the mechanism cannot read is reported as what it is, not as something else.**
A gate file that fails its schema is reported by name as unreadable, and the refusal says what it is (a damaged record)
rather than "there is no gate" — because the two states have different remedies, and today the reader answers the second
about the first. Control: an absent file still reads as "no gate".
Selectors: `tests/unit/a-damaged-gate-record-is-not-an-absent-one.test.ts`,
`tests/unit/an-obligation-is-read-as-the-round-wrote-it.test.ts`.

**Amended 2026-10-17, widened by the seal's own refusal.** This criterion now covers the other record of the same kind: the
**closure contract** a root-cause round records. The seal refused this change's repair of round 9's contract with
`inventory entries name no file in this repository` for 10 of 10 entries and `no passing check in this seal matches the
declared effectivenessTest` for a field that is a sentence — both readings of records nobody could have written differently,
and the remedy the refusal printed (a new round) cannot be run from the phase the refusal leaves the task in
(`docs/investigations/2026-10-17-the-closure-obligation-cannot-be-satisfied.md` measures all three links of that cycle). The
reader for that record is repaired in this change: an inventory entry is resolved to the file it names, an effectiveness
test that names a check the seal ran is satisfied, and a contract nothing in this seal can confirm is reported as **its own
named state** — decided by a recorded operator decision (`obligation:<defectClass>` among the task's waivers) and published
as a **gap**, never as a satisfied contract, and never as "a check ran and did not match". The amendment widens the
criterion, and it does one thing beyond widening it, stated here rather than left to be inferred: the added clause makes
"a contract nothing in this seal can confirm" an **acceptable outcome** when a recorded operator decision says so, where
before it was a refusal. It is not a pass — the gap is published with its reason and approver, and no reader may report it as
a satisfied contract — but it is a licence, and it is the criterion moving onto the one instrument that cannot decide it
(`gate-r10-F4`). The licence is also **not profile-gated**: the recorded decision is read on every profile, which is the
correction `gate-r10-F3` required, and a decision can only release the *unverifiable* state — a check that ran and failed is
refused with or without a decision (`gate-r10-F1`).

**AC-3 — every boundary's remedy runs in the phase that prints it.**
The creation table is checked against the phases each creating command accepts; a consumed gate can be rebuilt from the
phase the task is actually in (the measured case: a consumed `judge_gate` while the task sits in `judge`). The check is
mechanical: the table is walked and each entry's command is asked whether it runs in the phase its remedy names, so
adding a boundary without a runnable remedy is red.
Selector: `tests/unit/a-gate-remedy-runs-where-it-is-printed.test.ts`.

**AC-4 — the disposition vocabulary has one derivation, and the schema names no mechanism that is not there.**
`schemas/review-finding.schema.json` allows `open | fixed | deferred | accepted | routed` and states that the value is
"set by a disposition command (`findings defer|accept|rout`) or by the closure rule marking a finding fixed"; the ladder
closes a finding only on `fixed`. The two are one vocabulary in two artefacts, and the schema names a command that does
not exist. The criterion: the schema's enum and the ladder's own vocabulary are the same set (checked by reading both, so
a value added to one side and not the other is red), and the schema's description names only mechanisms that exist.
Selector: `tests/unit/a-disposition-has-one-vocabulary.test.ts`.

**Amended 2026-10-13, after measuring the original premise.** This AC was first written as "a repaired finding is closed
by the round that repaired it, so `review --approve` stops refusing on repairs that already happened". That premise is
**refuted by the code**, and the correction is recorded here rather than quietly implemented:

- what refuses approval after a repair is the record's **binding**, not a finding's disposition —
  `src/workflow/orchestrator.ts:2262`: `if (revisionId && !bindsToRevision(existing, approveBinding))` refuses with
  "Review approval requires findings recorded for the same sealed revision (or the same content) as current evidence.
  Re-run /kata-review before approving." That refusal is correct (a review of old content is not evidence about new
  content), and its printed road is executable;
- `openFindings` has **no gate consumer** — `grep -rn "openFindings" src/` reaches only the change record itself and the
  ladder's comment, so a finding nothing disposes of is a *reporting* hole, not a gate;
- and `readBlockingProblems` drops the findings of an unbound record (`src/workflow/review-read.ts:226`), so a repaired
  finding cannot refuse the approval in the first place.

The three rounds that this change was meant to stop buying came from I-21 (a claim with no reading set), I-36 and I-37 —
not from an undisposable finding. So the AC is narrowed to what is measured: one vocabulary, and a schema that does not
describe a command nobody can run. The wider form (a disposition written from a recorded fact) stays in the queue as part
of I-35, to be implemented only after a reproduction shows a gate that refuses on it.

## 4. Declared surface

| Path | Why |
|---|---|
| `src/cli/workflow.ts` | the gate command's write-side validation and the damaged-record refusal |
| `src/workflow/user-choice-gate.ts` | the vocabulary, the creation table, the readability of a damaged record |
| `src/workflow/review-read.ts` | where a recorded round's binding to a revision is already derived |
| `src/quality/review-ladder.ts` | `isOpenFinding` and the approval bar this change must not weaken |
| `tests/unit/an-out-of-vocabulary-gate-choice-is-refused.test.ts` | AC-1 |
| `tests/unit/a-damaged-gate-record-is-not-an-absent-one.test.ts` | AC-2 (the gate record) |
| `tests/unit/an-obligation-is-read-as-the-round-wrote-it.test.ts` | AC-2 (the closure contract, §8) |
| `src/quality/obligation-check.ts` | the reader the seal uses for a closure contract (§8) |
| `src/workflow/orchestrator.ts` | the seal's call site: the recorded decision reaches the reader, and the gap is published |
| `tests/unit/a-seal-satisfies-the-closure-contract.test.ts` | one assertion pinned the changed inventory sentence |
| `docs/investigations/2026-10-17-the-closure-obligation-cannot-be-satisfied.md` | the measurement behind §8, including the first diagnosis that was wrong |
| `tests/unit/a-gate-remedy-runs-where-it-is-printed.test.ts` | AC-3 |
| `tests/unit/a-disposition-has-one-vocabulary.test.ts` | AC-4 |
| `tests/unit/gate-refusal-names-the-remedy.test.ts` | the case that pinned the inert consumed-gate remedy, moved to the property |
| `schemas/review-finding.schema.json` | AC-4: the vocabulary the ladder must agree with |
| `docs/design/2026-10-13-the-gates-can-be-repaired.md` | this document |

## 5. Boundaries

- **No gate is weakened.** AC-4 closes a finding only on a recorded round bound to a newer revision; the approval bar and
  the blocking-severity sets are unchanged. AC-1/AC-2/AC-3 add validation and a remedy; none of them lets a task skip a
  boundary.
- **A consumed gate is not damage.** AC-2's "damaged" is a record that fails its schema; a valid, consumed record is the
  normal state after a phase command and keeps its own remedy (AC-3).
- **Nothing closes a finding here.** The disposition vocabulary is compared between the schema and the ladder and no
  write site is added: `disposition: 'fixed'` still has no writer in `src/`, which is recorded as I-35's remaining half.
- **The schema's description** now says what the code does — the value is written by whoever records the finding, there is
  no separate disposition command, and absent means open.
- **Out of scope, queued:** I-38 (the loop's escalation routes back to another round) is a routing decision, not a
  validation defect, and needs the user's choice.

### The binding question, decided once

Round 9 measured one question — *does an existing binding still speak for the current content?* — answered by three symbols
in two files: the gate's own predicate ("unbound means it speaks"), `verdict-binding.bindsToRevision` (an unbound record
speaks while nothing is sealed), and `assertRevision`'s unbound exemption (accept, silently). The third was reachable by no
instrument at all, and the first two contradicted each other.

**The answer is stated once and every reader asks it.** `recordSpeaksForCurrentContent(record, identity)` in
`verdict-binding.ts` is the name the question is asked by; `bindsToRevision` answers it (and the two cannot drift, because
the unbound answer lives in `namesAnyBinding` / `unboundBindingSpeaksForCurrentContent`, which both call), and
`assertRevision`, the reuse rule and the removal rule all ask it with **the identity their caller has already read** — one
pointer read per verb, widened to the declared content by `contentIdentityFor` when nothing is sealed, so a pre-seal answer
still binds to the declared content (`computeManifestHash` here and the seal's `computeBothOwnedDigests` produce the same
digest, which is what makes that sentence true rather than assumed).

**A record that names no binding at all speaks only while nothing is sealed.** Once a revision exists, "the current content"
is a fact the record never named, so the answer is no for **both** record kinds — the boundary gate and the task-level
choice — and the road out is the one AC-2 built: `gate reset` removes a record that no longer speaks, and the boundary is
answered again. Refusing it is the direction this change exists to take (an unbound record authorising content nobody was
asked about is the round-6 F3 hole, one record kind over), and its measured cost is recorded here rather than implied: of
the 170 gate records in this repository, 52 name no binding and **12 of those are open on tasks that already have a sealed
revision** — every one an `implementation_gate` written before the writer bound what it wrote — so those 12 boundaries need
one `gate reset` plus one `gate approve` the next time they are asked.

**And consuming is not re-asking.** The gate that admitted a command is the gate that command consumes: re-asking compared
the record against a world the command itself had moved, which failed `build --seal --owned-path` — the flow that gives a
task its owned paths at seal time — *after* the seal had succeeded.

## 6. Cost

Four ACs, seven selectors (AC-2 has two — the gate record and the closure contract §8 repairs — and AC-3 has two: the
property sweep and the case that pinned the old remedy), **17 declared paths** (the frozen subject; it grew twice, both times
by `scope change` and both times for a reason the seal itself produced — the binding predicate of round 9 lives in
`src/workflow/verdict-binding.ts`, and §8's reader repair reaches `src/quality/obligation-check.ts`,
`src/workflow/orchestrator.ts` and one assertion in another change's instrument). Measured: implementation ≈5 h
(including the correction of AC-4 after its premise was refuted, and §8 after the seal refused), one independent round
≈29 min / ≈721k tokens. The declared falsifier set is measured, not asserted: **32 executable instruments** at this
revision (seven at the first seal, five added by the round-1 repairs, ten by the round-3 repair of the instrument gap, three by
the round-5 repair — the task-level shape rule, the reader-side vocabulary of the task choice and the unreadable-record
clause — one by the round-6 repair of the binding hole, five by the round-9 repair of the same question at its remaining
sites, and one by §8's repair of the obligation reader; two anchors were re-aimed as those repairs moved the lines they
name). All 32 were re-run at this revision (`ledger evidence verify`: 32 supported, all observed, each mutation applied once
and restored), and each is aimed at the line it mutates, and each is re-read against the revision it is declared for.
Two coverage boundaries are stated rather than implied: a fixture carries a **FIFO** and a **socket** at a record path (both
created in-process, so the shape rule is asked without opening either — round 8's F4 added the socket, and this sentence is
corrected in the same change: round 9's F3 measured it still saying no fixture carried one), while **no fixture carries a
hard link** at a record path; and no case drives the bundled CLI any more — a prebuilt bundle judges whichever revision built
it (round 6's F2 measured one such case running a stale bundle and reporting another revision's behaviour), so those cases
were removed and the CLI layer is a declared, uninstrumented boundary.

A third boundary and a named hole: the disposition-vocabulary check treats a single backticked token as a *name* rather
than a command (an invented one-word verb would pass it), and this change's own `classification.json` is **unreadable**, so the
classification the review package would carry is absent — recorded here rather than passed over.

## 7. Why this is first

Closing two changes on 2026-10-12/13 cost **three extra review rounds and one hand-repaired record** because of these
three defects (I-35 twice, I-36 and I-37 once each). Every change that follows pays the same tax: a repaired finding
cannot be marked repaired, and a boundary that was crossed cannot be crossed again when its gate has been consumed.

## 8. The closure contract, read as the round wrote it

Round 9 concluded `repair` for `refusal-cannot-be-executed` and recorded a closure obligation; the repair was implemented,
the full suite was green, the ledger decided `pass`, all 31 declared falsifiers re-ran `supported` — and the seal refused,
twice, for two fields no repair could satisfy. That is a defect in the gate that certifies this change, and it is repaired
here rather than deferred, because the same gate would refuse the next round's repair the same way.

Measured (`docs/investigations/2026-10-17-the-closure-obligation-cannot-be-satisfied.md`):

- **`inventory`** was read as a path per entry (`entryPathOf` = the text before a colon), so an entry written the way a
  reviewer writes one — `` `src/workflow/verdict-binding.ts` bindsToRevision (the predicate other verdicts ask) `` — named a
  filename containing spaces and parentheses. 10 of 10 entries were reported missing, however correct the repair was.
- **`effectivenessTest`** must be a substring of a check id, name, command or scope path, while the field is a sentence
  describing what reddens. No text of that shape can match, and the refusal said "no passing check in this seal matches",
  which reads as a test that ran and did not match.
- **the remedy it printed** ("a new round through `kata-cli ledger run` and a recorded result") cannot run from the phase
  the refusal leaves the task in: `boundaryForCommand('review', 'implement')` is null, the CLI derives the review entry's
  confirmation from it, the phase machine is strictly linear (`src/core/state.ts:72-74`), and the `--result-file` prologue
  requires the review phase. Adding `implement` to the boundary table was tried and reverted: it changes one refusal into
  another and makes no road run.

**What is repaired.** The two fields are read as the round writes them — an inventory entry resolves to the token that
names a file, and only where the entry writes it as a path (its first token, a backticked or quoted token, or a token
carrying a separator) and only when that path is a regular file, so a sentence that merely contains `src` or `package.json`
names nothing (backticks, a `:line` suffix and trailing punctuation stripped); and an effectiveness test is satisfied by a
passing check **whose id, name, command or scoped path speaks for the declaration** — one rule, applied to both questions
about that fact. *(Corrected 2026-10-18: this paragraph described the satisfied rule as the eight-character identifier search
that lived in `declarationNamesACheck`, which was the reader's **other** rule and not the one that decided `satisfied`
(`envelopeNamesCheck` had no length filter). The two rules disagreed for legal inputs, and that disagreement is
`gate-r10-F1`; the second rule is deleted rather than documented.)*
An entry that names no file is reported **quoted**, so the round sees which one; a declaration that names **no check at
all** is its own state, reported as such, and decided by a recorded operator decision naming `obligation:<defectClass>`
among the task's waivers — published as a **gap** with its reason and approver, never as a satisfied contract, and with no
decision it refuses like any other unmet obligation. A false negative and a waived gap are both stored as what they are:
this repository refuses to make a gate pass by being unreadable.

**What is not repaired, and belongs to its own change.** A class-conclusion round still cannot be recorded before a seal.
That is a new capability (a round without a phase transition, and a relaxed phase guard on the result path), not a repair of
this one, and this change does not pretend otherwise: it is measured, with its three links named, in the investigation note.
