# Review recurrence circuit breaker

## Decision

A review request now carries a deterministic `recurrencePacket` when a defect class is
`mechanizable`, recurs across review rounds, and at least one recurrence has
`origin: "repair"`. The packet changes the next independent read from ordinary
certification into root-cause analysis.

The packet is derived only from `.kata/tasks/<id>/review-rounds.jsonl` and names
that file, `review-history.jsonl`, and `review.json` as its sources. It carries
the recurring class, affected finding ids, the repair-origin count, and the
minimal recorded rounds containing that class. It does not copy author prose or
infer a cause from a finding message.

A result recorded against such a request must include `recurrenceAnalysis`:

- the exact triggered classes;
- one conclusion: behaviour defect, unsound instrument, claim-scope error,
  workflow-routing error, or demonstrated non-recurrence;
- at least one concrete record/source reference; and
- a compatible next action: `repair`, `restate_claim`, or
  `resume_certification`.

The review-result writer rejects an ordinary result while the packet is active.
It persists a validated analysis alongside the round result so later repair and
certification work can see the conclusion rather than relying on conversation
memory.

## Why

Repeated review rounds had treated each new finding as a local defect even when
the finding attacked the previous repair. This creates a positive feedback loop:
more hand-written assertions or exception lists create more review surface while
the original mismatch remains unexamined. The loop is especially likely when a
claim states router-wide behaviour but its falsifier mutates only one branch, or
when a text heuristic stands in for a semantic boundary.

The circuit breaker preserves strict review: it does not waive a finding or
allow approval. It changes the review obligation before another ordinary round
is purchased, forcing a reviewer to identify whether the repair target is code,
an instrument, claim scope, or an unwalkable workflow route. A later repair
still requires normal independent certification.

## Amendment (2026-10-16): the breaker now contracts the repair, and recurrence has a named consequence

Measured after four months of use on `the-gates-can-be-repaired`: eight rounds, ~70.7 hours, 53 findings, 51 of them
`origin: repair`, and a blocking count that went 5 → 2 → 3 → 1 → 2 → 1 → (unmeasured) → 2. The packet fired and named the
class each time; the loop still ran, because every conclusion it could carry (`behaviour_defect`, `instrument_unsound`,
`workflow_routing_error`) was forced to `nextAction: repair`, and a repair is a local patch the next round is free to find
a neighbour of. Three changes make the conclusion binding and the recurrence terminal:

1. **`repair` owes a `closureObligation`.** A conclusion that routes back to repair must carry the class-level closure the
   next Build is contracted to: `states` (the finite states the class can be in), `sourceOfTruth` (the one symbol every
   producer and consumer derives the fact from), `inventory` (every producer, consumer, writer and reader that exists
   today), `invariant`, `repairSurface`, `effectivenessTest` (the check that reddens while any site still violates the
   invariant) and `ifRecursAgain`. A `repair` conclusion without it is refused; attaching it to a conclusion that is *not*
   `repair` is refused too, because that would contract a repair that is not going to happen. This is the difference
   between "you must explain yourself" and "you must say what would make recurrence impossible".
2. **`ifRecursAgain` is enforced, not merely recorded.** `src/quality/repair-declarations.ts` derives which classes have already been declared (from `review-history.jsonl` plus the active record); a class whose latest conclusion asked for a repair, and which is *still* a stop-line candidate, has spent its declared repair, so routing answers `escalate_declared_repair_did_not_hold` — terminal, and ahead of the route that would buy the same repair again. `not_same_class` clears a class rather than spending it.
3. **`ifRecursAgain` is a terminal exit, from a closed vocabulary** (`rewrite_mechanism` | `waive_with_owner` |
   `abandon_change`), shared with the escalation surface (`ESCALATION_EXITS`) so the exits printed when a loop stops and
   the consequence a repair contract commits to cannot drift. None of them is another repair.
4. **The validator reports every problem at once.** A round whose result carried one out-of-vocabulary value or one
   malformed sub-object was refused with one sentence, and the whole round's findings were discarded with it (measured
   twice in one round). A validator that costs a round per mistake multiplies the loop it exists to shorten.

The escalation this packet feeds is also no longer a review round: `escalate_review_without_progress` routes to `/kata`
(read-only status) with the three exits attached, and the stop line now counts the **repair chain** rather than one
revision — because every repair seals a new revision, the revision-scoped count restarted at each one and never reached
`NO_PROGRESS_ROUNDS`. See `docs/architecture-reviews/2026-10-16-review-loop-nonconvergence-root-cause.md` for the root-cause
analysis and `docs/engineering/2026-10-10-unified-kata-defect-queue.md` §4 for what landed.

## Boundaries

- No recurrence is inferred from missing or unreadable history.
- Only registered `mechanizable` classes activate the packet; non-mechanizable
  review feedback remains an ordinary review concern.
- The packet does not decide root cause. The independent reviewer supplies the
  conclusion, and the writer only validates its binding and action shape.
- This decision does not alter gate strength, reviewer independence, or the
  archive/approval rules.
