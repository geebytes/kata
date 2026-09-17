# The evaluation harness executes its fixtures

The second gap the `strata-foundation` verification found. `runEvaluation` produced a report with release-gate
verdicts without running anything: every `EvaluationRun` was built from the manifest's own declared fields
(`acceptancesPassed = expectedAcceptances − expectedRepairs`, `repairCount = expectedRepairs`), `tokensUsed`,
`costCredits` and `latencyMs` were hardcoded to `0`, and `checkReleaseGates` then reported pass/fail from those
numbers. The published `docs/evaluations/2026-07-11-app-dogfood.md` was therefore a restatement of
`evals/dogfood-app.json`.

## What the harness does now

Each fixture is executed through the product's own entry points and the run records what came out:

- open and design the fixture task, write its owned file, and seal a revision with a passing check
  (`runCommand('build', …)`);
- for fixtures that declare repairs, move the workspace past the sealed revision, let Verify fail on the now-stale
  evidence, take the repair entry the product records, and re-seal;
- read the sealed evidence and ask the Judge for its acceptance results;
- count repair rounds from `state-events.jsonl` (`to: implement` from `hardVerify`/`review`/`judge`) rather than from
  the manifest;
- measure wall-clock latency per fixture and read the fixture root's Wiki records.

`EvaluationRun` now carries the observation next to `expected: { acceptances, repairs, escalations }`, so a report
shows both what was declared and what happened, and a fixture that cannot be opened, designed, sealed or repaired
fails the run instead of contributing an invented row.

## What is deliberately not measured

`tokensUsed`, `costCredits` and `escalationCount` are exported as `unmeasuredMetrics` and reported in
`report.unmeasured`. Model choice, cost and retries belong to the host platform — the same decision that removed the
vendor-neutral model policy — so the harness states that it has no data instead of reporting a zero a reader could
mistake for a measurement. The corresponding release gates (escalation rate, cost) therefore pass without evidence,
and the observed report says so. The `evaluation-and-release` capability spec was amended to match: it now requires
the harness to measure acceptance pass rate, repair count, latency and Wiki counts, and to report unmeasurable
metrics as explicitly unmeasured.

## The documented command exists

`docs/operations.md` documented `kata-cli eval evals/my-manifest.json` while `src/cli.ts` had no `eval` command. It
does now, with `--persist <report.json>` for the full report and `--root <path>` for a specific workspace, and the
operations guide's metric table distinguishes what is measured from what is not.

## Evidence

`kata-cli eval evals/dogfood-app.json --persist docs/evaluations/2026-09-17-app-dogfood-observed.json` executed all four
fixtures (open → design → build → judge, with a real repair round for `df-implement` and `df-repair`): acceptance
pass rate 100% (7/7), repair rate 0.50 (2 repair rounds recorded in the state logs), 97 ms average latency, all five
release gates passing, `unmeasured` listing the three model-owned metrics. The observed summary is committed as
`docs/evaluations/2026-09-17-app-dogfood-observed.md`, and the 2026-07-11 report now carries a note that its figures
were declared expectations.

## Verification

- `tests/unit/eval-runner-observations.test.ts` — a passing fixture records its executed steps (`open`, `design`,
  `build`, `judge`), two acceptance results, zero repairs and non-zero latency; a repair fixture records the repair
  round the state log contains; a fixture that cannot be executed rejects instead of producing a run.
- `tests/e2e/dogfood-config.test.ts` now exercises the same manifest end to end and prints measured metrics.
- Full suite: 435 tests in 45 files, all passing; `tsc --noEmit` clean; `dist/cli.js` rebuilt.
