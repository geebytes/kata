# Git Flow Isolation Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a `git_flow` workflow profile create and switch to a task feature branch after explicit confirmation, preferring the installed `git flow` command and safely falling back to native Git.

**Architecture:** Keep Git Flow probing and command execution in a small `core/git-flow.ts` module that produces an inspectable plan before it mutates a repository. `kata open` creates the task, requests confirmation only in a TTY, executes the approved plan, then persists the actual strategy, branch, base branch, and outcome in the task-owned workflow profile. Handoffs read that same record and prohibit an Agent from changing branch lifecycle implicitly.

**Tech Stack:** TypeScript, Node.js `execFileSync`, `@inquirer/prompts`, Vitest.

## Global Constraints

- Prefer `git flow feature start <task-id>` only when `git flow` is installed and initialized in the repository.
- Otherwise create `feature/<task-id>` with `git switch -c feature/<task-id> <baseBranch>`.
- Resolve base branch from Git Flow config, then `develop`, then the current branch.
- In a non-TTY session, never create or switch a branch; persist `pending_confirmation` instead.
- Refuse mutation on a dirty worktree, an unresolved base branch, or an existing target branch that is not current.
- Never run `git flow feature finish`, merge, push, or release commands automatically.

---

### Task 1: Model Git Flow plans and task persistence

**Files:**
- Create: `src/core/git-flow.ts`
- Modify: `src/core/workflow-profile.ts`
- Modify: `src/core/task.ts`
- Modify: `schemas/task.schema.json`
- Test: `tests/unit/git-flow.test.ts`

**Interfaces:**
- Produces `inspectGitFlow(root, taskId): GitFlowPlan` with `strategy`, `branch`, `baseBranch`, `status`, `command`, and `reason`.
- Produces `applyGitFlowPlan(root, plan): GitFlowExecution` that only accepts a confirmed, active plan.
- Adds optional `WorkflowProfile.gitFlow` with exact fields `{ strategy: 'git-flow' | 'manual'; branch: string; baseBranch: string; status: 'active' | 'pending_confirmation' | 'failed' }`.

- [ ] **Step 1: Write failing unit tests**

```ts
it('prefers git flow when it is installed and initialized', () => {
  expect(inspectGitFlow(root, 'sample-task')).toMatchObject({
    strategy: 'git-flow', branch: 'feature/sample-task', baseBranch: 'develop',
    command: ['git', 'flow', 'feature', 'start', 'sample-task'],
  });
});

it('falls back to native Git when git flow is unavailable', () => {
  expect(inspectGitFlow(root, 'sample-task')).toMatchObject({
    strategy: 'manual', command: ['git', 'switch', '-c', 'feature/sample-task', 'develop'],
  });
});
```

- [ ] **Step 2: Verify RED**

Run: `/home/work/.nvm/versions/node/v22.23.1/bin/node node_modules/vitest/vitest.mjs run tests/unit/git-flow.test.ts`

Expected: FAIL because `src/core/git-flow.ts` and its exports do not exist.

- [ ] **Step 3: Implement the smallest inspectable plan module**

```ts
export type GitFlowPlan = {
  strategy: 'git-flow' | 'manual'; branch: string; baseBranch: string;
  status: 'active' | 'pending_confirmation' | 'failed'; command: string[]; reason?: string;
};

export function inspectGitFlow(root: string, taskId: string): GitFlowPlan { /* probe only */ }
export function applyGitFlowPlan(root: string, plan: GitFlowPlan): GitFlowExecution { /* execute exact plan */ }
```

- [ ] **Step 4: Extend profile schema and persistence**

Add the optional `gitFlow` object to `WorkflowProfile`, `TaskRecord`, and `task.schema.json`; keep tasks without it valid.

- [ ] **Step 5: Verify GREEN**

Run the Task 1 test command.

Expected: PASS, including dirty-tree, existing-branch, and base-branch failure cases.

### Task 2: Confirmed open-flow execution

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/cli/prompt.ts`
- Modify: `src/workflow/orchestrator.ts`
- Test: `tests/e2e/workflow-regression.test.ts`
- Test: `tests/unit/workflow-profile.test.ts`

**Interfaces:**
- Consumes `inspectGitFlow` and `applyGitFlowPlan` from Task 1 after `runCommand('open', ...)` returns the final task id.
- Produces `workflowProfile.gitFlow` and a structured `nextAction` when confirmation is pending or execution failed.

- [ ] **Step 1: Write failing workflow tests**

```ts
it('keeps git-flow profile pending without a TTY and does not invoke Git', async () => {
  const result = await runWorkflowCommand('open', 'sample-task', root);
  expect(result.workflowProfile.gitFlow.status).toBe('pending_confirmation');
  expect(currentGitBranch(root)).toBe('develop');
});
```

- [ ] **Step 2: Verify RED**

Run: `/home/work/.nvm/versions/node/v22.23.1/bin/node node_modules/vitest/vitest.mjs run tests/e2e/workflow-regression.test.ts tests/unit/workflow-profile.test.ts`

Expected: FAIL because opening a Git Flow profile does not yet persist a pending execution result.

- [ ] **Step 3: Implement the confirmation boundary**

After task creation, detect a `git_flow` profile. In a TTY, display the exact command and base branch through a default-false confirmation. On confirmation apply the plan and write the active result. On rejection or non-TTY write `pending_confirmation`, return the exact follow-up command/action, and leave the branch unchanged.

- [ ] **Step 4: Verify GREEN**

Run the Task 2 test command.

Expected: PASS; no test shell invokes a real global `git flow` binary.

### Task 3: Cross-platform guardrails and documentation

**Files:**
- Modify: `src/workflow/handoff.ts`
- Modify: `src/workflow/context-fabric.ts`
- Modify: `README.md`
- Modify: `README_ZH.md`
- Modify: `docs/superpowers/specs/2026-07-14-comet-workflow-profile-integration-design.md`
- Test: `tests/unit/context-fabric.test.ts`

**Interfaces:**
- Consumes the persisted `workflowProfile.gitFlow` output from Task 2.
- Produces handoff instructions that name the active/pending branch and prohibit start/finish/switch commands outside the approved action.

- [ ] **Step 1: Write failing handoff tests**

```ts
expect(packet.permissions.guardInstructions).toContain(
  'Work on feature/sample-task; do not start, finish, or switch Git Flow branches outside the recorded task action.',
);
```

- [ ] **Step 2: Verify RED**

Run: `/home/work/.nvm/versions/node/v22.23.1/bin/node node_modules/vitest/vitest.mjs run tests/unit/context-fabric.test.ts`

Expected: FAIL because the current guard only describes a generic Git Flow choice.

- [ ] **Step 3: Implement profile-derived guard and docs**

Use the exact persisted branch in handoff guards. Document installed/initialized Git Flow preference, manual fallback, confirmation requirement, non-TTY behavior, and the prohibition on automatic finish/merge.

- [ ] **Step 4: Verify GREEN and regressions**

Run:

```sh
/home/work/.nvm/versions/node/v22.23.1/bin/node node_modules/vitest/vitest.mjs run
/home/work/.nvm/versions/node/v22.23.1/bin/node node_modules/typescript/bin/tsc -p tsconfig.build.json
```

Expected: all Kata tests and the build pass.
