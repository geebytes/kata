# workflow-runtime Specification

## Purpose
The lifecycle a change travels through and the guarantees that keep it resumable: persisted state a new session can pick up without conversation history, guarded phase transitions, the slash-command surface, the facts a workflow must not let drift, and the declaration a task makes about what it owns and what it accepts.

## Requirements

### Requirement: Resumable task lifecycle
The runtime SHALL persist task status, phase, artifact paths, active session, and verification outcome so a new session can resume without relying on conversation history.

#### Scenario: Resume an interrupted task
- **WHEN** a session starts with an active task whose status is `implementing`
- **THEN** the runtime SHALL report the next permitted action and SHALL NOT restart planning or silently skip guards

### Requirement: Guarded phase transitions
The runtime SHALL reject phase transitions unless required artifacts, evidence, and user decisions for that transition are present.

#### Scenario: Verify cannot be skipped
- **WHEN** a task has a code diff but no passing hard-check evidence
- **THEN** a transition to `judging`, `distilling`, or `archived` SHALL fail with machine-readable missing requirements

### Requirement: Slash-command workflow
The distribution SHALL expose `/kata`, `/kata-open`, `/kata-design`, `/kata-build`, `/kata-verify`, `/kata-archive`, `/kata-hotfix`, and `/kata-tweak` Skills that call the same runtime protocol.

#### Scenario: Tool-neutral command behavior
- **WHEN** `/kata-open` is invoked through two supported coding tools
- **THEN** both tools SHALL create the same task schema and phase state

### Requirement: Protected workflow facts
The runtime SHALL keep task acceptance criteria, workflow state, evidence references, and verified Wiki records outside the write authority of implementer agents.

#### Scenario: Implementer attempts to weaken acceptance
- **WHEN** an implementer changes an acceptance criterion or verified Wiki record
- **THEN** the runtime SHALL reject the write and emit an authorization finding

### Requirement: Pinned git classification
Kata SHALL NOT decide behaviour by matching git's human-readable output where a structural answer exists. A failure that depends on repository state (whether a commit exists, whether a ref resolves) SHALL be classified by asking git the question rather than by parsing the message, and git invoked through `runGit` SHALL run with a pinned locale so parsed output cannot change with the operator's environment.

#### Scenario: A repository with no commit
- **WHEN** a worktree is created in a repository that has no commit
- **THEN** the command SHALL refuse and SHALL name the remedy, because the classification asks git whether `HEAD` resolves rather than matching the failure message

#### Scenario: A healthy repository
- **WHEN** a worktree is created in a repository that has a commit
- **THEN** the worktree SHALL be created, so the structural check does not turn a healthy repository into a refusal

#### Scenario: A failure that is not the no-commit case
- **WHEN** a worktree fails for another reason, such as an unresolvable base or an occupied path
- **THEN** git's own detail SHALL be reported without the no-commit remedy, so the message does not claim a cause that did not occur

#### Scenario: Parsed git output under a non-English locale
- **WHEN** git is invoked through `runGit` in an environment whose locale is not English
- **THEN** git SHALL run with `LC_ALL=C`, so output kata parses does not depend on the operator's environment

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
