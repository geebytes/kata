---
date: 2026-09-20T09:39:51+0800
author: vforfreedom
commit: 99113df
branch: master
repository: kata
target: "verify/review/TDD quality path: src/workflow + src/quality"
target_kind: module
layer_count: 5
phases: [{ n: 1, title: Evidence-readiness handoff, depends_on: [], blast_radius: on-disk, effort: M }, { n: 2, title: TDD acceptance evidence, depends_on: [1], blast_radius: on-disk, effort: L }, { n: 3, title: Independent-pass charters and delta review, depends_on: [1], blast_radius: public-API, effort: L }, { n: 4, title: TDD vertical contract, depends_on: [2], blast_radius: cross-module, effort: M }]
unresolved_finding_count: 0
status: ready
tags: [architecture-review, kata, verify, review, tdd, quality-gates]
last_updated: 2026-09-20T09:39:51+0800
last_updated_by: vforfreedom
last_updated_note: "Added TDD test-reuse and no-independent-test-authoring constraint."
---

# Architecture review — Kata verify, review, and TDD quality path

This standalone review examines the Kata workflow from TDD-guided build and seal through verify, independent review, judge, and repair. It focuses on responsibility boundaries, duplicated test/check execution, whether verify and review may safely merge, and how unit-level TDD should relate to acceptance and governance gates. The artifact is advisory only; no implementation files are changed.

---

## Conventions

### Finding shape

Each finding records evidence, current state, desired state, proposed improvement, severity, effort, blast radius, class, status, dependencies, and cross-cut tag. Findings are triaged individually before being recorded as accepted, rejected, deferred, or withdrawn.

### Layers (top → down)

| # | Layer | Files / responsibility |
|---|---|---|
| 0 | Public phase contracts and host Skills | `src/workflow/orchestrator.ts`; `.agents/skills/kata-{build,verify,review}/SKILL.md` |
| 1 | TDD, seal, and executable evidence contract | `src/quality/{evidence,claims,check-resolver,project-checks,relevant-checks,acceptance-matrix,evidence-adequacy}.ts`; `src/workflow/{seal-preflight,seal-reads}.ts` |
| 2 | Verify readiness and revision binding | `src/workflow/{revision,verdict-binding}.ts`; `src/quality/{revision-delta,review-scope,code-surface}.ts` |
| 3 | Independent review, Judge, and repair closure | `src/quality/{adversarial,reviewer,judge,finding-*,repair*,repair-obligations}.ts`; `src/workflow/{review-read,repair-entry}.ts` |
| 4 | Test architecture and TDD-to-governance linkage | direct `tests/unit/*`, `tests/e2e/*`, adapter/golden coverage for the above path |

---

## Methodology principles

### M1 — Three assurance layers, three non-substitutable questions

**Origin:** L0-01 through L0-03, L1-01 through L1-02, and L4-02; the selected approach explicitly distinguishes focused implementation evidence, readiness validation, and independent risk discovery.

**Rule.** TDD and focused unit tests establish that a named behavioural unit now works for its acceptance criterion; Verify establishes that the declared evidence, revision, coverage, and repair state make a task ready to assess; Review independently challenges remaining product, boundary, regression, and maintainability risk. Do not merge these questions or let one pass manufacture evidence for another. Avoid duplicate execution by passing current, bound evidence forward, while requiring a fresh, new review conclusion for every repaired revision.

**Apply to (keep):**
- Per-AC focused-test selector and final GREEN evidence in TDD mode.
- Verify as the sole producer of a current readiness PASS before Review.
- A separate fresh-context Review with a node-specific charter and a new revision binding.
- Unit tests for local contracts plus a minimal vertical fixture for their workflow wiring.

**Apply to (drop / change):**
- Treating broad-suite success as proof of every TDD acceptance criterion.
- Having Review re-run or rediscover integrity checks already mechanically verified by Verify.
- Reusing a pre-repair approval merely because a changed path was read in an earlier review.
- Replacing vertical workflow tests with copies of lower-level production-test assertions.
---

## Layer 0 — Public phase contracts and host Skills

