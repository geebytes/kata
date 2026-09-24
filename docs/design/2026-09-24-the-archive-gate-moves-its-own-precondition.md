# The archive gate moves its own precondition

## What I expected, and what is actually true

I told the user that `major-finding-closure` and `repair-obligation-deadlock` were one handoff away from archiving: both are at
phase `judge` with `judge PASS` / `verify PASS` / `review approved`, all three bound to the same revision as `current-revision.json`
with matching `manifestHash`, and the only refusal I could see was *"Workflow mutation requires a current acknowledged handoff
receipt for distiller"*. I walked that handoff through and reported the path open.

**That was wrong, and the handoff refusal was the first of two.** Behind it, `kata-cli archive` refuses with *"Cannot enter distill
until fresh evidence, reviewer clearance, and judge PASS are present"* — and the gate report says why:

```
major-finding-closure   | status superseded | fresh: null | review: true | judge: false stale_judgement
repair-obligation-deadlock | status superseded | fresh: null | review: true | judge: false stale_judgement
```

`freshPassingTestEvidence` skips an envelope whose bound revision is not current, so `freshEvidence` is null and the gate fails. And
`revisionStatus` is `superseded` — measured, not inferred — because the expected manifest hash of the revision's owned paths no longer
matches the digest it recorded.

## The cause, measured

`onlyInTask: 0 | onlyInRevision: 0` — the declaration did not change. The **content** did, and one part of it is structural:

```
major-finding-closure | ownedPaths 29 | missing: 3
  ✗ openspec/changes/major-finding-closure/proposal.md
  ✗ openspec/changes/major-finding-closure/specs/model-policy-and-evidence/spec.md
  ✗ openspec/changes/major-finding-closure/tasks.md
  ✓ openspec/changes/archive/2026-09-21-major-finding-closure/proposal.md   (all three, moved)
```

**A governed change's own three OpenSpec files are in its `ownedPaths`, and the OpenSpec archive step moves them into
`openspec/changes/archive/<date>-<id>/`.** So the revision's manifest covers three paths that archiving relocates; the moment the
OpenSpec side is archived, the revision can never be `current` again, its evidence can never be fresh, and **kata's `archive` can
never pass** — because the freshness it requires was destroyed by the archive it also needs.

`src/cli/ops.ts` and the other shared source paths contributed as well (my later work edited them), but those could be re-sealed.
The three moved OpenSpec files cannot: they no longer exist at the paths the revision covers, and moving them back would undo the
OpenSpec archive.

## The class

**The gate's precondition is destroyed by the operation it gates.** It is not "a check reads a declaration while claiming reality"
(that is the class table's second entry, and the declaration here is correct) and it is not any of the other four. It is:

> **a measurement whose subject the workflow relocates, so satisfying the procedure invalidates the evidence for it.**

The same shape as the fifth, one level apart: the fifth is *the output has one channel and the process may not reach it*; this is
*the evidence names a location and the procedure moves the thing*. Both are failures of a workflow rather than of a mechanism, and
both were invisible to reading code — the first needed three rounds that wrote nothing, this one needed an archive attempt that
looked like a handoff problem.

## What I did not do

I did not move the OpenSpec files back to make the gate pass. That would satisfy the check by undoing the archive it certifies —
the same class of move as editing a record until a gate accepts it, and this line has recorded that as the one thing a repair must
not do. The two changes stay at `judge` with their verdicts intact and their archive blocked by a platform defect, which is the
honest state, and it is recorded here rather than in a workaround.

The measured consequence for the queue: **any change whose OpenSpec side has been archived can no longer be archived by kata**, so
`check-log-artifact-missing` and `worktree-no-commit-message` — already at phase `archive` and reported as done — were archived
before their OpenSpec files moved, or by a path that did not re-check freshness. That distinction is worth measuring before it is
claimed, and it is not measured here.
