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

An adversarial brief SHALL carry prior findings grouped by class, together with each class's count and disposition. The
history projection SHALL be derived only from records the node being briefed cannot write: an adversarial node's own
record SHALL NOT contribute its current round's findings to that node's history.

The class of a finding SHALL be derived from the finding's own fields rather than declared, so a class cannot be changed by
naming it differently. Recording a pass MAY update lifecycle framing, scope, claims, and the reading set; record validity
SHALL instead bind to the issued brief copy, not require a later re-render to be byte-identical.

#### Scenario: A brief does not self-author its history

- **WHEN** a pass is recorded for an adversarial node
- **THEN** a later brief for that node SHALL NOT list that node's new finding in `Findings by class`
- **AND** the record SHALL remain bound to the copy issued before the pass was recorded

#### Scenario: A class from the other node is visible

- **WHEN** the other adversarial node previously recorded a finding with a disposition
- **THEN** the brief SHALL name its derived class and disposition

#### Scenario: A class already repaired is visible as repaired

- **WHEN** a brief carries a class whose findings are all fixed
- **THEN** the class SHALL be reported as repaired
- **AND** a reviewer that still believes the class is open SHALL report that as a finding against the decision

### Requirement: Create-time owned surface validation

An `open` command that receives owned paths SHALL normalize and validate the entire resulting surface before creating a
task. The surface SHALL contain at least one repository-relative path; absolute paths and paths escaping the repository
SHALL be refused without leaving a task artefact behind.

#### Scenario: Invalid owned paths do not create a broken task

- **WHEN** `open` receives an absolute or escaping `--owned-path`
- **THEN** `open` SHALL refuse at that command
- **AND** no task artefact SHALL be created

> Note: a scope apply has the matching before-write rule; this requirement covers the initial command path.

### Requirement: Sealed test citation boundary

An adversarial pass SHALL reject a test path it cites unless the task matrix declares it or the current sealed change
record lists it as a path present before that pass. The latter exception permits a reviewer to describe a Build-authored
repair regression without treating it as new review-authored evidence; a test added after sealing SHALL remain refused.

#### Scenario: A sealed repair regression may be cited

- **WHEN** a pass cites a test path present in the current revision's sealed change record
- **THEN** the citation SHALL not be rejected solely because a matrix row omitted that test path

> Note: this authorizes citation, not a new verification outcome or test authorship.

#### Scenario: A test written after seal is refused

- **WHEN** a pass cites a test path absent from both the matrix and the current sealed change record
- **THEN** the adversarial gate SHALL refuse the record as an undeclared test path
