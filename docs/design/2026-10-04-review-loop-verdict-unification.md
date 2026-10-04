# Review-loop verdict unification

**Change:** `review-loop-verdict-unification`
**Profile:** `current_worktree / tdd / strict`
**Status:** implemented; pending governed falsification, seal, and verification.

## 1. Problem and root-cause attribution

`review-escalation-revision-binding` established that a review round needs a revision binding. Its strict reviews then found that the *verdict* remains assembled across multiple readers and routing branches. A local filter is not enough when a parallel source can emit an escalation without that filter.

The historical findings divide into two classes:

| Finding | Attribution | Lesson |
| --- | --- | --- |
| Old-revision rounds blocked a fresh review | Pre-existing; it opened the predecessor change. | A verdict had no revision scope. |
| Filtered loop, unfiltered aggregates | Introduced by the predecessor's initial binding implementation. | Filtering one loop does not scope the aggregate that consumes it. |
| Unreadable sealed pointer passed `undefined`, restoring whole-history meaning | Introduced/activated by the predecessor's initial optional-identity integration. | `undefined` must not mean both “unknown identity” and “all supplied rounds”. |
| A writer stamped a round after a second sealed-pointer read | Introduced by the predecessor's binding implementation. | Authorization and attribution must use one snapshot. |
| `historyHasNothingToMeasure` independently emitted an escalation | Pre-existing parallel path, introduced before the predecessor change; not caused by its latest repair. | File corruption or absence cannot borrow the semantics of a current-revision verdict. |

The latest substantive review finding is therefore not evidence that the last patch created a regression. It exposed a pre-existing parallel verdict producer that AC-2 made visible. The independent-review loop is doing its job; the architecture lacked a finite, auditable list of verdict producers and consumers.

## 2. Decision

Introduce one total, pure decision boundary:

```ts
assessReviewLoop(input: ReviewLoopInput): ReviewLoopAssessment
```

`ReviewLoopInput` carries exactly one sealed-revision record read and one review-round-history record read. The evaluator is the **only producer** of review-loop outcomes. Navigation, prompts, next-action selection, and repair admission consume its discriminated result; they must not recompute escalation from raw rounds, `undefined` identity, or file-level booleans.

`reviewProgress` remains an internal calculation over an explicitly supplied, already-scoped round set. It must not accept an optional revision identity or silently interpret a missing identity as “all rounds”.

## 3. Total assessment model

The result is a discriminated union. Each variant owns its data source and its deterministic routing meaning.

| Variant | Preconditions | May emit a current-review escalation? | Routing meaning |
| --- | --- | ---: | --- |
| `not_applicable` | No current sealed revision or phase does not require a review-loop judgment. | No | No loop override; normal revision/phase routing remains authoritative. |
| `unreadable_current_revision` | Sealed-revision pointer exists but cannot be parsed or validated. | No | Named `repair_unreadable_current_revision` refusal. |
| `unreadable_round_history` | Current identity is usable but review-round history cannot be read. | No | Named `repair_unreadable_round_history` refusal. |
| `no_current_rounds` | Both records are usable and no round is bound to the current identity. | No | Fresh-review path; foreign and legacy lines stay audit-only. |
| `unmeasurable_current_rounds` | Current-bound rounds exist but none carries a measurable blocking count. | No generic escalation | A distinct, named review-loop terminal carrying only current round ids/count; it is not an artefact-read error and not a zero-id blocking escalation. |
| `progressing_current_rounds` | Current-bound measured rounds have not reached the no-progress threshold. | No | Normal review continuation. |
| `stalled_current_rounds` | Current-bound measured rounds reach the no-progress rule. | **Yes** | The sole source of `reviewEscalation`; payload contains only the scoped round/count/blocking-id set. |

`unreadable_*` and `unmeasurable_*` are intentionally distinct: unreadable means no facts can be read; unmeasurable means readable current facts cannot support the measurement. Neither can be represented as a zero-count escalation.

## 4. Scope and snapshot rules

1. A usable sealed pointer produces an explicit `CurrentRevisionIdentity` (`revisionId` plus `manifestHash`). There is no `undefined` identity mode.
2. Only a round whose complete binding equals that identity enters the scoped set. Foreign-revision and legacy-unbound rows remain readable in history output but never enter an assessment for a later revision.
3. `appendReviewRound` / approval / repair writers receive the exact identity snapshot read while authorizing the write. They do not call a current-revision reader again to stamp the row.
4. A reader returns a three-way record state (`absent | usable | unreadable`). The assessment maps that state once; downstream consumers do not reinterpret an unreadable record as empty, absent, or whole history.
5. `ReviewLoopAssessment` is the one value navigation branches on. Prompt and next-action surfaces receive that outcome or a projection of it, never raw round data for a second verdict.

## 5. Routing and priority

The evaluator separates *classification* from navigation priority. Navigation assigns one route to each assessment kind before considering lower-priority ledger or ordinary repair routes:

1. `unreadable_current_revision`
2. `unreadable_round_history`
3. `unmeasurable_current_rounds`
4. `stalled_current_rounds`
5. non-terminal kinds delegate to the ordinary current revision / review flow

