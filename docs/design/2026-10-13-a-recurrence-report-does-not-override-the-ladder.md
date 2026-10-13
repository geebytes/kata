# A recurrence report does not override the ladder

## Context

`a-repair-revalidates-the-evidence-it-moved` reached `review` with a current revision, a passing ledger, and no strict-bar finding. Its historical `instrument-unsound` recurrence was correctly detected as `stopLineCandidate`, but `src/workflow/navigation.ts` routed that diagnostic to `/kata-build`. `src/workflow/repair-entry.ts` then correctly refused Build: it admits a review repair only for an actual blocking/major finding, a ledger deficit, or a superseded revision. The result was an unexecutable loop.

## Decision

Keep recurrence detection and reporting, but do not let a historical `stopLineCandidate` override the normal review ladder. A recurrence with no current strict-bar finding must lead to the fresh review needed to decide whether the repair actually resolved it. A clean current review then follows the normal Judge path. Build admission remains unchanged; no synthetic finding or waiver is created.

## Acceptance and tests

- **AC-1:** Recurrence remains visible in diagnostics but cannot route a current, otherwise-repair-free review to Build.
- **AC-2:** That state requests one fresh independent review without creating a repair obligation or bypassing the stop-line.
- **AC-3:** A clean fresh review reaches Judge rather than looping back to review or Build because of historical recurrence.
- **AC-4:** Build remains unavailable unless its existing strict admission conditions are genuinely met.

`tests/unit/a-recurrence-report-does-not-override-the-ladder.test.ts` will exercise all four routing states. The focused mutation removes the recurrence-route guard; the cases must redden while the existing Build-admission behaviour remains unchanged.

## Boundaries

This change does not weaken strict review, close findings by assertion, fabricate a major finding, or alter the semantics of `stopLineCandidate`. It changes only the navigation consequence of a diagnostic when the repair ladder has no admissible repair.
