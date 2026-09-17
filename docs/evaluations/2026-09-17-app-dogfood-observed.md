# Kata Dogfood Evaluation — observed run

**Date:** 2026-09-17
**Manifest:** `evals/dogfood-app.json`
**Command:** `kata-cli eval evals/dogfood-app.json --persist docs/evaluations/2026-09-17-app-dogfood-observed.json`

Every fixture below was executed: the task is opened and designed, a revision is sealed with a passing check, the
Judge reaches its acceptance results for that sealed evidence, and fixtures that declare repairs are driven through a
real repair round (move the workspace past the sealed revision → Verify FAIL on stale evidence → repair entry →
re-seal). Repair rounds are counted from `state-events.jsonl`, not from the manifest.

| Fixture | Executed | Declared acceptances | Judge PASS | Repair rounds | Latency |
|---|---|---:|---:|---:|---:|
| df-open | open → design → build → judge | 2 | 2 | 0 | 69 ms |
| df-implement | open → design → build → verify:FAIL → repair → judge | 2 | 2 | 1 | 130 ms |
| df-verify | open → design → build → judge | 2 | 2 | 0 | 65 ms |
| df-repair | open → design → build → verify:FAIL → repair → judge | 1 | 1 | 1 | 124 ms |

| Metric | Measured |
|---|---|
| Acceptance pass rate | 100.0% (7/7) |
| Repair rate | 0.50 per task (2 repairs / 4 fixtures) |
| Average latency | 97 ms per fixture |
| Wiki rejection rate | 0% (no records in fixture roots) |
| Release gates | all 5 passed |

**Not measured, by design:** `tokensUsed`, `costCredits`, `escalationCount`. Model choice, cost and retries belong to
the host platform — Kata does not configure, route or record models — so the report lists these under `unmeasured`
rather than reporting a zero that a reader could mistake for a measurement. The escalation-rate and cost release
gates therefore pass vacuously and should be read as "no data" until a host-side harness supplies them.

The earlier report `2026-07-11-app-dogfood.md` predates this harness: its figures were the manifest's declared
expectations restated as metrics, with cost, tokens and latency hardcoded to zero.
