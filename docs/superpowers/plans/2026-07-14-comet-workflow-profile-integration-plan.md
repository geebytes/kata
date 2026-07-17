# Comet Workflow Profile Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `kata open` persist workflow choices, integrate the supported Comet initialization boundary, and carry the choices through build, review, and handoff.

**Architecture:** Add a validated task-owned workflow profile and a Comet opening acknowledgement. The CLI collects defaults or TTY choices and reports `/comet-open` as a host-agent action; downstream operations read the profile for deterministic guard instructions and permissions.

**Tech Stack:** TypeScript, Node.js, Vitest, @inquirer/prompts.

## Global Constraints

- Do not claim a host slash command has executed from Node.js.
- Never silently create or migrate a Git worktree.
- TDD profile requires RED → GREEN evidence in task instructions.
- Preserve existing task compatibility when profile is absent.

---

### Task 1: Profile types, persistence, and red tests

**Files:** `src/core/task.ts`, `src/core/workflow-profile.ts`, `tests/unit/workflow-profile.test.ts`.

- [ ] Write failing tests for profile defaults, validation, and legacy task fallback.
- [ ] Run the focused test and confirm RED.
- [ ] Add the minimal profile model and persistence support.
- [ ] Re-run focused tests and confirm GREEN.

### Task 2: Open flow and Comet acknowledgement

**Files:** `src/cli.ts`, `src/workflow/orchestrator.ts`, `src/comet/*`, `tests/e2e/workflow-profile.test.ts`.

- [ ] Write failing E2E tests for non-interactive defaults, Comet init result, `/comet-open` next action, and acknowledgement.
- [ ] Confirm RED, then implement open/acknowledge behavior.
- [ ] Verify GREEN without invoking a real external Comet binary in tests.

### Task 3: Profile-derived build/review/handoff behavior

**Files:** `src/workflow/handoff.ts`, `src/workflow/orchestrator.ts`, `src/workflow/context-fabric.ts`, relevant tests.

- [ ] Write failing tests for TDD/review guards and permission preservation across regenerated packets.
- [ ] Confirm RED, implement the smallest profile-aware derivation, then verify GREEN.

### Task 4: Skills, schemas, and documentation

**Files:** `schemas/task.schema.json`, adapter manifests/templates, `README.md`, `README_ZH.md`, `docs/usage-guide.md`, tests.

- [ ] Update installed skill source/template rendering with trigger, input, output, and profile behavior.
- [ ] Update English and Chinese docs with the user journey and explicit Comet boundary.
- [ ] Run `npm run lint`, `npm test`, and `npm run build` from `kata/`.
