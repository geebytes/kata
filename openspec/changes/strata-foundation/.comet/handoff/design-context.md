# Comet Design Handoff

- Change: kata-foundation
- Phase: design
- Mode: compact
- Context hash: cc3abc171787ba1153109dd32dba7b1bc0f3a000411db5064744f4eb985a9a9d

Generated-by: comet-handoff.sh

OpenSpec remains the canonical capability spec. This handoff is a deterministic, source-traceable context pack, not an agent-authored summary.

## openspec/changes/kata-foundation/proposal.md

- Source: openspec/changes/kata-foundation/proposal.md
- Lines: 1-35
- SHA256: 9bea03021716690a227e1b584f5ee8f5ba856cfe5018de9f14e1b9700e79d053

```md
## Why

AI coding tools can generate code quickly, but each tool currently has its own skills, prompts, task state, and memory. Project knowledge is often copied into an LLM wiki without provenance, so agents become more confident without becoming more correct. Kata provides a Comet-based, cross-tool workflow whose Wiki improves project understanding while CI, tests, Reviewer, and Judge remain the correctness gates.

## What Changes

- Create an independently installable Node.js project under `/app/kata/`, using Comet as the workflow/runtime foundation.
- Provide platform adapters and distributable Skills for Codex, Claude Code, OpenCode, and a generic fallback adapter.
- Add resumable task lifecycle commands and slash-command Skills such as `/kata`, `/kata-open`, `/kata-design`, `/kata-build`, `/kata-verify`, and `/kata-archive`.
- Add vendor-neutral model tiers, budgets, escalation rules, and structured role protocols for planning, implementation, review, judging, and distillation.
- Add hard evidence collection for lint, typecheck, tests, CI, and reviewer findings; prevent Judge or Wiki summaries from bypassing evidence gates.
- Add a governed Wiki with source references, content hashes, verification status, drift detection, conflict blocking, candidate promotion, and task-scoped context manifests.
- Add workflow/skill evaluation, cost and reliability metrics, adapter compatibility tests, and installation/update/doctor release gates.

## Capabilities

### New Capabilities

- `workflow-runtime`: Comet-based resumable state machine, task artifacts, guards, handoff, CLI, and slash-command lifecycle.
- `platform-skills`: Cross-platform installation and thin adapters for Codex, Claude Code, OpenCode, and generic skill-capable tools.
- `model-policy-and-evidence`: Model tiers, budgets, escalation, evidence envelopes, Reviewer/Judge contracts, and repair loops.
- `governed-wiki`: Provenance-aware Wiki records, source hashing, drift/conflict detection, context manifests, candidate promotion, and verified memory.
- `evaluation-and-release`: Workflow evaluation, compatibility fixtures, cost/reliability metrics, and safe install/update/uninstall release gates.

### Modified Capabilities

- None.

## Impact

- New Node.js/TypeScript project files under `/app/kata/` with Comet/OpenSpec integration points.
- Generated platform Skill directories and adapter manifests for supported AI coding tools.
- New `.kata/` project data contract for task state, rules, Wiki, evidence, and runtime pointers.
- No changes to the existing exam-highlight runtime or generated protobuf/database files.
- Model providers remain configuration-driven; API credentials stay outside repository files.
```

## openspec/changes/kata-foundation/design.md

- Source: openspec/changes/kata-foundation/design.md
- Lines: 1-182
- SHA256: 9eb55c7432d36399d11ac4c6556aa29611dd7e8cea60cbcf2ef9907a2b9acf03

[TRUNCATED]

