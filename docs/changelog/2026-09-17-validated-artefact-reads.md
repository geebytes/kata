# Artefacts are validated where they are read

The architecture review's L4-02 finding: nine schemas shipped, one of them enforced. `src/core/schema.ts` could
validate any named artefact, and exactly one caller used it (`validateWikiRecord` on the Wiki store). Every other
artefact — task records, state records and events, evidence envelopes, review findings, Judge results, handoff packets
and receipts — was read with `JSON.parse(...) as SomeType`, so a file that no longer matched what the runtime writes
could only fail later, somewhere else.

## What is validated now

`readValidated<T>(schemaName, path)` reads, parses and validates, and every failure names the artefact, the path and
the drifted field:

```
workflow-state-record artefact /…/current-state.json does not match its schema: $.phase must be one of …
task artefact /…/task.json does not match its schema: $.upstreamCoverage.sources[0].requirements[0].mappedTo must be string or null
```

`readValidatedOptional<T>` is its tolerant sibling for readers that treat "not written yet" as a normal state: an
absent file is `null`, drift is still an error, so a corrupted artefact can never masquerade as a missing one.

Wired into the readers:

| Artefact | Reader |
|---|---|
| workflow state record and events | `core/state.ts` (`readCurrentState` and the event log; the phase-only reads in the orchestrator now go through the validated reader too) |
| task record | `core/task.ts` (`readTask`), used by the seal path and the Comet acknowledgement |
| repair record | `orchestrator.ts` (both active-repair readers and the resolution writer) |
| repair obligations | `quality/repair-obligations.ts` |
| task revision | `workflow/revision.ts` (revision and current-revision) |
| user choice gate | `workflow/user-choice-gate.ts` |
| handoff packet and receipt | `workflow/context-fabric.ts` |
| review findings | `quality/reviewer.ts`, validated per finding as they are appended |
| Judge result | the distill gate in `core/state.ts` |
| evidence envelope | Judge input in `orchestrator.ts` |
| wiki record | already validated |

Four artefacts had no schema at all; `repair`, `repair-obligations`, `revision` and `user-choice-gate` schemas were
added, so the readers above validate against a declared contract rather than a hand-written shape.

## Schema drift the validation found immediately

Enforcing the schemas exposed that three of them did not describe what the runtime actually writes. Each was fixed
against the live records, not the other way round:

- `task.schema.json` was missing `branch`, which `createTask` records whenever it runs on a branch. Every task
  created on a branch failed validation.
- `workflow-state-record` and `workflow-state-event` declared an `actor` object that forbade the `platform` field the
  runtime adds.
- The validator itself could not express a nullable field, while `UpstreamRequirement.mappedTo` and
  `outOfScopeReason` are explicitly `string | null`. `Schema.type` now accepts a union, so the schema can say
  "string or null" instead of the field being left out.

## Not covered yet

- `readUpstreamSummary` in `workflow/navigation.ts` stays tolerant on purpose: it is a diagnostic surface, and a
  drifted artefact there should be reported rather than thrown at `kata-cli status`. Its reads are still unvalidated.
- `verify.json` has no schema yet, so verify results are still cast.
- The orchestrator's reads of *sibling* tasks' `task.json` (ownership-conflict discovery) are unvalidated: failing on
  another task's drifted file would block sealing a task that is itself healthy.

## Verification

- `tests/unit/schema-validation.test.ts` — a valid artefact passes; a missing one is a named read failure and `null`
  through the tolerant variant; an invalid enum, an unexpected field and a non-JSON file each fail with the artefact,
  path and field in the message; union types accept `null` and reject a number; the four new schemas accept real
  records and reject a bad one.
- The suite caught the drift itself while this landed: 53 failures on the first run, all of them either a schema that
  did not match the runtime (the three above) or a test fixture that recorded an incomplete repair.
- Full suite: 443 tests in 47 files, all passing; `tsc --noEmit` clean; `dist/cli.js` rebuilt and carries the new
  schema assets.
