---
change: kata-foundation
design-doc: docs/superpowers/specs/2026-07-11-kata-foundation-design.md
base-ref: dca2f22b17f1b4777c9db1f09f518ad6b8ced012
---

# Kata Foundation 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `/app/kata` 构建以 Comet 外部运行时为底座、面向 Codex/Claude Code/OpenCode 的可安装 Skills 工作流，并用受治理 Wiki、证据门和模型策略降低 agent 对项目的无知且阻止不正确代码通过。

**Architecture:** Kata 通过公开 CLI/脚本/manifest 兼容 Comet，不导入 Comet 私有模块。`.kata/` 保存任务、证据、策略和 Wiki；Comet 负责基础 phase/guard/handoff，Kata 负责任务契约、上下文、模型权限、质量证据和 Wiki 晋升。所有平台适配器生成同一套 `/kata-*` Skills。

**Tech Stack:** Node.js 20+、TypeScript 5+、JSON Schema、Markdown front matter、Vitest、Zod/Ajv（选定一个 schema 校验库并全局复用）、npm 打包。

## Global Constraints

- 只在 `/app/kata` 开发；不创建远程仓库或 Git submodule。
- 不 fork Comet；仅通过公开 CLI、脚本和 manifest 边界集成，并由 `comet-compat.yaml` 固定兼容版本范围。
- Wiki 只能帮助理解项目；CI、lint、typecheck、测试、Reviewer 和 Judge 才能证明代码正确性。
- candidate/stale Wiki 不得进入 authoritative context；任何源冲突进入 `needs-clarification`。
- Judge 只读输入并输出结构化 PASS/FAIL，不修改代码；repair 必须回到 hard verification。
- 所有生成文件带 ownership/hash manifest；更新遇到用户修改必须报告冲突，禁止静默覆盖。
- 不提交 API key、运行时日志或本地 session 指针；`.kata/runtime/` 默认加入 `.gitignore`。

## 文件与模块地图

计划中的核心目录如下：

```text
kata/
├── package.json, tsconfig.json, vitest.config.ts
├── src/cli.ts
├── src/core/{schema,state,task,recovery,context}.ts
├── src/comet/{compat,client,guard}.ts
├── src/policy/{model-policy,permissions,escalation}.ts
├── src/quality/{evidence,reviewer,judge,repair}.ts
├── src/wiki/{record,store,provenance,drift,conflict,promotion,context}.ts
├── src/adapters/{manifest,discovery,ownership,codex,claude-code,opencode,generic}.ts
├── src/eval/{fixtures,metrics,runner,release-gates}.ts
├── schemas/*.json
├── templates/{kata-layout,skills,platforms}/
├── tests/unit, tests/property, tests/e2e, tests/golden
└── docs/{README,installation,configuration,wiki,operations,troubleshooting}.md
```

### Task 1: 建立 TypeScript workspace 与 Comet 兼容边界

**Files:**
- Create: `/app/kata/package.json`, `/app/kata/tsconfig.json`, `/app/kata/vitest.config.ts`, `/app/kata/src/cli.ts`
- Create: `/app/kata/src/comet/compat.ts`, `/app/kata/src/comet/client.ts`, `/app/kata/src/comet/guard.ts`, `/app/kata/comet-compat.yaml`
- Test: `/app/kata/tests/unit/comet-compat.test.ts`

**Interfaces:**
- `CometCompatibility { minVersion: string; maxVersion?: string; capabilities: Record<string, boolean> }`
- `CometClient { init(change: string): Promise<void>; status(change: string): Promise<CometStatus>; next(change: string): Promise<CometNext> }`
- `CometGuard { check(change: string, phase: string): Promise<GuardResult>; apply(change: string, phase: string): Promise<GuardResult> }`

- [x] **Step 1: Write failing compatibility tests** asserting public command invocation, version rejection outside range, and no import path containing `private`/`internal`.
- [x] **Step 2: Run `npm test -- tests/unit/comet-compat.test.ts`;** expected FAIL because workspace and interfaces do not exist.
- [x] **Step 3: Add strict package scripts**: `lint`, `typecheck`, `test`, `build`, `pack`; implement `CometClient` as a child-process boundary using argument arrays and captured JSON stdout.
- [x] **Step 4: Run `npm run typecheck && npm test -- tests/unit/comet-compat.test.ts`;** expected PASS.
- [x] **Step 5: Commit `chore: scaffold kata typescript workspace and comet boundary`.**

### Task 2: 定义 schema 与 `.kata` layout

