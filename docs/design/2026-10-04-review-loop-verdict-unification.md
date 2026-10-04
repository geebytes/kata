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
  asserts the entry still authorizes from its one read. It counts **both** exported spellings — see §6.1.5, which records
  that this clause was true of the intent and false of the file until review round 3.

### 6.1.5 The counting mock has to cover both exported spellings — measured, not assumed (F1 of review round 3)

§6.1.1 claimed the witness counts both spellings; the file counted one. The claim was written from intent rather than
from the file, and two independent reviews caught the consequence: a second pointer read spelled
`readCurrentTaskRevision` left the counting case green, because `vi.mock` replaces a module's exports for its *importers*
while a module-internal call to its own function is not redirected. The mock now wraps both exports, and the falsifier
that proves it is the defect's own spelling — reintroducing
`revisionStillDescribes(root, taskId, await readCurrentTaskRevision(root, taskId))` in the supersede test makes the count
2 and reddens the case. Lesson recorded rather than assumed: the mutation that validates a witness must be the mutation
that actually reintroduces the defect, not a convenient one that happens to redden.

### 6.1.6 Names and comments must assert what the case asserts

`tests/unit/review-artefact-read-state.test.ts` carried a case named "routes a corrupted round history to the escalation
terminal" whose assertions were `not_applicable` and `not.toBe(...)` — it never asserted that route (an independent
review caught it; the fixture seals no revision). The name now says what it asserts, and the case also pins that a
damaged history is not dispatched to build. `src/workflow/prompt-catalogue.ts` told the operator the counts ride under
`reviewEscalation`, a field `navigation.ts` declares deprecated and routing never reads — the prompt now names
`reviewLoop`, the assessment the router actually read.


### 6.1.2 The same invariant in the review entry (F4 of review round 2)

The second review found the same class one layer out, in an AC-4 implementation path: `orchestrator.ts` minted the
current-revision identity **twice** in one `review` entry — `entryBinding` for the placeholder it stamps and a second
`currentRevisionIdentity` for the overwrite/archive decision — so a seal landing between the two reads let the stamp and
the decision rest on different revisions. The entry now reads the pointer once (`readCurrentTaskRevisionState`) and mints
both identities from that read through `currentRevisionIdentityFrom`, pinned by
`tests/unit/review-entry-reads-the-pointer-once.test.ts` with the counting mock (mutation: restoring the second
`currentRevisionIdentity` call makes the count 2 and reddens the case).

### 6.1.3 Membership needs both conjuncts witnessed (F2 of review round 2)

C2 claims a round enters the assessed set only when `revisionId` **and** `manifestHash` match. Every fixture coupled the
two fields, so dropping the `manifestHash` conjunct left all declared C2 selectors green. `tests/unit/review-loop-assessment.test.ts`
now builds the one shape that separates the conjuncts — the current `revisionId` with a different `manifestHash` — and
asserts it stays audit-only; dropping the conjunct reddens it.

### 6.1.4 An unreadable round history is a refusal, not a measurement with a note

`navigation.ts` claimed a damaged line in an otherwise readable history "has measurements, and they decide — with the
damage reported beside them". The code cannot represent that state: any malformed line makes the whole record
`unreadable`, which `assessReviewLoop` returns as `unreadable_round_history` with no count and its own route, and no
assessment variant carries a measurement together with `reviewHistoryUnreadable`. The comment was corrected to describe
the pinned behaviour rather than a state that does not exist.

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

### 6.1.7 The writers' one-read invariant, third and fourth sites (F1/F2 of review round 4)

The review-loop writers that stamp a round are the artefact the escalation reads, so each must mint its identity from one
pointer read. Round 4 found the invariant still unmet on AC-4's own declared surface, in `orchestrator.ts`:

- the **approval** path read the same non-atomically written file at least three times — `readBlockingProblems` reading
  it internally, `verifyAgainstRequest` reading it again through the request builder, and `currentRevisionIdentity` a
  third time for the round it stamps. It now takes one `readCurrentTaskRevisionState`, hands it to all three, and mints
  the stamp through `currentRevisionIdentityFrom`;
- the **result-file** path minted its binding from one read and let `readReviewRecord` take a second to decide whether
  the revision already had a record. The reader now receives the caller's read.

Both are pinned by `tests/unit/review-writers-read-the-pointer-once.test.ts` with the counting mock, and the falsifier is
the mutation that reintroduces the defect (dropping the handed-in read reddens the case).

### 6.1.8 An order claim needs a reachable state (F3 of review round 4)

`review-artefact-read-state.test.ts` had a case named "keeps the unreadable-history refusal ahead of a broken ledger"
whose fixture sealed no revision: the assessment answered `not_applicable` and the route came from the ledger, so the
order the name asserts was never exercised — demoting the round-history arm below the ledger branches reddened nothing
(measured). The fixture now seals a revision first, so `unreadable_round_history` is the state under test, and that
demotion reddens six cases. Same rule as §6.1.6: a name may only assert what the case can reach.

### 6.1.9 Two refusals need their own voice, and a stale reason needs deleting

`repair_unreadable_current_revision` and `repair_unreadable_round_history` had no `statusPrompt`, so an operator saw the
generic "run /kata-build" line for two states the unified assessment introduced precisely to stop being read as ordinary
builds; both now name the artefact to repair. `src/quality/repair.ts` still justified its damage accounting with a call
path that no longer exists ("`navigation` feeds these rounds to `reviewProgress` whatever the kind says") — the route
returns `unreadable_round_history` before `reviewProgress` is reached; the sentence now describes that. The three
`@deprecated` projections on `UpstreamSummary` (`reviewEscalation`, `reviewHistoryUnreadable`,
`currentRevisionUnreadable`) remain written and read by no production code; they are left in place deliberately as the
readable shape older records were written in, and are recorded here as dead output rather than silently removed.

### 6.1.10 Round 5: the same invariant, the same class, and what is deliberately left

Round 5 reported no counterexample to C1–C4 and four more instances of the class this change exists to state.

- **A second look inside the same refusal** (`orchestrator.ts:1628`): the ledger-not-pass branch took its own
  `readBlockingProblems` after the decision had already been made from `approvalRevisionRead`. Measured reachable
  (decided-and-not-passing ledger, no problems at the mode's bar) and fixed by handing it the read in hand.
- **The third witness that counted one spelling** (`tests/unit/review-entry-reads-the-pointer-once.test.ts`): §6.1.5's
  lesson was applied to two files and missed a third. Fixed the same way, with the sibling-spelling mutation reddening
  it.
- **A case that could not reach what it named** (`review-artefact-read-state.test.ts`): the case claimed a damaged
  history is not dispatched to build, from a fixture that sealed no revision — so every `not.toBe(...)` was vacuous, and
  its claim contradicted the sibling case that pins the sealed behaviour. The fixture now seals, and deleting the
  round-history arm reddens two cases.
- **Two documentation facts**: the `ReviewLoopAssessment` doc called `stalled_current_rounds` "the only verdict variant"
  while the union has seven (it is the only one that *escalates*), and `reviewProgress` is exported without an identity
  parameter. The second is kept deliberately — its only production caller is the evaluator — and now says so at the
  definition instead of being inferred by the next reader.

**Outside this change's declared surface, recorded rather than fixed**: `src/workflow/distill-gates.ts` synthesises one
"is the review clear" decision from three separate pointer reads (`readReviewRecord`, `readBlockingProblems`,
`currentRevisionIdentity` at :76/:97/:108, plus a fourth in the judge path). That file is not in this change's ownership,
so it is a follow-up candidate, not a silent repair.
