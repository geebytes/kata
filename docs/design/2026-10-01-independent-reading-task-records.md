# Independent reading — `task-records-outlive-the-worktree`

Subject revision `rev:cb73e90191bed2d5`. Read-only review; I wrote only this file plus fixtures under `/tmp/kata-repro/`.

**Method.** Read `src/core/layout.ts`, `src/workflow/worktree.ts`, `src/workflow/orchestrator.ts`, `src/cli/ops.ts`.
Ran the six changed test files: `npx vitest run <6 files>` → 21 passed. Then drove the real source through
`npx vite-node --config vitest.config.ts /tmp/kata-repro/*.mts` to try to break each sentence.

## Verdicts

**C1 — supported, narrowly.** `taskDir` (`layout.ts:448`) sends every enumerated record through `recordsRoot`
(`layout.ts:416`). Measured: in a repo whose `.gitignore` is `.kata/`, `recordsRoot(worktree) === primary`. But the owner
rule covers only paths built from `taskDir`; `evidenceDir` (`layout.ts:528`) is still `kataDir(root)`, so "exactly one
owner" holds for the `.kata/tasks/<id>` subtree, not for task records generally.

**C2 — refuted.** The guard lives only on the archive path (`removeWorktreeSafely`). `kata-cli worktree remove`
(`src/cli/ops.ts:190`) calls `removeWorktree` directly. Measured (script A): after `removeWorktreeSafely` correctly
returned `refusedBecause:'worktree-only-records'` and left `judge.json` in place, `removeWorktree({force:true})` removed
the worktree and `judge.json` was gone. The detector also under-reports (below).

**C3 — refuted.** `worktreeOnlyRecords` compares only top-level names (`layout.ts:384-391`). Measured (script C): primary
has `revisions/` (no files), worktree has `revisions/rev1.json` + `revisions/rev2.json` → report is `[]`. On this
repository it returns `[]` (test `no-audit-trail...:98` is green) while a recursive diff finds **252 files that exist only
in worktrees** (`gate-input-integrity` 37, `security-tier-platform-boundary` 171, `verdict-readings-per-run` 44, all under
`handoffs/`). No `src/cli` command calls it (grep), so an operator only sees names if an archive refusal fires.

**C4 — refuted.** The corrected `layout.ts` sentence matches `taskDir`, but `worktree.ts:17-18` still says "the task's own
state, copied in when it is not already present (the state is tracked …)" although the copy was deleted, and the
`recordsRoot` doc ("The records' owner is derived from where the task lives") over-claims because `evidenceDir` is not.
The prose test at `task-state-location-statement-is-true.test.ts` reads only `layout.ts`.

**C5 — refuted as a recovery.** The mechanics are as claimed (copy, never move, owner wins, returns `moved`; two tests
confirm). But it misses nested records exactly as C3 does, and it has **no production caller**: grep finds
`recoverWorktreeRecords` only in `worktree.ts:160` and its test. The 252 stranded files above were never recovered.

## Findings

blocking | src/workflow/worktree.ts:119 + src/core/layout.ts:117-140 | deleting the state copy breaks code isolation: `resolveWorkspaceRootForTask` keys only on `<root>/.kata/tasks/<id>/current-state.json`, so in a `.kata/`-ignored repo a command run from the worktree resolves to the primary checkout (measured `resolve(worktree) -> primary`; `worktree list` shows the linked tree's `tasks: []`) | a test that runs a task-addressed command from inside a worktree in a repo whose `.gitignore` is `.kata/` and asserts the worktree, not the primary, is the target.
major | src/core/layout.ts:384-391 | detector is non-recursive; a worktree-only file inside a directory the owner also has is invisible | primary `revisions/` + worktree `revisions/rev1.json` → expect the report to name `rev1.json` (measured `[]`).
major | this repo (.kata/worktrees/*/.kata/tasks/*/handoffs) | 252 governed files still live only in worktrees, yet the repository test asserts `worktreeOnlyRecords(repo) === []` — a false negative that certifies an incomplete migration | a recursive fixture/case that diffs the two task trees must return non-empty (it currently passes).
major | src/cli/ops.ts:190 | `kata-cli worktree remove` bypasses the guard entirely, so the "no route reaches the deletion without passing it" claim is false | invoking the `worktree remove` handler on a worktree holding a stranded record must refuse and name it.
major | src/workflow/worktree.ts:160 | `recoverWorktreeRecords` is unreachable from any command; the only invocations are tests | a wiring check that asserts every recovery entry point has a CLI caller.
major | src/core/layout.ts:528 | `.kata/evidence/<taskId>-*.json` is still per-root and is neither detected nor guarded (measured: worktree-only evidence → report `[]`); archive removes the worktree and the evidence | a case that writes evidence with `--root worktree` and expects it detected/refused.
minor | src/workflow/worktree.ts:17-18 | stale comment still describes a copy that no longer exists and a "tracked" premise the change calls false | apply the `task-state-location-statement-is-true` prose check to `worktree.ts`; it reddens.
minor | src/workflow/worktree.ts:128 | `rootResolution` promises the worktree resolves as the workspace root; in a `.kata/`-ignored repo it does not | assert the promise, e.g. `resolveWorkspaceRootForTask(taskId, target) === target` after `createWorktree`.
minor | src/cli/workflow.ts:26, src/cli/tasks.ts:11 | unused `resolveWorkspaceRootForTask` imports remain after the resolver split | `tsc` with `noUnusedLocals` (or the lint gate) reddens.

## Probes

The request carries no probes.

## What I could not falsify

`recordsRoot`'s skip of any ancestor under `.kata/worktrees` works (`isUnderLinkedWorktrees`, `layout.ts:440`), the
archive refusal names files (`orchestrator.ts:2311-2318`), and the recovery's non-overwrite rule holds when the owner
already has the file. The failures above are all about scope (top-level only, `.kata/tasks` only) and about the copy
removal's side effect on root resolution.
