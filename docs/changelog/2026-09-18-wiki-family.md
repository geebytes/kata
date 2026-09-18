# The Wiki family leaves the entry point

Fifth L0-01 family: the governed knowledge store's command surface — `wiki` with its twenty-odd subcommands (init,
orient, ingest, query, lint, verify, task, register, candidate, closure, audit, lifecycle, refresh, relevance, promote,
reject, retire, plus the revalidation and drift commands), and its typed invocation parser.

`src/cli/wiki.ts` owns 254 lines that were in `cli.ts`, and `cli.ts` is 1531 lines — from 2728 before the L0-01 slices.
It is the one family whose subcommands span four modules (the LLM Wiki, the record store, drift/revalidation, promotion)
because it is the operator's entry point to all of them; that is a reason to keep the family together, not to spread it.

## Verification

- `tsc --noEmit` clean; the full kata suite passes (610 tests in 74 files), including the Wiki suites (closure,
  revalidation, governance, the invalid-record case added earlier) that drive this handler through `main`; `dist/cli.js`
  rebuilt.