Files: `src/workflow/orchestrator.ts`, `.agents/skills/kata-build/SKILL.md`, `.agents/skills/kata-verify/SKILL.md`, `.agents/skills/kata-review/SKILL.md`.

### L0-01 — Make a current PASS verify verdict a review-entry precondition

**Evidence**
`src/workflow/orchestrator.ts:917-1077` writes `verify.json`; `src/workflow/orchestrator.ts:1110-1215` enters `review` from `hardVerify` without reading it. README states `/kata-verify` verifies freshness and coverage before `/kata-review`.

**Current state**
Verify and review can both assess readiness, but review can bypass the recorded verify verdict completely. The documented order is consequently advisory rather than a state/artifact contract.

**Desired state**
Verify owns evidence freshness, AC adequacy, frozen-tier, obligation, Wiki-closure, and verify-pass readiness; review starts only from a current, bound PASS artifact and owns independent product-risk findings.

**Proposed improvement**
At review entry, validate a same-revision `verify.json` PASS plus its revision binding and reject missing/stale/failed results with `/kata-verify` as the only remedy. Keep review's approval and Judge contracts unchanged; add an explicit migration path for legacy tasks without a binding.

- **Severity:** High
- **Effort:** M
- **Blast radius:** on-disk/cross-module
- **Class:** redesign
- **Status:** **accepted** — require a current Verify artifact before review.
- **Depends on:** none
- **Cross-cut tag:** `T1-phase-ownership`

### L0-02 — Preserve two independent passes but give them non-overlapping charters

**Evidence**
`.agents/skills/kata-verify/SKILL.md:71-125` and `.agents/skills/kata-review/SKILL.md:65-125` require nearly identical fresh-context adversarial workflows; `cmdVerify` and `cmdReview --approve` each call `adversarialGateFor()` with distinct nodes.

**Current state**
The two passes provide valuable independence but their instructions largely repeat, making their distinct falsification goals implicit and risking redundant reading/testing.

**Desired state**
Verify's independent pass falsifies provenance, evidence freshness, AC/matrix coverage, and gate/repair state. Review's pass falsifies implementation behavior, boundary handling, regressions, maintainability, and assumptions not proven by evidence.

**Proposed improvement**
Keep both gates. Version two concise node-specific charters and require each brief to identify prior evidence it may rely on versus dimensions it must examine anew; permit delta-scoped review only after the recorded coverage check proves all changed paths are included. Measure overlap, omissions, duration, and incremental finding yield before narrowing either pass.

- **Severity:** Med
- **Effort:** M
- **Blast radius:** public-API/cross-module
- **Class:** redesign
- **Status:** **accepted** — retain two independent passes with explicit non-overlapping charters.
- **Depends on:** L0-01
- **Cross-cut tag:** `T2-independent-assurance`

### L0-03 — Turn TDD mode into an AC-to-focused-test contract, not a prompt alone

**Evidence**
`src/workflow/orchestrator.ts:410-412` only returns a RED→GREEN prompt when build is not sealed; `.agents/skills/kata-build/SKILL.md:140-150` repeats it; final seal evaluates only collected check results.

**Current state**
A `tdd` workflow profile communicates a development discipline but persists no link from behavioral acceptance criteria to focused unit tests or final evidence. The runtime cannot distinguish no focused test from a successful broad suite.

**Desired state**
For behavior-bearing ACs, TDD mode makes the focused unit-test path/identifier and its final GREEN evidence reviewable alongside integration/entrypoint evidence. It does not infer an unreliable timestamp or commit history for RED.

**Proposed improvement**
Extend the acceptance matrix/evidence vocabulary with optional-but-required-in-`tdd` unit-test links per applicable AC, validate their presence at design/seal, and show them in Verify/Review packets. Let implementers record a RED command/intent as an auditable attestation; do not block on reconstructing historical execution order.

- **Severity:** High
- **Effort:** L
- **Blast radius:** on-disk/cross-module
- **Class:** redesign
- **Status:** **accepted** — require AC→focused-test links and final GREEN evidence in TDD mode.
- **Depends on:** L0-01
- **Cross-cut tag:** `T3-tdd-governance-link`

### Layer 0 — tally

| Status | Count |
|---|---|
| accepted | 3 |
| rejected | 0 |
| deferred | 0 |
| withdrawn | 0 |