**Files:**
- Create: `/app/kata/schemas/{task,workflow-state,evidence,review-finding,judge-result,model-policy,wiki-record}.schema.json`
- Create: `/app/kata/src/core/schema.ts`, `/app/kata/src/core/layout.ts`, `/app/kata/src/core/config.ts`
- Create: `/app/kata/tests/unit/layout.test.ts`, `/app/kata/tests/property/schema.property.test.ts`

**Interfaces:**
- `validate<T>(schemaName: string, value: unknown): T`
- `initLayout(root: string): Promise<LayoutResult>`
- `LayoutResult { created: string[]; existing: string[]; conflicts: string[] }`

- [x] **Step 1: Write failing tests** for required task acceptance IDs, evidence task/diff hash, Wiki statuses (`candidate|verified|stale|rejected`), and creation of `.kata/{rules,wiki,tasks,evidence,schemas,runtime}`.
- [x] **Step 2: Run `npm test -- tests/unit/layout.test.ts tests/property/schema.property.test.ts`;** expected FAIL.
- [x] **Step 3: Implement schemas and `initLayout`;** create `.gitignore` entries for `.kata/runtime/`, use atomic file writes, and reject malformed config before creating files.
- [x] **Step 4: Run `npm run typecheck && npm test -- tests/unit/layout.test.ts tests/property/schema.property.test.ts`;** expected PASS.
- [x] **Step 5: Commit `feat: add kata schemas and project layout`.**

### Task 3: 实现任务状态、恢复与上下文 manifest

**Files:**
- Create: `/app/kata/src/core/task.ts`, `/app/kata/src/core/state.ts`, `/app/kata/src/core/recovery.ts`, `/app/kata/src/core/context.ts`
- Test: `/app/kata/tests/unit/state.test.ts`, `/app/kata/tests/unit/recovery.test.ts`, `/app/kata/tests/unit/context.test.ts`, `/app/kata/tests/property/state.property.test.ts`

**Interfaces:**
- `createTask(input: CreateTaskInput): Promise<TaskRecord>`
- `transition(taskId: string, to: Phase, actor: Actor): Promise<StateRecord>`
- `recover(taskId: string): Promise<RecoveryDiagnostic>`
- `buildContextManifest(input: ContextRequest): Promise<ContextManifest>`

- [x] **Step 1: Write failing tests** for legal `intake→plan→implement→hardVerify→review→judge→distill→archive`, rejection of direct `implement→archive`, deterministic active-session pointer recovery, and exclusion of stale/candidate Wiki.
- [x] **Step 2: Run focused Vitest commands;** expected FAIL.
- [x] **Step 3: Implement append-only state events plus atomic current-state projection;** require acceptance IDs before `implement`, evidence/reviewer/judge gates before `distill`, and source-read warnings for stale Wiki.
- [x] **Step 4: Run `npm run typecheck && npm test -- tests/unit/state.test.ts tests/unit/recovery.test.ts tests/unit/context.test.ts tests/property/state.property.test.ts`;** expected PASS.
- [x] **Step 5: Commit `feat: implement task state recovery and context manifests`.**

### Task 4: 实现 `/kata-*` Skills 与平台安装器

**Files:**
- Create: `/app/kata/src/adapters/manifest.ts`, `discovery.ts`, `ownership.ts`, `codex.ts`, `claude-code.ts`, `opencode.ts`, `generic.ts`
- Create: `/app/kata/templates/skills/{kata,kata-open,kata-design,kata-build,kata-verify,kata-archive,kata-hotfix,kata-tweak}.md`
- Modify: `/app/kata/src/cli.ts`
- Test: `/app/kata/tests/golden/adapters.test.ts`, `/app/kata/tests/unit/installer.test.ts`

**Interfaces:**
- `discoverPlatforms(): Promise<PlatformInfo[]>`
- `install(platform: Platform, scope: InstallScope, options: InstallOptions): Promise<InstallReport>`
- `update(...)`, `uninstall(...)`, `renderSkill(command: SkillCommand, platform: Platform): string`

- [x] **Step 1: Write golden tests** requiring all first-release adapters to render the same normalized command manifest and preserve user-owned files.
- [x] **Step 2: Run `npm test -- tests/golden/adapters.test.ts tests/unit/installer.test.ts`;** expected FAIL.
- [x] **Step 3: Implement project/global discovery, capability flags, ownership/hash manifest, dry-run and conflict-safe writes;** add CLI commands `kata init`, `kata update`, `kata uninstall`.
- [x] **Step 4: Run `npm run build && npm test -- tests/golden/adapters.test.ts tests/unit/installer.test.ts`;** expected PASS.
- [x] **Step 5: Commit `feat: install kata skills across coding platforms`.**

### Task 5: 模型策略、权限与 repair loop