```md
## Context

Kata is an independent project under `/app/kata/`. It uses the Comet project pattern as its workflow foundation: a Node.js CLI installs platform-specific Skills, keeps task state in the repository, and resumes long-running work through guarded phases. The new behavior is a governed Wiki and evidence protocol, not a second workflow engine.

The main design constraint is epistemic separation:

```text
rules / approved ADR / contracts  = normative intent
code + tests + CI                  = implementation and executable evidence
reviewer                           = engineering risk review
judge                              = acceptance decision from evidence
wiki                               = derived, source-linked project understanding
```

The first release targets Codex, Claude Code, and OpenCode, then extends through a generic adapter contract. The core runtime must not depend on any provider API or store credentials in Git.

## Goals / Non-Goals

**Goals:**

- Reuse Comet-compatible lifecycle concepts, guards, handoff, Skills, and installation behavior while keeping Kata-owned extensions isolated.
- Make `/kata-*` commands available through multiple AI coding tools while preserving one task state and one evidence model.
- Give low-cost implementers narrow, task-scoped context and bounded repair budgets.
- Make Wiki records provenance-aware, hashable, drift-aware, conflict-aware, and explicitly promotable.
- Make hard checks and Judge decisions machine-readable and impossible to bypass with Wiki summaries.
- Provide a staged implementation path that can be built and evaluated incrementally.

**Non-Goals:**

- Reimplementing Comet's generic workflow engine or copying its implementation wholesale.
- Building a hosted Wiki, model gateway, or centralized telemetry service in the first release.
- Treating LLM summaries as requirements, proof, or an automatic source of rules.
- Guaranteeing identical hooks or sub-agent behavior on platforms that do not expose those capabilities.
- Changing the existing `/app` exam-highlight runtime.

## Decisions

### 1. Comet-compatible shell with Kata-owned core extensions

The package will be a TypeScript/Node.js CLI with Comet-style commands and distributable Skill bundles. The runtime will use an adapter boundary rather than importing Comet internals as an unstable library dependency. A compatibility layer may invoke installed Comet scripts/skills where available, while Kata records its own task, evidence, and Wiki metadata.

Alternatives considered:

- **Fork Comet wholesale**: rejected because upstream changes would become difficult to merge and Wiki semantics would be coupled to implementation details.
- **Build a new workflow engine**: rejected because it duplicates the most proven part of the existing model and would delay the Wiki/evidence value.
- **Use Comet only as documentation**: rejected because resumability, phase guards, and platform installation are core product behavior.

### 2. Repository layout and storage contract

The package source is organized as:

```text
src/
  cli/             command handlers
  core/            state machine, schemas, guards, handoff
  adapters/        codex, claude-code, opencode, generic
  installer/       discovery, manifest, update/uninstall
  policy/          model tiers, budgets, escalation
  evidence/        command/CI/reviewer envelopes
  wiki/            records, hash index, drift, promotion
  eval/            fixtures, metrics, report writers
templates/         Skill and platform templates
schemas/           JSON Schemas for task/evidence/wiki/state
```

Each consuming repository receives:

```text
.kata/
  config.yaml
  model-policy.yaml
  workflow.yaml
  rules/
  wiki/
  tasks/<task-id>/
  evidence/<task-id>/
  runtime/
```

`.kata/runtime` is local session state and is ignored by default. Rules, Wiki, tasks, evidence summaries, and manifests are Git-tracked so another developer or tool can resume.
```

Full source: openspec/changes/kata-foundation/design.md

## openspec/changes/kata-foundation/tasks.md

- Source: openspec/changes/kata-foundation/tasks.md
- Lines: 1-52
- SHA256: 744dd724ad02858773dba1e5587dbe8ed2dfeb270449ae7658ee50274fe54730

