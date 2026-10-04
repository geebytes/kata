# Review escalation revision binding

## Problem

`review-rounds.jsonl` is append-only but each line currently records only a timestamp and a blocking count. `readUpstreamSummary()` therefore feeds every historical round into `reviewProgress()`, regardless of the current sealed revision. A prior revision containing only unmeasurable (`blockingCount: null`) rounds can permanently route a later, freshly sealed revision to `escalate_review_without_progress`, even when it has no current findings and must receive a new independent review.

## Decision

Each newly written review-loop round is bound to the revision identity (`revisionId` and `manifestHash`) that opened it. The read/routing surface selects only rounds whose identity matches the current sealed revision before calculating escalation.

Legacy lines without a binding remain readable and visible as audit history. They do not establish an escalation for a later revision because they cannot honestly be attributed to that revision. This does not approve the new revision: it only restores the normal fresh-review path, which still requires independent review, ledger evidence, and Judge approval.

When no sealed revision exists, the legacy repair path remains authorizable for compatibility but records no new unbound loop measurement. The whole-history reader remains available only for that no-current-identity state.

## Writers and readers

- `src/workflow/repair-entry.ts` writes bound rounds when entering a review repair.
- `src/workflow/orchestrator.ts` writes a bound cleared round when review approval records zero findings.
- `src/quality/repair.ts` validates, preserves, and filters revision-bound rounds.
- `src/workflow/navigation.ts` derives `reviewEscalation` from the current revision's filtered history only.

## Verification

Focused tests cover writer bindings, filtering against prior and legacy lines, and the routing outcome for a current revision with only non-current history. The existing terminal-loop tests retain coverage that repeated non-declining rounds within one revision still stop automated repair.
