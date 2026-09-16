# Let a superseded revision re-enter Build from Judge

This is the same dead-end as the review-boundary repair, one phase later, and it surfaced the moment release
evidence was added after a Judge PASS.

`/kata-archive` from `judge` transitions to `distill`, and `assertDistillGates` refuses that transition unless
fresh passing evidence, reviewer clearance, and a Judge PASS all line up with the *current* diff hash. Adding a
file to an owned path changes that hash, so the existing evidence stops being fresh and the archive transition is
rejected. But the reuse path back was closed: `reenterImplementForRepair` accepted only a repairable Judge **FAIL**,
so a Judge PASS plus any post-Judge owned-path change left the task unable to re-seal and unable to archive.

The gate now authorizes the repair on either condition, reusing the rule already applied at the review boundary:
a repairable Judge FAIL (unchanged), or a sealed revision that is **superseded** — the owned-path manifest hash no
longer matches what was sealed, computed from the workspace rather than declared by the agent. `repair.json`
records which applied (`judge_fail` versus `revision_superseded`), and a drift-authorized repair carries no
acceptance scopes because no acceptance failed.

Both repair entrypoints now also stop at `implement` instead of continuing to seal in the same command, so a caller
asking to repair gets a repaired state and decides explicitly when to seal — matching the review boundary's
existing behaviour rather than silently sealing a revision the caller never asked for.

Safety is unchanged: sealing mints a new revision, which invalidates the review's revision binding, so the task
must pass `verify`, a fresh Review, and Judge again before it can archive.

`tests/e2e/workflow-resume.test.ts` covers both directions at this boundary: a post-Judge owned-path change
re-enters `implement` with `reason: 'revision_superseded'` and `fromPhase: 'judge'`, while a Judge PASS with no
drift is still rejected.
