# A costly attempt is visible while the round runs (§18.7's first question)

§18.7 asked whether `toolUses` could be recorded **per attempt** rather than per pass, "so a costly hypothesis is visible
while it runs". It can, and the answer matters because of §18.2's mechanism: cost grows with the square of the turns, so
the *last* attempts of a round are the most expensive ones — and the pass total arrives exactly when that decision can no
longer be used.

## What landed

- **`toolUses` on `AdversarialAttempt`**, and on the heartbeat line. The recorded attempt makes the cost curve available in
  the record; the heartbeat makes it available **mid-round**, which is the point.
- **`adversarial note` accepts it on the same line it already writes.** The number rides along with the heartbeat write
  rather than needing its own invocation — the §12 trap, applied to this field: a measurement that costs a turn would eat
  more than it explains.
- **The brief asks for it**, in the shape it hands out, and re-prints earlier attempts with their counts. A reviewer that
  is not told to count is not measurably any cheaper.
- **Optional throughout.** A reviewer that does not count is not blocked — it is merely less measurable, which is the
  honest failure mode for a diagnostic.

## The two questions that remain open, and why

§18.7 also asks whether the reading set can be derived or must be curated (derived here, bounded to 40, and §14's own
measurement said 79.5% of owned paths are matrix-declared, so the derivation has coverage), and whether **any host reports
tokens at all** — to which the answer today is that `toolUses` is the only portable signal, since kata cannot see the host's
token counter. That second one is not answerable from inside this repository.

## Verification

`tests/unit/adversarial-progress.test.ts` gains two cases: a heartbeat attempt records its tool uses (readable by
`progressSummary` mid-round), and the recorded-attempt schema accepts an attempt both with and without a count — asserted
by validating real records through the same validator the store uses. Full kata suite: 779 tests in 96 files; `tsc` clean.
