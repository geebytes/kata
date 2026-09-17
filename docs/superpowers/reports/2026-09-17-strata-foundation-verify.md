# strata-foundation — verification report (does not pass)

**Date:** 2026-09-17
**Change:** `openspec/changes/strata-foundation` (phase `verify`)
**Scope:** full verification of the five capabilities the change declares.
**Verdict:** **NOT PASSING.** 16 of 19 requirement scenarios are satisfied with evidence; three are not, and one of
them is a spec-versus-product contradiction that needs a decision rather than a fix.

This report is deliberately not registered through `comet state set … verification_report` and the verify guard was
not applied: the structural checks would pass on the strength of this file's existence, and the substance does not.

## Evidence collected

| Check | Command | Result |
|---|---|---|
| Type check | `node_modules/.bin/tsc --noEmit` | clean (exit 0) |
| Unit, property, golden and e2e suite | `npm test` (vitest run) | 423 passed / 423, 43 files |
| Build | `npm run build` (recorded by the build guard) | passed, `dist/cli.js` 463.2 kb |
| Phase guard, build | `comet classic guard strata-foundation build` | 14/14 checks passed, applied |
| Phase guard, verify | `comet classic guard strata-foundation verify` | 3/4 — only `verification_report exists` is pending |

The source-level mapping behind the table below comes from the architecture review of `kata/src/` performed on
2026-09-16 (`kata/` is a standalone repository; the review document lives in the host project's
`.rpiv/artifacts/architecture-reviews/`).

## Capability verdicts

### workflow-runtime — satisfied

| Requirement / scenario | Evidence |
|---|---|
| Resumable task lifecycle / Resume an interrupted task | `src/core/state.ts` appends append-only state events and projects `current-state.json` atomically; `src/core/recovery.ts` replays legal chain links and rewrites the projection. Covered by `tests/unit/state.test.ts`, `tests/unit/recovery.test.ts`, `tests/e2e/workflow-resume.test.ts`. |
| Guarded phase transitions / Verify cannot be skipped | `isLegalPhaseTransition` accepts only the next phase; `assertAcceptanceIds` and `assertDistillGates` gate entry to `implement` and `distill`. Covered by `tests/unit/state.test.ts` and `tests/property/`. |
| Slash-command workflow / Tool-neutral command behavior | `src/adapters/manifest.ts` renders one normalized command manifest per platform. Covered by `tests/golden/adapters.test.ts`. |
| Protected workflow facts / Implementer attempts to weaken acceptance | Enforced by the emitted hook guard (`renderHookGuardScript` in `src/adapters/ownership.ts`) plus `src/policy/permissions.ts` role scopes. Covered by `tests/unit/installer.test.ts` (spawns the generated guard) and `tests/unit/permissions.test.ts`. **Caveat:** the typed policy module has no production caller and has drifted from the emitted script (review L1-04). The scenario holds on the hook path; the implementation duplication does not. |

### platform-skills — satisfied

| Requirement / scenario | Evidence |
|---|---|
| Capability-based adapters / Partial platform support | `src/adapters/platforms.ts` declares per-platform capabilities; `discovery.ts` reports unavailable capability names. Covered by `tests/unit/installer.test.ts`. |
| Safe installation and update / User customization during update | Ownership/hash manifest, conflict reporting and dry-run in `src/adapters/ownership.ts`. Covered by `tests/unit/installer.test.ts`. |
| Generic fallback adapter / Unsupported tool | Generic platform definition with `.kata/skills/<id>.md` projection. Covered by `tests/golden/adapters.test.ts`. |

### model-policy-and-evidence — 3 of 4 satisfied, 2 gaps

| Requirement / scenario | Verdict | Evidence |
|---|---|---|
| Immutable evidence envelopes / Evidence does not match the diff | satisfied | `src/quality/evidence.ts` records `diffHash` and `checkFreshness` marks mismatched evidence stale; Judge rejects it. Covered by `tests/unit/evidence.test.ts`, `tests/e2e/quality-gates.test.ts`. |
| Independent Judge protocol / Missing boundary test | satisfied | `src/quality/judge.ts` emits per-acceptance PASS/FAIL with evidence references and repair scopes, and reads evidence rather than the working tree. Covered by `tests/e2e/quality-gates.test.ts`. |
| Bounded repair loop / **Repair changes unrelated files** | **not satisfied** | `enforceRepairScope` and its `DiffSummary`/`DiffBudget` inputs exist in `src/quality/repair.ts` and are covered by `tests/unit/repair.test.ts` and `tests/e2e/quality-gates.test.ts`, but **no production module calls them** — the runtime never computes a diff summary, so a repair that touches unrelated files is not blocked. The requirement's other half (repair only for failed acceptance conditions, always back to hard verification) *is* implemented in the repair entry points and `state.ts`. Tracked as review finding **L3-05**; the decision taken on 2026-09-17 is to wire the gate. |
| **Vendor-neutral model policy / Economy implementation fails twice** | **not satisfied — contradicts the product's stated policy** | No implementation exists in `src/`: there is no model-tier, budget or escalation module (`src/policy/` contains only `permissions.ts`), and no test file. The change's capability spec requires the runtime to route roles through capability tiers and escalate, while the product now states the opposite in its own contract: "Kata 不配置、不路由也不记录宿主平台模型" (`AGENTS.md`, the generated skill text, the delegation prompt and the pause instructions all repeat it). Escalation survives only as a metric field (`src/eval/metrics.ts`). |