Cross-cutting tags introduced: `T1-phase-ownership`, `T2-independent-assurance`, `T3-tdd-governance-link`.
Cross-cutting tags reused: none.

Dependency edges within Layer 0: L0-02 and L0-03 depend on L0-01.

---

## Layer 1 — TDD, seal, and executable evidence contract

Files: `src/quality/{evidence,claims,check-resolver,project-checks,relevant-checks,acceptance-matrix,evidence-adequacy}.ts`, `src/workflow/{seal-preflight,seal-reads}.ts`.

### L1-01 — In TDD mode, evaluate evidence per acceptance row rather than globally

**Evidence**
`src/quality/evidence-adequacy.ts:62-96` computes one `freshPassingTestEvidence` array and returns it for every AC; only entrypoint-level rows perform `evidenceMatchesRow()`. `acceptance-matrix.ts` already has stable row/check identity matching.

**Current state**
A fresh passing `test` envelope can satisfy unrelated unit or integration ACs. The matrix models AC-specific evidence but the shared evaluator does not apply that model for ordinary levels.

**Desired state**
The stricter attribution rule applies to `workflowProfile.tdd`: each applicable AC must have current passing evidence that matches its own matrix declaration. Non-TDD profiles retain the existing compatibility behavior.

**Proposed improvement**
Add a profile-aware per-row adequacy branch: in TDD mode, require `evidenceMatchesRow()` for every AC's declared focused unit evidence and preserve the current per-AC entrypoint rule. Report both the row and the missing declaration/evidence in repair scope; retain global suites only as diagnostic health evidence.

- **Severity:** High
- **Effort:** M
- **Blast radius:** cross-module/on-disk
- **Class:** redesign
- **Status:** **accepted** — apply per-AC matrix evidence matching to TDD profiles only.
- **Depends on:** L0-03
- **Cross-cut tag:** `T3-tdd-governance-link`

### L1-02 — Give focused TDD tests a machine-checkable identity

**Evidence**
`src/quality/acceptance-matrix.ts:45-69` validates `testPaths`, while `check-resolver.ts:111-180` can execute an entire suite when no selector is supplied. L0-03 requires AC→focused-test links.

**Current state**
A task can name a test file while final evidence is produced by a broad suite. The reviewer cannot tell whether the AC has a focused unit test or only incidental suite coverage.

**Desired state**
Every behavior AC in TDD mode identifies a focused selector the resolver can execute, unless a deliberate shared suite declares explicit coverage semantics.

**Proposed improvement**
Extend matrix test evidence for TDD with a selector-or-explicit-coverage discriminator. Validate selector capability at design/seal; permit `coversAll` only with a written rationale and show the exception in Verify and Review packets. Do not require one physical test per AC.

- **Severity:** Med
- **Effort:** M
- **Blast radius:** on-disk/cross-module
- **Class:** redesign
- **Status:** **accepted** — require a resolvable selector or explicit shared-suite coverage.
- **Depends on:** L0-03
- **Cross-cut tag:** `T3-tdd-governance-link`

### Layer 1 — tally

| Status | Count |
|---|---|
| accepted | 2 |
| rejected | 0 |
| deferred | 0 |
| withdrawn | 0 |

Cross-cutting tags introduced: none. Reused: `T3-tdd-governance-link`.
Dependency edges within Layer 1: L1-01 and L1-02 depend on L0-03.

---

## Layer 2 — Verify readiness and revision binding

Files: `src/workflow/{revision,verdict-binding}.ts`, `src/quality/{revision-delta,review-scope,code-surface}.ts`.

### L2-01 — Use review scope only to narrow a new delta pass, never to preserve approval

**Evidence**
`src/quality/review-scope.ts:31-59` calculates whether changed paths are within recorded review scope, but repository search finds no production caller. `verdict-binding.ts:98-141` otherwise expires a current review when its binding no longer matches.

**Current state**
The code contains a conservative scope model and revision digests, but it is not wired into an actual review round. Its comment can be misread as allowing a pre-repair review to certify the repaired code.

