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
3. **A disposition is derived, never asserted.** `disposition: 'fixed'` is written by the mechanism when it records the
   fact that closes a finding — a review round bound to a **newer revision** than the one that produced it, which is the
   same fact `bindsToRevision` already answers for the ladder. There is **no command that lets an operator close a
   finding**: the disposition follows from the repair being recorded, so this does not weaken a gate — it makes the gate
   able to see a repair that already happened.

Point 3 is deliberately the narrow form. A free-form `findings dispose` command would let an operator close a blocking
finding by assertion, which is exactly the gate-strength change this repository refuses to make unilaterally (memory
#1036/#1285). If the narrower form turns out to be insufficient, the wider one is a separate decision for the user.

## 3. Acceptance criteria

**AC-1 — an out-of-vocabulary gate choice is refused by name, and nothing is written.**
`kata-cli gate approve --boundary <b> --choice <c>` validates `c` against the gate vocabulary and the boundary's own
allowable answers; a refusal names the value and lists the vocabulary. A control asserts the three legal values still
approve, and a second control asserts that the *same* validation is what the reader applies (so write and read cannot
drift again).
Selector: `tests/unit/an-out-of-vocabulary-gate-choice-is-refused.test.ts`.

**AC-2 — a gate record the mechanism cannot read is reported as damaged, not as absent.**
A gate file that fails its schema is reported by name as unreadable, and the refusal says what it is (a damaged record)
rather than "there is no gate" — because the two states have different remedies, and today the reader answers the second
about the first. Control: an absent file still reads as "no gate".
Selector: `tests/unit/a-damaged-gate-record-is-not-an-absent-one.test.ts`.

**AC-3 — every boundary's remedy runs in the phase that prints it.**
The creation table is checked against the phases each creating command accepts; a consumed gate can be rebuilt from the
phase the task is actually in (the measured case: a consumed `judge_gate` while the task sits in `judge`). The check is
mechanical: the table is walked and each entry's command is asked whether it runs in the phase its remedy names, so
adding a boundary without a runnable remedy is red.
Selector: `tests/unit/a-gate-remedy-runs-where-it-is-printed.test.ts`.

**AC-4 — a repaired finding is closed by the fact that repaired it.**
When a review round is recorded against a revision newer than the one a finding was recorded on, that finding's
disposition becomes `fixed` with the reason naming the round and revision that closed it, so `openFindings` falls and
`review --approve` stops refusing on repairs that already happened. A control asserts the opposite direction: a round
bound to the **same** revision does not close the finding, and an open finding at or above the mode's bar still refuses
approval. No command accepts a disposition as an argument.
Selector: `tests/unit/a-finding-is-closed-by-the-round-that-closed-it.test.ts`.

## 4. Declared surface

| Path | Why |
|---|---|
| `src/cli/workflow.ts` | the gate command's write-side validation and the damaged-record refusal |
| `src/workflow/user-choice-gate.ts` | the vocabulary, the creation table, the readability of a damaged record |
| `src/workflow/review-read.ts` | where a recorded round's binding to a revision is already derived |
| `src/store/review-record.ts` | the review-record writer, where the disposition is written from that fact |
| `src/quality/review-ladder.ts` | `isOpenFinding` and the approval bar this change must not weaken |
| `tests/unit/an-out-of-vocabulary-gate-choice-is-refused.test.ts` | AC-1 |
| `tests/unit/a-damaged-gate-record-is-not-an-absent-one.test.ts` | AC-2 |
| `tests/unit/a-gate-remedy-runs-where-it-is-printed.test.ts` | AC-3 |
| `tests/unit/a-finding-is-closed-by-the-round-that-closed-it.test.ts` | AC-4 |
| `docs/design/2026-10-13-the-gates-can-be-repaired.md` | this document |

## 5. Boundaries

- **No gate is weakened.** AC-4 closes a finding only on a recorded round bound to a newer revision; the approval bar and
  the blocking-severity sets are unchanged. AC-1/AC-2/AC-3 add validation and a remedy; none of them lets a task skip a
  boundary.
- **A consumed gate is not damage.** AC-2's "damaged" is a record that fails its schema; a valid, consumed record is the
  normal state after a phase command and keeps its own remedy (AC-3).
- **The disposition is written on the repair path only.** Historical records without a disposition keep reading as open
  (the schema's "Absent means open"), so this change does not retroactively close anything: it closes what a round bound
  to a newer revision has answered, from the moment that round is recorded.
- **`schemas/review-finding.schema.json`'s sentence about a `findings` command** stays true only if such a command exists;
  this change does not add one, so the schema's description is corrected to name the mechanism that actually writes the
  field.
- **Out of scope, queued:** I-38 (the loop's escalation routes back to another round) is a routing decision, not a
  validation defect, and needs the user's choice.

## 6. Cost

Four ACs, four selectors, ~10 declared paths, one repair path in the review-record writer. Estimated 4–6 h of
implementation plus one independent round (≈15–20 min / ≈250k tokens). The falsifier set will grow by one instrument per
AC, each re-aimed against the line it mutates.

## 7. Why this is first

Closing two changes on 2026-10-12/13 cost **three extra review rounds and one hand-repaired record** because of these
three defects (I-35 twice, I-36 and I-37 once each). Every change that follows pays the same tax: a repaired finding
cannot be marked repaired, and a boundary that was crossed cannot be crossed again when its gate has been consumed.