### governed-wiki — satisfied

| Requirement / scenario | Evidence |
|---|---|
| Provenance-aware Wiki records / Source is missing | `src/wiki/record.ts` + `drift.ts` hash sources and mark records stale. Covered by `tests/unit/wiki-governance.test.ts`. |
| Candidate-only distillation / Failed task summary | Candidates are written only from Judge-PASS tasks (`src/wiki/provenance.ts`). Covered by `tests/unit/wiki-governance.test.ts`. |
| Drift and conflict blocking / Wiki contradicts an approved ADR | `src/wiki/conflict.ts` routes conflicts to `needs-clarification`. Covered by `tests/unit/wiki-governance.test.ts`. |
| Task-scoped Wiki context / Critical implementation rule | `src/core/context.ts` builds the authoritative manifest and excludes stale/candidate records with read-source warnings. Covered by `tests/unit/wiki-governance.test.ts`. **Caveat:** the wiki module's own twin, `wiki/context.ts:selectAuthoritativeContext`, is the implementation the governance suite exercises while production uses `core/context.ts` (review L4-01), and the context manifest re-declares a lossy `WikiRecord` (review L2-05). |
| Explicit promotion / Unreviewed candidate | `src/wiki/promotion.ts` refuses to promote anything that is not a candidate. Covered by `tests/unit/wiki-governance.test.ts`. **Caveat:** promotion trusts the caller's approval event and never re-checks the validation task or source hashes (review L4-06). |

### evaluation-and-release — 2 of 3 satisfied, 1 gap

| Requirement / scenario | Verdict | Evidence |
|---|---|---|
| Cross-platform compatibility fixtures / Adapter manifest comparison | satisfied | `tests/golden/adapters.test.ts`; installer compatibility in `tests/unit/installer.test.ts`, `tests/e2e/`. |
| Release safety / Update would overwrite user files | satisfied | Conflict reporting and non-destructive update in `src/adapters/ownership.ts`, covered by `tests/unit/installer.test.ts`. |
| **Workflow evaluation / Cost regression** | **not satisfied** | `src/eval/runner.ts:runEvaluation` builds every `EvaluationRun` from the manifest's declared fields (`acceptancesPassed = expectedAcceptances − expectedRepairs`, `repairCount = expectedRepairs`) and sets `tokensUsed`, `costCredits` and `latencyMs` to `0`; it executes no fixture, and `checkReleaseGates` then reports pass/fail from those numbers. Cost and latency therefore cannot be measured, and the published `docs/evaluations/2026-07-11-app-dogfood.md` figures are arithmetic on `evals/dogfood-app.json`. Tracked as review finding **L6-01**; the decision taken on 2026-09-17 is to make the harness execute its fixtures or to demote the artifact to a declared baseline. |

## Classification of the failures

1. **`enforceRepairScope` unwired (L3-05)** — missing wiring, not a design change. The gate, its types and its tests
   exist; nothing calls them on a live path.
2. **Evaluation harness does not measure (L6-01)** — implementation gap against a requirement that explicitly says
   "SHALL measure … token/cost usage, latency".
3. **Vendor-neutral model policy** — **spec drift requiring a user decision.** The delta spec and the Design Doc still
   specify a capability the product has since removed on purpose. The verify skill forbids choosing among the
   handling options automatically (record the divergence in the design doc / return to build and amend the Design Doc
   and delta spec / confirm the deviation is acceptable and let archiving mark the design doc superseded).

## Recommendation

Do **not** archive `strata-foundation` on this report. Two of the three gaps (1 and 2) are already-accepted
architecture-review findings whose fixes are either decided or in flight; if they land first, a re-run of this
verification should pass without weakening anything. The third needs a decision about the capability spec itself,
which is the only item that cannot be resolved by implementing code.
