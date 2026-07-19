# Non-interactive Confirmation Boundaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Kata reject non-interactive commands that omit user-owned choices, while preserving explicit automation paths.

**Architecture:** `/kata-*` Skills collect and confirm choices, then call the CLI with explicit flags. `src/cli.ts` validates those flags before any state mutation. The existing CLI test suites exercise observable behavior through `main()` using temporary workspaces and Git repositories.

**Tech Stack:** TypeScript, Node.js, Vitest, native Git fixtures.

## Global Constraints

- The CLI must not create a task, branch, install manifest, or generated platform file before rejecting missing non-interactive choices.
- Keep `kata init --yes` as the explicit detected-platform automation path.
- Keep existing task workflow profiles backward compatible.
- Write each behavior test first; observe its expected failure before changing production code.

---

### Task 1: Require an explicit workflow profile for `kata open`

**Files:**
- Create: `tests/e2e/noninteractive-open.test.ts`
- Modify: `src/cli.ts:621-643`

**Interfaces:**
- Consumes: `main(argv)` from `src/cli.ts` and `--isolation`, `--development`, `--review`.
- Produces: `kata open` either persists the caller-selected `WorkflowProfile` or rejects before task creation.

- [ ] **Step 1: Write the failing tests**

```ts
it.each([
  ['--isolation'],
  ['--development'],
  ['--review'],
])('rejects non-interactive open when %s is the only profile flag', async (providedFlag) => {
  const root = await tempRoot();
  await expect(main(['open', 'missing-profile', providedFlag, 'current_worktree', '--root', root]))
    .rejects.toThrow('requires explicit --isolation, --development, and --review');
  await expect(stat(join(root, '.kata/tasks/missing-profile'))).rejects.toThrow();
});

it('persists every explicitly selected workflow mode', async () => {
  const root = await tempRoot();
  await main(['open', 'explicit-profile', '--isolation', 'isolated_worktree', '--development', 'standard', '--review', 'security', '--root', root]);
  const task = JSON.parse(await readFile(join(root, '.kata/tasks/explicit-profile/task.json'), 'utf8'));
  expect(task.workflowProfile).toMatchObject({ isolationMode: 'isolated_worktree', developmentMode: 'standard', reviewMode: 'security' });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npm test -- tests/e2e/noninteractive-open.test.ts`

Expected: the incomplete-profile test fails because the CLI currently creates a task using defaults.

- [ ] **Step 3: Implement strict profile validation**

In `resolveOpenProfile`, parse all three enum arguments before creating a profile. If any value is missing, throw one deterministic error naming the three flags and directing callers to `/kata-open`. Only then construct `defaultWorkflowProfile()` and overwrite all three fields with validated explicit values. Remove the TTY `select()` calls from this path.

- [ ] **Step 4: Run the test and verify GREEN**

Run: `npm test -- tests/e2e/noninteractive-open.test.ts`

Expected: both rejection and explicit-persistence tests pass.

- [ ] **Step 5: Commit the task slice**

```bash
git add src/cli.ts tests/e2e/noninteractive-open.test.ts
git commit -m "fix(cli): require explicit workflow profile"
```

### Task 2: Gate Git Flow branch creation behind explicit confirmation

**Files:**
- Modify: `tests/e2e/git-flow.test.ts:13-49`
- Modify: `src/cli.ts:452-454`
- Modify: `src/cli.ts:602-618`

**Interfaces:**
- Consumes: `kata git-flow apply --change <task-id> [--confirm]`.
- Produces: a pending result and unchanged branch without `--confirm`; an active Git Flow profile and created branch with `--confirm`.

- [ ] **Step 1: Write failing tests for the two confirmation states**

Split the current Git Flow test after its fixture setup:

```ts
await main(['git-flow', 'apply', '--change', 'cli-feature', '--root', root, '--quiet']);
const pending = JSON.parse(await readFile(join(root, '.kata/tasks/cli-feature/task.json'), 'utf8'));
expect(pending.workflowProfile.gitFlow.status).toBe('pending_confirmation');
expect(execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim()).toBe('develop');

await main(['git-flow', 'apply', '--change', 'cli-feature', '--confirm', '--root', root, '--quiet']);
const active = JSON.parse(await readFile(join(root, '.kata/tasks/cli-feature/task.json'), 'utf8'));
expect(active.workflowProfile.gitFlow.status).toBe('active');
```

