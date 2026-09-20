The design note for this defect is `docs/design/2026-09-20-worktree-no-commit-message.md`, written when it was found
while verifying `check-log-artifact-missing`. This is the design of the fix.

# Classifying a git failure without reading git's prose

## What is broken

`src/workflow/worktree.ts` decides whether a `worktree add` failure means "this repository has no commit" by matching
git's **message**:

```ts
const detail = created.stderr.trim() || created.stdout.trim() || 'unknown error';
if (/not a valid object name|does not have any commits/i.test(detail)) {
    throw new Error(`git worktree add failed: ${detail}. The repository has no commit to branch from — make an initial commit first.`);
}
throw new Error(`git worktree add failed: ${detail}`);
```

Measured on git 2.43.0, in a repository with no commit, for the invocation kata actually makes
(`git worktree add -b <branch> <path> HEAD`):

| locale | stderr | exit |
|---|---|---|
| default (this environment) | `fatal: 无效引用：HEAD` | 128 |
| `LC_ALL=C` | `fatal: invalid reference: HEAD` | 128 |

Neither alternative in the regex matches either string, so **the branch is unreachable and the remedy the code exists to
state is never shown.** A first-time user in a fresh repository is handed a git internal instead of "make an initial
commit first".

Two independent causes, and fixing one leaves the other waiting:

1. **The classifier is written against a git version's wording.** `invalid reference: HEAD` is what this git says; the
   regex expects `not a valid object name` / `does not have any commits`, which is what some other version said.
2. **`runGit` does not pin `LC_ALL`.** `src/core/git.ts:19` passes `process.env` through, so the string a classifier
   reads depends on the operator's locale — by construction, for any message-matching classifier.

The second is why this is worth fixing structurally rather than widening the regex: widening it would make the message
match *this* environment and still break on the next git release or the next translation.

## Non-goals

- **Not a change to what `createWorktree` does.** It still refuses and still names the remedy; only the decision about
  *which* failure occurred moves off the message.
- **Not a general git-error taxonomy.** One classification is broken; this fixes that one, and the locale pinning covers
  the rest without inventing an abstraction nothing else needs.
- **Not a test relaxation.** The test asserts the remedy users are promised and it is correct as written.

## Decisions

### D1 — Decide from the repository, not from the failure message

The question the code actually needs answered is "does this repository have a commit to branch from?", and git can
answer it directly: `git rev-parse --verify HEAD` succeeds only when a commit exists. Asking that question is:

- **version-independent** — `rev-parse` output is not prose;
- **locale-independent** — the exit code carries the answer, not the text;
- **already available** — `readGitValue` in the same module is built on exactly this pattern.

The classification therefore runs *before* the `worktree add` attempt (or on its failure, as a second question), and the
message is only ever used as detail for the user, never as the branch condition.

### D2 — Pin the locale in `runGit`, so parsed output cannot drift with the environment

`runGit` gains `LC_ALL=C` in the child environment. This is the durable half of the fix: the regex site is one, but a
git upgrade or a translated build silently changing kata's behaviour is the class of defect this closes. It is set at
`runGit` rather than in `runProcessSync`, because `runProcessSync` serves checks, CodeGraph and Git Flow, and a check
that asserts on its own command's localized output would be broken by pinning it globally.

### D3 — Keep the message for the user, and keep the test

The thrown message keeps git's own detail appended — it is a real diagnostic — with the remedy sentence unchanged. The
existing test (`tests/unit/worktree.test.ts`, "reports a repository with no commit to branch from") already asserts that
remedy and should pass unchanged. A test that would pass with the classifier still broken is not acceptable: the new
test must fail if the classification returns to reading prose, which means asserting on **this** git's failure rather
than on a message the old code happened to match.

## Acceptance criteria

- **AC-1** — In a repository with no commit, `createWorktree` rejects with a message containing `no commit to branch
  from` and the remedy, on any git version and in any locale, because the decision no longer reads a message.
- **AC-2** — `runGit` runs git with `LC_ALL=C`, so parsed git output does not depend on the operator's environment.
- **AC-3** — A repository that *does* have a commit still creates the worktree: the structural check must not turn a
  healthy repository into a refusal.
- **AC-4** — A failure that is *not* the no-commit case still reports git's own detail rather than borrowing the
  no-commit remedy (for example an invalid base ref alongside a real HEAD, or a path that already exists).
- **AC-5** — The full suite is green: the pre-existing `worktree.test.ts` failure is resolved by the fix rather than by
  editing the expectation.

## Verification notes

- AC-1 must be verified in both a commitless repository and under an actual non-English locale, since the point is that
  neither matters. Setting `LC_ALL` in the test environment is the honest way to prove the second half.
- AC-2 is verified by observing the child environment (`runGit`'s env hand-off) rather than by asserting a translated
  string — a test that greps for Chinese output would re-introduce the dependency it is meant to remove.
- AC-3 and AC-4 are the guardrails: a structural check that is too eager (refusing a healthy repo) or too broad
  (claiming every failure is "no commit") is the regression this change could introduce.
