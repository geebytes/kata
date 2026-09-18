# A check declares how much of the machine it takes

Reported by another session, and it matches what this workspace measured earlier: kata's per-check concurrency is a
**disaster** in a repository whose checks are themselves parallel (`-n auto × N checks`). The project-wide switch
(`KATA_CHECK_CONCURRENCY`) cannot express the answer, because the answer differs **per check**: the cheap probes want to
share, the parallel suites want the machine to themselves.

## What changed

- `quality.buildChecks[].weight` (default `1`) — how many slots a check occupies when checks run concurrently.
- The scheduler is now **weighted**: a check whose weight reaches the limit runs alone, and releasing its slots wakes the
  waiters rather than leaving them to re-check on a timer. A weight larger than the limit is clamped, not rejected: asking
  for the whole machine is a legitimate thing for a `-n auto` check to say.
- A nonsense weight (`0`, negative, non-numeric) is rejected **at the config boundary**, where the project can see the
  reason.
- `docs/operations.md` gains *Giving a check its own weight*, with the configuration and the measured rationale.

## Verification

- `tests/unit/check-weight.test.ts` — weight defaults to one and reads a declared value; `checkConcurrency()` stays `1`
  unless the project opts in; with a limit of 2, two weight-2 checks do **not** overlap (the second starts only after the
  first has reached a terminal state) while two light checks still share the budget; the declared weight survives
  resolution into the check the scheduler reads; and an invalid weight fails config loading with its message.
- Full kata suite: 731 tests in 87 files; `tsc` clean; `dist/cli.js` rebuilt.

## Why it is not just an environment variable

`KATA_CHECK_CONCURRENCY` is a per-machine guess made once for every check. The weight is a statement **about a check**:
"this one is already a whole machine". The two compose — the variable sets the budget, the weights decide who fits in it —
and only the second survives being copied to another project, which is where the disaster kept reappearing.
