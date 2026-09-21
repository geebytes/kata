# Tasks — `review-record-integrity`

## 1. Strict bootstrap (AC-1)

- [x] 1.1 RED: `tests/unit/strict-bootstrap.test.ts` — a strict task's criteria are the placeholder, and `design` refuses.
- [x] 1.2 Add `bootstrapFile` to `CommandOptions`; parse `--bootstrap-file` in `src/cli/workflow.ts`.
- [x] 1.3 `cmdOpen` takes the declared criteria, matrix and upstream coverage; validates the matrix at open.
- [x] 1.4 Extend `CommandOptions.acceptance` with `claims`, so a claim no longer requires hand-editing `task.json`.

## 2. Machine-generated change record (AC-2)

- [x] 2.1 RED: `tests/unit/change-record.test.ts` — the module does not exist.
- [x] 2.2 `src/quality/change-record.ts`: `buildChangeRecord` derives paths/checks/claims/findings/counts; `judgement` is prose.
- [x] 2.3 `schemas/change-record.schema.json`; register it in `src/core/schema.ts`.
- [x] 2.4 The seal writes the record (`writeChangeRecord`) after the evidence is sealed.

## 3. Governed record rows declare checkable claims (AC-3)

- [x] 3.1 RED: `tests/unit/record-assertions.test.ts` — a false row is neither reported nor refused; the refusal crashes.
- [x] 3.2 Move the claim refusal **before** `resolveSealChecks`, so an unfalsifiable claim is refused instead of dereferenced.

## 4. Delta surface follows the change (AC-4)

- [x] 4.1 RED: `tests/unit/delta-surface.test.ts` — a changed file outside ownership reports `unchanged`; `applyScopeChange`
      and `scope apply` do not exist.
- [x] 4.2 `changeSurfaceAgainstWorkspace` measures the union of the base's owned paths and the working tree's changed paths.
- [x] 4.3 `applyScopeChange` writes the recorded surface under the task lock; `scope apply` CLI subcommand added;
      `runScopeCommand` accepts a root.

## 5. Brief carries the class history (AC-5)

- [x] 5.1 RED: `tests/unit/adversarial-history.test.ts` — no class table exists.
- [x] 5.2 `findingHistory` input + the rendered section; `findingClassOf` derives the class from criterion/path/source.
- [x] 5.3 Populate it from the tracked findings, filtered to the **other** node's record (a durable source).
- [x] 5.4 Regression caught by two existing tests (`a pass does not change the brief it answered`, `the brief is
      reproducible`): reading the live record moved the brief's hash. Fixed by scoping to `BRIEF_VOLATILE_INPUTS`-safe
      sources; both tests pass unmodified, which is the point.

## 6. Verification and records

- [x] 6.1 `npx tsc --noEmit` clean.
- [x] 6.2 Full suite green: **935 passed / 0 failed**.
- [x] 6.3 `docs/changelog/2026-09-21-machine-verifiable-review-records.md`.
- [x] 6.4 OpenSpec delta for `model-policy-and-evidence` and `workflow-runtime`.

## Notes carried forward

- The `--bootstrap-file` shape is deliberately parallel to `--requirements-file`; both validate before writing. A future
  change could let `open` derive a matrix skeleton from the criteria, but deriving *decisions* (which path implements
  which criterion) would be inventing the author's judgement, so it is left to the caller.
- `changedOutsideOwnership` currently reports; it does not block. Making it a gate is a separate decision with a real cost
  (it would refuse legitimate out-of-scope documentation edits), and the user's proposal D asked only that the class stop
  being re-derived by hand.
