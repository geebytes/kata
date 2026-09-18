# `codegraph index` gets a rebuild budget, not a sync budget

`kata-cli update --force` reported `CodeGraph index 超时` on every run. The cause was not the project and not the working
directory — it was the budget: both CodeGraph stages shared one timeout.

| Stage | Measured on this repository | Budget it had |
|---|---|---|
| `codegraph sync` (incremental) | **0–1 s** | 30 000 ms — fine |
| `codegraph index` (full rebuild) | **35, 36, 37, 45, 46 s** across five runs | **30 000 ms — cut off every time** |

The suspicion that the index "should run under the specific project" does not hold: `codeGraphInvocation(root)` already
returns `cwd: root`, the index lives at `<root>/.codegraph/`, it covers **972 files**, and `.models/` — 116 GB, 433 files —
is excluded by `.gitignore` and is not indexed. So the checkout's size was never the issue; a 30 s ceiling simply cannot
contain a 35–46 s rebuild, which means the stage reported a failure on a healthy project **every single time** — the kind
of line that teaches a reader to ignore the one that would matter.

## What changed

- `codegraphStageTimeoutMs(stage)`: `sync` keeps the refresh budget (incremental, sub-second), `index` gets its own
  rebuild budget — **300 000 ms** by default, overridable with `KATA_CODEGRAPH_INDEX_TIMEOUT_MS`.
- Each stage record carries the budget it actually had (`stages[].timeoutMs`), and the timeout detail reports that budget
  rather than a shared number, so a timeout reads as "this exceeded its budget" instead of "your project is broken".
- Best-effort semantics are unchanged: no stage failure aborts the update.

## Verification

- `tests/unit/codegraph-stage-budget.test.ts` — a fake `codegraph` that sleeps 3 s with a 1 s refresh budget: `sync` is
  `timed_out` **with `timeoutMs: 1000`**, `index` is `completed` **with `timeoutMs: 20000`**; and the default index budget
  is ≥ 300 000 and larger than the refresh budget.
- A real `kata-cli update --json` in k2skills after the fix: `codegraph-index status=completed durationMs=38428
  timeoutMs=300000` (the same run would have been `timed_out` before), `codegraph-sync completed` in 1254 ms.
- Full kata suite: 683 tests in 84 files; `tsc` clean; `dist/cli.js` rebuilt.
