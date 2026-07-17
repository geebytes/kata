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

### 3. One state machine, multiple platform adapters

The core states are `planning`, `implementing`, `hardVerifying`, `reviewing`, `judging`, `repairing`, `distilling`, `archiving`, `completed`, `blocked`, and `needs-clarification`. Each transition is an event validated against the task schema and evidence index.

```text
open → design → build → hardVerify → review → judge
                                      │          ├─ pass → distill → archive
                                      │          └─ fail → repair ─────┘
```

Platform adapters expose the same normalized command manifest. They may use native Skills, hooks, sub-agents, or only repository instructions, but they never own phase state. If a platform lacks a capability, the adapter declares the limitation and the CLI/CI guard remains authoritative.

### 4. Typed artifact contracts

All cross-role communication uses versioned JSON Schema documents:

- `Task`: id, scope, acceptance IDs, non-goals, branch/worktree, phase, active role, manifest refs.
- `EvidenceEnvelope`: command/provider, exit status, start/end time, diff hash, environment fingerprint, bounded log ref, tool version.
- `ReviewFinding`: severity, source, acceptance IDs, file/symbol refs, status, repair scope.
- `JudgeResult`: PASS/FAIL, per-acceptance result, evidence refs, reason, repair instruction.
- `WikiRecord`: statement, kind, scope, sources, source hashes, validation task/evidence, status, timestamps.

Invalid or extra-role outputs are rejected before state mutation. Secrets are redacted from logs and never included in manifests or Wiki records.

### 5. Model policy as capability tiers

`model-policy.yaml` defines `economy`, `capable`, and `frontier` roles, allowed operations, cost limits, retry limits, and escalation triggers. Provider/model names are configuration values, not code branches. Planner, reviewer, judge, and distiller default to frontier; implement/test/first-repair defaults to economy.

An economy worker is escalated after repeated hard-check failure, structured-output failure, source conflict, security-sensitive scope, budget overrun, or ambiguous acceptance. A repair worker can modify only the failed acceptance scope and must return to hard verification.

### 6. Evidence before Judge; Judge before Wiki

The verification pipeline is deliberately ordered:

```text
collect lint/typecheck/test/CI evidence
→ check diff and evidence hashes
→ Reviewer findings
→ independent Judge decision
→ candidate Wiki distillation
```

The Judge has read-only access to code and task artifacts and write-only access to its result. It cannot edit code, acceptance criteria, rules, or Wiki records. Distillation is permitted only when required evidence is current, all blocking findings are resolved, and Judge is PASS.

### 7. Governed Wiki as a derived knowledge index

Wiki content is stored as Markdown for readability with front matter matching `WikiRecord`. Every claim must identify source paths/symbols and hashes. A source index enables `wiki verify` to mark records stale when a source disappears or changes.

Promotion lifecycle:

```text
verified task
→ distiller creates candidate
→ schema/source/evidence validation
→ reviewer or human approval event
→ promote to verified
→ context builder selects it by task scope
```

Candidates never enter authoritative context. Verified records are still lower priority than approved rules, ADRs, contracts, and executable evidence. A conflict moves the task to `needs-clarification`; it is never resolved by a low-cost model guessing.

### 8. Minimal context manifests

`context build` selects normative rules, relevant verified Wiki records, source files, tests, and task artifacts. Each entry includes a reason, source type, status, and required read-before-write behavior. Stale Wiki entries are either omitted or included only as an explicit warning with their source references.

### 9. Installer ownership and update safety

Generated files carry a Kata manifest containing adapter version, template hash, and ownership. `init`, `update`, and `uninstall` operate at project/global scope, preserve user-owned modifications, support dry runs, and report conflicts. Adapter golden tests normalize platform-specific syntax to compare the underlying command/protocol contract.

### 10. Evaluation as a release gate

Fixtures exercise success, interruption/resume, stale Wiki, source conflict, failed test, Judge FAIL, bounded repair, adapter installation, and update conflict. Reports record acceptance pass rate, repair count, escalation rate, cost/tokens, latency, and rejected Wiki rate. A release fails if correctness or safety gates regress, even when language-model rubric scores improve.

## Risks / Trade-offs

- [Comet API drift] → Keep a small adapter boundary, pin tested versions, and run compatibility fixtures against supported Comet versions.
- [Wiki false authority] → Enforce source hashes, explicit statuses, read-only implementer permissions, and promotion gates.
- [Judge correlated errors] → Give Judge independent evidence and prohibit it from editing the implementation; require hard checks before Judge.
- [Platform capability variance] → Use capability manifests and generic fallback adapters; never claim unsupported hooks exist.
- [Context or log growth] → Use manifests, bounded logs, content hashes, and references to files/artifacts rather than embedding large payloads.
- [Cost escalation] → Set per-task budgets, role limits, retry ceilings, and auditable escalation events.
- [Sensitive data leakage] → Redact command output, exclude credentials from config, and validate paths before including source content.
- [Single large change] → Implement by milestones with independently testable contracts and keep each milestone separately committable.

## Migration Plan

1. Initialize `/app/kata` as an independent Node project and OpenSpec/Comet-compatible development workspace.
2. Implement core schemas, state store, guards, and CLI in offline mode before any provider integration.
3. Add Comet-compatible Skill bundle generation and Codex/Claude Code/OpenCode adapter fixtures.
4. Add evidence collection, model policy, Reviewer/Judge contracts, and repair loop.
5. Add governed Wiki records, source index, drift/conflict checks, promotion flow, and task context builder.
6. Add evaluation fixtures and release gates; run a dogfood task in `/app` without modifying the parent project's runtime.
7. Publish/install the package only after the adapter and governance gates pass.

Rollback is file-local: remove generated adapters and disable `.kata` workflow hooks; task artifacts and evidence remain readable. No production data migration is required for the first release.

## Open Questions

- Which Comet release range should Kata certify first, and should the dependency be optional or bundled?
- Which platform adapters are required for the first public release beyond Codex, Claude Code, and OpenCode?
- Should approval events be signed Git notes, committed JSON records, or an external review reference?
