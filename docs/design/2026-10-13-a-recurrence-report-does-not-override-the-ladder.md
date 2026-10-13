# A recurrence report does not override the ladder

## Context

`a-repair-revalidates-the-evidence-it-moved` reached `review` with a current revision, a passing ledger, and no strict-bar finding. Its historical `instrument-unsound` recurrence was correctly detected as `stopLineCandidate`, but `src/workflow/navigation.ts` routed that diagnostic to `/kata-build`. `src/workflow/repair-entry.ts` then correctly refused Build: it admits a review repair only for an actual blocking/major finding, a ledger deficit, or a superseded revision. The result was an unexecutable loop.

## Decision

Keep recurrence detection and reporting, but do not let a historical `stopLineCandidate` override the normal review ladder. A recurrence with no current strict-bar finding must lead to the fresh review needed to decide whether the repair actually resolved it. A clean current review then follows the normal Judge path. Build admission remains unchanged; no synthetic finding or waiver is created.

**One rule, two branches.** `src/workflow/navigation.ts` holds two recurrence routes, not one: `review_class_recurring` (a class recurring inside a repair) and `review_loop_recurring` (a finding *id* recurring across revisions). Both were written as `phase === 'review' && <diagnostic>`, and both had the same shape — a reading about history overriding the ladder, whose destination refuses in exactly the state that triggers it. The repair is therefore stated once, as a predicate the two branches share (`ladderAdmitsRepair`), rather than at the site the measurement happened to land on. Fixing one instance and leaving its sibling is the way this class returns in the next round.

The predicate is the same fact `repair-entry.ts` decides when it admits a repair: a blocking finding at the tier's bar, or a major one where the tier blocks on major findings. Where it holds, the recurrence branches still route and still name their own reason (a class recurring inside a repair says more than one id repeating); where it does not, the recurrence stays a published reading and the ladder's own branch decides.

## Acceptance and tests

- **AC-1:** Recurrence remains visible in diagnostics but cannot route a current, otherwise-repair-free review to Build.
- **AC-2:** That state requests one fresh independent review without creating a repair obligation or bypassing the stop-line.
- **AC-3:** A clean fresh review reaches Judge rather than looping back to review or Build because of historical recurrence.
- **AC-4:** Build remains unavailable unless its existing strict admission conditions are genuinely met.

`tests/unit/a-recurrence-report-does-not-override-the-ladder.test.ts` builds each state through `readUpstreamSummary` on disk — a sealed revision, an evidence item and a round history carrying the recurring class — rather than assembling a summary by hand, so the states are the ones the production reader produces. Its cases cover the class route (AC-1, AC-2), a clean recorded review (AC-3), and the two directions of AC-4: the same diagnostic still routes where a blocking finding bound to the current revision makes the repair admissible, and `authorizeRepair` refuses in the state with nothing at the bar. A fifth case pins the id reading against the same rule, so neither branch can be re-opened alone.

Single-point mutations, each proven parseable and byte-restored: the class branch ignoring the predicate reddens 3 cases; the id branch ignoring it reddens 1; the predicate forced to admit reddens 4; forced to refuse reddens 1 in the new selector and 3 in the pre-existing one.

## Consequences for an existing contract

`tests/unit/a-recurring-review-loop-is-reported.test.ts` (the contract the archived change `the-review-loop-carries-its-defect-classes` left) asserted the two recurrence routes in a state carrying **no review record at all**, so the ladder had nothing to repair and the route it asserted was one `kata-cli build` refuses. Its fixture now carries a blocking finding bound to the sealed revision — the state that makes the route walkable — so the property it names is still pinned rather than weakened. Two things in that fixture had to become real for the reader to accept it: the task record is created through `createTask` instead of written by hand (the router never opened it through the schema until a case carried a review record), and the new option is `blockingFinding`.

## Boundaries

This change does not weaken strict review, close findings by assertion, fabricate a major finding, or alter the semantics of `stopLineCandidate`. It changes only the navigation consequence of a diagnostic when the repair ladder has no admissible repair.

It also does not touch the escalation above (`escalate_review_without_progress`), which already routes to `/kata-review`; the ordering that keeps the escalation and the invalidating states above the recurrence readings is unchanged.

The recurrence reading is still a *report about history* and still says nothing about whether the current revision is sound: where the ladder admits a repair the branches route on the historical reading even though the current round may hold a different problem. That is deliberate — the reason names what keeps coming back — and it is the same latitude the branches had before.
