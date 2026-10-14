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

## Boundaries

- No recurrence is inferred from missing or unreadable history.
- Only registered `mechanizable` classes activate the packet; non-mechanizable
  review feedback remains an ordinary review concern.
- The packet does not decide root cause. The independent reviewer supplies the
  conclusion, and the writer only validates its binding and action shape.
- This decision does not alter gate strength, reviewer independence, or the
  archive/approval rules.
