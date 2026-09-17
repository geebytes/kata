# One next-action resolver, and one phase table behind it

The architecture review's L2-01 finding: "what happens next" was computed twice. The dispatcher's ladder lived in
`navigation.suggestCandidateAction`, and `cmdVerify` built a second, priority-less ladder inline over the same scope
literals — so the verify surface, which is the one that actually drives the user's next command, was the surface
nothing tested. The phase→skill/role/reason facts were split across four places: `nextSkillForPhase` in navigation,
`roleForPhase` in the CLI, `workflowNextReason` in the CLI, and a *second private* `roleForPhase` in
`hooks/runtime.ts`.

Two of those had already drifted into live defects:

- **The CLI and the hook disagreed about who may be active.** `hooks/runtime.ts` accepts `designer` as the active role
  during `plan` and `approver` during `archive`; `cli.ts` activated the hook as `implementer` and `dispatcher` for
  those phases. The hook throws on a mismatch and every call site swallows it with `.catch(() => null)`, so activating
  a task in `plan` or `archive` silently produced no active-task hook guard at all.
- **`roleForPhase` was used for two different questions.** At the activation sites it means "the role the hook
  accepts"; in the fallback action and the ask-user prompt it was used as "the role that acts next" — which for
  `review` is the judge, not the reviewer.

## What is one authority now

`workflow/navigation.ts` holds the phase facts in two tables, and everything else reads them:

- `activeRoleByPhase: Record<Phase, string>` — who may be active in a phase. `activeRoleForPhase` is what
  `hooks/runtime.ts` enforces; the CLI's `roleForPhase` is now an alias of it, so activation and enforcement cannot
  disagree (the silent-failure defect above is gone).
- `phaseFallback: Record<Phase, { nextSkill, role, reason, priority }>` — the next action a phase implies when nothing
  more specific applies. `nextSkillForPhase` returns its `nextSkill`, the CLI's `workflowNextReason` returns its
  `reason`, and the dispatcher's own tail ladder returns the row itself, so the three cannot disagree.

`cmdVerify` no longer derives anything: it writes `verify.json`, asks `readUpstreamSummary` for the artefacts it just
wrote, calls `suggestCandidateAction(phase, upstream)` and turns the suggestion into the action contract with
`nextActionForTask`. The inline ladder, the hand-built wiki-closure action and the phase-conditional `'/kata-judge' vs
'/kata-review'` ternary are gone; the error text still keys off the reason, which now comes from the resolver.

Two consequences worth naming, both deliberate:

- The dispatcher's `hardVerify` FAIL branch now applies the shared scope→reason mapping instead of hardcoding
  `repair_failed_verify`, so a verify FAIL whose scopes are uniform names the scope (`rebuild_superseded_revision`,
  `add_entrypoint_evidence`, …) exactly as `cmdVerify` did. This was the last place where the two ladders disagreed
  about a reason.
- The CLI's workflow fallback action no longer reports the placeholder reason `continue_workflow`; it reports the
  phase's real reason. `continue_workflow` was therefore removed from the vocabulary, since nothing produces it.

Wiki closure kept its place ahead of review, but only where it belonged: the resolver asks for closure when verify has
run to a verdict and the implementation itself is ready (`failedVerifyAcceptance === 0`), and still asks for
verification when nothing has been verified yet.

## Verification

- `tests/unit/next-action-resolver.test.ts` — every phase has one fallback row shared with `nextSkillForPhase`; the CLI's
  activation role equals the hook's for every phase; a verify FAIL maps through the shared scope table (and falls back
  for scopes that carry no specific reason); a verified task goes to review or judge by phase; an open Wiki closure
  precedes review but never precedes verification; a suggestion becomes the full action contract; `--seal` is appended
  only for rebuild reasons; every phase is reachable through the resolver.
- Full suite: 466 tests in 50 files, all passing, including the existing dispatcher tests that pin
  `roleForPhase('review') === 'reviewer'` and the e2e that pins the stale-repair reason; `tsc --noEmit` clean;
  `dist/cli.js` rebuilt.
