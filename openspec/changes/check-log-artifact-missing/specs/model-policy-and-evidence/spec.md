## MODIFIED Requirements

### Requirement: Immutable evidence envelopes
The evidence subsystem SHALL record command, environment summary, exit status, timestamps, relevant diff hash, and bounded logs for lint, typecheck, tests, CI, and reviewer results.

When a check's output exceeds the capture bound, the envelope SHALL report `logTruncated` and SHALL name a `logArtifact` path only when that file was actually written. The artifact SHALL hold the complete output. A requested artifact that could not be written SHALL be reported as a failure rather than discarded, and the envelope SHALL NOT claim it.

#### Scenario: Evidence does not match the diff
- **WHEN** the current diff hash differs from the evidence envelope hash
- **THEN** the evidence SHALL be marked stale and SHALL not satisfy a Judge acceptance condition

#### Scenario: A bounded check's transcript is referenced
- **WHEN** a check produces more output than the capture bound
- **THEN** the envelope SHALL carry `logTruncated: true` and, when `logArtifact` is present, the file at that path SHALL exist and contain the complete output

#### Scenario: The artifact cannot be written
- **WHEN** the artifact's parent directory is missing or unwritable
- **THEN** the envelope SHALL NOT carry `logArtifact`, and the write failure SHALL be reported instead of swallowed

#### Scenario: A transcript is written twice at the same path
- **WHEN** a later run writes the artifact path an earlier run used
- **THEN** the file SHALL contain that later run's output only, because the run owns the file, and the artifact name
  SHALL NOT be buildable from a path separator

#### Scenario: A superseded revision's transcript
- **WHEN** a seal supersedes the evidence set it replaces
- **THEN** the transcripts SHALL be archived with the envelopes, so the active path holds only the current revision's

#### Scenario: A task's first seal runs a bounded check
- **WHEN** a task is sealed for the first time and no evidence directory exists yet
- **THEN** the artifact SHALL still be written, because the runtime creates the directory before running the checks
