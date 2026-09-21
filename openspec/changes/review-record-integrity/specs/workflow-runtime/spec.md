## ADDED Requirements

### Requirement: Declared task contracts

A task that declares a strict review profile SHALL be able to receive its own declared contract at the command that creates
it — its acceptance criteria, its acceptance matrix and its upstream coverage — and an input that does not satisfy the
matrix rule SHALL be refused at that command, before the task exists.

#### Scenario: A strict task is bootstrapped with its contract

- **WHEN** a strict task is opened with a declared contract
- **THEN** the task's acceptance criteria SHALL be the declared ones, not a placeholder
- **AND** the design phase SHALL proceed without the task record being edited by hand

#### Scenario: A contract that does not hold is refused where it was written

- **WHEN** a declared contract's acceptance matrix does not cover its acceptance criteria
- **THEN** the create command SHALL refuse it
- **AND** the refusal SHALL name the criteria that have no matrix row

### Requirement: Brief finding history

An adversarial brief SHALL carry prior findings grouped by class, together with each class's count and disposition, drawn
only from sources a pass cannot write, so a brief is reproducible across the recording of its own answer.

The class of a finding SHALL be derived from the finding's own fields rather than declared, so a class cannot be changed by
naming it differently.

#### Scenario: A brief does not move when its own answer is recorded

- **WHEN** a pass is recorded and its findings are dispositioned
- **THEN** the brief for that pass SHALL render the same text and the same hash as before

#### Scenario: A class already repaired is visible as repaired

- **WHEN** a brief carries a class whose findings are all fixed
- **THEN** the class SHALL be reported as repaired
- **AND** a reviewer that still believes the class is open SHALL report that as a finding against the decision
