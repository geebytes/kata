---
date: 2026-09-20T10:09:51+0800
author: vforfreedom
commit: 99113df
branch: master
repository: kata
target: "Kata workflow, merged from docs/architecture-reviews/2026-09-20_kata-workflow-efficiency-review.md and docs/architecture-reviews/2026-09-20_09-39-51_kata-verify-review-tdd.md"
target_kind: directory
layer_count: 6
phases: [{ n: 1, title: "Foundation: 入口、身份与基线", depends_on: [], blast_radius: on-disk, effort: M }, { n: 2, title: "基线与刷新闭环", depends_on: [1], blast_radius: public-API, effort: M }, { n: 3, title: "证据契约与检查级复用", depends_on: [2], blast_radius: cross-module, effort: L }, { n: 4, title: "AC 级证据映射与保证边界", depends_on: [3], blast_radius: cross-module, effort: L }, { n: 5, title: "持久化正确性", depends_on: [3], blast_radius: on-disk, effort: L }, { n: 6, title: "上下文与 I/O 经济", depends_on: [1], blast_radius: on-disk, effort: L }, { n: 7, title: "评估并行与发布可信度", depends_on: [2], blast_radius: internal, effort: M }]
unresolved_finding_count: 0
status: ready
tags: [architecture-review, kata, efficiency, latency, tokens, tdd, quality-gates]
last_updated: 2026-09-20T10:09:51+0800
last_updated_by: vforfreedom
last_updated_note: "All 7 phases generated and approved as generated; Step 8 independent review (42 rows) triaged and applied at Step 9; status ready."
---

# Architecture review — Kata unified workflow efficiency and assurance

This review consolidates the repository-wide efficiency audit and the Verify/Review/TDD boundary audit into one implementation-ready artifact. It targets avoidable wall time, I/O, subprocess pressure, prompt tokens, and repeated administrative work without weakening provenance, independent assurance, or user-controlled trust boundaries. TDD/Build exclusively owns test authorship; Verify and Review only reuse declared, revision-bound test selectors and evidence.

---

## Conventions

### Finding shape

Each finding records evidence, current state, desired state, proposed improvement, severity, effort, blast radius, class, status, dependencies, and cross-cut tag. Existing accepted decisions are revalidated against the merged efficiency goal; no source files are changed by this review.

### Layers (top → down)

| # | Layer | Files / responsibility |
|---|---|---|
| 0 | Entry, CLI, and host-Skill cost surface | `src/cli.ts`, `src/cli/{tasks,workflow,installer,invocation}.ts`, `.agents/skills/kata*/SKILL.md` |
| 1 | Lifecycle, revision, and handoff orchestration | `src/workflow/{orchestrator,navigation,revision,context-fabric,verdict-binding,seal-*.ts}` |
| 2 | TDD, evidence, and independent assurance | `src/quality/{evidence,claims,check-resolver,acceptance-matrix,evidence-adequacy,adversarial,review-scope,revision-delta,reviewer,judge}.ts` |
| 3 | Task state, schema, relations, and Wiki authority | `src/core/{task,state,workflow-profile,relations,schema}.ts`, `src/wiki/*.ts`, `schemas/*.schema.json` |
| 4 | Platform/runtime infrastructure and repository I/O | `src/adapters/*.ts`, `src/{process,codegraph,hooks}/**`, `src/core/{layout,repository-identity,git,hash}.ts` |
| 5 | Evaluation, release control, and vertical regression coverage | `src/eval/*.ts`, `scripts/build.mjs`, directly relevant `tests/unit/*` and `tests/e2e/*` |

---

## Methodology principles

### M1 — 可证明的最小保证工作量
**Origin:** L1-01、L2-02、L2-03、L2-04；用户在合并审阅中明确以效率、wall time 与 token 成本为目标，同时要求保留质量门独立性与 TDD 测试复用边界。

**Rule.** 先通过内容身份、检查输入指纹、AC→check 映射和已封存证据证明工作可复用或可缩小；证明成立时只执行最小补集。任何映射缺失、身份不明或覆盖不能机械验证的情况，必须 fail-closed，退回全量检查、Build/TDD 修复或显式 strict/security 升级。独立性按职责而非重复次数配置：标准路径保留 Review 的新鲜上下文对抗与 Judge 裁决，不为 Verify 重复付出同质测试/agent 回合。

**Apply to (keep):**
- 内容/路径摘要、revision binding、矩阵 check ID、sealed evidence 和 delta scope 的可审计记录。
- TDD 唯一测试作者；Verify 证据校验；Review 独立缺陷发现；Judge 接受性裁决。
- 证据或映射不完整时的阻断与明确 repair obligation。

**Apply to (drop / change):**
- whole-tree 或 all-check 一刀切重跑。
- Verify 与 Review 默认重复的 clean-context 对抗 pass。
- Verify/Review 自建测试或无声明的测试执行。
- 将未测成本写作 `0`。

