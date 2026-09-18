# Repair batches (C1 of the pass-cost proposal)

The measurement the mechanism exists for: **three of six fix→seal→pass cycles in one day existed only because findings
were repaired one at a time.** Every repair produced a new revision, and every new revision invalidated *both* nodes'
passes — so the second batch paid a full re-verification for work the first batch had already discovered.

## What landed

`src/quality/repair-batch.ts` and `repair-batch.json` (schema-validated, written under the task lock):

- **`openRepairBatch` extends the open batch** rather than opening a second. That is the whole saving: findings that
  arrive while a batch is open join it, so the seal and the delta round happen **at batch close** instead of per finding.
- **`closeRepairBatch` refuses while a terminal finding it opened for is unaccounted.** This is the invariant the proposal
  named and §15 protects: closing a batch is the moment the platform stops asking for a re-verification, so it is exactly
  where a silently dropped obligation would become invisible. A finding is accounted for when it was repaired
  (`answered`), explicitly deferred **with a reason**, or no longer reported by a re-run (`stillOpen`).
- **`batchSaving` counts rather than estimates** — `N` findings in one closed batch means `N-1` seals not performed, read
  from the batch record itself.

## What it deliberately does not do

It does not decide when to open or close a batch. That is the author's decision, and the platform's job here is to make
the batch visible, count what it saved, and hold the same severity gate as before — `blocking` and `major` are not
dispositionable, and a batch cannot be a way around that.

## Verification

`tests/unit/repair-batch.test.ts` (5): a second `open` extends rather than duplicates; a close with an unaccounted `major`
is **refused and names it**; a close succeeds when every terminal finding was repaired, deferred with a reason, or is no
longer reported; `batchSaving` computes three findings in one batch as two seals avoided; and a malformed batch file is an
error rather than "no batches".

Full kata suite: 746 tests in 90 files; `tsc` clean; `dist/cli.js` rebuilt.
