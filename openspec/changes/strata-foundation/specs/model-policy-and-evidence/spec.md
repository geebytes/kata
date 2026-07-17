## ADDED Requirements

### Requirement: Vendor-neutral model policy
The runtime SHALL route roles through capability tiers, budgets, and escalation rules without requiring a specific model vendor or storing credentials in repository files.

#### Scenario: Economy implementation fails twice
- **WHEN** an economy implementer reaches the configured repair limit
- **THEN** the runtime SHALL escalate to the configured capable/frontier role or stop with a retryable failure

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
