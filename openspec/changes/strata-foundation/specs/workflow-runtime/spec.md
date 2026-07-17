## ADDED Requirements

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
