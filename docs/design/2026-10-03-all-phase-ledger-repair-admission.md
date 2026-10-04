# All-phase ledger-deficit repair admission

## Status

Accepted design for Kata change `all-phase-ledger-repair-admission`. This document is implementation input; it does not change a gate or implementation by itself.

## Problem

`navigation.ts` has one route for a decided ledger whose verdict is not `pass`: `/kata-build`, reason `satisfy_ledger_deficits`. Repair admission is split by phase in `src/workflow/repair-entry.ts`.

The predecessor `ledger-challenge-repair-entry` added ledger admission only to `authorizeVerifyRepair`. Its parent task then reproduced the same contradiction at review:

```text
phase=review
ledger=decided / insufficient / discovery_floor
nextAction=/kata-build
kata-cli build -> authorizeReviewRepair denied
```

`authorizeJudgeRepair` has the same omission. The defect is not that the router chose the wrong remedy; it is that three consumers implement different admission sets for the router's one ledger decision.

The successor is linked to the predecessor through authoritative relation edge `edge-a7626958e6e1492e` (`task:all-phase-ledger-repair-admission spawned_from task:ledger-challenge-repair-entry`). That edge transfers responsibility for the unresolved phase-general defect without claiming the predecessor has passed review.

## Decision

Add one exported helper in `src/workflow/repair-entry.ts`:

```ts
ledgerDeficitRepairAdmission(root, taskId, entryPhase): Promise<LedgerRepairAdmission>
```

It is the only repair-entry code allowed to call `ledgerVerdict()`.

| Ledger reader answer | Shared answer | Repair admission |
|---|---|---|
| `decided`, verdict not `pass` | `authorized` | authorizes repair with `reason: 'ledger_deficits'` |
| `decided`, verdict `pass` | `denied` | no ledger repair exists |
| `absent` | `denied` | no recorded ledger deficit exists |
| `unreadable` | `denied` | unknown is not repair authorization; include the reader detail |

The helper does not evaluate claims, recompute the verdict, or decide phase-specific verify/review/judge failure semantics. `navigation.ts` remains the sole router for ledger deficits and `src/store/verdict.ts` remains the sole ledger verdict derivation.

## Consumer order and preserved guards

Each authorizer (`authorizeVerifyRepair`, `authorizeReviewRepair`, `authorizeJudgeRepair`) retains its existing record-integrity and freshness checks.

1. Read/validate the phase artefact and preserve its existing unreadable/missing refusal.
2. Preserve an already-authorized ordinary route (`verify_fail`, `review_findings`, `judge_fail`, or `revision_superseded`) without consulting the ledger helper.
   - `review_findings` only means a blocking item whose `source` is the review record. `readBlockingProblems` may merge ledger claims for approval/closure consistency, but a claim-only strict-mode bar must not be relabelled as a review finding or bypass `ledgerDeficitRepairAdmission`.
3. If ordinary admission is unavailable, call `ledgerDeficitRepairAdmission`.
4. On authorized, return the shared `ledger_deficits` repair payload for that entry phase.
5. On denied, append the helper's explanatory ledger reason to the existing phase-specific refusal.

Consequences:

- A corrupt review/judge/verify artefact cannot be bypassed merely because a ledger exists.
- A stale phase artefact keeps its existing re-seal/re-review behavior.
- A current, decided `insufficient` ledger (including `challenge_open` or `discovery_floor`) can enter repair from every gate that navigation names.
- `absent`, `pass`, and `unreadable` ledgers are never upgraded to permission.

`RepairReason` already contains `ledger_deficits`; no schema or router change is required.

## Acceptance evidence

| AC | Focused evidence | Behaviour that must go red under mutation |
|---|---|---|
| AC-1 | `tests/unit/ledger-repair-predicate.test.ts` | restore a direct phase-local `ledgerVerdict()` decision or remove the sole helper call; the one-derivation assertion fails |
| AC-2 | `tests/unit/ledger-repair-denial.test.ts` | reverse the non-pass predicate or collapse `unreadable` into authorization; the table-driven boundary cases fail |
| AC-3 | `tests/unit/ledger-repair-phase-entry.test.ts` | remove a phase helper delegation or broaden the review `source === 'finding'` filter; the normal build fixture is denied or the strict claim-only review route records `review_findings` instead of `ledger_deficits` |

Every AC owns a distinct selector. AC-3 drives the public repair entry rather than only the helper, because the preceding failure was a mechanism present in source but unreachable through the actual phase route.

## Scope and cost

Implementation surface is one production module plus three focused unit selectors. The routine path performs at most one ledger read after the phase artefact integrity guard and only when ordinary repair admission has failed; it introduces no repository scan, external process, or model call.

Expected implementation: one TDD slice, three targeted mutation checks, full suite/typecheck, then strict verify/review. The successor must not absorb the unrelated F3/P1/P3 records-root/revision findings from `kata-current-problem-report.md`.
