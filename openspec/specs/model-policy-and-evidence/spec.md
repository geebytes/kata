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

A finding whose severity is terminal SHALL create a repair obligation, and a batch SHALL be closeable by accounting for every terminal finding it opened on. Resolving an obligation SHALL depend on evidence for the revision rather than on the task having declared an acceptance matrix.

A repair obligation SHALL be answerable by the revision's evidence, and a seal SHALL NOT refuse an obligation that the run being refused would itself answer. The seal and the resolver SHALL decide answerability by the same rule, and the seal SHALL deny only obligations that would remain unresolved once the run's evidence exists.

#### Scenario: Repair changes unrelated files
- **WHEN** a repair diff exceeds its failed scope or configured file/diff budget
- **THEN** the runtime SHALL block the loop and require a new planning decision

#### Scenario: A major finding is recorded
- **WHEN** a review finding of terminal severity is recorded
- **THEN** a repair obligation SHALL be created for it, from the same severity rule the gates use

#### Scenario: A repaired batch is re-sealed on a task with no acceptance matrix
- **WHEN** every terminal finding a batch opened on has been repaired and the content re-sealed
- **THEN** the batch SHALL close and name those findings as answered, whether or not the task declared an acceptance matrix

#### Scenario: A batch has closed
- **WHEN** the adversarial brief is issued after the batch closed
- **THEN** the round framing SHALL NOT describe a repaired finding as unrepaired

#### Scenario: An adversarial finding is added mid-round
- **WHEN** a finding of terminal severity is added to an adversarial pass
- **THEN** a repair obligation SHALL be created for it, so the batch it opens on can later account for it as answered

#### Scenario: An obligation is not scoped to a criterion
- **WHEN** an obligation carries no `acceptanceId`
- **THEN** it SHALL be answerable by the revision's passing evidence, because there is no criterion to scope it to

#### Scenario: A seal on a task with unresolved obligations
- **WHEN** a task has no acceptance matrix and carries an unresolved repair obligation
- **THEN** the seal SHALL refuse and name the obligations, rather than passing silently while the batch stays open

#### Scenario: A major finding is recorded in a verdict
- **WHEN** an adversarial pass records a finding of terminal severity
- **THEN** the repair batch it opens SHALL have an obligation for that finding, so the batch can account for it

#### Scenario: The severities that block approval
- **WHEN** review approval reads existing findings
- **THEN** it SHALL block on the severities the gate names for the task's review mode — blocking, and major in strict —
  so that a finding which does not block approval is not described as if it did

#### Scenario: A task with no acceptance matrix carries an unresolved obligation
- **WHEN** a seal runs on a task that declared no acceptance matrix and whose obligation this run's checks can answer
- **THEN** the seal SHALL run the checks, resolve the obligation from the evidence they produce, and seal

#### Scenario: An obligation the current run cannot answer
- **WHEN** a seal runs on a task carrying an obligation that this run's evidence would not answer
- **THEN** the seal SHALL refuse, name the criterion, and state that supplying evidence or an acceptance matrix is the remedy

#### Scenario: The seal and the resolver disagree about one obligation
- **WHEN** an obligation's answerability is computed for the preflight and for resolution
- **THEN** both SHALL consult one rule, so a seal can never pass while leaving the obligation unresolved

#### Scenario: A planned check the run will defer
- **WHEN** the plan contains a check the run will not execute, such as a frozen-tier check without the flag that includes it
- **THEN** the dry run SHALL NOT count it as evidence the run will produce, because a deferred check produces none

#### Scenario: A batch closes with answered findings
- **WHEN** a repair batch closes and names findings as answered
- **THEN** each answered finding SHALL be marked fixed, so the round framing stops reporting it as unrepaired, and a
  failure to record that SHALL be reported rather than swallowed

### Requirement: Adversarial pass reporting surface
The commands the review and verify Skills instruct a reviewer to use SHALL work as documented, including reporting a finding while a round is in progress.

#### Scenario: A finding is reported mid-round
- **WHEN** `kata-cli adversarial finding add --change <task-id> --node <node> --from-file <json>` is run with a valid task id
- **THEN** the finding SHALL be recorded against that task

#### Scenario: The change id is missing
- **WHEN** the same command is run without `--change`
- **THEN** it SHALL fail with a usage error naming the expected form, and SHALL NOT resolve the task id from an action word
