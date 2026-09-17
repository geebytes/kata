# The runtime refresh is bounded, asynchronous, and reports each stage

The architecture review's L0-04 finding: `runRuntimeRefresh` ran CodeGraph `sync` and `index` through `execFileSync`
inside the asynchronous update path, so the refresh blocked the event loop with no cancellation, and only the Comet
update had a timeout. Every failure was reported as `success: false`, which collapsed three different situations — a
stage that could not run, a stage that ran and failed, and a stage that was cut off — into one bit, and the policy
("the update proceeds regardless") was implicit in the fact that nothing was awaited.

## What changed

- **Asynchronous and bounded.** The CodeGraph stages go through the process facility (`runProcess`), each bounded by
  `KATA_RUNTIME_REFRESH_TIMEOUT_MS` (default 30 s, configurable 1–120 s) — the same knob the Comet update uses. The
  previous per-stage budget was a hardcoded 60 s that nothing documented; the refresh is an optional best-effort step, so
  being stricter by default and configurable is the better trade, and the outcome now says `timed_out` instead of hanging
  the event loop.
- **Per-stage outcomes.** `runtimeRefresh.stages[]` records, for each of `comet`, `codegraph-sync` and
  `codegraph-index`: `status`, `durationMs`, whatever the stage printed, and a `detail` for anything other than success.
  The three non-success statuses are decided structurally, without matching CodeGraph's own wording:
  - `skipped` — the binary could not start (`spawn_failed`), so there was nothing to run;
  - `timed_out` — the child outlived its own budget (the facility's timeout);
  - `failed` — it ran and exited non-zero.
- **The policy is stated.** `runtimeRefresh.policy === 'best-effort'`: no stage failure aborts the update. The two
  CodeGraph stages are independent and run in order (`sync`, then `index`); a failure in one does not skip the other,
  because either is useful on its own.
- **The report says when it was partial.** The human rendering names the stage that did not complete, its status and its
  detail, and adds that platform installation and updates were unaffected — so a best-effort refresh never reads as a
  clean run.
- **The compatibility surface is unchanged.** `runtimeRefresh.comet`, `.codegraphSync` and `.codegraphIndex` keep their
  `{ success, … }` shape for the update report and `--json` consumers; the stages are added beside them.

## Verification

- `tests/unit/installer.test.ts` — with `STRATA_CODEGRAPH_BIN` pointed at a path that does not exist, the update reports
  `policy: 'best-effort'`, both CodeGraph stages as `skipped` with a detail naming the missing binary, and a recorded
  duration for every stage. The existing `--json` test still asserts the per-stage `success` fields.
- Exercised end to end: `kata-cli update --json` now reports `comet timed_out` (with its detail) alongside the CodeGraph
  stages instead of one opaque failure.
- Full suite: 543 tests in 63 files, all passing; `tsc --noEmit` clean; `dist/cli.js` rebuilt.
