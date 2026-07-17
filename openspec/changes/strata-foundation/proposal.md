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
