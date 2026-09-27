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

### Requirement: Create-time owned surface validation

An `open` command that receives owned paths SHALL normalize and validate the entire resulting surface before creating a
task. The surface SHALL contain at least one repository-relative path; absolute paths and paths escaping the repository
SHALL be refused without leaving a task artefact behind.

#### Scenario: Invalid owned paths do not create a broken task

- **WHEN** `open` receives an absolute or escaping `--owned-path`
- **THEN** `open` SHALL refuse at that command
- **AND** no task artefact SHALL be created

> Note: a scope apply has the matching before-write rule; this requirement covers the initial command path.

> **Two requirements were dropped from this delta before it was merged** (`Brief finding history`, `Sealed test citation boundary`): their subject was deleted with the
> round-shaped route. A brief and the finding history it carried no longer exist — the ledger's claims are the review's
> input and `kata-cli ledger run` issues the request — and the citation boundary guarded the adversarial gate's record
> reader, which is gone with the gate. Merging them would have written a contract for something no longer there, which is
> the defect this repository removes most often; unlike the five that were merged, they were a proposal that never became
> live, so dropping them changes no specification.
