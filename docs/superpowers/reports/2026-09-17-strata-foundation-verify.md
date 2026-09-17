# strata-foundation — verification report

**Date:** 2026-09-17 (re-verified after repair)
**Change:** `openspec/changes/strata-foundation`
**Scope:** full verification of the five capabilities the change declares.
**Verdict:** **PASSING.** All 19 requirement scenarios across the five capabilities are satisfied by the current
implementation. The first pass did not pass; what it found and how each item was closed is recorded below and in
`docs/changelog/2026-09-17-strata-foundation-record-and-verification.md`.

## Evidence collected

| Check | Command | Result |
|---|---|---|
| Type check | `node_modules/.bin/tsc --noEmit` | clean (exit 0) |
| Unit, property, golden and e2e suite | `npm test` (vitest run) | 435 passed / 435, 45 files |
| Build | `npm run build` (recorded by the build guard, 3× across the phases) | passed, `dist/cli.js` rebuilt |
| Evaluation harness | `kata-cli eval evals/dogfood-app.json --persist …` | 7/7 acceptance criteria passing, repair rate 0.50 measured from state logs, all 5 gates passing |
| Phase guard, build | `comet classic guard strata-foundation build --apply` | 14/14 checks passed |
| Phase guard, verify | `comet classic guard strata-foundation verify` | all checks pass (this report registered as `verification_report`) |

The module-by-module mapping below comes from the architecture review of `kata/src/` performed on 2026-09-16; the
two fixes it produced are cited by test name.

## Capability verdicts

### workflow-runtime — satisfied

| Requirement / scenario | Evidence |
|---|---|
| Resumable task lifecycle / Resume an interrupted task | `src/core/state.ts` (append-only events + atomic projection), `src/core/recovery.ts` (replays legal chain links and rewrites the projection). Covered by `tests/unit/state.test.ts`, `tests/unit/recovery.test.ts`, `tests/e2e/workflow-resume.test.ts`. |
| Guarded phase transitions / Verify cannot be skipped | `isLegalPhaseTransition` accepts only the next phase; `assertAcceptanceIds` and `assertDistillGates` gate entry to `implement` and `distill`. Covered by `tests/unit/state.test.ts` and `tests/property/`. |
| Slash-command workflow / Tool-neutral command behavior | `src/adapters/manifest.ts` renders one normalized command manifest per platform. Covered by `tests/golden/adapters.test.ts`. |
| Protected workflow facts / Implementer attempts to weaken acceptance | Enforced by the emitted hook guard (`renderHookGuardScript`) plus the role scopes. Covered by `tests/unit/installer.test.ts` (spawns the generated guard) and `tests/unit/permissions.test.ts`. |

### platform-skills — satisfied

| Requirement / scenario | Evidence |
|---|---|
| Capability-based adapters / Partial platform support | `src/adapters/platforms.ts` declares per-platform capabilities; `discovery.ts` reports unavailable capability names. Covered by `tests/unit/installer.test.ts`. |
| Safe installation and update / User customization during update | Ownership/hash manifest, conflict reporting and dry-run in `src/adapters/ownership.ts`. Covered by `tests/unit/installer.test.ts`. |
| Generic fallback adapter / Unsupported tool | Generic platform definition with a `.kata/skills/<id>.md` projection. Covered by `tests/golden/adapters.test.ts`. |

### model-policy-and-evidence — satisfied