**Files:**
- Create: `/app/kata/src/policy/model-policy.ts`, `permissions.ts`, `escalation.ts`, `/app/kata/src/quality/repair.ts`
- Test: `/app/kata/tests/unit/model-policy.test.ts`, `/app/kata/tests/unit/permissions.test.ts`, `/app/kata/tests/unit/repair.test.ts`

**Interfaces:**
- `resolveRolePolicy(role: Role, config: ModelPolicy): ResolvedRolePolicy`
- `shouldEscalate(event: EscalationEvent, policy: ResolvedRolePolicy): EscalationDecision`
- `validateWrite(actor: Actor, path: string, task: TaskRecord): PermissionResult`
- `enforceRepairScope(finding: Finding, diff: DiffSummary): RepairScopeResult`

- [x] **Step 1: Write failing tests** for economy/capable/frontier roles, retry and diff budgets, protected rules/verified Wiki, escalation after two hard failures, and repair returning to `hardVerify`.
- [x] **Step 2: Run focused tests;** expected FAIL.
- [x] **Step 3: Implement policy resolution and permission checks** with vendor-neutral tiers and structured escalation events; reject unrelated repair paths.
- [x] **Step 4: Run `npm run typecheck && npm test -- tests/unit/model-policy.test.ts tests/unit/permissions.test.ts tests/unit/repair.test.ts`;** expected PASS.
- [x] **Step 5: Commit `feat: add model policy permissions and bounded repair`.**

### Task 6: 证据、Reviewer 与 Judge 质量门

**Files:**
- Create: `/app/kata/src/quality/evidence.ts`, `reviewer.ts`, `judge.ts`
- Test: `/app/kata/tests/e2e/quality-gates.test.ts`, `/app/kata/tests/unit/evidence.test.ts`

**Interfaces:**
- `collectEvidence(taskId: string, commands: CheckCommand[]): Promise<EvidenceEnvelope[]>`
- `checkFreshness(evidence: EvidenceEnvelope, diffHash: string): FreshnessResult`
- `recordFinding(input: ReviewFindingInput): Promise<ReviewFinding>`
- `judge(input: JudgeInput): Promise<JudgeResult>`

- [x] **Step 1: Write failing fixtures** for missing tests, stale evidence, blocking findings, Judge FAIL, bounded repair, and successful PASS with per-acceptance evidence references.
- [x] **Step 2: Run `npm test -- tests/unit/evidence.test.ts tests/e2e/quality-gates.test.ts`;** expected FAIL.
- [x] **Step 3: Implement bounded command execution with exit codes, redaction, environment summary, diff hash and CI import;** enforce read-only Judge output and no archive without fresh evidence.
- [x] **Step 4: Run focused tests and `npm run lint`;** expected PASS.
- [x] **Step 5: Commit `feat: enforce evidence reviewer and judge gates`.**

### Task 7: 受治理 Wiki 生命周期与联动

**Files:**
- Create: `/app/kata/src/wiki/{record,store,provenance,drift,conflict,promotion,context}.ts`
- Create: `/app/kata/src/cli/wiki.ts`
- Test: `/app/kata/tests/unit/wiki-governance.test.ts`, `/app/kata/tests/e2e/wiki-lifecycle.test.ts`

**Interfaces:**
- `proposeFromPassedTask(taskId: string): Promise<WikiRecord[]>`
- `verifySources(): Promise<DriftReport>`
- `checkConflicts(record: WikiRecord): Promise<ConflictReport>`
- `promote(id: string, approval: ApprovalEvent): Promise<WikiRecord>`
- `selectAuthoritativeContext(request: WikiContextRequest): Promise<WikiRecord[]>`

- [ ] **Step 1: Write failing tests** proving failed tasks, unapproved candidates, stale sources and conflicts cannot become `verified`.
- [ ] **Step 2: Run Wiki tests;** expected FAIL.
- [ ] **Step 3: Implement Markdown/front-matter records** with source paths/symbols/hashes, candidate generation only from PASS tasks, `wiki verify`, conflict routing to `needs-clarification`, explicit approval events, and `wiki promote` guards.
- [ ] **Step 4: Run `npm test -- tests/unit/wiki-governance.test.ts tests/e2e/wiki-lifecycle.test.ts`;** expected PASS.
- [ ] **Step 5: Commit `feat: add governed wiki lifecycle and context selection`.**

### Task 8: CLI workflow orchestration与 Comet handoff

**Files:**
- Modify: `/app/kata/src/cli.ts`, `/app/kata/src/comet/client.ts`
- Create: `/app/kata/src/workflow/orchestrator.ts`, `/app/kata/src/workflow/handoff.ts`
- Test: `/app/kata/tests/e2e/workflow-resume.test.ts`

