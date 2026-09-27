## REMOVED Requirements

- `### Requirement: Adversarial pass reporting surface`
- `### Requirement: Bounded repair loop`

## ADDED Requirements

### Requirement: Bounded repair

The runtime SHALL permit repair only for failed acceptance conditions, for evidence that does not pass, or for a ledger
that does not decide a pass, and SHALL return every repair to hard verification before another Judge decision.

What a repair owes SHALL be expressed as a claim whose evidence does not support it, and a repair SHALL be routed by the
ledger's own deficits rather than by a count of recorded problems — repairing one instance of a class buys the next round
of the same kind. The runtime SHALL NOT carry a repair obligation or a repair batch: both existed to group one review
round's findings for one repair, and there are no rounds to group.

#### Scenario: Repair changes unrelated files

- **WHEN** a repair diff exceeds its failed scope or configured file/diff budget
- **THEN** the runtime SHALL block the loop and require a new planning decision

#### Scenario: A claim the evidence does not support

- **WHEN** a claim's evidence does not meet the strength its severity requires
- **THEN** the ledger SHALL decide other than a pass, through `fail` or `insufficient`
- **AND** the ladder SHALL name `satisfy_ledger_deficits` rather than a count of findings

#### Scenario: A repaired claim stops being a deficit

- **WHEN** the evidence on a re-sealed revision meets the strength the claim's severity requires
- **THEN** the claim SHALL evaluate as supported, and only the claims whose dependencies moved SHALL need re-verification

#### Scenario: A planned check the run will defer

- **WHEN** the plan contains a check the run will not execute, such as a frozen-tier check without the flag that includes it
- **THEN** the dry run SHALL NOT count it as evidence the run will produce, because a deferred check produces none

### Requirement: Evidence-decided review

A governed change SHALL be certified by an evidence ledger rather than by a document about a review: a subject frozen by
content digest, claims, evidence with verdicts, and a decision derived from them. The decision SHALL be a three-way verdict
— `pass`, `fail` or `insufficient` — and a budget that a round exhausted SHALL never be reported as a pass.

Every policy section SHALL have a consumer, and a policy a stored ledger predates SHALL be read the way it was written:
a missing section SHALL take the value its absence implied and the substitution SHALL be reported, while an unknown section
SHALL still be refused, because an absent section is history and an extra key is a declaration nothing reads.

#### Scenario: A change with no ledger cannot be approved

- **WHEN** review approval is requested for a change carrying no ledger
- **THEN** the approval SHALL be refused, naming the commands that record one
- **AND** the change SHALL NOT fall back to an independent-pass record, because one fact with two answers is what the
  ledger replaced

#### Scenario: The ledger decides, and the gate reads that verdict

- **WHEN** a ledger decides a pass for the current content
- **THEN** review approval SHALL rest on it, recording the route, the tier, the assurance level, the claim count and what
  the route does not prove

#### Scenario: A verdict outlives its content

- **WHEN** a declared path moves after the ledger decided
- **THEN** the approval SHALL be refused and SHALL name the paths that moved

#### Scenario: A ledger that exists and cannot be read

- **WHEN** a stored ledger is present and its content does not load
- **THEN** the route SHALL refuse, because an unreadable record is not the same fact as no record

#### Scenario: A budget limit is reached

- **WHEN** a round reaches a declared tool-call, wall-clock or token limit
- **THEN** the verdict SHALL be `insufficient` and SHALL never be `pass`

#### Scenario: A stored policy predates a section

- **WHEN** a ledger's stored policy does not carry a section this build requires
- **THEN** the ledger SHALL be read with that section's implied value
- **AND** the reader SHALL report which sections were filled, rather than substituting silently

### Requirement: Deterministic review kernel

The decision that certifies a change SHALL be a pure function of the content it is given: the same input SHALL produce the
same output, and the kernel SHALL import no filesystem, process or network module and SHALL name no platform.

Findings SHALL be reported in a shape that can be submitted, and the shape SHALL NOT carry a verdict, because a producer
that states its own conclusion has replaced the judgement rather than informed it.

#### Scenario: The same subject decides the same on two adapters

- **WHEN** one subject is decided through two evidence adapters
- **THEN** both decisions SHALL be equal
- **AND** an adapter that cannot judge a stronger evidence class SHALL say so rather than guess

#### Scenario: A platform name reaches the kernel

- **WHEN** the kernel names a platform, a host binary or a session identifier
- **THEN** the platform-coupling check SHALL fail

#### Scenario: A producer submits its own judgement

- **WHEN** a submission carries a verdict or a passed flag
- **THEN** it SHALL be refused and the offending field SHALL be named

### Requirement: Archive carries its known problems

The archive gate SHALL have exactly two exits for a change whose ledger does not decide a pass, and both SHALL be recorded
decisions rather than omitted details: either the unsupported claims are repaired, or the problems are carried somewhere
with a reason, named at the gate.

#### Scenario: An unsupported claim reaches the archive gate

- **WHEN** a change's ledger lists a claim whose evidence does not support it
- **THEN** the archive SHALL be refused and SHALL name the claim

#### Scenario: Living with a problem is a decision

- **WHEN** a problem below the repair bar is to be left unfixed
- **THEN** the archive SHALL require it be carried to a named destination
- **AND** the record SHALL state the reason, because an implicit omission is what the gate exists to prevent