| Requirement / scenario | Evidence |
|---|---|
| Immutable evidence envelopes / Evidence does not match the diff | `src/quality/evidence.ts` records `diffHash` and `checkFreshness` marks mismatched evidence stale; the Judge rejects it. Covered by `tests/unit/evidence.test.ts`, `tests/e2e/quality-gates.test.ts`. |
| Independent Judge protocol / Missing boundary test | `src/quality/judge.ts` emits per-acceptance PASS/FAIL with evidence references and repair scopes, reading recorded evidence rather than the working tree. Covered by `tests/e2e/quality-gates.test.ts`. |
| Bounded repair loop / Repair changes unrelated files | **Satisfied after the fix.** `enforceRepairScope` is now reached from the seal path: during an active repair `cmdBuild` derives the declared scope from the failed acceptance matrix rows, compares it with the paths changed since `HEAD`, and refuses a repair that reached outside it (acknowledgeable with `--allow-out-of-scope-repair`; drift-authorized repairs record no scope and stay unconstrained). Covered by `tests/unit/repair.test.ts` and `tests/e2e/repair-scope.test.ts`. |
| Host-owned model selection / A role reaches its repair limit | The capability was amended to the policy the product implements: the runtime does not configure, route or record the host platform's model choice and stores no credentials, while the role write scopes stay Kata-owned. The gate behaviour the scenario requires — stop and tell the user to choose the model in their own platform — is `trustBoundaryForReason` + `pauseInstructionForBoundary`, covered by `tests/e2e/workflow-resume.test.ts` (the `nextAction` gate assertion) and `tests/unit/workflow-navigation.test.ts`. |

### governed-wiki — satisfied

| Requirement / scenario | Evidence |
|---|---|
| Provenance-aware Wiki records / Source is missing | `src/wiki/record.ts` + `drift.ts` hash sources and mark affected records stale. Covered by `tests/unit/wiki-governance.test.ts`. |
| Candidate-only distillation / Failed task summary | Candidates are written only from Judge-PASS tasks (`src/wiki/provenance.ts`). Covered by `tests/unit/wiki-governance.test.ts`. |
| Drift and conflict blocking / Wiki contradicts an approved ADR | `src/wiki/conflict.ts` routes conflicts to `needs-clarification`. Covered by `tests/unit/wiki-governance.test.ts`. |
| Task-scoped Wiki context / Critical implementation rule | `src/core/context.ts` builds the authoritative manifest and excludes stale/candidate records with read-source warnings. Covered by `tests/unit/wiki-governance.test.ts`. |
| Explicit promotion / Unreviewed candidate | `src/wiki/promotion.ts` refuses to promote anything that is not a candidate. Covered by `tests/unit/wiki-governance.test.ts`. |

### evaluation-and-release — satisfied

| Requirement / scenario | Evidence |
|---|---|
| Cross-platform compatibility fixtures / Adapter manifest comparison | `tests/golden/adapters.test.ts`; installer compatibility in `tests/unit/installer.test.ts` and `tests/e2e/`. |
| Release safety / Update would overwrite user files | Conflict reporting and non-destructive update in `src/adapters/ownership.ts`, covered by `tests/unit/installer.test.ts`. |
| Workflow evaluation / Repair-rate regression | **Satisfied after the fix.** `runEvaluation` executes each declared fixture (open, design, sealed build, a real repair round for fixtures declaring repairs, Judge results for the sealed evidence) and measures acceptance pass rate, repair count from `state-events.jsonl`, latency and Wiki counts; metrics the runtime cannot observe (tokens, cost, escalations) are reported under `unmeasured` instead of as zero, as the amended requirement now states. Covered by `tests/unit/eval-runner-observations.test.ts`, `tests/e2e/dogfood-config.test.ts`, and the observed report `docs/evaluations/2026-09-17-app-dogfood-observed.md`. The documented `kata-cli eval <manifest>` command now exists. |

## Previous attempt and how each item was closed

The first pass of this verification did not pass. It recorded: 16 of 19 scenarios satisfied, and three gaps —
`enforceRepairScope` unwired, an evaluation harness that restated its manifest, and a vendor-neutral model policy
the product had deliberately removed. The first two were closed by the fixes above; the third could not be closed by
code, so the drift decision was taken (amend the documents rather than reintroduce the capability), and the delta
spec, the change's `design.md`, the Design Doc and `proposal.md` now state host-owned model selection.

Two caveats remain on record without blocking this verification, because they are findings of the architecture
review with their own accepted remediations rather than gaps against this change's capability specs:

- the typed policy module `src/policy/permissions.ts` still has no production caller, while the emitted hook guard
  enforces the same rules (review L1-04);
- the wiki module's own context-selection twin (`src/wiki/context.ts`) is exercised by tests while production uses
  `src/core/context.ts` (review L4-01), and promotion trusts the caller's approval event (review L4-06).