**Desired state**
A repair always gets a newly recorded, current-revision review conclusion. When per-path digests prove a small change is fully within the prior reviewed scope, only the *new adversarial pass's input scope* may narrow.

**Proposed improvement**
Wire `changeSurface` + `reviewScopeVerdict` into brief construction. Issue a delta review brief only when changed paths are mechanically covered; otherwise issue a full brief. Require the resulting pass and approval to bind the new revision, preserve the fallback to full scope for legacy/no-digest/no-scope cases, and record full-versus-delta timing and finding yield.

- **Severity:** Med
- **Effort:** M
- **Blast radius:** cross-module
- **Class:** redesign
- **Status:** **accepted** — use scope to generate a new delta pass, not approval reuse.
- **Depends on:** L0-02
- **Cross-cut tag:** `T2-independent-assurance`

### Layer 2 — tally

| Status | Count |
|---|---|
| accepted | 1 |
| rejected | 0 |
| deferred | 0 |
| withdrawn | 0 |

Cross-cutting tags introduced: none. Reused: `T2-independent-assurance`.
Dependency edges within Layer 2: L2-01 depends on L0-02.

---

## Layer 3 — Independent review, Judge, and repair closure

Files: `src/quality/{adversarial,reviewer,judge,finding-*,repair*,repair-obligations}.ts`, `src/workflow/{review-read,repair-entry}.ts`.

### L3-01 — Make the independent-pass charter a node-owned, versioned contract

**Evidence**
`src/quality/adversarial.ts:195-495` renders one long generic brief whose only node-specific content is the label and the caller-selected mode; `buildAdversarialBrief()` supplies the same acceptance, evidence, reading-set, and instructions to both nodes.

**Current state**
Two gates are independently bound and correctly fail closed, but the meaningful distinction between Verify and Review exists only as prose interpretation. This drives repeated token cost and makes duplicate or missed examination likely.

**Desired state**
The verify and review passes share only the integrity protocol (fresh context, issued brief, revision/delta binding, finding schema). Their mandatory questions, evidence reuse rules, stop conditions, and success evidence are explicit per-node contracts.

**Proposed improvement**
Introduce a versioned `AdversarialNodeContract` used to render concise node sections: Verify challenges evidence provenance/freshness/AC and TDD link coverage; Review challenges implementation behavior, boundaries, regressions, and unproven assumptions. Preserve the same fresh-context and fail-closed mechanics, attach charter version to the record, and retain a full brief compatibility reader.

- **Severity:** High
- **Effort:** M
- **Blast radius:** public-API/cross-module
- **Class:** redesign
- **Status:** **accepted (absorbed into L0-02)** — two passes remain; their charters become explicit and non-overlapping.
- **Depends on:** L0-02
- **Cross-cut tag:** `T2-independent-assurance`

### Layer 3 — tally

| Status | Count |
|---|---|
| accepted | 1 |
| rejected | 0 |
| deferred | 0 |
| withdrawn | 0 |

Cross-cutting tags introduced: none. Reused: `T2-independent-assurance`.
Dependency edges within Layer 3: L3-01 depends on L0-02.

---

## Layer 4 — Test architecture and TDD-to-governance linkage

Files: direct unit/E2E/golden tests for the quality path.

### L4-01 — Test the Verify-before-Review boundary as a workflow contract

**Evidence**
`tests/e2e/repair-batch-is-wired.test.ts:51-78` invokes `issueAdversarialBrief()` and records a Verify result directly; `tests/e2e/seal-preflight-blockers.test.ts:75-125` exercises seal refusal, but no fixture drives a review request with absent, stale, or failed `verify.json`. L0-01 makes this an entry invariant.

**Current state**
Unit tests establish individual parsers and gates, while E2E fixtures cover repair batching and seal blockers. The new phase-order invariant has no end-to-end regression protection.

**Desired state**
A review invocation succeeds only after a current, bound Verify PASS; missing, stale, failed, or mismatched Verify artifacts fail closed and direct the task to Verify.

**Proposed improvement**
Add a focused workflow-contract fixture that covers the valid handoff and each refusal reason. Keep unit tests at the validator/reader boundary; do not repeat implementation-behaviour assertions in this fixture.

