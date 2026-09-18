# Reading the Wiki cannot fail: one broken record stops nothing

The last half of P0-3, reported with a reproduction: a single record carrying a field the schema does not allow
(`revalidatedBy`) still blocked **every** workflow mutation — `verify` was fine (its closure gate had been made tolerant),
but `handoff create` was not, because only `wiki/closure.ts` and `wiki/drift.ts` had been given the tolerant reader while
`wiki/context.ts` and `workflow/handoff.ts` kept the strict one. The error message had become clearer; the failure mode
had not changed.

## What changed — one rule instead of a per-caller choice

- **`store.readWikiRecordsWithIssues`** returns `{ records, invalid }`: valid records plus what could not be read, and it
  never throws.
- **`store.readWikiRecords`** is the valid records only. Reading the Wiki therefore **cannot fail**, so no gate can be
  stopped by a record it was not going to use — the arrangement that made the tolerance depend on which reader a caller
  happened to import is gone.
- A **named `readWikiRecordsStrict`** keeps the old behaviour legible for anyone who wants it; nothing calls it.
- **The record is never silently dropped.** `selectAuthoritativeContext` puts invalid records in `excluded` with
  `reason: 'invalid'` (the handoff packet's `excludedWiki` now carries them) and in `warnings` with the file and the
  schema's complaint; `auditWiki` gains `invalidRecords`; `wiki audit` is the surface where a drifted record gets fixed,
  and the closure remedy now names that command (it previously named `kata-cli wiki validate`, which does not exist).
- Refusal still happens exactly where a record is **used**: `revalidateWikiRecord` refuses to bless one it cannot read,
  and a closure that names an unreadable record still fails closed with `unevaluatable_records`.

## Verification

- `tests/unit/wiki-unrelated-invalid-record.test.ts` — with one unrelated invalid record in place: the handoff packet is
  built (the reported failure), the record appears in `excludedWiki` as `invalid`, the audit lists it, and revalidation of
  that record still refuses. Full kata suite: 610 tests in 74 files; `tsc` clean; `dist/cli.js` rebuilt.
