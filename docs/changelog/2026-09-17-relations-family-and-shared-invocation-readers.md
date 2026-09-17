# The relations and Git Flow family, and the shared invocation readers

Second L0-01 family: the commands about *where a task sits*.

`src/cli/relations.ts` (169 lines) owns `runRelationsCommand` (`relations add|list|resolve`), `runGitFlowCommand`
(`git-flow apply`) and the readers they share — `parseRelationEndpoint`, `parseTaskRelationType`,
`gitFlowBranchKindForProfile` — plus `parseRelationsArgs` from the entry point's parser pile.

`src/cli/invocation.ts` (47 lines) now holds the readers every family needs to find in raw argv: `parseChangeArg`,
`parseRootArg`, `argValue`. They were file-local helpers in the entry point, so a family module could not ask for them
without importing the entry point. Keeping one copy is also the honest starting point for L0-02: `parseChangeArg` is the
transitional positional guesser that keeps a list of value-taking flags, and each family that grows a typed parser can
stop calling it.

`cli.ts` is 2287 lines now (2728 before the three L0-01 slices).

## Verification

- `tsc --noEmit` clean; the full kata suite passes (565 tests in 67 files) — including the relations and Git Flow
  suites that drive these handlers through `main`.
- `dist/cli.js` rebuilt.
