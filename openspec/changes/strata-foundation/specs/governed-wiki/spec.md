## ADDED Requirements

### Requirement: Provenance-aware Wiki records
Every verified Wiki record SHALL include a statement, scope, source paths or symbols, source hashes, validation task, evidence references, status, and last verification time.

#### Scenario: Source is missing
- **WHEN** a Wiki record references a deleted source file
- **THEN** the record SHALL become `stale` and SHALL be excluded from authoritative task context

### Requirement: Candidate-only distillation
The system SHALL create Wiki candidates only from tasks that passed hard verification, review, and Judge gates; candidate creation SHALL not automatically promote a record.

#### Scenario: Failed task summary
- **WHEN** a task fails Judge or has stale evidence
- **THEN** Wiki distillation SHALL refuse to create a verified record from that task

### Requirement: Drift and conflict blocking
The Wiki subsystem SHALL detect source-hash drift and conflicts with rules, approved ADR/specs, tests, or current code, and SHALL surface conflicts before implementation proceeds.

#### Scenario: Wiki contradicts an approved ADR
- **WHEN** a Wiki statement conflicts with an approved ADR
- **THEN** the task SHALL enter `needs-clarification` and low-cost implementation SHALL be blocked

### Requirement: Task-scoped Wiki context
The system SHALL generate a minimal context manifest and SHALL distinguish verified Wiki guidance from normative rules and original sources.

#### Scenario: Critical implementation rule
- **WHEN** a task touches an area covered by a verified rule and related Wiki entry
- **THEN** the manifest SHALL include the rule, Wiki status/source summary, and a read-before-write source reference

### Requirement: Explicit promotion
Promotion to verified Wiki SHALL require schema validation, source availability, evidence linkage, and an explicit reviewer or human approval event.

#### Scenario: Unreviewed candidate
- **WHEN** a candidate has valid YAML but no approval event
- **THEN** promotion SHALL fail and the candidate SHALL remain non-authoritative