**Interfaces:**
- `runCommand(command: KataCommand, input: string): Promise<CommandResult>`
- `advance(taskId: string): Promise<PhaseResult>`
- `createHandoff(taskId: string, nextRole: Role): Promise<HandoffBundle>`

- [ ] **Step 1: Write an end-to-end failing test** for `/kata-open` creating a task, `/kata-build` consuming minimal context, `/kata-verify` blocking on failed checks, and resume continuing from recorded phase.
- [ ] **Step 2: Run `npm test -- tests/e2e/workflow-resume.test.ts`;** expected FAIL.
- [ ] **Step 3: Implement orchestration** that delegates base lifecycle operations to Comet, persists Kata contracts/evidence, and emits deterministic next-action diagnostics on compatibility failure.
- [ ] **Step 4: Run `npm run build && npm test -- tests/e2e/workflow-resume.test.ts`;** expected PASS.
- [ ] **Step 5: Commit `feat: orchestrate kata skills with comet lifecycle`.**

### Task 9: 评估、发布门与文档

**Files:**
- Create: `/app/kata/src/eval/{fixtures,metrics,runner,release-gates}.ts`, `/app/kata/tests/eval/workflow-regression.test.ts`
- Create: `/app/kata/docs/{README,installation,configuration,wiki,operations,troubleshooting}.md`
- Modify: `/app/kata/package.json`

**Interfaces:**
- `runEvaluation(manifest: EvaluationManifest): Promise<EvaluationReport>`
- `computeMetrics(runs: EvaluationRun[]): EvaluationMetrics`
- `checkReleaseGates(report: EvaluationReport): ReleaseGateResult`

- [ ] **Step 1: Write failing regression fixtures** for open/resume/implement/verify/repair/judge/distill/archive, adapter smoke tests and Wiki drift/conflict.
- [ ] **Step 2: Run `npm test -- tests/eval/workflow-regression.test.ts`;** expected FAIL.
- [ ] **Step 3: Implement metrics** for acceptance pass rate, repair/escalation rate, cost/tokens, latency and Wiki rejection; add release gates for schemas/state, evidence freshness, adapters and governance.
- [ ] **Step 4: Write onboarding and rollback docs** with concrete commands (`npm install`, `kata init`, `/kata-open`, `kata wiki verify`) and safety boundaries.
- [ ] **Step 5: Run `npm run lint && npm run typecheck && npm test && npm run build`;** expected all PASS.
- [ ] **Step 6: Commit `feat: add evaluation release gates and documentation`.**

### Task 10: `/app` dogfood 与首份评估报告

**Files:**
- Create: `/app/kata/evals/dogfood-app.yaml`, `/app/kata/docs/evaluations/2026-07-11-app-dogfood.md`
- Test: `/app/kata/tests/e2e/dogfood-config.test.ts`

**Interfaces:**
- `loadEvaluationManifest(path: string): EvaluationManifest`
- `persistEvaluationReport(path: string, report: EvaluationReport): Promise<void>`

- [ ] **Step 1: Write a manifest test** requiring the `/app` fixture to specify acceptance IDs, hard-check commands, Wiki scope and model tiers.
- [ ] **Step 2: Run `npm test -- tests/e2e/dogfood-config.test.ts`;** expected FAIL until the manifest exists.
- [ ] **Step 3: Add the manifest and execute `kata eval evals/dogfood-app.yaml`;** store command outputs and metrics under the report without credentials.
- [ ] **Step 4: Run `npm test -- tests/e2e/dogfood-config.test.ts` and inspect the report;** expected PASS with explicit failures retained as evidence if the dogfood task is not fully successful.
- [ ] **Step 5: Commit `test: record first app dogfood evaluation`.**

## Spec 覆盖检查

- Comet 外部边界、兼容版本与失败阻断：Tasks 1、8。
- `.kata` layout、状态恢复与非法流转：Tasks 2、3。
- Codex/Claude Code/OpenCode/generic Skills、ownership/hash 与幂等安装：Task 4。
- economy/capable/frontier、预算、权限、升级和 repair：Task 5。
- lint/typecheck/test/security/CI 证据、Reviewer、Judge 与 freshness：Task 6。
- candidate/verified/stale/rejected、来源 hash、冲突、晋升和上下文选择：Task 7。
- 跨平台回归、指标、release gate、文档与 dogfood：Tasks 9、10。

完成上述任务后，Kata 才允许进入 Comet `archive`；任何未通过的 hard gate、Reviewer blocking finding、Judge FAIL 或 Wiki provenance 冲突都必须保留在任务证据中并阻止归档。
