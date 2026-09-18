# The two defects the pass-cost proposal exposed, fixed

The addendum to `docs/design/2026-09-18-what-an-adversarial-pass-costs.md` recorded two defects, reproduced while recording
a pass against a task that carried deferred findings. Both were worked around at the time rather than fixed; this fixes
them, with the reproduction as a test.

## D1 — a later pass resurrected every deferral

The dispositions live on the **adversarial record**, and recording a pass replaces that record. So the five deferred
findings became `open` again, and `kata-cli findings defer --id <old-id>` then failed — the ids no longer existed. F1's
whole promise is that a deferral stays visible across passes.

**Fix:** `writeAdversarialRecord` reads the record it is about to replace and **carries a decision forward** onto the
finding of the same id when the new record does not state one itself. A decision belongs to the finding, not to the pass
that happened to report it.

## D2 — recording a pass invalidated the brief it answered

The brief embeds the known/deferred section, so replacing the record **changed the brief text** — and the gate validates a
record by recomputing that brief's hash. The record was therefore rejected with `brief_mismatch`, and re-fetching could not
recover the old hash: the operation being performed was the one that mutated the thing being verified.

**Fix, and the rule it generalises to:** the section is now derived **only** from `review.json`, the durable record, and
never from the pass's own record. **A brief may contain only state that recording a pass cannot change.** That is a
sharper statement of what a brief is — the question the pass answers — and it removes the second-order coupling that made
`brief_mismatch` reachable on every task with a deferral.

## Verification

`tests/unit/finding-disposition.test.ts` now carries the two reproductions:

- **D1:** defer a finding reported by one pass, record a second pass that re-reports it and says nothing about its
  disposition — the finding is still `deferred`, with its reason, and still appears in `deferredFindings`.
- **D2:** build the brief, record a pass that reports a finding and disposition it, build the brief again — the text and
  the SHA-256 are **identical**.

Full kata suite: 710 tests in 84 files; `tsc` clean; `dist/cli.js` rebuilt.