---

## Layer 0 — Entry, CLI, and host-Skill cost surface

Files: `src/cli.ts`, `src/cli/{tasks,workflow,installer,invocation}.ts`, `.agents/skills/kata*/SKILL.md`.

### L0-01 — Unambiguous task startup avoids duplicate context construction
**Evidence:** `src/cli/tasks.ts:198` calls `readTaskContext()` from status; `src/cli/tasks.ts:435` calls it again after packet creation during orient; every phase Skill begins with `kata-cli status` before `kata-cli orient`.
**Current state:** an explicit task ID still incurs a discovery/status context build before the authoritative orient packet builds equivalent task context.
**Desired state:** an explicitly anchored task reaches one authoritative orient/context construction; unanchored dispatch remains discoverable and rich.
**Proposed improvement:** add a light status mode that returns only phase/candidates by default, preserve `--with-context`, and make the Skills use a direct orient fast path when the user supplied a task ID.
**Severity:** Med  **Effort:** M  **Blast radius:** cross-module  **Class:** redesign
**Status:** **accepted** — light status plus explicit-task fast path.
**Depends on:** none.  **Cross-cut tag:** orchestration-cost.

### L0-02 — Refresh only after an update changes managed artifacts
**Evidence:** `src/cli/installer.ts:20-42` calls `runRuntimeRefresh()` after every aggregate update; `src/cli/installer.ts:116-117` runs CodeGraph `sync` then `index` sequentially.
**Current state:** a no-op update can still consume Comet/network work and an index rebuild budget.
**Desired state:** no-op updates report a visible skipped refresh without concealing an operator-requested forced refresh.
**Proposed improvement:** add `auto|always|never` refresh policy; `auto` runs refresh only after a managed artifact or runtime version changes, `always` remains available for recovery.
**Severity:** Med  **Effort:** M  **Blast radius:** public-API  **Class:** polish
**Status:** **accepted** — change-aware refresh with explicit force and skip reason.
**Depends on:** L0-01.  **Cross-cut tag:** orchestration-cost.

### L0-03 — Measure generated Skill payloads before compacting repeated prose
**Evidence:** `kata-verify/SKILL.md:61-126` and `kata-review/SKILL.md:61-126` duplicate the same clean-context/adversarial procedure; all phase Skills repeat startup, handoff, CodeGraph, and trust-boundary guidance.
**Current state:** repeated explanatory prose is sent on each invocation, while the cost of a shared reference versus an embedded contract is unknown.
**Desired state:** each execution has the constraints needed to act safely, with explanatory token cost justified by measured outcome quality.
**Proposed improvement:** record final rendered prompt bytes/tokens, required-read count, and pass duration by phase; only then compact duplicative explanation into a versioned common contract while retaining hard gates and phase-specific instructions in the rendered payload.
**Severity:** Med  **Effort:** M  **Blast radius:** cross-module  **Class:** redesign
**Status:** **accepted** — establish the payload baseline, then compact only proven redundancy.
**Depends on:** L0-01.  **Cross-cut tag:** prompt-economy.

### L0-04 — Enforce reuse of Build/TDD-declared tests in Verify and Review
**Evidence:** `src/quality/adversarial.ts:426-432` directs a node to construct a counterexample and permits writing new files; `kata-verify/SKILL.md:87` and `kata-review/SKILL.md:87` require it to “run the attempts”.
**Current state:** node instructions permit independently authored counterexample tests, duplicating TDD work and creating unowned test artifacts.
**Desired state:** Build/TDD alone authors or changes tests; Verify validates current revision-bound evidence and Review may rerun the same declared selectors as a reproduction oracle.
**Proposed improvement:** add `reuse_declared_tests_only` to the adversarial node contract. Bind every test execution to a sealed check ID/selector; emit a Build/TDD repair obligation—not a new test file—when a test is missing or inadequate.
**Severity:** High  **Effort:** M  **Blast radius:** cross-module  **Class:** redesign
**Status:** **accepted** — runtime-enforced declared-test reuse.
**Depends on:** L0-03.  **Cross-cut tag:** assurance-economy.

### Layer 0 — tally

| Status | Count |
|---|---|
| accepted | 4 |
| rejected | 0 |
| deferred | 0 |
| withdrawn | 0 |

Cross-cutting tags introduced: `orchestration-cost`, `prompt-economy`, `assurance-economy`.
Dependency edges within Layer 0: `L0-01 → L0-02`; `L0-01 → L0-03`; `L0-03 → L0-04`.

---

## Layer 1 — Lifecycle, revision, and handoff orchestration

Files: `src/workflow/{orchestrator,navigation,revision,context-fabric,verdict-binding,seal-*.ts}`.

