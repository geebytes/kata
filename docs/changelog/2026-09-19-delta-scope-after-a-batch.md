# The round after a closed batch measures what the repair changed (C4)

The measurement: delta rounds ran **11–18 min against 15–35 min** for full-scope rounds, and the mechanism already existed —
it was simply never the default, so a bounded repair was followed by a full re-derivation of everything it had not touched.

## What landed

`defaultBriefScope` answers what scope the next round gets, **and states why**:

- **A repair batch that closed on a revision** ⇒ the brief is delta-scoped from that revision. That is the case the
  measurement was about: the round after a bounded repair should measure the repair.
- **No closed batch** ⇒ full, because there is nothing to narrow against. (The first round after intake is exactly this.)
- **A batch that closed without naming a revision** ⇒ full, with that reason — not a delta against a guessed base.
- **An explicit `--since`** still wins, and says so.

The reason is reported through `AdversarialBrief.scopeReason` and printed by `adversarial brief`, so a delta default is
never something a reader has to infer; and a narrowing that happened for the wrong reason is distinguishable from one that
did not happen at all.

## What it deliberately does not do

It does not narrow at the freeze point: `--frozen` and the frozen-tier gate still require everything, and the full-scope
cases above are the ones the design named. It also does not invent a base — a batch with no revision falls back to full
rather than measuring against whatever revision happens to be current.

## Verification

`tests/unit/repair-batch.test.ts` gains four cases: full with its reason before any batch closes; delta from the batch's
base revision after it closes; an explicit `--since` winning over the batch default; and the fallback when the batch named
no revision. Full kata suite: 773 tests in 95 files; `tsc` clean; `dist/cli.js` rebuilt.
