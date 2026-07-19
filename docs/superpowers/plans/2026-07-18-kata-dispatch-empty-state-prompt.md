# Kata Dispatch Empty-State Prompt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Have the generated `/kata` Skill ask for a natural-language work goal when no task is found, while keeping `kata status` JSON unchanged.

**Architecture:** The `kata` branch of `renderSkill()` owns human-facing dispatch instructions. Add an explicit empty-state branch to that template. A golden rendering test verifies the generated Codex Skill contains the exact behavior.

**Tech Stack:** TypeScript, Vitest.

## Global Constraints

- Do not modify `kata status` runtime output or schema.
- Do not create a task from the empty state.
- Do not ask users for task IDs, change IDs, or CLI flags.
- Route the natural-language reply to `/kata-open`, which collects workflow choices.

---

### Task 1: Specify the empty dispatch interaction in the generated Skill

**Files:**
- Modify: `tests/golden/adapters.test.ts:137-151`
- Modify: `src/adapters/manifest.ts:275-291`

**Interfaces:**
- Consumes: the existing `kata status` dispatch JSON fields.
- Produces: generated `/kata` Skill instructions for the no-task state.

- [ ] **Step 1: Write the failing golden assertion**

Add a test that renders the `kata` command for Codex and asserts it contains:

```ts
expect(rendered).toContain('当前分支没有活跃的 Kata 任务。你想开启什么工作？');
expect(rendered).toContain('请用一句话描述目标');
expect(rendered).toContain('收到自然语言目标后，进入 /kata-open');
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- tests/golden/adapters.test.ts`

Expected: FAIL because the current `kata` template only describes candidate/recommendation dispatch.

- [ ] **Step 3: Add the empty-state instruction**

In the `command.id === 'kata'` template branch, add a section after status discovery defining the exact condition:

```text
phase === "dispatch" && candidates.length === 0 && recommended === null
```

Tell the Skill to render the approved Chinese prompt, wait for a natural-language goal, and continue through `/kata-open` instead of exposing raw diagnostics or CLI parameters.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npm test -- tests/golden/adapters.test.ts`

Expected: PASS.

- [ ] **Step 5: Run type and full regression checks**

Run: `npm run typecheck && npm test`

Expected: both commands exit successfully.

- [ ] **Step 6: Inspect the final diff**

Run: `git diff --check && git diff -- src/adapters/manifest.ts tests/golden/adapters.test.ts`

Expected: no whitespace errors and no CLI runtime/schema changes.

