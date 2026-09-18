# `record` reads the brief it was given, not a flag

Follow-up to binding a pass to the **issued** brief (D2). Two things still assumed the old design, where the gate
re-derived the brief and the caller restated its inputs:

- `record` took `--since` and re-computed the change surface from it. But a delta round's surface was **fixed when kata
  issued the brief**, and re-deriving it at record time lets the two disagree — the caller could name a base the brief was
  never about, and the gate would then be checking a scope the reviewer never saw.
- The printed `recordCommand` advertised `--since`, and the skill text told the reader to pass it — an instruction for a
  command that no longer needs it, and an invitation to restate what the brief already decides.

## What changed

- `record` takes **no `--since`**. Its scope comes from `scopeForIssuedBrief`: the brief that was answered knows whether it
  was a delta, and from which base (`since` is stored on the issued copy at `issueAdversarialBrief`).
- The printed `recordCommand` is now the three things a reviewer actually supplies: the result file, `--elapsed-ms` and
  `--tool-uses`.
- The verify/review guidance says to put the brief's **hash** on the result, that the scope comes from that brief, and that
  nothing hand-writes it — while keeping the `delta_stale` rule the gate enforces.

## Verification

- `tests/unit/adversarial-procedure.test.ts` now asserts the new contract (the hash, the scope-from-brief sentence, the
  `delta_stale` rule) rather than the removed flag.
- `tests/unit/adversarial-brief-binding.test.ts` drives a full round then a delta round through the **CLI**, recording the
  second against its delta brief's hash — the path the two-round measurement depends on.
- Full kata suite: 740 tests in 88 files; `tsc` clean; `dist/cli.js` rebuilt.
