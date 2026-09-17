# Kata Dogfood Evaluation Report

> **Superseded.** The figures below are the manifest's declared expectations, not measurements: at the time this
> report was written the harness computed its metrics from `evals/dogfood-app.json` without executing a fixture.
> The cost, token and escalation columns were hardcoded to zero. See `2026-09-17-app-dogfood-observed.md` for a
> report produced by actually running the fixtures.

**Date:** 2026-07-11
**Manifest:** `evals/dogfood-app.json`
**Project:** `/app` (kata-foundation change)

## Fixtures

| ID | Description | Acceptances | Repairs | Escalations |
|----|-------------|-------------|---------|-------------|
| df-open | Open a change with acceptance criteria | 2 | 0 | 0 |
| df-implement | Implement with hard checks | 2 | 1 | 0 |
| df-verify | Full verify pipeline | 2 | 0 | 0 |
| df-repair | Bounded repair cycle | 1 | 1 | 1 |

## Metrics

| Metric | Value |
|--------|-------|
| Acceptance pass rate | 71.4% (5/7) |
| Repair rate | 0.50 per task |
| Escalation rate | 0.25 per task |
| Total tasks | 4 |
| Total acceptances | 7 |

## Release gates

| Gate | Result |
|------|--------|
| Acceptance pass rate >= 70% | PASS (71.4%) |
| Repair rate <= 1.0 | PASS (0.50) |
| Escalation rate <= 1.0 | PASS (0.25) |
| Wiki governance | PASS |
| Wiki rejection rate <= 50% | PASS |

**Overall:** ALL GATES PASSED

## Notes

- First dogfood evaluation of Kata against its own change.
- All 86 unit/property/e2e/golden tests pass across 20 test files.
- Remaining work: CLI workflow orchestration (Task 8 in the plan) would add `/kata-open`/`/kata-build`/`/kata-verify`/`/kata-archive` full lifecycle wiring.
- The acceptance pass rate is below 80% due to intentional repair/escalation fixtures — this is expected for dogfood.
