# Let a superseded revision re-enter Build from Review

`/kata-build` could only return a task to `implement` from `review` when the recorded review carried a `blocking`
finding, or a `major` finding under strict closure. The guard existed to stop an agent from rewriting reviewed code
without a recorded reason, but it left a real repair path unreachable: a reviewer that records only `minor`/`note`
findings, and whose author then repairs them anyway, has no way back to Build. The working tree no longer matches
the sealed revision, so the evidence is stale, and the only remaining move is to carry that stale evidence into
Judge. `verify` had already recognized the same condition as repairable — `revision_superseded` is one of its
`repairableScopes` — which made the inconsistency sharper: `verify` could recommend `/kata-build --seal` for a
condition `build` then refused.

`reenterImplementForReviewRepair` now authorizes the repair on one of two independent conditions:

- the review carries `blocking` findings, or `major` findings under strict closure (unchanged); or
- the sealed revision is **superseded** — the owned-path manifest hash no longer matches what was sealed, which is
  computed from the workspace rather than declared by the agent.

The repair record's `reason` distinguishes them (`review_findings` versus `revision_superseded`), and a
drift-authorized repair carries every recorded finding — including `minor` and `note` — as repair context, since
those are exactly what the author is acting on. `readActiveReviewRepairBaseline` now accepts both reasons, so a
drift-authorized repair keeps the existing "cannot seal without a changed manifest" check and is marked resolved
after a successful seal.

This does not weaken review. A new seal mints a new revision, which invalidates the review's revision binding, so
the task must pass `verify` and a fresh `/kata-review` again before Judge. The authorization is hash-derived and
auditable in `repair.json` (`baselineManifestHash` against the current manifest), not self-declared.

`tests/e2e/workflow-resume.test.ts` covers both directions: minor findings plus an owned-path mutation re-enter
`implement` with `reason: 'revision_superseded'` and the finding preserved, while minor findings with no mutation
still stay in `review` and are rejected with the (now extended) message.
