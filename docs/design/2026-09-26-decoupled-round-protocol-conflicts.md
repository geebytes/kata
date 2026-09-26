# Audit: does the landed design and code support the new round protocol, or contradict it?

**Question asked:** does what is already built and decided support `docs/design/2026-09-26-decoupled-round-protocol.md`, or does it
conflict with it?

**Method:** every landed artefact that states *who launches, who observes, who enforces and who authors a receipt* was read and compared —
the schema, the module docstrings, the CLI's own comments, the four test files that exercise receipts and envelopes, the six acceptance
criteria of `adversarial-admissibility` (the change that owns the admission contract), the five of `review-record-integrity` (the other strict
change), and the prior authority `docs/design/2026-09-21-adversarial-execution-control-optimization.md` §3.2.1/§3.2.2, which decided the
capability contract in the first place.

**Verdict in one paragraph.** Nothing contradicts the new design's *intent* — and no acceptance criterion of any change does at all — but
**four landed sentences, four test premises and two written design decisions do**, because the new design relocates three responsibilities
(enforcement, accounting, authorship) from the executor to kata, and the previous design deliberately put two of them the other way for a
stated reason. That reason is the strongest objection to this work and §4 answers it with a check that already exists. Two gaps in the new
plan were also found; one of them is a factual error in my own plan document.

---

## 1. Contradictions in landed text — each needs an edit, none is a behaviour conflict

| # | landed claim | where | why it conflicts | resolution |
|---|---|---|---|---|
| C1 | *"Host-authored, measured and bound: it arrives on its own channel (`--receipt-file`)"* | `schemas/adversarial-review.schema.json:254` | the new design's sentence is *kata-authored*; the schema is the definition every reader trusts, so it is the first thing that must change | reword to *"written by kata from the stream it observed … it arrives on its own channel (`--receipt-file`), and the gate refuses a record whose receipt does not bind to an issued run"* |
| C2 | *"The executor's report. Authored by the host, never by the reviewer."* | `src/quality/review-execution.ts:119` | same, one level down | *"written by kata from the run it observed; never by the reviewer"* |
| C3 | *"host-authored, measured and bound"* | `src/quality/review-execution.ts:13` (module docstring) | same | reword with C2 |
| C4 | *"kata runs a declared command and **validates the receipt it writes**. Kata does not decide how a session is isolated — the command does"* | `src/cli/ops.ts:467` | under the new design kata *writes* the receipt and *decides the allowlist*; the first clause becomes false and the second becomes half-true | split into what stays and what moves: kata still does not decide *how* a session is isolated; it decides what the session may not do and writes the receipt from what it saw |

**None of these is a behaviour conflict**: the record still carries a `receipt`, the gate still binds it to the issued request, and no
acceptance criterion mentions the author. They are statements that become false, which in this repository is the same category of defect as
the eleven "a declaration that claims more than it measures" findings already recorded.

---

## 2. Test premises that must move rather than be repaired

| # | test | premise under the old design | under the new design |
|---|---|---|---|
| T1 | `tests/unit/host-executor.test.ts` (12 cases) | `runReviewRound` produces a receipt, given a fake adapter | the same logic moves to `src/quality/round-runner.ts`, but its **output is a decision about a stream**, not a receipt it owns; the cases move with it and three of them change meaning |
| T2 | `review-execution-receipt.test.ts:141` *"reports `budget_exhausted` from the receipt rather than certifying a truncated round"* | the receipt is the source of the status | the status comes from **kata's own count**; the receipt only reports it. The case should be rewritten to assert that a host claiming `completed` past the budget still yields `budget_exhausted` — which is new AC-4 |
| T3 | `review-execution-receipt.test.ts:331` *"the receipt arrives on its own channel"* | it arrives from the host | it still arrives on its own channel, now written by kata; the case survives with its reason reworded |
| T4 | `pi-adapter-refuses-what-it-cannot-run.test.ts` | the adapter's failure produces no receipt through `runReviewRound` | the adapter produces no `result` line, and the parser refuses; the case survives, one level up |

---

## 3. Gaps in the new plan — one of them an error in my own document

