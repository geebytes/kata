# workflow-runtime — delta for enrich-packet-outside-the-task-store

## ADDED Requirements

### Requirement: The task store holds only tasks

A directory created under the governed task store SHALL be a task the CLI can resolve, or SHALL NOT be created there. An
artefact that is not a task — a handoff packet for a person or an agent to read, for instance — SHALL live outside the
store, so enumerating the store enumerates tasks and nothing else.

#### Scenario: A directory in the store resolves as a task

- **WHEN** the store is enumerated
- **THEN** every directory in it SHALL carry a task record the CLI resolves
- **AND** a store entry without one SHALL be refused rather than reported as an unknown task

#### Scenario: A handoff packet is not written into the store

- **WHEN** a subsystem produces a packet addressed to a person or an agent rather than to the runtime
- **THEN** the packet SHALL be written outside the governed task store
- **AND** no directory SHALL be created under the store for it

### Requirement: One writer per task-owned artefact

A task-owned artefact SHALL have exactly one writer, and that writer SHALL hold the task lock and replace the file
atomically. A second write path to the same artefact SHALL be refused by a check, because two paths to one fact is how a
declaration is corrected without a record while the read paths validate it.

#### Scenario: A write that bypasses the locking writer

- **WHEN** a module writes a path inside the governed task store without going through the locking writer
- **THEN** the invariant check SHALL report the file and the call site

#### Scenario: The former second writer

- **WHEN** the subsystem that used to write the artefact by its own path runs
- **THEN** it SHALL call the single writer, so the two cannot produce different documents