```md
## 1. Project and Comet foundation

- [ ] 1.1 Create the Node.js/TypeScript package workspace under `/app/kata` with strict lint, typecheck, test, build, and package scripts.
- [ ] 1.2 Define the Comet compatibility boundary, supported version range, and adapter-facing runtime interfaces without importing private Comet internals.
- [ ] 1.3 Add versioned JSON Schemas for Task, workflow state, evidence envelope, review finding, Judge result, model policy, and Wiki record.
- [ ] 1.4 Implement the local `.kata/` layout initializer with safe defaults, Git ignore rules for runtime state, and configuration validation.
- [ ] 1.5 Implement task creation, active-session pointers, state transitions, phase guards, status JSON, and deterministic recovery diagnostics.
- [ ] 1.6 Add unit and property tests proving invalid transitions cannot reach distill/archive and interrupted tasks resume at the recorded phase.

## 2. Skills and platform adapters

- [ ] 2.1 Define the normalized Skill command manifest for `/kata`, `/kata-open`, `/kata-design`, `/kata-build`, `/kata-verify`, `/kata-archive`, `/kata-hotfix`, and `/kata-tweak`.
- [ ] 2.2 Implement project/global platform discovery and ownership/hash manifests for generated files.
- [ ] 2.3 Implement Codex, Claude Code, and OpenCode adapters using each platform's native Skill/command conventions.
- [ ] 2.4 Implement the generic fallback adapter and capability declaration for tools without hooks or sub-agents.
- [ ] 2.5 Implement idempotent `init`, conflict-safe `update`, dry-run, and uninstall behavior that preserves user-owned files.
- [ ] 2.6 Add golden adapter tests comparing normalized command/protocol manifests across all first-release platforms.

## 3. Model policy and execution protocol

- [ ] 3.1 Implement vendor-neutral economy/capable/frontier role configuration, per-task budgets, retry limits, and escalation events.
- [ ] 3.2 Implement minimal context manifest generation with rule, Wiki, source, test, and task artifact entries and read-before-write metadata.
- [ ] 3.3 Implement structured implementer, reviewer, Judge, and repair input/output validators with role-specific write permissions.
- [ ] 3.4 Implement repair-scope enforcement, file/diff budgets, bounded retries, and return-to-hard-verification behavior.
- [ ] 3.5 Add tests for escalation triggers, invalid structured output, budget exhaustion, unauthorized writes, and unrelated repair changes.

## 4. Evidence and quality gates

- [ ] 4.1 Implement evidence collection for configured lint, typecheck, unit/integration test, security, and CI commands with bounded logs and diff hashes.
- [ ] 4.2 Implement evidence freshness checks, environment summaries, redaction, and evidence index lookup by task and acceptance ID.
- [ ] 4.3 Implement Reviewer finding schema, blocking/severity handling, and resolution tracking.
- [ ] 4.4 Implement read-only Judge execution contract that emits per-acceptance PASS/FAIL with evidence references and bounded repair instructions.
- [ ] 4.5 Add end-to-end fixtures for missing tests, stale evidence, Reviewer blocking findings, Judge failure, repair, and successful verification.

## 5. Governed Wiki

- [ ] 5.1 Implement Markdown/front-matter WikiRecord storage, source reference normalization, source hash index, and schema validation.
- [ ] 5.2 Implement candidate generation from passed tasks only, including task/diff/evidence provenance and non-authoritative status.
- [ ] 5.3 Implement `wiki verify` drift detection for changed/missing sources and mark affected records stale.
- [ ] 5.4 Implement conflict checks against rules, approved ADR/specs, tests, contracts, and source code; route conflicts to `needs-clarification`.
- [ ] 5.5 Implement explicit reviewer/human approval events and `wiki promote` with promotion guards.
- [ ] 5.6 Implement task-scoped Wiki context selection that excludes stale/candidate records from authoritative context and emits source-read warnings.
- [ ] 5.7 Add governance tests proving failed tasks, unapproved candidates, stale sources, and conflicting records cannot become verified Wiki.

## 6. Evaluation and release

- [ ] 6.1 Build repeatable workflow fixtures for open, resume, implement, verify, repair, judge, distill, and archive paths.
- [ ] 6.2 Implement evaluation metrics for acceptance pass rate, repair count, escalation rate, cost/tokens, latency, and Wiki rejection rate.
- [ ] 6.3 Add installer/update/uninstall compatibility tests and representative Codex/Claude Code/OpenCode end-to-end smoke tests.
- [ ] 6.4 Add release gates for core schemas/state machine, Wiki governance, evidence freshness, adapters, and workflow evaluation regressions.
- [ ] 6.5 Document installation, project onboarding, model policy configuration, Wiki lifecycle, troubleshooting, and safe migration/rollback.
- [ ] 6.6 Run a dogfood task against `/app` using the generated Skills and record the first evaluation report before publishing a package.
```

## openspec/changes/kata-foundation/specs/evaluation-and-release/spec.md

- Source: openspec/changes/kata-foundation/specs/evaluation-and-release/spec.md
- Lines: 1-22
- SHA256: b496394a13be150271a38465d42d3f165cd1e8e48c45c430eaf6e0c504792672

