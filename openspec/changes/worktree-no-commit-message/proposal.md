## Why

`createWorktree` refuses a repository that has no commit, and it exists to tell the user the remedy: "make an initial
commit first". It decides which failure occurred by matching **git's message**, and on git 2.43 that message no longer
contains the text the regex expects.

Measured in a commitless repository, for the invocation kata actually makes (`git worktree add -b <branch> <path> HEAD`):
git exits 128 with `fatal: invalid reference: HEAD` (`LC_ALL=C`) or `fatal: 无效引用：HEAD` (this environment's locale).
Neither `not a valid object name` nor `does not have any commits` appears, so the branch is unreachable and the remedy is
never shown — a first-time user is handed a git internal instead.

Two causes: the classifier is written against one git version's wording, and `runGit` does not pin `LC_ALL`, so the
string a classifier reads depends on the operator's locale. The existing test fails for this reason; it is correct and
must be made to pass by fixing the classifier, not by editing the expectation.

## What Changes

- `src/workflow/worktree.ts` decides "this repository has no commit" from the repository (`git rev-parse --verify HEAD`)
  rather than from git's prose, so the classification is version- and locale-independent.
- `src/core/git.ts` runs git with `LC_ALL=C`, so any output kata parses cannot change with the operator's environment.
- The message keeps git's own detail as diagnostics and keeps the remedy sentence unchanged.
- Tests cover the no-commit case, a healthy repository, and a failure that is *not* the no-commit case — the two ways a
  structural check can regress.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `workflow-runtime`: worktree creation classifies its failures structurally, and git output kata parses is
  locale-pinned. User-visible behaviour is unchanged where it already worked, and repaired where it did not.

## Impact

- `src/workflow/worktree.ts`, `src/core/git.ts` and `tests/unit/worktree.test.ts`.
- The full-suite failure that made unrelated changes' seal gates red is resolved.
- Design: `docs/design/2026-09-20-worktree-classification-fix.md`; the defect write-up is
  `docs/design/2026-09-20-worktree-no-commit-message.md`.
