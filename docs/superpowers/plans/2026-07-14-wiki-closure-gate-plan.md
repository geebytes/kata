# Wiki Closure Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Require every task to record a valid knowledge-closure decision before verification and archival.

**Architecture:** Add a small task-owned closure module. Build creates a deferred record; a Wiki CLI command records captured/not-applicable decisions; verify and archive evaluate the same record. Candidate validation remains in existing `.kata/wiki` governance.

**Tech Stack:** TypeScript, Node.js, Vitest.

## Tasks

### Task 1: Closure model and RED tests

- Files: `src/wiki/closure.ts`, `tests/unit/wiki-closure.test.ts`.
- Write failing tests for deferred initialization, valid not-applicable decision, and captured candidate validation.
- Implement task-owned JSON read/write/evaluation.

### Task 2: CLI and workflow gates

- Files: `src/cli.ts`, `src/workflow/orchestrator.ts`, `tests/e2e/workflow-resume.test.ts`.
- Add `kata wiki closure --task <id> --decision <captured|not_applicable|deferred> --reason <text> [--candidate <id>]`.
- Create deferred closure in build; fail verify/archive when closure is missing, deferred, or invalid.

### Task 3: Skills and documentation

- Files: `src/adapters/manifest.ts`, `README.md`, `README_ZH.md`, golden tests.
- Instruct every platform to decide captured/not-applicable/deferred rather than fabricate a page.
- Run the full Kata suite and TypeScript build.
