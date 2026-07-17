# Context Fabric Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let any installed Kata adapter hand off a governed task on the same Git branch through a deterministic, validated context packet rather than platform chat history.

**Architecture:** Add a versioned `HandoffPacket` and receipt beside each task. A platform-neutral core builds and validates packet anchors from the current worktree, task state, selected Wiki and evidence; workflow/orient exposes it; adapters render identical consume/acknowledge instructions for their native UX.

**Tech Stack:** Node.js 20+, TypeScript 5+, JSON Schema, Vitest, existing Kata CLI and adapter registry.

## Global Constraints

- Scope is one Git worktree and branch; no remote transport, multi-clone reconciliation, provider API calls, or chat-history import.
- All canonical artifacts are repository-relative paths below `.kata/tasks/<task-id>/`; reject absolute paths and path traversal.
- Wiki provides project context only. CI, tests, Reviewer and Judge remain the code-correctness gates.
- A model route is an optional execution hint; it never attests to actual platform model selection.
- Preserve existing task, evidence, review, judge and model-route artifacts and public `createHandoff()` behavior during migration.

---

### Task 1: Define packet and receipt schemas

**Files:**
- Create: `schemas/handoff-packet.schema.json`, `schemas/handoff-receipt.schema.json`
- Modify: `src/core/layout.ts`, `src/core/schema.ts`
- Test: `tests/property/schema.property.test.ts`, `tests/unit/handoff.test.ts`

**Interfaces:**
- Produces `HandoffPacket` and `HandoffReceipt` schema validation through existing `validate<T>(schemaName, value)`.
- Requires `protocolVersion: 1`, task/role identifiers, repository anchors, relative paths, and packet SHA-256 in a receipt.

- [ ] **Step 1: Write failing schema tests** for a valid v1 packet, a packet with `../escape`, an absolute required-read path, a malformed receipt hash, and a receipt whose task id differs from its packet.
- [ ] **Step 2: Run** `node node_modules/vitest/dist/cli.js run tests/property/schema.property.test.ts tests/unit/handoff.test.ts`.

  Expected: FAIL because handoff schemas and validators do not exist.

- [ ] **Step 3: Add both JSON schemas and register their filenames in the schema/layout registry.** Require `repository.worktreeRoot` to equal `.` and make all `requiredReads`, `evidencePaths`, `priorArtifacts`, and `allowedWrites` relative strings without `..` segments.
- [ ] **Step 4: Run** `node node_modules/vitest/dist/cli.js run tests/property/schema.property.test.ts tests/unit/handoff.test.ts`.

  Expected: PASS.

- [ ] **Step 5: Commit** `feat(context): add handoff packet schemas`.

### Task 2: Build and verify the platform-neutral Context Fabric

**Files:**
- Create: `src/workflow/context-fabric.ts`
- Modify: `src/workflow/handoff.ts`, `src/core/context.ts`
- Test: `tests/unit/context-fabric.test.ts`, `tests/unit/handoff.test.ts`

**Interfaces:**
- `createContextPacket(input: CreateContextPacketInput): Promise<HandoffPacket>`
- `readContextPacket(root: string, taskId: string, id: string): Promise<HandoffPacket>`
- `verifyContextPacket(input: VerifyContextPacketInput): Promise<ContextPacketVerification>`

- [ ] **Step 1: Write failing tests** that initialize a task, create verified and stale Wiki records, create evidence, then expect a packet to contain verified records, exclude stale records, and include the current diff hash.
- [ ] **Step 2: Add failing tests** that mutate a tracked file after creation and expect `verifyContextPacket` to return `valid: false, reason: 'diff_mismatch'`; create a different branch fixture and expect `branch_mismatch`.
- [ ] **Step 3: Run** `node node_modules/vitest/dist/cli.js run tests/unit/context-fabric.test.ts tests/unit/handoff.test.ts`.

  Expected: FAIL because the Context Fabric module does not exist.

- [ ] **Step 4: Implement Git-anchor collection with `git rev-parse HEAD`, `git branch --show-current`, and the existing `computeDiffHash()`.** Treat unavailable Git metadata as `null` only when the packet is created and verified in the same non-Git worktree; otherwise return a structured verification failure.
- [ ] **Step 5: Implement deterministic packet construction.** Always include present orientation files, task/state files, selected authoritative Wiki paths, existing evidence/review/judge/repair/model-route file references, and role-derived write permissions. Sort all lists before serializing.
- [ ] **Step 6: Keep `createHandoff()` as a compatibility projection of the new packet.** Do not change its exported type in this task.
- [ ] **Step 7: Run** `node node_modules/vitest/dist/cli.js run tests/unit/context-fabric.test.ts tests/unit/handoff.test.ts`.

  Expected: PASS.

- [ ] **Step 8: Commit** `feat(context): create and verify deterministic handoff packets`.

### Task 3: Add acknowledgement receipts and CLI commands

**Files:**
- Modify: `src/cli.ts`, `src/workflow/context-fabric.ts`
- Test: `tests/unit/cli.test.ts`, `tests/e2e/workflow-resume.test.ts`

**Interfaces:**
- `kata handoff create --task <id> --from <role> --to <role> [--platform <name>]`
- `kata handoff show --task <id> --id <handoff-id>`
- `kata handoff verify --task <id> --id <handoff-id>`
- `kata handoff acknowledge --task <id> --id <handoff-id> --platform <name> [--role <role>]`