### L1-01 — Reuse evidence at declared check and acceptance granularity
**Evidence:** `src/workflow/orchestrator.ts:~432-445` reuses only when every recorded envelope has the current whole-tree diff hash; `~582-584` chooses the derived check set only after revision comparison.
**Current state:** one changed artifact can re-run unrelated passing checks even when its inputs and mapped acceptance criteria remain unchanged.
**Desired state:** a passing check remains reusable only when its executable inputs, relevant surface, selector, and acceptance mapping are unchanged; uncertainty remains fail-closed.
**Proposed improvement:** persist each check’s input fingerprint and covered ACs; reuse independently valid envelopes, run the complement, and emit a per-check reuse/invalidated explanation.
**Severity:** High  **Effort:** L  **Blast radius:** on-disk  **Class:** redesign
**Status:** **accepted** — check-level, declared-coverage reuse with full-run fallback.
**Depends on:** L0-04.  **Cross-cut tag:** assurance-economy.

### L1-02 — Compute manifest and path digests in one ordered walk
**Evidence:** `src/workflow/revision.ts:48-50` calls `computeManifestHash()` then `computePathDigests()`; both expand owned directories and hash all content.
**Current state:** each revision seal reads/hashes the same owned tree twice before checks begin.
**Desired state:** one stable traversal yields both the legacy manifest digest and granular digests without changing revision identity.
**Proposed improvement:** introduce a streaming ordered walker that feeds the legacy manifest hash and per-path hash map simultaneously; compare digest output byte-for-byte with the present implementation for files, directories, missing paths, and ignored paths.
**Severity:** Med  **Effort:** M  **Blast radius:** on-disk  **Class:** polish
**Status:** **accepted** — single-walk equivalent digesting.
**Depends on:** none.  **Cross-cut tag:** repository-io.

### L1-03 — Reuse acknowledged unchanged context by content hash
**Evidence:** `src/workflow/context-fabric.ts:~215` emits `AGENTS.md`, three `.llmwiki` files, task and state on every packet; `~217-249` also appends design references for implementer/reviewer/judge.
**Current state:** phase handoffs repeatedly require the same immutable files to be read, consuming context and token budget despite a stable revision.
**Desired state:** each role sees every new or changed authoritative source while prior acknowledged content is referenced rather than duplicated.
**Proposed improvement:** add a role/revision content-hash memo to the packet receipt. Required reads classify into `new_or_changed` and `acknowledged_unchanged`; only the former are mandatory reads, and both remain listed/auditable.
**Severity:** High  **Effort:** L  **Blast radius:** on-disk  **Class:** redesign
**Status:** **accepted** — hashed context memo with authority-preserving invalidation.
**Depends on:** L0-01.  **Cross-cut tag:** prompt-economy.

### L1-04 — Parallelize independent preflight reads under a bounded scheduler
**Evidence:** `src/workflow/seal-preflight.ts:~80-228` accumulates pure-read blockers in order; CodeGraph candidate discovery waits behind unrelated matrix/ownership reads.
**Current state:** independent preflight operations serialize their latency before any test may start.
**Desired state:** the user receives the same complete, deterministically ordered blocker list with lower waiting time.
**Proposed improvement:** execute independent reads under a bounded scheduler; retain dependency edges for matrix and owned-path checks, collect results in existing reporting order, and preserve fail-closed behavior.
**Severity:** Med  **Effort:** M  **Blast radius:** internal  **Class:** polish
**Status:** **accepted** — dependency-aware bounded preflight concurrency.
**Depends on:** L1-02.  **Cross-cut tag:** orchestration-cost.

### Layer 1 — tally

| Status | Count |
|---|---|
| accepted | 4 |
| rejected | 0 |
| deferred | 0 |
| withdrawn | 0 |

Cross-cutting tags introduced: `assurance-economy`, `repository-io`, `prompt-economy`, `orchestration-cost`. Reused: `orchestration-cost`, `prompt-economy`, `assurance-economy`.
Dependency edges within Layer 1: `L0-04 → L1-01`; `L0-01 → L1-03`; `L1-02 → L1-04`.

---

## Layer 2 — TDD, evidence, and independent assurance

Files: `src/quality/{evidence,claims,check-resolver,acceptance-matrix,evidence-adequacy,adversarial,review-scope,revision-delta,reviewer,judge}.ts`.

### L2-01 — Make expected exit code the evidence pass contract
**Evidence:** `src/quality/claims.ts:~89-102` emits claim checks with `expectExitCode`; `src/quality/evidence.ts:~241-249` labels every nonzero result failed; orchestrator sealing tests exit code directly.
**Current state:** the declared claim outcome and the collector/gate outcome disagree for expected-nonzero assertions.
**Desired state:** evidence consumers share one explicit result: actual exit code plus whether it matched the declared expected code.
**Proposed improvement:** extend envelopes with `passed`; set it from `expectExitCode ?? 0`; migrate freshness, adequacy and seal predicates to it while retaining raw exit code for diagnosis.
**Severity:** High  **Effort:** M  **Blast radius:** on-disk  **Class:** redesign
**Status:** **accepted** — expected-exit result contract.
**Depends on:** L1-01.  **Cross-cut tag:** assurance-economy.

