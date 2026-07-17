## 1. Project and Comet foundation

- [x] 1.1 Create the Node.js/TypeScript package workspace under `/app/kata` with strict lint, typecheck, test, build, and package scripts.
- [x] 1.2 Define the Comet compatibility boundary, supported version range, and adapter-facing runtime interfaces without importing private Comet internals.
- [x] 1.3 Add versioned JSON Schemas for Task, workflow state, evidence envelope, review finding, Judge result, model policy, and Wiki record.
- [x] 1.4 Implement the local `.kata/` layout initializer with safe defaults, Git ignore rules for runtime state, and configuration validation.
- [x] 1.5 Implement task creation, active-session pointers, state transitions, phase guards, status JSON, and deterministic recovery diagnostics.
- [x] 1.6 Add unit and property tests proving invalid transitions cannot reach distill/archive and interrupted tasks resume at the recorded phase.

## 2. Skills and platform adapters

- [x] 2.1 Define the normalized Skill command manifest for `/kata`, `/kata-open`, `/kata-design`, `/kata-build`, `/kata-verify`, `/kata-archive`, `/kata-hotfix`, and `/kata-tweak`.
- [x] 2.2 Implement project/global platform discovery and ownership/hash manifests for generated files.
- [x] 2.3 Implement Codex, Claude Code, and OpenCode adapters using each platform's native Skill/command conventions.
- [x] 2.4 Implement the generic fallback adapter and capability declaration for tools without hooks or sub-agents.
- [x] 2.5 Implement idempotent `init`, conflict-safe `update`, dry-run, and uninstall behavior that preserves user-owned files.
- [x] 2.6 Add golden adapter tests comparing normalized command/protocol manifests across all first-release platforms.

## 3. Model policy and execution protocol

- [x] 3.1 Implement vendor-neutral economy/capable/frontier role configuration, per-task budgets, retry limits, and escalation events.
- [x] 3.2 Implement minimal context manifest generation with rule, Wiki, source, test, and task artifact entries and read-before-write metadata.
- [x] 3.3 Implement structured implementer, reviewer, Judge, and repair input/output validators with role-specific write permissions.
- [x] 3.4 Implement repair-scope enforcement, file/diff budgets, bounded retries, and return-to-hard-verification behavior.
- [x] 3.5 Add tests for escalation triggers, invalid structured output, budget exhaustion, unauthorized writes, and unrelated repair changes.

## 4. Evidence and quality gates

- [x] 4.1 Implement evidence collection for configured lint, typecheck, unit/integration test, security, and CI commands with bounded logs and diff hashes.
- [x] 4.2 Implement evidence freshness checks, environment summaries, redaction, and evidence index lookup by task and acceptance ID.
- [x] 4.3 Implement Reviewer finding schema, blocking/severity handling, and resolution tracking.
- [x] 4.4 Implement read-only Judge execution contract that emits per-acceptance PASS/FAIL with evidence references and bounded repair instructions.
- [x] 4.5 Add end-to-end fixtures for missing tests, stale evidence, Reviewer blocking findings, Judge failure, repair, and successful verification.

## 5. Governed Wiki

- [x] 5.1 Implement Markdown/front-matter WikiRecord storage, source reference normalization, source hash index, and schema validation.
- [x] 5.2 Implement candidate generation from passed tasks only, including task/diff/evidence provenance and non-authoritative status.
- [x] 5.3 Implement `wiki verify` drift detection for changed/missing sources and mark affected records stale.
- [x] 5.4 Implement conflict checks against rules, approved ADR/specs, tests, contracts, and source code; route conflicts to `needs-clarification`.
- [x] 5.5 Implement explicit reviewer/human approval events and `wiki promote` with promotion guards.
- [x] 5.6 Implement task-scoped Wiki context selection that excludes stale/candidate records from authoritative context and emits source-read warnings.
- [x] 5.7 Add governance tests proving failed tasks, unapproved candidates, stale sources, and conflicting records cannot become verified Wiki.

## 6. Evaluation and release

- [x] 6.1 Build repeatable workflow fixtures for open, resume, implement, verify, repair, judge, distill, and archive paths.
- [x] 6.2 Implement evaluation metrics for acceptance pass rate, repair count, escalation rate, cost/tokens, latency, and Wiki rejection rate.
- [x] 6.3 Add installer/update/uninstall compatibility tests and representative Codex/Claude Code/OpenCode end-to-end smoke tests.
- [x] 6.4 Add release gates for core schemas/state machine, Wiki governance, evidence freshness, adapters, and workflow evaluation regressions.
- [x] 6.5 Document installation, project onboarding, model policy configuration, Wiki lifecycle, troubleshooting, and safe migration/rollback.
- [x] 6.6 Run a dogfood task against `/app` using the generated Skills and record the first evaluation report before publishing a package.
