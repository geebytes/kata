# Shared owned paths supersede every sibling change

## The measurement

Four changes hold unresolved obligations — 18 in total. I hypothesised they were blocked the same way the two judged changes are
(their revisions no longer current), so disposing each obligation one at a time would be wasted work. Measured:

| change | revisionStatus | fresh evidence | review | judge | open obligations | missing owned paths |
|---|---|---|---|---|---|---|
| `closure-gate` | **superseded** | null | false | `not_passed` | 2 | 1 (a moved OpenSpec file) |
| `kata-gate-surface` | **superseded** | null | false | `not_passed` | 5 | 0 |
| `review-record-integrity` | **superseded** | null | false | `not_passed` | 5 | 0 |
| `wiring-coverage-check` | **superseded** | null | true | `not_passed` | 6 | 0 |

**All four are `superseded`, and for three of them no owned path is missing.** `onlyInTask: 0 | onlyInRevision: 0` held for the
judged pair too: the declaration is unchanged and the **content** moved. The content that moved is the shared source — `src/cli/ops.ts`,
`src/cli/matrix.ts`, `src/quality/adversarial.ts`, `src/quality/repair-obligations.ts`, `src/workflow/seal-preflight.ts`,
`src/workflow/revision.ts`, `src/core/schema.ts` — which every one of these changes declares and which this change has been editing all
day.

This is the constraint already recorded as *"two concurrent governed changes can both stay `current` only if their declared ownedPaths
do not overlap"*. Measured at scale: **nine governed changes share six central source files, so each change's work supersedes every
sibling's revision**, and a superseded revision cannot yield the fresh evidence the archive gate requires.

## What is and is not blocked

**Dispositions are not blocked.** Measured rather than assumed: `kata-cli falsify --none` recorded an absence for `closure-gate`'s
`cg5-f1` on a superseded revision, and a `falsify` for `cg5-f2` ran its three steps for real and refused with `did_not_redden` because
my probe mutation was a no-op. So the guard that refuses *"the working tree is not what revision-X describes"* does not fire here: it
compares the change's own declared paths, and those are the revision's.

**The archive is blocked**, and not by the dispositions — by freshness. `freshPassingTestEvidence` skips an envelope whose bound
revision is not current, so `freshEvidence` is null and `assertDistillGates` fails whatever the obligations say.

## The consequence, stated as a choice rather than a plan

Re-unblocking one change needs a full cycle: `build --seal` recomputes the manifest from the current tree (minting a revision that is
current again), then `verify`, then `review`, then `judge`. Per change. Four changes. And because they share the paths, **whichever one
re-seals first supersedes the other three** — so the cycles cannot be interleaved; they must be run one at a time, each to completion,
with no other change's edits landing in between.

That is a real serialization the workflow does not express: it offers no lock on a shared owned path and no way to say *"this change is
frozen while another completes"*. The honest options are:

1. **Run the four cycles** — expensive (each a seal + verify + review + judge), and each must not be interrupted by another change.
2. **Narrow the shared declarations** — each change owning only what is its own, with the central files owned by one change, so
   siblings stop superseding each other. That is a declaration correction per change, and the command for it exists.
3. **Leave them** — their verdicts are recorded, their work is in the tree, and they stay unarchived with a measured reason.

Option 2 is the only one that removes the cause rather than paying it four times, and it is the same shape as every other fix on this
line: the paths are a declaration, and the declaration is what makes siblings collide.

## The narrowing question, measured

I proposed narrowing the declarations as the only option that removes the cause. Measured per path, and the proposal needs splitting:

| change | owned | drifted | where the drift is |
|---|---|---|---|
| `closure-gate` | 28 | 14 | src 8, tests 5, schemas 1 |
| `kata-gate-surface` | 19 | 11 | src 4, tests 4, schemas 2, docs 1 |
| `review-record-integrity` | 27 | 14 | src 7, tests 5, schemas 1, docs 1 |
| **`wiring-coverage-check`** | **11** | **1** | **tests 1** |

**Narrowing does not substitute for a re-seal.** For `closure-gate` five of its *own* test files drifted as well — it repaired them after sealing — so removing the shared `src/` and `schemas/` paths from the declaration would leave a revision that is still not current. The declaration is not the cause; content changed after the seal.

**What narrowing does buy is durability.** A re-seal over the full surface mints a revision that the next sibling edit to any shared file supersedes again; a re-seal over the change's own paths cannot be superseded except by editing those. So the two are not alternatives — the narrow-then-re-seal is the variant that survives.

**And one change is nearly free.** `wiring-coverage-check` declares 11 paths and exactly one drifted — `tests/unit/unpinned-repairs.test.ts`, which I edited today for another change. Its surface is otherwise its own: `scripts/wiring-check.mjs`, `src/quality/wiring-check.ts`, its five test files and two design docs. It is one re-seal from being current, and its six obligations are then answerable.

**The residual collision is a shared test file.** `tests/unit/unpinned-repairs.test.ts` is declared by both `wiring-coverage-check` and `kata-gate-surface` and drifted for both, so whichever re-seals second supersedes the first — unless that path is assigned to exactly one of them. That is the general shape of the fix: **each shared path assigned to one change, not removed from all**, because a path declared by nobody is a path whose edits no revision measures.
