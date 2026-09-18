# Promotion verifies the provenance it used to trust

L4-06: `promote()` checked `status === 'candidate'` and flipped the record to `verified`. The trust ladder
(`model_proposed` → `evidence_verified`) could therefore be climbed by anything able to write a candidate — including the
Wiki's own ingestion, which mints candidates with `validationTaskId: 'llmwiki-ingest'` (not a task at all) and hashes it
generated itself. A `verified` record is what `selectAuthoritativeContext` serves to later tasks, so the check belongs at
the transition.

## What changed

`src/wiki/provenance-gate.ts` asks three questions, each answerable from the repository rather than from the record's own
claims:

1. **did the task the record names actually pass Judge?** — a validation id that names no task (ingestion) fails with
   `unknown_validation_task`, a real task with no passing Judge result fails with `validation_task_not_passed`;
2. **do the source hashes still describe the sources?** — `source_hash_mismatch` / `source_missing`, so promotion cannot
   manufacture a verified record from sources that have moved on;
3. **is there evidence behind it?** — `no_evidence`.

The refusal names the failures and the remedy (`kata-cli wiki revalidate --record <id>`, then promote). The drift check
stays where it was: promotion refuses to *create* a verified record from changed sources; `drift.ts` is what discovers one
that went stale afterwards.

## Verification

- `tests/unit/wiki-governance.test.ts` — a candidate whose validation task is not a task, one whose task never passed
  Judge, and one whose source hash no longer matches are each refused with their reason, and the same record with all
  three satisfied promotes.
- `tests/unit/llmwiki.test.ts` — the ingestion-minted candidate is refused with the reason, and stays a candidate (its
  previous expectation — that ingestion could promote — is what the finding was about).
- Full kata suite: 618 tests in 76 files; `tsc` clean; `dist/cli.js` rebuilt.

**Recorded limit:** the schema already requires at least one evidence id, so `no_evidence` is a second line of defence
behind the record shape rather than the only one; that case is noted in the test instead of being faked through a
record the schema rejects.
