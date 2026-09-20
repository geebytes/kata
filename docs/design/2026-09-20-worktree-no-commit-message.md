# The worktree error git no longer produces in English

Found while verifying the log-artifact change (`check-log-artifact-missing`). The full suite has one failure, and it is
**not** a locale-only test flake: it is a product defect in `src/workflow/worktree.ts` that a green-looking test suite
would hide once anyone sets `LC_ALL=C`.

## What happens

`tests/unit/worktree.test.ts` — "reports a repository with no commit to branch from":

```text
expected [Function] to throw error matching /no commit to branch from/
  but got 'git worktree add failed: fatal: 无效引用：HEAD'
```

`src/workflow/worktree.ts` classifies git's failure by matching its **message**:

```ts
const detail = created.stderr.trim() || created.stdout.trim() || 'unknown error';
if (/not a valid object name|does not have any commits/i.test(detail)) {
    throw new Error(`git worktree add failed: ${detail}. The repository has no commit to branch from — make an initial commit first.`);
}
throw new Error(`git worktree add failed: ${detail}`);
```

On git 2.43.0, `git worktree add -b <branch> <path> HEAD` in a commitless repository fails with
`fatal: invalid reference: HEAD` — and **neither alternative in that regex matches it**. Measured:

| locale | git stderr | exit |
|---|---|---|
| default (Chinese) | `fatal: 无效引用：HEAD` | 128 |
| `LC_ALL=C` | `fatal: invalid reference: HEAD` | 128 |

So the branch is unreachable in both, and the remedy the code exists to state ("make an initial commit first") is never
given. Worse, the two disagree with each other:

- **Without an explicit base** (`git worktree add -b b <path>`) git 2.43 **succeeds** — it prints
  `No possible source branch, inferring '--orphan'` and creates an orphan worktree, exit 0. `kata-cli` always passes an
  explicit `HEAD` base (`gitWorktreeAdd` in `src/core/git.ts`), which is why kata sees the failure at all.
- **`runGit` does not pin `LC_ALL`**, so the message a classifier reads depends on the operator's environment. Any
  message-matching classifier in this file is locale-dependent by construction.

## Why it matters

- The user-facing remedy for a misconfigured repository is missing: a first-time user in a fresh repo is told
  `git worktree add failed: fatal: 无效引用：HEAD` and left to interpret a git internal, instead of being told to commit.
- The test that pins this behaviour fails in this environment, so the suite is red for a reason unrelated to any change
  — which is how a real regression gets waved through as "that pre-existing failure".
- Fixing only the test (changing the expectation to the Chinese string, or setting `LC_ALL=C` in the test) would make it
  green while leaving the product message wrong in every non-English environment.

## What it is not

Not a regression from the efficiency work or from the log-artifact change: it reproduces identically on a clean tree
with both changes stashed. Not a test-only problem: the code path that produces the user-facing message is wrong, the
test is the messenger.

## Suggested fix (not made here)

Two independent corrections, and both are needed:

1. **Classify the failure structurally, not by prose.** The conditions are already distinguishable without matching git's
   output: the repository has no commit (`git rev-parse HEAD` fails) or the base is not a valid object. Checking that
   before or instead of parsing `stderr` removes the locale dependency entirely.
2. **Pin `LC_ALL=C` in `runGit` for any invocation whose output is parsed.** Measured scope: this regex at
   `src/workflow/worktree.ts:101` is the **only** place in `src/` that matches git's prose (`grep -rn "not a valid object
   name|does not have any commits|invalid reference" src/` returns that one line), so the locale dependency is currently
   a single site — but it is a single site that a git upgrade can break again, so pinning the locale is the durable half
   of the fix.

The existing test is the right test — it asserts the remedy users are promised. It should be kept and made to pass by
fixing the classifier.

Found and recorded rather than folded into `check-log-artifact-missing`, whose scope is the evidence log artifact.

## Outcome

Fixed, and the fix is recorded in `docs/design/2026-09-20-worktree-classification-fix.md` plus
`docs/changelog/2026-09-20-git-failure-classified-structurally.md`. Two things this investigation got right and one it
did not:

- **Right:** the test was the messenger, not the problem. It was left asserting the remedy users are promised, and it is
  green because the classifier was fixed.
- **Right:** the scope measurement held — `worktree.ts:101` was the only site in `src/` matching git's prose, so pinning
  `LC_ALL` at `runGit` closed the class without a broader error taxonomy.
- **Wrong:** the first draft of the fix's AC-2 said to verify the locale pin "by observing the child environment". That
  is not observable from the outside in a way that proves anything, and the *real* proof turned out to be cheaper — set
  `LC_ALL=zh_CN.UTF-8` in the caller, run a failing git command through `runGit`, and assert the emitted message is the
  English form (`fatal: invalid reference: HEAD`) rather than `fatal: 无效引用：HEAD`. The environment is the input; the
  language of the output is the observable.

The full suite is green for the first time in this line of work (**888 passed, 0 failed**), which also unblocks the seal
gate of the change this was found under.