This preserves the predecessor's safety property — unreadable history cannot route an author to ordinary build work merely because another artefact is usable — without mislabelling unreadability as escalation. A route has a reason only for the fact it actually observed.

## 6. Verification matrix

The implementation is TDD-first and adds a table-driven matrix rather than another finding-specific example.

### Assessment matrix

For each sealed state (`absent`, `usable`, `unreadable`) and history state (`absent`, `usable`, `unreadable`), assert the exact assessment variant and route. For usable history, vary the scoped composition:

- no rows;
- legacy-unbound only;
- foreign-bound only;
- current-bound measurable / progressing;
- current-bound measurable / stalled;
- current-bound all-unmeasurable;
- each current case with arbitrary foreign and legacy rows appended.

The append transformation is a metamorphic property: adding non-current rows must not change an assessment already based on a current identity.

### Consumer and writer matrix

- Every assessment variant maps to exactly one route, with no priority collision with ledger, review-record, or revision-read failures.
- `reviewProgress` has no optional-identity fallback and is reachable only through the evaluator for routing decisions.
- A controlled sealed-reader sequence proves a writer's authorization identity is the identity stamped onto its new round even if a later read would differ.
- Legacy rows stay visible to audit/history display but do not alter the assessment of any sealed revision.

Each AC gets a mutation-backed falsifier. Mutations target the evaluator’s membership predicate, the sole escalation variant, the route mapping, and the writer snapshot handoff respectively; each must turn its selector red and restore cleanly.


## 6.1 Strict review evidence contract

> F1 repair: an acceptance matrix and seal evidence alone do not populate the strict ledger's ReviewRequest. This change therefore declares one ledger claim per AC, each with the relevant implementation/test paths as its reading set and a mutation-backed `executable_falsifier`.

| Claim | AC | Falsifier target | Selector |
| --- | --- | --- | --- |
| C1 | AC-1 | the evaluator's unreadable-identity discrimination | `tests/unit/review-loop-assessment.test.ts` |
| C2 | AC-2 | `roundBoundTo()` membership predicate | `tests/e2e/review-loop-verdict-unification.test.ts` |
| C3 | AC-3 | the stalled-kind route reason | `tests/unit/review-loop-routing-contract.test.ts` |
| C4 | AC-4 | writer reuse of `blockingRead.revision` snapshot | `tests/unit/review-round-revision-binding.test.ts` |

### 6.1.1 One pointer read per repair entry (F1 of review round 1)

An independent review measured that C4's claim ("does not take a second current-revision read") did not hold:
`authorizeReviewRepair` stamped the round from the read `readBlockingProblems` carried, but then asked
`revisionNoLongerDescribes` — which performed its own `readCurrentTaskRevision` — to choose between
`review_findings` and `revision_superseded`. Two readers of one non-atomically written file, so under a concurrent seal the
repair reason and the stamped round could rest on two different pointer states; the declared witness could not see it,
because it asserted the textual absence of one spelling of the second read.

The rule, now implemented and pinned behaviourally:

- the entry takes **one** `readCurrentTaskRevisionState` and hands that read to `readBlockingProblems`, so the binding,
  the mode, the open problems, the supersede test and the stamp all derive from the same snapshot;
- `revisionStillDescribes(root, taskId, revision)` takes the revision from its caller and never reads the pointer, so a
  second reader cannot reappear inside the supersede test;
- the witness makes the pointer's **second** call impossible (the same counting mock the verify/judge writers use) and
  asserts the entry still authorizes from its one read — mutation-checked: restoring a fresh pointer read inside the
  supersede test changes the count from 1 to 2 and reddens the case.

The ledger submission is produced through `kata-cli ledger evidence add`; Kata applies each mutation, requires the selector to redden, restores it, and records the observed verdict. The subsequent ReviewRequest must carry these claims and their dependency paths; an empty strict request is a blocking review failure, never an empty review conclusion.
## 7. Files and migration

Expected implementation surface:

- `src/quality/repair.ts` — assessment union, pure evaluator, explicitly scoped progress helper.
- `src/workflow/navigation.ts` — one evaluator call and exhaustive route mapping.
- `src/workflow/repair-entry.ts` — carry the authorization snapshot rather than re-reading it.
- `src/workflow/orchestrator.ts` — provide one snapshot to round writers.
- focused review-loop, routing, binding, filter, and artefact-read-state unit tests.

There is no on-disk migration. Existing unbound rows remain legible historical data. They receive no inferred revision binding and therefore cannot affect any later sealed revision.

## 8. Non-goals

- This change does not alter ledger verdict semantics, review severity thresholds, or gate strength.
- It does not rewrite or delete historical review rounds.
- It does not certify the predecessor change; after this successor is sealed and independently reviewed, the predecessor must receive its own fresh review against its own revision.

## 9. Cost and closure criterion

The prior incremental loop paid a full seal/verify plus an independent review per newly discovered source (observed reviews ranged from roughly 222 s to 929 s). This design pays one broader implementation round but bounds discovery by an explicit producer/consumer and state matrix.

The design is complete only when every review-loop verdict producer and consumer is mapped to `ReviewLoopAssessment`, the matrix covers every record-state combination, and an independent reviewer can find no raw-round or optional-identity route that bypasses the evaluator.
