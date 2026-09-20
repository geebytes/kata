# A git failure is classified from the repository, not from git's prose

`createWorktree` refuses a repository with no commit to branch from, and it exists to name the remedy: "make an initial
commit first". It decided which failure occurred by matching git's **message**:

```ts
if (/not a valid object name|does not have any commits/i.test(detail)) { … }
```

On git 2.43 that branch was unreachable. Measured in a commitless repository, for the invocation kata actually makes
(`git worktree add -b <branch> <path> HEAD`):

| locale | git stderr | exit |
|---|---|---|
| `LC_ALL=C` | `fatal: invalid reference: HEAD` | 128 |
| this environment's default | `fatal: 无效引用：HEAD` | 128 |

Neither alternative matched either string, so a first-time user in a fresh repository was handed a git internal instead
of the one sentence that says what to do. The test that pins the remedy had been failing for this reason, which is how it
was found — see `docs/design/2026-09-20-worktree-no-commit-message.md` for the investigation and
`docs/design/2026-09-20-worktree-classification-fix.md` for the fix.

Two independent causes, fixed together because either alone leaves the other waiting:

- **The classifier read prose.** `hasCommit(root)` now asks git whether `HEAD` resolves (`git rev-parse --verify HEAD`)
  and branches on the exit code, following the `readGitValue` pattern already in `src/core/git.ts`. The question is the
  one the code needs answered, and it does not change when git's wording or the locale does. Git's own detail is still
  appended to the message as a diagnostic.
- **`runGit` did not pin the locale.** It now runs git with `LC_ALL=C`. The pin lives there rather than in
  `runProcessSync` on purpose: that facility also serves checks, CodeGraph and Git Flow, and pinning the locale for a
  project's own test commands would change their behaviour.

Behaviour that must **not** change, and is now asserted:

- a healthy repository still creates the worktree (a structural check that is too eager would refuse one);
- a failure that is not the no-commit case reports git's own detail and does not borrow the no-commit remedy;
- the remedy is named under a non-English caller locale, because the answer is no longer read from a translated string.

`tests/unit/worktree.test.ts` covers all of it, including an assertion on the language git actually emits when the caller
sets `LC_ALL=zh_CN.UTF-8` — the only way to prove the pin removes the dependency rather than hiding it.

Full suite after this change: **888 passed, 0 failed.**