### L2-02 — Bind passing test evidence to the acceptance criterion it proves
**Evidence:** `src/quality/evidence-adequacy.ts:~66-101` computes one `freshPassingTestEvidence` set and returns it for every criterion; row-specific matching is required only for entrypoint-level rows.
**Current state:** an unrelated passing test can satisfy multiple ACs, forcing broad re-runs to compensate for uncertainty.
**Desired state:** each AC has named test/claim evidence, so the gate can decide both adequacy and reuse exactly.
**Proposed improvement:** require matrix-backed test check IDs for each strict AC, match evidence by row for all verification levels, and provide a migration diagnostic for legacy ACs.
**Severity:** High  **Effort:** L  **Blast radius:** on-disk  **Class:** redesign
**Status:** **accepted** — AC-scoped evidence, with explicit legacy migration.
**Depends on:** L2-01.  **Cross-cut tag:** assurance-economy.

### L2-03 — Reserve the standard independent adversarial pass for Review
**Evidence:** `src/quality/adversarial.ts:~28-36` declares both `verify` and `review` nodes as fresh-context independent passes; `renderAdversarialBrief()` gives them the same sealed evidence, owned paths, reading set and attempt machinery.
**Current state:** standard Verify and Review each pay a clean-context adversarial pass despite their agreed responsibilities differing: Verify establishes evidence readiness; Review discovers defects independently.
**Desired state:** deterministic Verify establishes trusted, current AC evidence; one fresh-context Review challenges the implementation; Judge makes the independent acceptance decision from both artefacts.
**Proposed improvement:** remove `adversarial verify` as a standard gate requirement and retain it only as an explicit strict/security escalation. Keep Review fresh-context, revision-bound and fail-closed, so the efficiency reduction does not merge responsibilities.
**Severity:** High  **Effort:** L  **Blast radius:** cross-module  **Class:** redesign
**Status:** **accepted** — Review-only standard adversarial pass; Verify remains deterministic, strict escalation explicit.
**Depends on:** L2-02.  **Cross-cut tag:** independent-assurance.

### L2-04 — Make declared TDD selectors the only executable test oracle outside Build
**Evidence:** `src/quality/adversarial.ts:~430-448` says sealed checks should not be re-run, but `~550-576` permits writing counterexample files and running attempts; the brief does not machine-constrain commands to declared selectors.
**Current state:** Verify/Review can duplicate tests or create transient harnesses, increasing token and process cost while blurring Build/TDD ownership.
**Desired state:** Build/TDD is the sole author of tests; Verify and Review inspect sealed results and at most reproduce through declared focused selectors.
**Proposed improvement:** include allowed check IDs/selectors in the node contract; enforce command receipts against them. Missing coverage or an unrepresentable counterexample becomes a repair obligation routed to Build/TDD, not a test authored by the quality node.
**Severity:** High  **Effort:** L  **Blast radius:** cross-module  **Class:** redesign
**Status:** **accepted** — selector-bound oracle and Build/TDD feedback loop.
**Depends on:** L2-02, L2-03.  **Cross-cut tag:** tdd-ownership.

### Layer 2 — tally

| Status | Count |
|---|---|
| accepted | 4 |
| rejected | 0 |
| deferred | 0 |
| withdrawn | 0 |

Cross-cutting tags introduced: `independent-assurance`, `tdd-ownership`. Reused: `assurance-economy`.
Dependency edges within Layer 2: `L1-01 → L2-01 → L2-02 → {L2-03, L2-04}`.

---

## Layer 3 — Task state, schema, relations, and Wiki authority

Files: `src/core/{task,state,workflow-profile,relations,schema}.ts`, `src/wiki/*.ts`, `schemas/*.schema.json`.

### L3-01 — Replace the partial JSON-Schema interpreter with a standard validator
**Evidence:** `src/core/schema.ts:34-47` defines a narrow schema model; `assertMatches()` implements type/enum/properties but not Schema keywords such as `const` and `uniqueItems` used by bundled schemas.
**Current state:** the disk contract advertises constraints the runtime may silently ignore, causing late and repeated workflow failures.
**Desired state:** every supported on-disk schema is interpreted consistently before its data drives a gate.
**Proposed improvement:** adopt a pinned standard JSON-Schema validator for the schemas' declared draft; retain Kata’s error wrapping and add corpus fixtures for each schema and diagnostic path.
**Severity:** High  **Effort:** M  **Blast radius:** on-disk  **Class:** redesign
**Status:** **accepted** — standard validator with compatibility corpus.
**Depends on:** L2-01.  **Cross-cut tag:** durable-correctness.

