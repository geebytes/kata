# model-policy-and-evidence Specification

## Purpose
TBD - created by archiving change strata-foundation. Update Purpose after archive.
## Requirements
### Requirement: Host-owned model selection
The runtime SHALL NOT configure, route, or record the host platform's model choice, and SHALL NOT store provider credentials in repository files. Role protocols stay Kata-owned: the implementer has bounded write access to task code and tests, the reviewer writes findings only, the judge writes a structured verdict only, and the distiller writes candidates only.

#### Scenario: A role reaches its repair limit
- **WHEN** an implementer has exhausted the repair rounds available for the task
- **THEN** the runtime SHALL stop at the corresponding gate and instruct the user to choose the model in the host platform, instead of switching models itself

### Requirement: Immutable evidence envelopes
The evidence subsystem SHALL record command, environment summary, exit status, timestamps, relevant diff hash, and bounded logs for lint, typecheck, tests, CI, and reviewer results.

#### Scenario: Evidence does not match the diff
- **WHEN** the current diff hash differs from the evidence envelope hash
- **THEN** the evidence SHALL be marked stale and SHALL not satisfy a Judge acceptance condition

### Requirement: Independent Judge protocol
The Judge SHALL receive acceptance criteria, diff, evidence, and relevant sources and SHALL return structured PASS/FAIL results without modifying code or acceptance criteria.

#### Scenario: Missing boundary test
- **WHEN** an acceptance condition lacks a passing test or equivalent hard evidence
- **THEN** the Judge SHALL return FAIL with the acceptance identifier and a bounded repair scope

### Requirement: Bounded repair loop
The runtime SHALL permit repair only for failed acceptance conditions and SHALL return every repair to hard verification before another Judge decision.

#### Scenario: Repair changes unrelated files
- **WHEN** a repair diff exceeds its failed scope or configured file/diff budget
- **THEN** the runtime SHALL block the loop and require a new planning decision

