## Why

A check that prints more than 2 MB produces an evidence envelope carrying `logTruncated: true` alongside a `logArtifact`
path. That path is a promise — "the excerpt above is bounded, the whole transcript is at this file" — and on the first
seal of every task the file is not written, silently.

Measured through the real collector with 3 MB of stdout: when `.kata/evidence/` is absent the artifact does not exist;
once that directory exists the artifact is written and is complete. The directory is created by `writeEvidence`, which
runs *after* the checks, so the trigger is deterministic rather than intermittent.

This is a diagnosability defect, not a correctness one: the verdict reads the exit code, `logBytes` still reports the
true size, nothing accumulates and no later read trips. But the excerpt keeps only head and tail, so the line that
explains a failure is often in the elided middle — and the pointer to the complete output is exactly what is missing.
The asymmetry is backwards: the first seal of a task has no transcript, later seals do.

## What Changes

- `src/workflow/orchestrator.ts` creates the evidence directory before the checks run, so a first seal has a transcript.
- `src/process/run.ts` stops discarding a failed artifact write. A captured-artifact failure becomes a reported field on
  the process result instead of being swallowed by a bare `.catch(() => undefined)`.
- `src/quality/evidence.ts` stops claiming an artifact it does not have: `logArtifact` is present only when the file was
  actually written, and the reason it was not is reported.
- Tests assert the relationship the field implies, so a future cause (a full disk, a read-only mount, a permission
  change) cannot be silent either.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `model-policy-and-evidence`: a truncated check's `logArtifact` now names a file that exists, or is absent with a
  reported reason. The field's meaning is unchanged; it becomes true.

## Impact

- `src/workflow/orchestrator.ts`, `src/process/run.ts`, `src/quality/evidence.ts` and their tests.
- `schemas/evidence.schema.json` only if the reported reason needs a field; `logArtifact` keeps its current shape.
- No change to the verdict path: `exitCode`, `passed`, `logBytes` and `logTruncated` behave as before.
- Design: `docs/design/2026-09-20-check-log-artifact.md`.
