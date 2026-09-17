# One reader of repository state

The architecture review's L5-02 finding: git was reached through four independent wrappers with different conventions.
`core/git.ts` was 13 lines exporting a single function that used `git -C <root>`; `core/git-flow.ts` had its own
`runGit` using `cwd: root` and a different failure convention; `workflow/context-fabric.ts` defined a `git(root, args)`
helper *inside the workflow layer* used to compute the handoff packet's head and branch; and `workflow/revision.ts`
ran `git status --porcelain=v1 -z` inline in the ownership and drift code. "Read the repository state" had no owner,
and the modules that needed it most sat above the module that nominally provided it.

## What changed

**`core/git.ts` owns repository reads:**

- `runGit(root, args)` — reports `{ ok, stdout, stderr }` instead of throwing, so a caller decides what a failure means.
- `readGitValue(root, args)`, `currentGitBranch(root)`, `currentGitHead(root)`, `isGitRepository(root)`.
- `changedGitPaths(root)` — the changed, untracked and renamed paths from `git status --porcelain=v1 -z`, which is the
  fact drift detection and ownership inference are built on.

Consumers now call it: `workflow/revision.ts`'s `changedRepositoryPaths` **is** `changedGitPaths` (the token parsing,
including reporting both sides of a rename, moved verbatim — that parsing decides what drift sees, so it was moved
rather than rewritten), `workflow/context-fabric.ts`'s inline helper is gone in favour of `currentGitHead` and
`currentGitBranch`, and `core/git-flow.ts`'s runner is the shared `runGit` wrapped in its own contract — Git Flow keeps
only its strategy and plans. `grep -rn "execFileSync('git'" src` matches `core/git.ts` (reads) and `git-flow.ts`'s
mutating executor, which is the subject of L5-03 rather than a read.

## Verification

- `tests/unit/git-reads.test.ts` — branch, head and repository detection in a real work tree and in a directory that is
  not one (where every read reports failure rather than throwing), and the changed-path set across clean, modified,
  untracked and renamed states, asserting a rename contributes both names.
- Full suite: 499 tests in 55 files, all passing; `tsc --noEmit` clean; `dist/cli.js` rebuilt.
