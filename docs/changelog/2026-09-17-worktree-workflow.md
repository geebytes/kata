# Worktree workflow: kata owns the convention, and the pointer stops travelling

Kata declared `isolated_worktree` and then left the creation convention to each host. Two things went wrong with that,
and both were reproduced before anything changed:

1. **A nested worktree made every task-addressed command fail.** Hosts that nest worktrees (`.claude/worktrees/<name>`)
   put one inside the repository; task state is tracked, so the worktree carries its own `.kata/tasks/<id>/` **and** the
   primary checkout above it has one too. Root resolution collected both ancestor candidates and failed closed:
   `Ambiguous Kata task root for <task>: <worktree>, <primary>. Pass --root explicitly.`
2. **The session pointer was not actually ignored.** `.kata/runtime/active-task.json` is a session pointer, and the rule
   meant to keep it out of git (`ensureRuntimeGitignore`) was only reached from `initLayout` — which nothing in the CLI
   path called (only the eval fixtures did). So the pointer was committed, and a worktree or a fresh clone checked out an
   "active task" nobody had activated there: the hook guard would enforce that task's phase and role against whoever was
   working in that checkout.

## What changed

**Root resolution: the nearest owner wins.** Ancestor candidates are collected from the working directory upward, so the
first one is the checkout the command runs in — that is the one meant. A nested worktree therefore resolves to itself,
and its primary checkout resolves to itself. Genuine ambiguity is preserved where it is real: sibling worktrees that own
the task with no owner above them still fail closed (`Multiple descendant worktrees own…`), with `--root` to select one.

**The ignore rule lands where it matters.** `ensureRuntimeGitignore` is exported and runs when kata writes the thing it
protects — hook activation (which every flow performs, and which the CLI also does on `open`) — and at `worktree create`
and `init`. `ensureWorkspaceHygiene` (the rule plus the vendored schema copies) is what setup calls; the schema copies
are a setup-time artifact and deliberately do not land mid-flow, where writing them would dirty the tree that Git Flow's
clean-worktree check reads. The rule now covers `.kata/worktrees/` as well as `.kata/runtime/`.

**Kata creates the worktrees it declared.** `workflow/worktree.ts` and `kata-cli worktree create|list|remove`:

- Linked worktrees live under `<repo>/.kata/worktrees/<task>` — ignored by git (so a nested worktree is never untracked
  paths in its primary checkout) and by repository identity (so it is never workspace drift).
- `create` branches `kata/<task>` from the current branch (or `--base`), writes the ignore rules in both checkouts, and
  copies the task's state in when the base commit predates the task — task state is tracked, so an older base would
  otherwise check out a workspace with no task in it. The session pointer is deliberately not copied.
- `list` reports each worktree with its branch, kind, whether it is the current one, and the tasks whose state it
  carries.
- `remove` follows git's semantics: uncommitted changes are refused unless `--force`, and a forced removal reports what
  it cost.
- A repository with no commit gets `no commit to branch from` rather than git's `not a valid object name: 'HEAD'`.

**The skill text says what to run.** The isolation-mode guidance (`.kata` skill text and the guard instructions) now
names `kata-cli worktree create --change <task>` for `isolated_worktree` and `user_decides`.

## Consequences worth stating

- `.kata/` stays tracked, so a worktree still inherits the task from its commit, and branches still fork task state.
  What is now excluded is exactly the machine-local part: `runtime/` and `worktrees/`.
- Two existing tests encoded the old fail-closed policy for a nested owner; they now assert the nearest-owner rule,
  which is the behaviour this change exists to provide.

## Verification

- `tests/unit/worktree.test.ts` — the rule is written, is idempotent, and `git check-ignore` agrees for both entries;
  `create` places the worktree under `.kata/worktrees/`, leaves no untracked worktree paths in the primary checkout, and
  copies the task state when the base predates it (never the pointer); a command run inside the linked worktree moves
  **that** checkout's phase and leaves the primary one alone; `list` reports branches, kinds and carried tasks; `remove`
  refuses dirty worktrees and reports a forced removal; a commit-less repository gets the clear error.
- `tests/unit/layout.test.ts` and `tests/e2e/workflow-resume.test.ts` — a task owned by a nested checkout and its parent
  resolves to the checkout the command runs in, and the genuine multi-descendant case still fails closed.
- Full suite: 534 tests in 62 files, all passing; `tsc --noEmit` clean; `dist/cli.js` rebuilt; `docs/operations.md` has a
  Worktrees section covering the commands, resolution and what git sees.