### L3-02 — Serialize graph mutations and atomically replace the authoritative relation file
**Evidence:** `src/core/relations.ts:99-126` reads, appends and writes the whole graph; `~310-314` calls direct `writeFile()` without a relation-graph lock.
**Current state:** concurrent relation commands can lose a valid edge without an error, producing wrong status routing and repeated investigation.
**Desired state:** every accepted relation is preserved or the caller receives an explicit conflict.
**Proposed improvement:** add a graph-scoped lock and atomic-replace writer around the full read-modify-write transaction, with concurrency and crash-recovery tests.
**Severity:** High  **Effort:** M  **Blast radius:** on-disk  **Class:** redesign
**Status:** **accepted** — graph lock plus atomic replacement.
**Depends on:** L3-01.  **Cross-cut tag:** durable-correctness.

### L3-03 — Scope Wiki diagnostics to the task’s requested sources
**Evidence:** `src/wiki/context.ts:~27-50` filters authoritative records by relevance but builds `excluded` from every stale/invalid record; only warnings at `~55-70` apply requested refs.
**Current state:** a handoff carries unrelated repository history, inflating tokens and hiding actionable task-local warnings.
**Desired state:** task-relevant health problems remain explicit; global maintenance debt stays discoverable without becoming every packet’s payload.
**Proposed improvement:** emit full diagnostics only for requested source refs; emit aggregate global counts plus a `kata-cli wiki audit` pointer for unrelated records.
**Severity:** Med  **Effort:** S  **Blast radius:** internal  **Class:** polish
**Status:** **accepted** — scoped detail, global summary.
**Depends on:** L1-03.  **Cross-cut tag:** prompt-economy.

### L3-04 — Validate and atomically persist all Wiki updates
**Evidence:** `src/wiki/closure.ts:~41-51` constructs closure records without schema validation; `~114-117` writes them directly with `writeFile()`.
**Current state:** a partial or concurrent write can leave a malformed record that repeatedly pollutes later context/gates.
**Desired state:** Wiki updates are validated, durable and conflict-safe before becoming workflow authority.
**Proposed improvement:** route every create/update through validated locked mutation and atomic replacement; make readers distinguish missing from corrupt data.
**Severity:** High  **Effort:** M  **Blast radius:** on-disk  **Class:** redesign
**Status:** **accepted** — validated atomic Wiki writes.
**Depends on:** L3-01.  **Cross-cut tag:** durable-correctness.

### Layer 3 — tally

| Status | Count |
|---|---|
| accepted | 4 |
| rejected | 0 |
| deferred | 0 |
| withdrawn | 0 |

Cross-cutting tags introduced: `durable-correctness`. Reused: `prompt-economy`.
Dependency edges within Layer 3: `L3-01 → {L3-02, L3-04}`; `L1-03 → L3-03`.

---

## Layer 4 — Platform/runtime infrastructure and repository I/O

Files: `src/adapters/*.ts`, `src/{process,codegraph,hooks}/**`, `src/core/{layout,repository-identity,git,hash}.ts`.

### L4-01 — Stream repository identity hashing without changing its digest
**Evidence:** `src/core/repository-identity.ts:~75-110` reads every file into a `RepositoryFile[]`; `repositoryTreeHash()` iterates that completed array only afterward.
**Current state:** hash memory is proportional to all included repository bytes rather than a single file/chunk.
**Desired state:** identity semantics remain byte-for-byte stable with bounded memory.
**Proposed improvement:** expose a stable ordered async walk for identity consumers, stream path/content into the hasher, and retain an explicit materialized API only for callers needing contents. Lock behavior with digest-equivalence fixtures.
**Severity:** Med  **Effort:** M  **Blast radius:** internal  **Class:** polish
**Status:** **accepted** — streaming stable hash equivalence.
**Depends on:** L1-02.  **Cross-cut tag:** repository-io.

### L4-02 — Bound child-process capture while preserving diagnostic recovery
**Evidence:** `src/process/run.ts:~67-152` appends every stdout/stderr chunk to unbounded strings; only the later evidence layer truncates after capture.
**Current state:** a verbose process can consume unbounded runner memory before evidence gets a chance to cap its stored log.
**Desired state:** normal execution has a firm memory bound without concealing recoverable diagnostics.
**Proposed improvement:** capture bounded head/tail segments with byte count and truncation metadata; optionally tee full output to a declared artifact path, whose reference—not payload—enters evidence.
**Severity:** High  **Effort:** M  **Blast radius:** internal  **Class:** redesign
**Status:** **accepted** — bounded capture with opt-in full artifact.
**Depends on:** none.  **Cross-cut tag:** process-economy.

