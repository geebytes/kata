# An unresolved obligation blocks the run whose evidence would resolve it

Found while repairing the `major`-finding closure defect (`docs/design/2026-09-20-major-finding-closure.md`, layer 3).
Recorded there deliberately unrepaired; this change exists to close it.

## What is broken

Two commands disagree about when an obligation may be unresolved, and the disagreement is a deadlock.

**The seal refuses before the checks.** `collectSealPreflight` (`src/workflow/seal-preflight.ts`, check 5) denies a seal
when any obligation lacks a `resolvedAt`:

```
Unresolved repair obligations: every terminal finding owes a repair, and the seal records which evidence answered it.
```

**Resolution happens after them.** `resolveObligationsForRevision` (`src/workflow/orchestrator.ts`) is the only path that
ever sets `resolvedAt` — `reopenObligation` has no production caller and there is no CLI for it. It runs well after the
preflight:

| step | line | what it needs |
|---|---|---|
| `collectSealPreflight` | 443 | no unresolved obligations |
| checks run, evidence collected | ~567 | — |
| `resolveObligationsForRevision` | 646 | the evidence the checks just produced |

So an unresolved obligation stops the run that would have produced the evidence answering it. Neither `build --seal` nor
`verify` can get past it: `verify` fails the affected criterion with `unresolved_repair_obligation`
(`src/quality/evidence-adequacy.ts`).

**Why it went unnoticed.** Check 5 returned early for a task with no `acceptanceMatrix`:

```ts
if (task.acceptanceMatrix) return;
```

Matrix tasks therefore escaped the deadlock — the seal ran, and resolution followed. Removing that early return (necessary
in `major-finding-closure`, because closure resolves from acceptance ids and evidence rather than needing a matrix) made
the deadlock reachable on the default task shape, which is what `/kata-open` produces.

**The ordering has never been exercised end to end.** Both obligation tests call `resolveObligationsForRevision` directly
(`tests/e2e/quality-gates.test.ts`); no test seals a task that carries an unresolved obligation and then asserts the seal
resolved it.

## Options considered, and why three are rejected

The question is not "how do we stop refusing" — it is **when may an obligation be considered answered**, and the
invariants from the efficiency review decide most of the answer: no gate passes without evidence, and anything not
mechanically provable fails closed.

| option | shape | verdict |
|---|---|---|
| **A** | the preflight stops denying an obligation this run *will* answer | **rejected** — the preflight would predict what the checks are about to prove, which is the "gate guesses" failure mode the misleading-result rule exists to prevent |
| **B** | resolve ahead of the preflight, from the previous revision's sealed evidence | **rejected** — an obligation could then be answered by evidence from *before* the repair, which is precisely the stale-evidence hole the revision binding exists to close |
| **C** | resolution stays after the checks; the preflight denies only what this run *cannot* answer | **chosen** |
| **D** | add a CLI to resolve by hand, keep refusing | **rejected** — makes an obligation a bookkeeping entry rather than something evidence answers, which is the "talked out of the way" case `isTerminalSeverity` already refuses for dispositions |

## Decisions

### D1 — One mapping function, consulted by both the preflight and the resolver

C's risk is drift: if the preflight decides "this run can answer it" with one rule and the resolver decides it with
another, the seal passes and the obligation stays open — the defect this change is fixing, reintroduced in a subtler form.

So the acceptance-to-evidence question moves into **one** function that answers it for a given revision's evidence, and
both callers use it. The preflight asks it in a **dry** mode (deny only the obligations that would still be unresolved
once this run's evidence exists); the resolver asks it for real and stamps the answer. Sharing the function is what makes
C honest rather than two guesses that happen to agree.

### D2 — The preflight's refusal keeps its force for what the run cannot answer

C must not soften the gate. An obligation that this run cannot answer — one scoped to a criterion with nothing to prove
it, or whose evidence this run does not produce — is still denied. What changes is only the case where the seal is
refusing to let the run produce the evidence it is asking for.

### D3 — The refusal names the distinction

A refusal that says "unresolved" when the remedy is "run the seal you are being blocked from" is a trap. The preflight's
message must say which it is: an obligation the current run will answer (proceed) versus one it will not (supply evidence
or add a matrix).

## Acceptance criteria

- **AC-1** — On a task with no acceptance matrix carrying an unresolved obligation, `build --seal` runs the checks,
  resolves the obligation from the evidence they produce, and seals. Today it refuses.
- **AC-2** — An obligation this run cannot answer still refuses the seal, with the criterion named; the gate does not
  weaken.
- **AC-3** — The preflight and the resolver agree by construction: for any obligation, the preflight's dry-run verdict and
  the resolver's actual outcome are the same. Asserted jointly, not by two separate expectations.
- **AC-4** — The matrix paths are unchanged: with a matrix and an unsatisfied criterion the obligation stays unresolved;
  with a matrix and matching evidence it resolves.
- **AC-5** — The deadlock is reproduced as a test *through the seal* — the shape no existing test exercises — rather than
  by calling the resolver directly.

## Verification notes

- AC-1 and AC-5 are the same fixture: an end-to-end seal, which is exactly what has never been tested.
- AC-3 is the new invariant, and it is the one worth a test even though it is about internal agreement: the whole
  defect class is "two places disagreed about the same question".
- AC-4 must be asserted against the existing matrix tests in `tests/e2e/quality-gates.test.ts` rather than duplicated.

## What implementation found beyond the design

The design named the deadlock. Implementation found two more members of the same family, and one of them was the
*failure mode the design was written to prevent* — which is why it is recorded here rather than quietly fixed.

### The dry run over-promised (found by the review pass, repaired)

The preflight built `plannedEvidence` from **every** planned check with `exitCode: 0`. A check declared `tier: 'frozen'`
is deferred unless `--frozen` is passed, so it produces no evidence — and the dry run counted it anyway. Measured on one
obligation: the preflight's verdict over a frozen-only plan was `true` while the same rule over what that plan really
produces was `false`. So the seal **passed while the obligation stayed open**, reported by nothing.

That is precisely the silent pass this change exists to eliminate, arriving through the mechanism meant to eliminate it —
which is the argument for having reviewed the change against its own claim rather than its diff. Both the collector and the
preflight now derive the executed set from `deferredChecks`, so the preflight reasons about the checks that will run.

### Two more members of the same family (repaired)

- **Closure ran before resolution.** `closeBatchAfterSeal` was called *before* `resolveObligationsForRevision`, so the
  first successful seal of any batch refused on `answered: []` — one run late, with the refusal swallowed by a
  `.catch(() => null)`. Same ordering class as the deadlock.
- **Closure did not mark what it closed.** `closeRepairBatch` computed `answered` but nothing wrote the finding's
  *disposition*, which is a separate field. A batch could close with `answered: [id]` while `readTrackedFindings` reported
  that finding `open`, so the next brief still said "an open major finding is unrepaired". Fixed by marking an answered
  finding `fixed` at closure — and by making a failure there an error rather than a silent `false`.

### A pre-existing ambiguity the fix surfaced

`TrackedFinding.source` used the bare node name, so an adversarial pass's `review` finding and a `review.json` finding
both carried `'review'`. A write aimed at one hit the other and failed with an ENOENT on a file that task does not have.
The label now names the record (`review` versus `adversarial-verify` / `adversarial-review`), so `applyDisposition` picks
the path from the label instead of guessing between two.

### One more accountability gap, on the `record` path

`adversarial finding add` was given an obligation for a terminal finding; `adversarial record` opens the batch but created
none, so a finding that arrived in the verdict had nothing that could ever answer it. The record path now persists one too.
