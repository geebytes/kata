# workflow-runtime Specification

## Purpose
TBD - created by archiving change strata-foundation. Update Purpose after archive.
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
