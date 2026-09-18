# A pass records how long it took, so F2's saving can finally be measured

The finding-lifecycle design's §11 named its largest unverified assumption: that proportional re-verification turns a
10–22 minute pass into 2–3 minutes. It could not be measured because **nothing recorded how long a pass took** — the
number lived in a session's wall clock and was gone when the record was overwritten.

## What changed

- A pass may report `elapsedMs` (`adversarial record --elapsed-ms <n>`), and the record's `scope.kind` is stamped even
  when it is `full`, so both sides of the comparison exist.
- `writeAdversarialRecord` **snapshots the previous pass** into `.kata/tasks/<task>/passes/<node>-<stamp>.json` before
  replacing it. Without this the baseline is destroyed by the very act of recording the improvement.
- `kata-cli adversarial status` reports `deltaSaving`: the previous full pass's elapsed time, the delta pass's, the
  difference and the factor — or `{ measurable: false, note: … }` when no full pass recorded a time, because an invented
  baseline would be worse than an absent one.

## Verification

- `tests/unit/revision-delta.test.ts` — a 20-minute full pass followed by a 3-minute delta pass: the snapshot keeps the
  baseline, the current record keeps the delta's own duration.
- Full kata suite: 652 tests in 81 files; `tsc` clean; `dist/cli.js` rebuilt.

## What is still not measured

The mechanism now exists; the number does not, and cannot until a task runs a full pass and a delta pass with `--elapsed-ms`
reported. That is one task's next two rounds, not another analysis — and the honest state of F2's headline claim remains
**unconfirmed**, as the measurement report records.
