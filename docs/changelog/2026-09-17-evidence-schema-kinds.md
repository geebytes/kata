# The evidence schema accepts the kinds the code can produce

A seal in this workspace failed with:

```
evidence artefact .kata/evidence/<task>-AC-1-integration-….json does not match its schema:
$.kind must be one of lint, typecheck, test, ci, review, judge, security
```

The evidence was written by kata itself, for an acceptance matrix whose verification level is `integration` — a kind the
code has known since the matrix gained verification levels (`evidenceKinds` in `quality/evidence.ts`), but which
`evidence.schema.json`'s `kind` enum never learned. So the seal's own product failed the seal's own schema, and the task
could not be read back.

## What changed

- `schemas/evidence.schema.json` — the `kind` enum now lists all nine kinds, in `evidenceKinds`' order:
  `lint, typecheck, test, ci, review, judge, security, integration, entrypoint`.
- `tests/unit/evidence-schema-kinds.test.ts` — two assertions that make the drift impossible to repeat: the schema's enum
  equals `evidenceKinds` exactly (order included), and every kind the *acceptance matrix* may declare appears in the
  evidence enum, because a declared check of such a kind has to be recordable as evidence.

`task.schema.json`'s matrix `evidence[].kind` enum was already correct (`test`, `lint`, `typecheck`, `integration`,
`entrypoint`) — it was the evidence artefact schema, the one that has to accept what the matrix declares, that lagged.

## Why a test rather than a generated schema

The schema is an asset: kata vendors it into projects (`.kata/schemas/`) so other tooling can validate records without
kata. It cannot import the TypeScript constant, so the agreement between the two is asserted where both are visible
instead of being derived in one place.

## Verification

- `tests/unit/evidence-schema-kinds.test.ts` passes, and fails if either list changes alone.
- The seal that was blocked by this now reads its evidence: re-running `kata-cli build <task> --seal` proceeds past the
  schema load (the schema error is gone).
- Full kata suite: 564 tests in 67 files, all passing; `tsc --noEmit` clean; `dist/cli.js` rebuilt.
