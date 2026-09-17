# Check concurrency is opt-in: a seal must not cause the failures it reports

L3-02 gave the seal bounded concurrency for evidence collection (up to `min(4, availableParallelism - 1)` checks at
once). In the kata repository that was harmless — its checks are hermetic temp-directory tests. In this workspace it
produced a false accusation.

## What was measured

A seal of the k2skills task ran **four to five pytest processes at the same time** — `lint`, `typecheck`, the project's
full suite (`make test`) and two acceptance-matrix checks — reconstructed from the run's own progress events, which
interleave `started`/`passed` for different checks throughout. Three of those checks failed with `exit=1`, and re-running
them afterwards **alone** showed the cause:

- `tests/test_partitioned_media_compile_e2e.py` passes on its own (`1 passed in 4.22s`) and fails when run after
  `tests/test_package_quality.py` in the same process.
- These integration checks `DROP TABLE` and recreate rows in **one shared PostgreSQL database**.
- `tests/test_ocr_asset_export.py` + `tests/test_k3_media_main_path.py` failed with
  `ValueError: content item source must exist and be active` — rows another run had dropped.

So the failures were caused by the seal's own parallel execution, not by the change under test. A seal that reports
failures it created is worse than a slow one: it sends the author to repair code that is fine, and it makes the evidence
untrustworthy.

## What changed

- **`checkConcurrency()` returns 1 by default.** Concurrency stays available — `KATA_CHECK_CONCURRENCY=<n>` — for
  projects whose checks are known to be independent. The seal cannot know what checks share (a database, a port, a
  global cache, a fixture directory), so the safe default is the one that cannot corrupt the verdict, and the project
  that knows better says so.
- `tests/e2e/seal-cost-and-revision-identity.test.ts` — the concurrency test now opts in explicitly, and a new test pins
  the default: two checks where the second writes a witness file, and the first records whether it existed when it
  started. Serial execution must record `false`.

## Relationship to the rest of L3-02

The other three parts of that finding stand and are unaffected: evidence is retained per revision instead of deleted,
an unchanged seal reuses the revision and its evidence, and revision identity is content-derived. Only the parallelism
default changed, and it changed because of evidence rather than preference.

## Verification

- `tests/e2e/seal-cost-and-revision-identity.test.ts` — six tests: the opt-in concurrency case, the serial default, reuse
  of an unchanged revision, archiving of superseded evidence, content-derived revision identity.
- Full kata suite: 565 tests in 67 files, all passing; `tsc --noEmit` clean; `dist/cli.js` rebuilt.