- **Severity:** High
- **Effort:** S
- **Blast radius:** cross-module
- **Class:** polish
- **Status:** **accepted (absorbed into L0-01)** — lock the Verify-before-Review contract with E2E coverage.
- **Depends on:** L0-01
- **Cross-cut tag:** `T1-phase-ownership`

### L4-02 — Add one minimal TDD-to-governance vertical contract fixture

**Evidence**
`tests/unit/evidence-adequacy.test.ts` and `tests/unit/check-resolver.test.ts` isolate row/evidence and command-resolution behaviour; `tests/e2e/repair-batch-is-wired.test.ts:14-23` proves a specific repair lifecycle. No test executes the proposed TDD chain from an AC-linked focused test through final GREEN evidence, Verify, and Review admission.

**Current state**
Existing tests are appropriately granular, but their composition does not prove that the proposed TDD metadata, per-AC evidence rule, and phase gates interoperate. A future change could leave every module test green while disconnecting the workflow.

**Desired state**
One small deterministic fixture proves the happy path and targeted refusal paths for the TDD contract, without rerunning Kata's complete suite or duplicating each production unit test.

**Proposed improvement**
Create a reusable TDD fixture with one behavioural AC, a resolvable focused selector, a recorded final GREEN result, and an integration/entrypoint declaration where applicable. Exercise design/seal, Verify evidence presentation, and Review admission; add negative variants for missing AC link, unresolved selector, and unmatched evidence. Keep all lower-level edge permutations in their existing unit suites.

- **Severity:** High
- **Effort:** M
- **Blast radius:** cross-module/on-disk
- **Class:** redesign
- **Status:** **accepted** — add a minimal TDD vertical-contract fixture, rather than duplicating all component tests.
- **Depends on:** L0-01, L0-03, L1-01, L1-02
- **Cross-cut tag:** `T3-tdd-governance-link`

### Layer 4 — tally

| Status | Count |
|---|---|
| accepted | 2 |
| rejected | 0 |
| deferred | 0 |
| withdrawn | 0 |

Cross-cutting tags introduced: none. Reused: `T1-phase-ownership`, `T3-tdd-governance-link`.
Dependency edges within Layer 4: L4-01 depends on L0-01; L4-02 depends on L0-03, L1-01, and L1-02.
---

## Cross-cutting themes
### T1 — Evidence-readiness ownership (active)

**Findings:** L0-01, L4-01.

Verify becomes the sole state transition that converts sealed, current evidence into readiness. Review consumes that conclusion rather than independently reimplementing staleness and adequacy checks; the E2E boundary test locks the handoff.

### T2 — Independent assurance without redundant work (active)

**Findings:** L0-02, L2-01, L3-01.

Verify and Review remain separate because their falsification questions differ. Versioned node charters and current evidence prevent repeated integrity work, while review scope may reduce a *new* pass's reading set only when coverage proves it safe; it never preserves an old approval.

### T3 — TDD evidence as a governed acceptance contract (active)

**Findings:** L0-03, L1-01, L1-02, L4-02.

TDD becomes observable without pretending Kata can reconstruct historical RED execution: a behaviour AC names a focused selector, the final GREEN result is bound to that row, TDD adequacy validates it per AC, and one vertical test proves the wiring.

---

## Consolidated polish plan
### Phase 1 — Enforce the evidence-readiness handoff

**Findings:** 2 — L0-01, L4-01.

**Files touched:** 5 — `src/workflow/orchestrator.ts`, `src/workflow/verdict-binding.ts`, `src/workflow/review-read.ts`, `.agents/skills/kata-{verify,review}/SKILL.md`, plus a focused E2E fixture.

**Blast-radius mix:** on-disk/cross-module. **Coordination:** none. **Class mix:** 1 redesign / 1 polish.

Make a bound Verify PASS the only review-entry route, preserve explicit legacy migration handling, and establish the end-to-end success/refusal contract. **Risk:** stored-artifact compatibility and existing task migration.

### Phase 2 — Make TDD acceptance evidence executable

**Findings:** 3 — L0-03, L1-01, L1-02.

