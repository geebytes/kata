## 1. The existing test must pass (it is correct as written)

- [x] 1.1 Confirm RED for the right reason: `tests/unit/worktree.test.ts` — "reports a repository with no commit to branch from" fails with `git worktree add failed: fatal: …引用…`, not with a missing-throw. <!-- comet-task:1-1 -->
- [x] 1.2 Add a guardrail test: a repository that **has** a commit still creates the worktree, so the structural check cannot refuse a healthy repository. <!-- comet-task:1-2 -->
- [x] 1.3 Add a guardrail test: a failure that is *not* the no-commit case (unresolvable base, occupied path) reports git's own detail and does **not** borrow the no-commit remedy. <!-- comet-task:1-3 -->

## 2. Classify from the repository, not from the message

- [x] 2.1 Ask git whether `HEAD` resolves (`rev-parse --verify HEAD`) and branch on that answer instead of on `stderr`. <!-- comet-task:2-1 -->
- [x] 2.2 Keep git's own detail in the thrown message as a diagnostic, and keep the remedy sentence unchanged. <!-- comet-task:2-2 -->
- [x] 2.3 Re-run the three tests from section 1: the no-commit one now passes, and neither guardrail regressed. <!-- comet-task:2-3 -->

## 3. Pin the locale so parsed output cannot drift

- [x] 3.1 Add `LC_ALL=C` to `runGit`'s child environment in `src/core/git.ts`. <!-- comet-task:3-1 -->
- [x] 3.2 Verify the pin by observing the environment git receives, not by asserting a translated string — asserting on Chinese output would re-introduce the dependency being removed. <!-- comet-task:3-2 -->
- [x] 3.3 Verify in a genuinely non-English locale that the no-commit classification is unaffected. <!-- comet-task:3-3 -->

## 4. Suite and documentation

- [x] 4.1 Run the full suite: it is green, and the previously-red `worktree.test.ts` case is resolved by the fix rather than by editing the expectation. <!-- comet-task:4-1 -->
- [x] 4.2 Update `docs/design/2026-09-20-worktree-no-commit-message.md` with anything implementation corrected, and record the outcome in the changelog. <!-- comet-task:4-2 -->

## Verification evidence

- **AC-1** — `tests/unit/worktree.test.ts` "reports a repository with no commit to branch from" passes **unedited**, and a
  second case asserts the same remedy with the caller's `LC_ALL=zh_CN.UTF-8`.
- **AC-2** — justified by the language git actually emits: with the caller set to a Chinese locale, `runGit`'s
  `worktree add` failure is `fatal: invalid reference: HEAD` (English), asserted positively and asserted **not** to match
  `引用`.
- **AC-3** — "still creates the worktree in a repository that has a commit" (`stat(created.path)` resolves).
- **AC-4** — "does not borrow the no-commit remedy for a failure that is not one": a healthy repository with
  `base: refs/heads/does-not-exist` still reports `git worktree add failed` and does *not* match
  `no commit to branch from`.
- **AC-5** — full suite **888 passed / 0 failed**, the previously-red case resolved by the fix rather than by editing the
  expectation.

One correction to this change's own design, recorded in the design note: AC-2's stated verification ("observe
`runGit`'s env hand-off") is not observable from outside. The honest test is the caller-locale one above — the
environment is the input, and the language of git's output is what can be asserted.