- [ ] **Step 1: Write failing CLI tests** for create printing a packet path and SHA-256, show returning the same canonical JSON, verify failing after a diff mutation, and acknowledge writing one receipt with the packet hash.
- [ ] **Step 2: Add failing tests** that attempt `--task ../escape`, `--id ../../packet`, or `--platform ../opencode` and assert no file outside the task handoff directory is created.
- [ ] **Step 3: Run** `node node_modules/vitest/dist/cli.js run tests/unit/cli.test.ts tests/e2e/workflow-resume.test.ts`.

  Expected: FAIL because the handoff command group is absent.

- [ ] **Step 4: Parse the `handoff` command group using existing CLI argument validation.** Write packets to `.kata/tasks/<task>/handoffs/<id>.json` and receipts to `.kata/tasks/<task>/handoffs/<id>.receipt.json`; use atomic writes already adopted by task/state code.
- [ ] **Step 5: Change `kata orient` to create or reference a current packet and emit only `handoff: { id, path, sha256, verificationCommand }`.** Retain the existing inline compatibility bundle temporarily under `legacyHandoff` to avoid breaking callers.
- [ ] **Step 6: Run** `node node_modules/vitest/dist/cli.js run tests/unit/cli.test.ts tests/e2e/workflow-resume.test.ts`.

  Expected: PASS.

- [ ] **Step 7: Commit** `feat(cli): add context handoff and acknowledgement commands`.

### Task 4: Make adapters consume the same contract

**Files:**
- Modify: `src/adapters/manifest.ts`, `src/adapters/ownership.ts`, `src/adapters/{codex,opencode,claude-code,generic}.ts`, `src/adapters/platforms.ts`
- Test: `tests/golden/adapters.test.ts`, `tests/unit/installer.test.ts`

**Interfaces:**
- Every rendered `/kata-*` Skill includes the exact `handoff verify`, required-read, acknowledgement, and role-artifact sequence.
- Adapter-specific content is limited to platform command syntax and documented capability limitations.

- [ ] **Step 1: Write golden tests** that render Codex, OpenCode, Claude Code, GitHub Copilot, and generic skills, extract their protocol block, and compare it to one normalized expected block.
- [ ] **Step 2: Write a failing test** asserting that platform skills call no provider API and do not claim that `platformOptions.model` was applied.
- [ ] **Step 3: Run** `node node_modules/vitest/dist/cli.js run tests/golden/adapters.test.ts tests/unit/installer.test.ts`.

  Expected: FAIL because generated skills do not reference the Context Fabric commands.

- [ ] **Step 4: Add a normalized “consume handoff” section to generated Skills.** It must say: verify packet; read every `requiredReads`; acknowledge with actual platform/role; obey packet permissions; then write only canonical role artifacts.
- [ ] **Step 5: Add an `executionHint` note that calls model routes advisory/auditable, not enforced model selection.** Do not create platform process launchers.
- [ ] **Step 6: Run** `node node_modules/vitest/dist/cli.js run tests/golden/adapters.test.ts tests/unit/installer.test.ts`.

  Expected: PASS.

- [ ] **Step 7: Commit** `feat(adapters): render portable context handoff instructions`.

### Task 5: Gate governed phases and document the operating model

**Files:**
- Modify: `src/core/state.ts`, `src/workflow/orchestrator.ts`, `docs/README.md`, `docs/operations.md`, `docs/platform-adapters.md`, `docs/configuration.md`, `docs/usage-guide.md`
- Create: `docs/context-fabric.md`
- Test: `tests/unit/state.test.ts`, `tests/e2e/workflow-regression.test.ts`, `tests/e2e/workflow-resume.test.ts`

**Interfaces:**
- Review/Judge receive only a packet that verifies against the current branch/diff.
- `ContextPacketVerification` has `valid: boolean`, `reason?: 'head_mismatch' | 'branch_mismatch' | 'diff_mismatch' | 'packet_hash_mismatch'`.

- [ ] **Step 1: Write failing state/e2e tests** in which a handoff is created, the diff changes, and Review/Judge transition is blocked until a new packet is created and acknowledged.
- [ ] **Step 2: Write a passing fixture** for an OpenCode implementer receipt followed by a GitHub Copilot reviewer receipt on the same branch, with both using the same task packet schema.
- [ ] **Step 3: Run** `node node_modules/vitest/dist/cli.js run tests/unit/state.test.ts tests/e2e/workflow-regression.test.ts tests/e2e/workflow-resume.test.ts`.

  Expected: FAIL because state/orchestrator do not yet consult packet freshness.

- [ ] **Step 4: Enforce packet verification at role handoff boundaries, not every local edit.** A changed diff requires a newly created packet before another role accepts the work; hard evidence rules remain unchanged.
- [ ] **Step 5: Write `docs/context-fabric.md` with same-worktree scope, command examples, packet/receipt semantics, platform-neutral responsibility boundaries, and the statement that Wiki is not correctness proof.** Update existing docs to link it and describe model routing as optional execution hint.
- [ ] **Step 6: Run** `node node_modules/typescript/lib/tsc.js --noEmit && node node_modules/vitest/dist/cli.js run && node node_modules/typescript/lib/tsc.js -p tsconfig.build.json`.

  Expected: PASS.

- [ ] **Step 7: Commit** `feat(workflow): enforce same-branch context handoffs`.

## Plan Self-Review

- AC-1 is covered by Tasks 2–4 and the cross-platform fixture in Task 5.
- AC-2 is covered by schemas, Git-anchor verification, receipts and phase-boundary tests in Tasks 1–3 and 5.
- AC-3 is covered by deterministic Wiki filtering and the explicit advisory model-route rule in Tasks 2 and 4–5.
- AC-4 is covered by adapter golden tests and the OpenCode-to-Copilot fixture in Tasks 4–5.
- The plan intentionally excludes remote synchronization and process/model launchers, preserving the same-worktree boundary.
