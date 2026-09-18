# The Wiki record grows an explicit provenance dimension

L4-07: two stores hold "what is known" — the governed records under `.kata/wiki` and the documentation pages under
`.llmwiki` — joined by a convention (an ingested record put `.llmwiki/…` in `sourceRefs` and `llmwiki-ingest` in
`validationTaskId`) with authority then decided by matching `sourceRefs`. So a summary of a page counted as knowledge
about whatever that page happened to cite.

## What changed

- **`WikiProvenance`** on the record: `source` | `ingested` | `distilled` | `verified`, with the difference spelled out in
  the type's doc comment. `schemas/wiki-record.schema.json` accepts it.
- **Writers declare it**: ingestion says `ingested` at both of its minting points; a task's distillation says `distilled`.
- **Readers infer it for records that predate the field** (`inferProvenance`): `llmwiki-*` validation ids and `.llmwiki/`
  source refs mean `ingested`, anything else `distilled`. Deliberately a reader rather than a migration — no record is
  rewritten, and a record that declares its provenance is believed.
- **Authority applies it**: `selectAuthoritativeContext` serves a record only when its provenance resolves to sources, so
  an ingested summary is excluded with the explicit reason `ingested-summary` instead of silently ranking as knowledge.
  `.llmwiki` stays what it is — a view over raw and paged sources, readable, never authority about the code.

## Verification

- `tests/unit/wiki-governance.test.ts` — a verified distilled record and a verified ingested summary over the same
  source: only the first is authoritative, the second is excluded as `ingested-summary`; and `inferProvenance` reads the
  old convention correctly while believing a declared value.
- Full kata suite: 620 tests in 76 files; `tsc` clean; `dist/cli.js` rebuilt.
