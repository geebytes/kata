# One authoritative-context selection

The architecture review's L4-01 finding: the governance rule "which knowledge is authoritative for this task" had two
implementations in two layers. `wiki/context.ts`'s `selectAuthoritativeContext` and `core/context.ts`'s
`buildContextManifest` applied the same `status === 'verified'` filter, the same relevance predicate (record
`sourceRefs` or `scope` intersecting the requested refs), the same sort, the same excluded projection with the same
`not-authoritative`/`stale` reasons, and the same stale-source warning sentence — each over its own record shape.

Production used only the manifest; `selectAuthoritativeContext` was imported only by the Wiki governance suite. So the
copy the governance tests pinned was not the copy that built the manifest agents actually receive — the same pattern
recorded in L1-04 (write policy) and L3-05 (unwired gates): the tested authority and the live authority were different
code.

## What changed

`buildContextManifest` is now a projection: it asks `selectAuthoritativeContext(root, sourceRefs)` — reading through
the canonical, validated store (L2-05) — and adds the task metadata (`taskId`, `sourceRefs`) around the result. Its
local reader, relevance predicate and selection logic are gone; `core/context.ts` is 43 lines, and it declares no
governance rule of its own.

## Verification

- `tests/unit/context.test.ts` — the existing manifest tests (authoritative vs excluded selection, stale warnings,
  relevance by source ref or scope) now exercise the live path, plus a new test that builds a fixture with verified,
  candidate, stale and unrelated records and asserts the manifest's `authoritativeWiki`, `excludedWiki` and `warnings`
  are exactly what the selection returns. Re-forking the logic would fail that test.
- Full suite: 475 tests in 51 files, all passing; `tsc --noEmit` clean; `dist/cli.js` rebuilt.