**Files touched:** 9 — `src/quality/{acceptance-matrix,evidence-adequacy,check-resolver,evidence,claims}.ts`, `src/workflow/{seal-preflight,seal-reads}.ts`, `schemas/*`, and focused unit tests.

**Blast-radius mix:** on-disk/cross-module. **Coordination:** none. **Class mix:** all redesign.

Add TDD-only AC→focused-test declarations, selectors/shared-suite exceptions, and per-row final-GREEN adequacy; surface the resulting evidence in existing packets. **Risk:** task-schema versioning, selector portability, and compatibility for non-TDD profiles.

### Phase 3 — Separate independent-pass charters and safely narrow repair review

**Findings:** 3 — L0-02, L2-01, L3-01.

**Files touched:** 8 — `src/quality/{adversarial,review-scope,revision-delta,code-surface}.ts`, `src/workflow/{revision,verdict-binding}.ts`, `.agents/skills/kata-{verify,review}/SKILL.md`, and quality tests.

**Blast-radius mix:** public-API/cross-module. **Coordination:** none. **Class mix:** all redesign.

Implement versioned Verify/Review charters, bind each new pass to its own revision, and use mechanically proven scope only to issue a fresh delta Review brief. Measure overlap, wall time, and incremental findings before any further narrowing. **Risk:** brief/artifact reader compatibility and accidentally treating scope as approval reuse.

### Phase 4 — Prove the TDD contract end to end

**Findings:** 1 — L4-02.

**Files touched:** 2 — reusable test fixture support and one focused E2E test module.

**Blast-radius mix:** cross-module/on-disk. **Coordination:** none. **Class mix:** all redesign.

Run the smallest deterministic TDD path through design, seal, Verify packet, and Review admission, including missing-link, bad-selector, and unmatched-evidence refusal variants. Retain unit tests for local permutations. **Risk:** fixture brittleness; keep external tools stubbed and assertions contract-level.

```text
Phase 1 (Evidence-readiness handoff)
   ↓
   ├──► Phase 2 (TDD acceptance evidence)
   │         ↓
   │    Phase 4 (TDD vertical contract)
   │
   └──► Phase 3 (Independent-pass charters and delta review)
```

---

## Follow-up Review 2026-09-20T09:39:51+0800

### F1 — Verify and Review reuse declared TDD tests; Build owns test authorship

**Decision:** accepted — Verify and Review must not independently create, edit, generate, or maintain test-source code. They reuse the task's declared focused unit tests and sealed test evidence; a missing or inadequate test becomes a Build/TDD repair obligation, not a test authored inside either gate.

**Boundary contract**
- **Build/TDD owns:** creating or changing production and test code, executing RED→GREEN work, declaring the AC→focused-test selector, and producing the final sealed GREEN evidence.
- **Verify owns:** checking that the declared focused-test evidence is current, passing, revision-bound, and matches its AC/matrix row. It may execute an already-declared selector only as a deterministic evidence revalidation; it must neither widen its selector nor write test code. Missing, stale, or unmatched evidence returns the task to Build/TDD.
- **Review owns:** using the same declared focused tests and their outputs as a reproduction/behaviour oracle while independently examining unproven risks. It may re-run an existing declared selector in a fresh context, but may not add a regression test, alter a fixture, or create a speculative test harness. A missing regression test is recorded as a finding with test intent and routed to Build/TDD.
- **Judge owns:** deciding against the bound Verify/Review records and their reused evidence; it does not author or mutate test code.

**Implementation constraint**
The versioned `AdversarialNodeContract` from L3-01 must expose an `executionPolicy` equivalent to `reuse_declared_tests_only`. Any re-executed test evidence must reference an existing acceptance-matrix check/selector and the revision under review. The Phase 4 vertical fixture must prove that Verify and Review accept declared GREEN evidence and reject an absent, stale, unmatched, or undeclared selector without creating test files.

**Rationale**
This retains independent assurance without paying for a second, uncontrolled test-authoring loop. It also makes responsibility diagnosable: behavioural test gaps are repaired through TDD; evidence defects through Verify; and product-risk findings through Review followed by Build/TDD.

**Plan impact**
Apply this constraint in Phase 2's selector/evidence schema, Phase 3's node charters and record validation, and Phase 4's vertical-contract fixture.
