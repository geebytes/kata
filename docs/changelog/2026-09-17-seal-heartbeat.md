# The seal writes a heartbeat

Monitoring a seal meant `pgrep`-ing for a process — which false-positives on the agent's own command line (measured: 20
minutes of waiting on a seal that had already finished) — or waiting blind with no way to tell a slow check from a
wedged one.

Every seal now appends one JSON line per check transition to `.kata/tasks/<task>/seal-progress.jsonl`:

```json
{"type":"quality_check_progress","check":"test","state":"started","at":"2026-09-17T14:31:02.114Z"}
{"type":"quality_check_progress","check":"test","state":"passed","exitCode":0,"elapsedMs":612431,"at":"2026-09-17T14:41:14.545Z"}
{"type":"seal_complete","at":"2026-09-17T14:41:15.002Z","checks":15}
```

It records `elapsedMs` from each check's own start, so "still running" and "finished after 10 minutes" are distinguishable
without a process table. Writing failures are swallowed on purpose: the log is an observation, and a seal that died
because its log was unwritable would be worse than one nobody can watch.

## Verification

- `tests/e2e/seal-cost-and-revision-identity.test.ts` — a seal over two checks writes their `started`/`passed`
  transitions with timestamps and closes with `seal_complete`. Full kata suite: 578 tests in 67 files; `dist/cli.js`
  rebuilt.