Also add an assertion to the `kata open --isolation git_flow ...` result that `nextAction.requiresUserConfirmation` is `true` and its CLI fallback includes `--confirm`.

- [ ] **Step 2: Run the test and verify RED**

Run: `npm test -- tests/e2e/git-flow.test.ts`

Expected: the first apply currently creates the branch, so the pending-state assertion fails.

- [ ] **Step 3: Implement the confirmation gate**

Parse `--confirm` only for `git-flow apply`. Without it, return the inspected pending plan and a `nextAction` containing `requiresUserConfirmation: true`; do not call `applyGitFlowPlan` or update the task profile. With it, preserve current branch creation. Change the pending action emitted after `open` to require confirmation and render `kata git-flow apply --change <task-id> --confirm`.

- [ ] **Step 4: Run the test and verify GREEN**

Run: `npm test -- tests/e2e/git-flow.test.ts`

Expected: no-confirmation leaves the branch on `develop`; explicit confirmation creates `feature/cli-feature`.

- [ ] **Step 5: Commit the task slice**

```bash
git add src/cli.ts tests/e2e/git-flow.test.ts
git commit -m "fix(git-flow): require branch creation confirmation"
```

### Task 3: Reject a bare non-interactive initializer

**Files:**
- Modify: `tests/unit/installer.test.ts:1-125`
- Modify: `src/cli.ts:87-126`

**Interfaces:**
- Consumes: `kata init [--platform <platform> --scope <scope>]` and `kata init --yes`.
- Produces: a side-effect-free error for bare non-interactive `init`; explicit installer and `--yes` behavior remains available.

- [ ] **Step 1: Write a failing side-effect test**

```ts
it('rejects bare non-interactive init without writing the generic installation', async () => {
  const root = await tempRoot();
  await expect(main(['init', '--root', root])).rejects.toThrow('requires explicit --platform and --scope');
  await expect(stat(join(root, '.kata-config.json'))).rejects.toThrow();
  await expect(stat(join(root, 'AGENTS.md'))).rejects.toThrow();
});
```

Keep the existing `init --yes` test unchanged as proof that explicit automation still works.

- [ ] **Step 2: Run the test and verify RED**

Run: `npm test -- tests/unit/installer.test.ts`

Expected: the new test fails because bare `init` currently installs the generic project profile.

- [ ] **Step 3: Add the non-interactive argument guard**

Before generic installer dispatch in `runMain`, when `command === 'init'`, stdin is not a TTY, `--yes` is absent, and either `--platform` or `--scope` is absent, throw a deterministic usage error referring callers to the installation Skill or both explicit flags. Do not alter interactive wizard or `--yes` routing.

- [ ] **Step 4: Run the test and verify GREEN**

Run: `npm test -- tests/unit/installer.test.ts`

Expected: bare init makes no writes; existing installer tests, including `--yes`, pass.

- [ ] **Step 5: Commit the task slice**

```bash
git add src/cli.ts tests/unit/installer.test.ts
git commit -m "fix(init): reject implicit noninteractive installs"
```

### Task 4: Verify the integrated CLI contract

**Files:**
- Verify only: `src/cli.ts`, `tests/e2e/noninteractive-open.test.ts`, `tests/e2e/git-flow.test.ts`, `tests/unit/installer.test.ts`

**Interfaces:**
- Consumes: all newly enforced CLI boundaries.
- Produces: type-safe, regression-tested confirmation behavior.

- [ ] **Step 1: Run all affected tests**

Run: `npm test -- tests/e2e/noninteractive-open.test.ts tests/e2e/git-flow.test.ts tests/unit/installer.test.ts`

Expected: PASS.

- [ ] **Step 2: Run repository checks**

Run: `npm run typecheck && npm test`

Expected: both commands exit successfully.

- [ ] **Step 3: Inspect the final diff**

Run: `git diff --check && git diff -- src/cli.ts tests/e2e/noninteractive-open.test.ts tests/e2e/git-flow.test.ts tests/unit/installer.test.ts`

Expected: no whitespace errors and no changes outside the approved scope.

- [ ] **Step 4: Commit verification-ready changes**

```bash
git add src/cli.ts tests/e2e/noninteractive-open.test.ts tests/e2e/git-flow.test.ts tests/unit/installer.test.ts
git commit -m "test(cli): cover noninteractive confirmation boundaries"
```

