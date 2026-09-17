# The context manifest reads the canonical Wiki record and store

The architecture review's L2-05 finding: `core/context.ts` declared its own `WikiStatus`/`WikiRecord` — a lossy subset
of the canonical record in `wiki/record.ts` that dropped `createdAt`, `updatedAt`, `approvalEvent` and
`rejectionEvent` — and re-implemented `readWikiRecords` by reading `.kata/wiki/*.json` and casting the JSON. The
canonical store and its validator already existed, and `workflow/handoff.ts` already used them through a dynamic
import, so both readers were live: the manifest path could carry records the validator was never asked about, and the
schema could not be trusted to describe what the manifest saw.

## What changed

- `core/context.ts` imports `WikiRecord`/`WikiStatus` from `wiki/record.ts` and `readWikiRecords` from `wiki/store.ts`,
  and re-exports the types so its callers keep working. Its local record interface and its local reader are gone: the
  file is 64 lines, down from 97, and nothing in `core/` redeclares a domain record.
- `wiki/store.ts`'s reader validates each record against `wiki-record.schema.json` before returning it — this was the
  second half of the finding ("the canonical store's validation is bypassed on the manifest path": only `writeWikiRecord`
  called the validator). A drifted record now fails where it is read, named by file, instead of surfacing as an
  `undefined` on whichever consumer read it first.

The two `tests/unit/context.test.ts` fixtures that wrote records without `createdAt`/`updatedAt` were accepted only
because the reader did not validate; they now carry the timestamps the writer always writes.

## Verification

- `tests/unit/context.test.ts` and the Wiki suites pass unchanged in meaning (authoritative vs excluded selection,
  stale warnings, candidate generation), now reading through the canonical, validated store.
- Full suite: 474 tests in 51 files, all passing; `tsc --noEmit` clean; `dist/cli.js` rebuilt.
