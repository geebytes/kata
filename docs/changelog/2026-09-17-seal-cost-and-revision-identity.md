# Seal economics: what a seal costs, and what identifies it

Two review findings landed together because they are the same problem seen from two sides: L3-02 (every seal re-runs
the whole check set serially, and each seal deletes the previous evidence) and L3-04 (a revision is minted per seal
with no content dedupe, over directory-granularity ownership).

## Cost (L3-02)

- **Checks run one at a time by default.** `collectEvidence` ran a plain `for` loop: one child process at a time. This
  change briefly made it run up to `min(4, availableParallelism - 1)` checks at once (`KATA_CHECK_CONCURRENCY`
  overriding it), reassembling results in declaration order so a caller's view of the set does not depend on
  scheduling. **That default was reverted the same day** — see `2026-09-17-check-concurrency-opt-in.md`: a seal ran
  four to five concurrent checks that shared one PostgreSQL database, three failed, and re-running them alone passed. A
  seal that reports failures it created is worse than a slow one, so `checkConcurrency()` returns **1** unless
  `KATA_CHECK_CONCURRENCY` is set. The progress contract is unchanged; a check's own `weight` is the finer instrument.
- **CodeGraph queries run concurrently.** `discoverCodeGraphCandidates` awaited one `codegraph affected` per
  implementation path in a serial loop. The per-path attribution it produces — which implementation path dragged each
  affected test in — is a product behaviour with its own test, and a single batched call returns a flat list without it,
  so the cost is paid in parallel rather than by dropping the information.
- **Evidence is retained, not deleted.** `writeEvidence` unlinked every existing `<taskId>-*.json` and wrote the new
  set. It now archives the outgoing set under `.kata/evidence/superseded/<revisionId>/`, so a superseded revision's
  evidence stays auditable while the active set stays what the current seal proved. The archive directory is read from
  the envelopes' own `revisionId`, not guessed.
- **An unchanged seal reuses the revision and its evidence.** Before collecting, the seal checks whether the revision
  identity already exists *and* every recorded envelope passed against the current tree hash. If so it reports
  `reusedRevision`/`reusedEvidence` and runs nothing. Reuse is only permitted for evidence that previously passed
  against content that is still current — anything else runs, so the gate stays fail-closed.

## Identity (L3-04)

- **A revision id derives from its content**: `revision-<first 16 hex of sha256(taskId, manifestHash, sorted checkIds)>`.
  The same task, the same owned-path content and the same resolved check set resolve to the same revision; re-sealing
  byte-identical content no longer mints a new id and silently demotes the previous one, which used to invalidate a
  review or judge verdict bound to it even though nothing had changed. `createTaskRevisionIfChanged` reports whether
  the revision was reused, which is what the reuse path above keys on.
- **Ownership overlap is reported at file granularity.** `findOwnershipConflicts` keeps the cheap directory-prefix test
  as the first pass, and when two claims overlap it intersects the files each claim actually covers: `tests/` on one
  task and `tests/` on another no longer reads as a total collision when they touch different files inside it, while a
  claim on a whole directory that collides with a sibling's file still reports that file.

## Verification

- `tests/e2e/seal-cost-and-revision-identity.test.ts` — the concurrency case **opts in** with
  `KATA_CHECK_CONCURRENCY`, and a second test pins the serial default; the first waits for a marker file the second
  writes, so both can only pass if they really ran concurrently. A second seal over unchanged content reports
  `reusedEvidence` and the check's marker file proves it did not run twice; the revision id is stable across an
  identical re-seal and changes when the content does; the previous evidence is readable under
  `superseded/<revisionId>/` while the active set holds only the current seal's; and ownership conflicts are reported
  per file (no conflict for different files, a conflict naming the shared file otherwise).
- `tests/unit/context-fabric.test.ts`'s "rejects a revision-anchored packet after the task seals a new revision" now
  seals *changed* content, since an identical re-seal is deliberately the same revision.
- Full suite: 513 tests in 58 files, all passing; `tsc --noEmit` clean; `dist/cli.js` rebuilt.
