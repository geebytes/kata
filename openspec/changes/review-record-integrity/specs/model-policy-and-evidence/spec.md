## ADDED Requirements

### Requirement: Derived change records

A revision SHALL carry a change record whose factual surface is derived from the facts the runtime already holds — the
paths the working tree reports as changed, the sealed evidence, the evaluated claims and the tracked findings — and the
runtime SHALL NOT accept that surface from a caller.

#### Scenario: A record is derived, not asserted

- **WHEN** a seal produces a change record for a revision
- **THEN** the changed paths SHALL come from the repository's own change listing
- **AND** the record SHALL name the changed paths no declared owned path covers
- **AND** the record SHALL carry counts it derived, so no reader derives a count by hand

#### Scenario: A record's prose is labelled

- **WHEN** a change record carries prose
- **THEN** that prose SHALL be confined to a `judgement` field, named so a reader knows which half of the record is a claim
  about intent rather than a derived fact

### Requirement: Checkable record rows

A governed record row SHALL be able to declare a checkable claim, and a row whose claim contradicts it SHALL fail the seal
and SHALL name the claim that failed, rather than being discovered by a later independent pass.

A claim that declares no expected outcome SHALL be refused before the check set is resolved, because a check that cannot
fail is not evidence.

#### Scenario: A false record row fails the seal

- **WHEN** a governed record row declares a claim whose command contradicts the row
- **THEN** the seal SHALL fail
- **AND** the failure SHALL name the claim identifier


#### Scenario: A failed claim is recorded with the seal that found it

- **WHEN** a claim check contradicts its record row during a seal
- **THEN** that seal's change record SHALL list the claim failure and its observed outcome
- **AND** the record SHALL NOT report an empty claim-failure surface while the seal diagnostics report a contradiction
#### Scenario: An unfalsifiable claim is refused before it runs

- **WHEN** a claim declares no expected outcome, so nothing can contradict it
- **THEN** the runtime SHALL refuse it before resolving or running the check set
- **AND** the refusal SHALL say a check that cannot fail is not evidence

### Requirement: Applied scope changes

A recorded scope change SHALL be applicable, and applying it SHALL change the task's declared owned paths so that the next
revision hashes the grown surface. Applying a scope change that was not recorded SHALL be refused with the reason.

The delta surface computed against a base revision SHALL include every path the working tree reports as changed, whether or
not a declared owned path covers it.

#### Scenario: The audited surface grows by decision

- **WHEN** a scope change is recorded for a task
- **THEN** applying it SHALL change the task's declared owned paths
- **AND** applying a scope change that was never recorded SHALL be refused with the reason

#### Scenario: The delta surface includes what changed

- **WHEN** a delta surface is computed against a base revision
- **THEN** it SHALL include every path the working tree reports as changed, whether or not a declared owned path covers it

## MODIFIED Requirements

### Requirement: Immutable evidence envelopes

The evidence subsystem SHALL record command, environment summary, exit status, timestamps, relevant diff hash, and bounded
logs for lint, typecheck, tests, CI, and reviewer results.

#### Scenario: Evidence does not match the diff

- **WHEN** the current diff hash differs from the evidence envelope hash
- **THEN** the evidence SHALL be marked stale and SHALL not satisfy a Judge acceptance condition