```md
## ADDED Requirements

### Requirement: Cross-platform compatibility fixtures
The project SHALL test that each supported adapter installs the same command manifest, task schema, and guard contract.

#### Scenario: Adapter manifest comparison
- **WHEN** Codex, Claude Code, and OpenCode fixtures are generated
- **THEN** their normalized command and protocol manifests SHALL be equivalent

### Requirement: Workflow evaluation
The evaluation harness SHALL measure task pass rate, acceptance pass rate, repair count, escalation rate, token/cost usage, latency, and Wiki rejection rate using repeatable task fixtures.

#### Scenario: Cost regression
- **WHEN** a workflow revision increases cost beyond its configured threshold without improving acceptance pass rate
- **THEN** the release evaluation SHALL fail or mark the revision for review

### Requirement: Release safety
Release SHALL require passing core state-machine tests, Wiki governance tests, installer/update/uninstall tests, adapter fixtures, and representative end-to-end workflow evaluations.

#### Scenario: Update would overwrite user files
- **WHEN** the release test detects an unconfirmed overwrite path
- **THEN** the release gate SHALL fail
```

## openspec/changes/kata-foundation/specs/governed-wiki/spec.md

- Source: openspec/changes/kata-foundation/specs/governed-wiki/spec.md
- Lines: 1-36
- SHA256: 9419e3aca8d61e12a619c45bd33a234ca18dc58b9809a66fae9bc71697efc22a

```md
## ADDED Requirements

### Requirement: Provenance-aware Wiki records
Every verified Wiki record SHALL include a statement, scope, source paths or symbols, source hashes, validation task, evidence references, status, and last verification time.

#### Scenario: Source is missing
- **WHEN** a Wiki record references a deleted source file
- **THEN** the record SHALL become `stale` and SHALL be excluded from authoritative task context

### Requirement: Candidate-only distillation
The system SHALL create Wiki candidates only from tasks that passed hard verification, review, and Judge gates; candidate creation SHALL not automatically promote a record.

#### Scenario: Failed task summary
- **WHEN** a task fails Judge or has stale evidence
- **THEN** Wiki distillation SHALL refuse to create a verified record from that task

### Requirement: Drift and conflict blocking
The Wiki subsystem SHALL detect source-hash drift and conflicts with rules, approved ADR/specs, tests, or current code, and SHALL surface conflicts before implementation proceeds.

#### Scenario: Wiki contradicts an approved ADR
- **WHEN** a Wiki statement conflicts with an approved ADR
- **THEN** the task SHALL enter `needs-clarification` and low-cost implementation SHALL be blocked

### Requirement: Task-scoped Wiki context
The system SHALL generate a minimal context manifest and SHALL distinguish verified Wiki guidance from normative rules and original sources.

#### Scenario: Critical implementation rule
- **WHEN** a task touches an area covered by a verified rule and related Wiki entry
- **THEN** the manifest SHALL include the rule, Wiki status/source summary, and a read-before-write source reference

### Requirement: Explicit promotion
Promotion to verified Wiki SHALL require schema validation, source availability, evidence linkage, and an explicit reviewer or human approval event.

#### Scenario: Unreviewed candidate
- **WHEN** a candidate has valid YAML but no approval event
- **THEN** promotion SHALL fail and the candidate SHALL remain non-authoritative
```

## openspec/changes/kata-foundation/specs/model-policy-and-evidence/spec.md

- Source: openspec/changes/kata-foundation/specs/model-policy-and-evidence/spec.md
- Lines: 1-29
- SHA256: 63f0589cef1a0fc49b82433dafebe463b8c8029edd37b343fe92c1940c83bbe1