| # | gap | why it matters | resolution |
|---|---|---|---|
| **G1** | **the plan says `--receipt-file` becomes a refusal. It is the wrong flag.** `--receipt-file` belongs to `adversarial record` (the operator hands kata the receipt); `execute` has `--receipt-out`. | as written, the plan would break the very pipeline it describes — `record` is how a receipt reaches a record at all | the flag that changes is `execute`'s `--receipt-out` (now where **kata** writes, not where the host wrote) and the **`KATA_REVIEW_RECEIPT` environment variable stops being handed to the host**. `record --receipt-file` stays exactly as it is. **The plan document is corrected in the same commit as this audit.** |
| **G2** | **the plan does not say how `record` tells a kata-written receipt from a hand-written one.** Today the gate checks binding and capabilities only; under the new design the receipt's authority is *"kata wrote it"* — and `record` will accept any file that validates. | without this, the redesign moves authorship but buys nothing at admission time: a hand-written receipt still passes the same checks | `execute` records each run in the task store (`runId`, `requestSha256`, the derived status, the counts); `record` requires the receipt's `runId` to appear there **as a completed run**. A hand-written receipt has no executed run behind it. This is the same shape as the falsifier ledger, which is already the store-of-record for dispositions |

---

## 4. The strongest objection, and the check that answers it

The prior design put enforcement outside kata **on purpose**, and said why:

> *"Kata does not decide how a session is isolated — the command does — and **that is what keeps a change to kata from loosening the envelope it
> certifies**."* — `2026-09-21-…-optimization.md` §3.2.1

and again in §3.2.2: *"an envelope **the executor enforces** and the receipt reports"*.

The new design does the opposite: kata enforces. **A kata change can now loosen the envelope it certifies**, which is precisely the failure
mode the original sentence was written to prevent. Three things make that acceptable, and the third is the one that decides it:

1. **Kata already owns the numbers.** The packet carries the budget, and `MEASURED_REVIEW_PASS_COST` + `REVIEW_HEADROOM` derive it from recorded
   passes. The executor never chose the envelope; it only obeyed it. What moves is *who checks*, not *who sets*.
2. **The reason the original kept enforcement outside was that kata could not observe.** That was true of a receipt: an artefact handed over
   once, at the end. It is false of a stream, and the entire redesign is that change of observability.
3. **The control against loosening already exists and is tested**: `tests/unit/review-budget-envelope.test.ts:168` — *"sets every limit above
   the cost the recorded passes actually incurred"* — plus *"derives the limits rather than restating them, so a recalibration moves all three
   together"*. A kata change that widened the envelope would have to lower a limit below its measurement, and that test refuses it.

**So the objection is answered, but it is not answered by the new plan as written** — the plan never mentions it. It must, because the
alternative reading (kata now enforces, therefore kata can weaken its own gate) is the exact class of change this repository has spent the day
removing.

---

## 5. What is compatible, verified

* **No acceptance criterion conflicts.** `adversarial-admissibility` AC-1…AC-6 and `review-record-integrity` AC-1…AC-5 mention neither the
  receipt's author nor the envelope's enforcer. The relocation supersedes two *design decisions*, not any criterion a change asserts.
* **The record path is unchanged.** `record` still refuses a receipt inside the reviewer's result body (`executedBy` and `receipt` are refused by
  name), and that refusal is *strengthened* by the redesign rather than weakened.
* **The gate is unchanged.** `requiresExecutionReceipt` for `strict`/`security` nodes and `verifyExecutionReceipt`'s binding checks stay as they
  are; only the artefact's author changes.
* **What I actually ran stays valid.** Both certified rounds of `adversarial-admissibility` went through `execute`; neither would behave
  differently under the redesign except that the receipt they produced would have been written by kata.
* **The `host/` boundary is unaffected.** `src/` still never imports `host/`, and the test that asserts it is untouched.
* **The falsifier/ledger machinery is a precedent, not a conflict**: G2 proposes the same store-of-record shape, in the same task store, that
  dispositions already use.

---

## 6. What must change in the plan before implementation

1. **Correct G1** — `--receipt-out` and the `KATA_REVIEW_RECEIPT` variable are what change; `--receipt-file` stays.
2. **Add G2** — the execution registry that makes *"kata wrote it"* checkable at admission, with its own AC.
3. **Record the §4 relocation as a decision**, with the budget-envelope test named as its control.
4. **Add the four text corrections of §1 and the four test moves of §2 to the migration table**, as part of steps 2 and 4 rather than as
   follow-ups.
5. **State the objective boundary**: this is a soundness change, not a cost optimization, and it must not be presented as one — the
   `docs/verfify.md` objective (`minimize(tokens, latency) subject to recall/falsePass ≥ baseline`) is not what this work moves.

**Nothing found requires abandoning the design.** Every conflict is a statement to reword, a test to move, or a decision to re-record — and the
one substantive objection (§4) is answered by a measurement that is already enforced.
