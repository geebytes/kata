# Experiment: does an early emit deadline make a pass produce a record?

## The measurement this tests

Across every dispatched round on this line (62 rounds with at least one tool call), **34 returned a record and 28 did not**, and the 28 are
not rounds whose record was lost — they are rounds that wrote almost nothing:

```
  141 chars / 165 tools   aa183e24   ← one whole round, ~50 minutes
  172 chars /  48 tools   488d9a71
  599 chars /  58 tools   3b3db848   ← the round dispatched with the gate's exact refusal in its prompt
 1131 chars / 141 tools   73958595
 2648 chars / 128 tools   bf83bac6
```

against producing rounds at `11,232 / 97` and `29,621 / 116`. A round that reads 165 times and emits 141 characters has not lost a record; it
never produced one, which is why `salvage` correctly reports *no complete record* rather than a partial one.

## Hypothesis

The blocker is the **cost the pass believes a record has**. The brief asks for a complete pass — hypotheses with methods and observations,
attempts with evidence, findings with three fields — and a pass that does not yet have all of that keeps reading until it does. The reading has
no end, so the record is never emitted.

**Refuted if** a pass told to emit by tool call 25 still produces none, or overruns the deadline without emitting.

## Design

One round, on `review-record-integrity` — the change whose record rate is **0 of 8**, so a single record is a result distinguishable from noise.

- revision `revision-324fa316cf79954a`, brief `f081e0b5877a8aaea660c06239bb6ba874718eb41459b8086b390ee5f3d652d5`, mode `cold`
- Treatment, stated in the dispatch prompt and nowhere else: **"Emit a record by your 25th tool call. Emit it whether or not you feel
  finished."** Plus the two permissions the brief already grants and the pass may not believe: **a one-hypothesis record is a complete record**,
  and **emitting more than once costs nothing** ("the last record you emit is the record").
- Baseline: the eight prior rounds on this change, 48–165 tool calls, zero records.

## Prior evidence that must be read before believing a positive result

The envelope *has* been tighter before: its first values were `maxToolCalls: 48` and `maxWallMs: 900_000`, lifted from a design document's
illustrative JSON and never calibrated. Measured consequence (2026-09-22): an independent pass executed honestly under that envelope was killed
at the wall limit after 15 minutes having made **70 tool calls** over 32 turns, still working — it **overran a 48-call limit by 46%**, and
`budget_exhausted` is a refused verdict, so a strict review was structurally impossible. The envelope was raised to 215 calls and 66 minutes
because a limit below the cost of a real round does not stop a runaway, it refuses honest work.

So the two outcomes this experiment can produce are both informative:

- **A record lands** → the deadline works where a numeric envelope did not, because it is a *deadline* rather than a budget: it says when to
  write, not when to stop reading.
- **No record, or an overrun** → the lever is not the budget's size, and the cause is the pass's stopping behaviour, measured a second time at a
  different number.

## Measurement after the round

Tool calls made before the first record-shaped message; total tool calls; the record's `hypotheses`/`findings` counts if it lands; and whether
`kata-cli adversarial record` accepts it.


## Result: the deadline produced a record — the first one this change has ever had

| | baseline (8 prior rounds) | treatment (1 round) |
|---|---|---|
| records | **0** | **1** ✓ |
| tool calls | 48 – 165 | **36** (deadline was 25 → **+44%**) |
| assistant text | 141 – 2,648 chars | 1,399 chars before the record, then the record itself at **16,237** |
| hypotheses | — | **6, claiming AC-1 … AC-5 — none missing** |
| findings | — | 3 (1 major, 2 minor) |
| `kata-cli adversarial record` | — | **`status: recorded`** |

**The pass said so out loud**, which is the part that matters: *"I've reached my tool-call deadline. Emitting the record now with what I have
established."* It had been telling me for 36 calls that it needed to verify two more things; the deadline is what turned that into a record.

**And it overran the deadline by 44%** — 36 calls against a stated 25. That number is worth keeping because the envelope has been overrun by the
same factor before: the retired 48-call limit was overshot at **70 calls (+46%)**. A pass told "stop at N" stops at about **1.45 × N**, which is
within a few percent of `REVIEW_HEADROOM = 1.5` — the factor that file already applies over its measured costs, arrived at independently.

**So the lever is not the budget's size, it is the instruction to emit.** The envelope has always been a number the pass may cross; the deadline
is an action it must take. Both are prose in the same brief, and only one of them produced a record on a change whose rate was 0 of 8.

## What the record itself found, and the second wall behind it

The record's findings are real and one is major (`rri-f1`: the brief's finding-history table renders a finding's class under two different
vocabularies depending on which store it came from). **But the gate refuses it for a different reason**:

```
status: recorded | gate satisfied: false | reason: executor_unavailable
```

`executor_unavailable` is the fail-closed half of the execution-control contract: a strict node requires a host that advertises `fresh_context`
and `read_only_fs` **via a receipt**, and this host can offer those as agent properties but has no receipt mechanism, so kata refuses rather than
trusting a self-report. That is architecture #722, and it means `review-record-integrity` is blocked by a **host capability**, not by a record —
and the eight record-less rounds were hiding it, because a change cannot discover which wall it is behind until it stops hitting the first one.

## What this changes for the four blocked changes

`closure-gate`, `kata-gate-surface` and `repair-by-another-author` are blocked by `stale_revision` and, for `closure-gate`, by a record that
claimed only AC-1 … AC-3. **The deadline is the same lever for both halves**: a round told to emit by call N emits a record at about 1.45 N, and
the record it emits claims what it has examined — so the treatment for those three is one round each with the deadline, plus the five criteria
named in the prompt. Whether their records then meet the same `executor_unavailable` wall is the next measurement, and it is cheap because it
happens at the gate rather than after 60 minutes of reading.
