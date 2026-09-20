## MODIFIED Requirements

### Requirement: Bounded repair loop
The runtime SHALL permit repair only for failed acceptance conditions and SHALL return every repair to hard verification before another Judge decision.

A finding whose severity is terminal SHALL create a repair obligation, and a batch SHALL be closeable by accounting for every terminal finding it opened on. Resolving an obligation SHALL depend on evidence for the revision rather than on the task having declared an acceptance matrix.

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

### Requirement: Adversarial pass reporting surface
The commands the review and verify Skills instruct a reviewer to use SHALL work as documented, including reporting a finding while a round is in progress.

#### Scenario: A finding is reported mid-round
- **WHEN** `kata-cli adversarial finding add --change <task-id> --node <node> --from-file <json>` is run with a valid task id
- **THEN** the finding SHALL be recorded against that task

#### Scenario: The change id is missing
- **WHEN** the same command is run without `--change`
- **THEN** it SHALL fail with a usage error naming the expected form, and SHALL NOT resolve the task id from an action word