### L4-03 — Bound CodeGraph candidate fanout without losing source attribution
**Evidence:** `src/quality/acceptance-matrix.ts:~330-343` executes a CodeGraph `affected` subprocess for every source path via unbounded `Promise.all`.
**Current state:** strict closure may burst one expensive process per path, competing with tests and increasing timeout/flakiness risk.
**Desired state:** candidate attribution remains per source path while resource use is predictable.
**Proposed improvement:** schedule per-path queries through a configurable bounded pool, maintain deterministic path/result association, and fail closed on any unavailable query.
**Severity:** Med  **Effort:** M  **Blast radius:** internal  **Class:** polish
**Status:** **accepted** — bounded attributed CodeGraph fanout.
**Depends on:** L1-04.  **Cross-cut tag:** orchestration-cost.

### Layer 4 — tally

| Status | Count |
|---|---|
| accepted | 3 |
| rejected | 0 |
| deferred | 0 |
| withdrawn | 0 |

Cross-cutting tags introduced: `repository-io`, `process-economy`. Reused: `orchestration-cost`.
Dependency edges within Layer 4: `L1-02 → L4-01`; `L1-04 → L4-03`.

---

## Layer 5 — Evaluation, release control, and vertical regression coverage

Files: `src/eval/*.ts`, `scripts/build.mjs`, directly relevant `tests/unit/*` and `tests/e2e/*`.

### L5-01 — Represent host-unavailable metrics as unavailable, not zero
**Evidence:** `src/eval/runner.ts:~18-19` names `tokensUsed`, `costCredits`, and `escalationCount` unmeasured; `~141-143` stores all as `0`; `src/eval/metrics.ts:~31-33` aggregates them as numbers.
**Current state:** unavailable observability becomes plausible zero-cost data and can corrupt efficiency decisions.
**Desired state:** reports distinguish measured zero from unavailable data and never gate on unknown values.
**Proposed improvement:** use nullable value-plus-availability fields, exclude unavailable values from averages/totals, and surface collection coverage beside every cost metric.
**Severity:** High  **Effort:** M  **Blast radius:** on-disk  **Class:** redesign
**Status:** **accepted** — unavailable metric contract.
**Depends on:** none.  **Cross-cut tag:** measurement-integrity.

### L5-02 — Make fixture expectations executable release contracts
**Evidence:** `src/eval/runner.ts:~34-37` stores each fixture’s expected values; `~64-71` aggregates and gates observations without comparing them to those expectations.
**Current state:** a broken or mis-specified fixture can produce a passing aggregate report.
**Desired state:** every fixture declares an observable expected result that is checked before its metrics influence release confidence.
**Proposed improvement:** produce an expectation verdict per fixture; fail the release gate for mismatch/unavailable expectation while preserving all observations for diagnosis.
**Severity:** High  **Effort:** M  **Blast radius:** internal  **Class:** redesign
**Status:** **accepted** — expectation verdict is a release input.
**Depends on:** L5-01.  **Cross-cut tag:** measurement-integrity.

### L5-03 — Offer bounded parallel evaluation only for isolated fixtures
**Evidence:** `src/eval/runner.ts:~60-62` awaits every `runFixture()` in sequence; `runFixture()` creates a unique temporary root at `~91`.
**Current state:** independent evaluation fixtures pay summed wall time even though their filesystem state is isolated.
**Desired state:** conservative CI remains stable while explicit benchmark/release runs can use available parallelism.
**Proposed improvement:** add opt-in bounded fixture concurrency with deterministic ordered reports, per-fixture cleanup, and a resource/concurrency record; default stays serial.
**Severity:** Med  **Effort:** M  **Blast radius:** internal  **Class:** polish
**Status:** **accepted** — opt-in isolated fixture pool.
**Depends on:** L5-02.  **Cross-cut tag:** orchestration-cost.

### Layer 5 — tally

| Status | Count |
|---|---|
| accepted | 3 |
| rejected | 0 |
| deferred | 0 |
| withdrawn | 0 |

Cross-cutting tags introduced: `measurement-integrity`. Reused: `orchestration-cost`.
Dependency edges within Layer 5: `L5-01 → L5-02 → L5-03`.

---

## Cross-cutting themes

### T1 — assurance-economy (active)

**Findings:** L0-04, L1-01, L2-01, L2-02.

这些 finding 合成一条主线：把“我复查了一切”的模糊声明，换成可机械核验的最小声明。检查输入指纹（L1-01）、期望退出码契约（L2-01）与 AC→check 证据映射（L2-02）共同给出“哪些检查仍然成立”的可判定依据；L0-04 保证这一缩小只发生在证据层，不会变成节点自行补测。实现该主题后，一次两行修复不再以整棵 owned manifest 为代价重新独立走查，同时每一项 AC 仍有具名证据。**closure:** L2-02（没有 AC 级证据映射，检查级复用无法安全判定）。