```md
## ADDED Requirements

### Requirement: Vendor-neutral model policy
The runtime SHALL route roles through capability tiers, budgets, and escalation rules without requiring a specific model vendor or storing credentials in repository files.

#### Scenario: Economy implementation fails twice
- **WHEN** an economy implementer reaches the configured repair limit
- **THEN** the runtime SHALL escalate to the configured capable/frontier role or stop with a retryable failure

### Requirement: Immutable evidence envelopes
The evidence subsystem SHALL record command, environment summary, exit status, timestamps, relevant diff hash, and bounded logs for lint, typecheck, tests, CI, and reviewer results.

#### Scenario: Evidence does not match the diff
- **WHEN** the current diff hash differs from the evidence envelope hash
- **THEN** the evidence SHALL be marked stale and SHALL not satisfy a Judge acceptance condition

### Requirement: Independent Judge protocol
The Judge SHALL receive acceptance criteria, diff, evidence, and relevant sources and SHALL return structured PASS/FAIL results without modifying code or acceptance criteria.

#### Scenario: Missing boundary test
- **WHEN** an acceptance condition lacks a passing test or equivalent hard evidence
- **THEN** the Judge SHALL return FAIL with the acceptance identifier and a bounded repair scope

### Requirement: Bounded repair loop
The runtime SHALL permit repair only for failed acceptance conditions and SHALL return every repair to hard verification before another Judge decision.

#### Scenario: Repair changes unrelated files
- **WHEN** a repair diff exceeds its failed scope or configured file/diff budget
- **THEN** the runtime SHALL block the loop and require a new planning decision
```

## openspec/changes/kata-foundation/specs/platform-skills/spec.md

- Source: openspec/changes/kata-foundation/specs/platform-skills/spec.md
- Lines: 1-22
- SHA256: 6f96f238abb4b324ff59954f376a873737c5aabc98da227e776553c8816c7509

```md
## ADDED Requirements

### Requirement: Capability-based adapters
The installer SHALL model platform support as capabilities such as skills, hooks, sub-agents, and model selection rather than assuming identical tool features.

#### Scenario: Partial platform support
- **WHEN** a platform supports Skills but not write hooks
- **THEN** the installer SHALL install the Skill adapter and declare guard enforcement as CLI/CI-only

### Requirement: Safe installation and update
The installer SHALL support project/global scopes, detect owned files by manifest and hash, preserve user-owned files, and provide idempotent update and uninstall operations.

#### Scenario: User customization during update
- **WHEN** a generated adapter file has been modified by the user
- **THEN** `kata update` SHALL report the conflict and SHALL NOT overwrite it without explicit confirmation

### Requirement: Generic fallback adapter
The distribution SHALL provide a generic adapter using repository instructions and explicit CLI commands for tools without native Skill support.

#### Scenario: Unsupported tool
- **WHEN** `kata init` cannot identify a native adapter
- **THEN** it SHALL offer the generic adapter and report which automatic hooks are unavailable
```

## openspec/changes/kata-foundation/specs/workflow-runtime/spec.md

- Source: openspec/changes/kata-foundation/specs/workflow-runtime/spec.md
- Lines: 1-29
- SHA256: b7532670d3b536f9c04da40b86979eea0f822fedba63ad9b0f6353a62168079d

```md
## ADDED Requirements

### Requirement: Resumable task lifecycle
The runtime SHALL persist task status, phase, artifact paths, active session, and verification outcome so a new session can resume without relying on conversation history.

#### Scenario: Resume an interrupted task
- **WHEN** a session starts with an active task whose status is `implementing`
- **THEN** the runtime SHALL report the next permitted action and SHALL NOT restart planning or silently skip guards

### Requirement: Guarded phase transitions
The runtime SHALL reject phase transitions unless required artifacts, evidence, and user decisions for that transition are present.

#### Scenario: Verify cannot be skipped
- **WHEN** a task has a code diff but no passing hard-check evidence
- **THEN** a transition to `judging`, `distilling`, or `archived` SHALL fail with machine-readable missing requirements

### Requirement: Slash-command workflow
The distribution SHALL expose `/kata`, `/kata-open`, `/kata-design`, `/kata-build`, `/kata-verify`, `/kata-archive`, `/kata-hotfix`, and `/kata-tweak` Skills that call the same runtime protocol.

#### Scenario: Tool-neutral command behavior
- **WHEN** `/kata-open` is invoked through two supported coding tools
- **THEN** both tools SHALL create the same task schema and phase state

### Requirement: Protected workflow facts
The runtime SHALL keep task acceptance criteria, workflow state, evidence references, and verified Wiki records outside the write authority of implementer agents.

#### Scenario: Implementer attempts to weaken acceptance
- **WHEN** an implementer changes an acceptance criterion or verified Wiki record
- **THEN** the runtime SHALL reject the write and emit an authorization finding
```

