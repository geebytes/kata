# One mutation discipline for task-scoped artefacts

L3-09: `withTaskLock` guarded exactly two call sites — `transition` and the review-repair re-entry — while every other
task-artefact mutation was an unlocked read-modify-write:

| Artefact | Writer |
|---|---|
| `task.json` | `acknowledgeCometOpen`, `updateGitFlowProfile` |
| `review.json` | the reviewer appending a finding |
| `repair-obligations.json` | blocking findings, Judge FAILs, the resolver, reopen |
| `repair.json` | the orchestrator |

Two concurrent commands on one task could therefore lose an update in exactly the files that carry the review, judge and
obligation bindings — and an obligation is what keeps a bounded repair from being closed early.

## What changed

- **`mutateTaskArtefact(root, taskId, path, mutate)`** (`core/state.ts`) runs a mutation inside `withTaskLock` and lands it
  through `writeFileAtomic` (now exported). The mutator **returns the bytes to write** rather than receiving them, because
  the lock has to cover the *read* as much as the write — a helper that took the new content would not close the window it
  exists to close.
- Every writer above now goes through it: the two profile writers share one locked `updateProfile`, the reviewer appends
  inside the lock, and the obligations module has a single locked `updateObligations(merge)` that its four callers use.
- `resolveObligationsForRevision` decides *inside* the lock for the same reason: it reads the set it is about to write.

## Verification

- `tests/unit/task-artefact-lock.test.ts` — a profile change is refused while the lock is held (and the rest of
  `task.json` survives the atomic write), and two obligation writes in sequence append rather than dropping one.
- Full kata suite: 617 tests in 76 files; `tsc` clean; `dist/cli.js` rebuilt.