### T2 — prompt-economy (active)

**Findings:** L0-03, L1-03, L3-03.

三者都指向同一个 token 泄漏面：每个 phase 的渲染 payload 重新携带稳定不变的说明与未变化文件。L0-03 先建立 payload/耗时基线，让压缩决策有依据；L1-03 用内容哈希把 required reads 分成 `new_or_changed` 与 `acknowledged_unchanged`；L3-03 把无关 Wiki 健康问题降为计数与 audit 入口。主题完成后，指令的硬约束仍逐字出现在 payload 中，被削减的是重复解释与无关历史。

### T3 — orchestration-cost (active)

**Findings:** L0-01, L0-02, L1-04, L4-03, L5-03.

这是 wall time 主题，全部是“等待本可并行或无必要的工作”。显式任务 ID 的重复上下文构建（L0-01）、no-op 更新触发的 refresh 与索引重建（L0-02）、串行 preflight 读取（L1-04）、无界 CodeGraph 扇出（L4-03）、串行 fixture 评估（L5-03）各自独立，但共享同一改进形态：识别独立单元，给定有界调度或跳过条件，并保持输出顺序与 fail-closed 语义。

### T4 — 保证边界与测试所有权 (active)

**Findings:** L2-03, L2-04.

质量门效率不能靠削弱独立性获得，只能靠消除职责重叠。L2-03 去掉 Verify 与 Review 默认重复的 clean-context 对抗 pass，同时保留 Review 的新鲜上下文与 Judge 裁决；L2-04 把“测试作者”唯一化到 Build/TDD，使 Verify/Review 只能复用已声明 selector。两者合起来定义了效率优化的边界：省掉的是重复执行，不是独立视角。**风险提示：** 该主题是本审阅中唯一触碰保证强度的改动，落地需要 L2-02 的 AC 级证据映射先行，并保留 strict/security 显式升级路径。

### T5 — durable-correctness (active)

**Findings:** L3-01, L3-02, L3-04.

这些不是性能问题，而是会持续制造重复调查成本的持久化缺陷：Schema 解释器与声明关键字不一致（L3-01）、关系图无锁读改写丢边（L3-02）、Wiki 记录未校验且非原子落盘（L3-04）。共同点是坏数据通过权威文件持续放大成本——一次静默丢失需要多轮诊断，一条损坏记录污染后续每个 handoff。目标是让磁盘契约既是权威也是可验证的。

### T6 — 仓库 / 进程 I/O 经济 (active)

**Findings:** L1-02, L4-01, L4-02.

三项都在去掉不必要的全量物化：同一 owned tree 被两次遍历哈希（L1-02）、whole-tree 哈希把全部内容驻留内存（L4-01）、子进程输出无上限累积后才截断（L4-02）。共同纪律是以稳定顺序流式处理，用等价性测试锁定语义，且不把截断伪装成完整日志。

### T7 — measurement-integrity (closed by L5-02)

**Findings:** L5-01, L5-02.

效率目标必须有可信基线，否则优化无法证明。L5-01 把宿主不可观测的成本标为 unavailable 而非 `0`，L5-02 让每个 fixture 的预期结果成为可执行的发布契约而非仅供参考的字段。两者完成后，本审阅提出的所有效率声明都可用真实（而非零值）数据复核。

---

## Consolidated polish plan

**22 accepted findings across 7 phases.** Dependency edges are respected: each phase lands before anything that depends on it. Two phases (4 and 5) touch disjoint files and may run in parallel if desired.

### Phase 1 — Foundation: 入口、身份与基线

**Findings:** 4 — L0-01, L1-02, L4-02, L5-01.

**Files touched:** ~7 — `src/cli/tasks.ts`, `src/cli/workflow.ts`, `src/workflow/revision.ts`, `src/process/run.ts`, `src/eval/metrics.ts`, `src/eval/runner.ts`, `.agents/skills/kata*/SKILL.md`.

**Blast-radius mix:** 3 internal, 1 on-disk.
**Coordination:** none.
**Class mix:** 3 polish / 1 redesign.

**Why first:** these four are dependency-free and low-risk, and two of them (L0-03’s prerequisites and L5-01) are what make every later efficiency claim measurable. Nothing here changes gate semantics.

### Phase 2 — 基线与刷新闭环

**Findings:** 3 — L0-02 (← L0-01), L0-03 (← L0-01), L5-02 (← L5-01).

**Files touched:** ~5 — `src/cli/installer.ts`, `.agents/skills/kata*/SKILL.md`, `src/workflow/prompt-catalogue.ts`, `src/eval/runner.ts`, `src/eval/release-gates.ts`.

**Blast-radius mix:** 1 public-API, 1 on-disk, 1 cross-module.
**Coordination:** none.
**Class mix:** 1 polish / 2 redesign.

**Risk flag:** L0-02 changes the refresh CLI surface (`auto|always|never`); keep `always` available for recovery and make skipped refresh visible.

### Phase 3 — 证据契约与检查级复用

**Findings:** 3 — L0-04 (← L0-03), L1-01 (← L0-04), L2-01 (← L1-01).

**Files touched:** ~6 — `src/quality/adversarial.ts`, `src/quality/claims.ts`, `src/quality/evidence.ts`, `src/workflow/orchestrator.ts`, `src/workflow/seal-preflight.ts`, `.agents/skills/{kata-verify,kata-review}/SKILL.md`.

**Blast-radius mix:** 2 on-disk, 1 cross-module.
**Coordination:** none.
**Class mix:** 0 polish / 3 redesign.

**Why here:** this is the load-bearing phase for T1. Without check-level input fingerprints and the expected-exit contract, later reuse decisions would be guesses.

### Phase 4 — AC 级证据映射与保证边界

**Findings:** 3 — L2-02 (← L2-01), L2-03 (← L2-02), L2-04 (← L2-02, L2-03).

**Files touched:** ~7 — `src/quality/evidence-adequacy.ts`, `src/quality/acceptance-matrix.ts`, `src/quality/adversarial.ts`, `src/quality/{reviewer,judge}.ts`, `src/core/task.ts`, `.agents/skills/{kata-verify,kata-review,kata-judge}/SKILL.md`.

**Blast-radius mix:** 2 on-disk, 1 cross-module (widest: cross-module).
**Coordination:** none.
**Class mix:** 0 polish / 3 redesign.

**Risk flag (highest in this review):** L2-03 removes the standard adversarial Verify pass. Landing it before L2-02 would reduce assurance without the evidence mapping that justifies the reduction. Keep strict/security escalation explicit, keep Review fresh-context and fail-closed, and record measured before/after defect-detection on at least one real task before deleting the path.

### Phase 5 — 持久化正确性

**Findings:** 3 — L3-01 (← L2-01), L3-02 (← L3-01), L3-04 (← L3-01).

**Files touched:** ~5 — `src/core/schema.ts`, `src/core/relations.ts`, `src/wiki/closure.ts`, `package.json` (validator dependency), `tests/unit/*` schema corpus.

**Blast-radius mix:** 3 on-disk.
**Coordination:** none (new runtime dependency must be bundled — `packages: 'external'` in `scripts/build.mjs` keeps it external, so it must be a real `dependencies` entry).
**Class mix:** 0 polish / 3 redesign.

**Risk flag:** on-disk format and schema semantics. Land the standard validator behind the existing error-wrapping and run the full artifact corpus before changing any writer.

### Phase 6 — 上下文与 I/O 经济

**Findings:** 5 — L1-03 (← L0-01), L1-04 (← L1-02), L3-03 (← L1-03), L4-01 (← L1-02), L4-03 (← L1-04).

**Files touched:** ~8 — `src/workflow/context-fabric.ts`, `src/workflow/seal-preflight.ts`, `src/wiki/context.ts`, `src/core/repository-identity.ts`, `src/quality/acceptance-matrix.ts`, `src/cli.ts`, `.agents/skills/kata*/SKILL.md`.

**Blast-radius mix:** 1 on-disk, 4 internal.
**Coordination:** none.
**Class mix:** 3 polish / 2 redesign.

**Why late:** every item here is a behavioral optimization whose correctness is judged by an equivalence or coverage test — those tests are cheaper and more trustworthy once Phase 3’s evidence contracts exist.

### Phase 7 — 评估并行与发布可信度

**Findings:** 1 — L5-03 (← L5-02).

**Files touched:** ~2 — `src/eval/runner.ts`, `src/eval/release-gates.ts`.

**Blast-radius mix:** 1 internal.
**Coordination:** none.
**Class mix:** 1 polish / 0 redesign.

**Risk flag:** opt-in only. Default stays serial so CI behavior is unchanged; the report must record the concurrency used.

### Dependency graph

```
Phase 1 (Foundation: entry, identity, baseline)
   ↓
   ├──► Phase 2 (Baseline & refresh loop)
   │        ↓
   │    Phase 3 (Evidence contract & check-level reuse)
   │        ↓
   │        ├──► Phase 4 (AC-scoped evidence & assurance boundary)  ⚠ assurance-affecting
   │        └──► Phase 5 (Durable correctness)                      ⚠ on-disk format
   │
   └──► Phase 6 (Context & I/O economy)   ← also needs Phase 1 (L1-02, L1-04)
                                 ↓
                            Phase 7 (Evaluation parallel & release confidence)
```

Phases 4 and 5 are independent of each other (disjoint files) and may run in parallel once Phase 3 lands. Phase 7’s only dependency is Phase 2 (L5-03 ← L5-02), so it may also be pulled forward at any point after Phase 2.
