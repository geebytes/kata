# Runner knowledge sits beside the matrix model

The architecture review's L1-03 finding: the workflow orchestrator owned the only knowledge of test runners.
`resolveCheckForRow` hardcoded that `vitest` lives at `<dir>/node_modules/vitest/vitest.mjs` and is launched through
`process.execPath`, that `tsc` lives at `node_modules/typescript/bin/tsc`, the recognised selector-capable command lines
(`vitest`, `pytest`, `uv run pytest`), the `{{selector}}` placeholder convention, the `kata/`-prefix strip for a nested
project, and the per-kind timeouts — while the acceptance-matrix *model* lives in `quality/acceptance-matrix.ts`. Adding
a runner or moving a package layout therefore meant editing the orchestration module, and `matrixChecks` even repeated
the dedupe tuple that its own resolver output had already been through.

## What changed

**`quality/check-resolver.ts`** now owns row-to-check resolution, beside the matrix model it interprets:

- `matrixRunners` — the runner table as data: the Node entry file (`vitest`, `tsc`), the command kata passes to Node on
  the selector path (`pytest`), and the whole-command-line case (`uv`). One place to change when a layout moves.
- `resolveCheckForRow(row, evidence, root)` — the three shapes a declaration can take, in the order they were tried: a
  `{{selector}}` template, a known selector-capable runner, a plain command line; plus `matrixProjectDir`,
  `testSelectorForRuntime` and `selectorArgs` as named helpers rather than inline expressions.
- `matrixChecks(root, matrix)` and `dedupeChecks(checks)` — the matrix walk and the one identity tuple, which the seal's
  check resolver also uses instead of its own copy.

The orchestrator keeps scheduling and reporting: it imports the resolver and its own copies are gone.

## Behaviour, including two quirks that were preserved rather than fixed

This is a move, so what runs had to stay identical — including two entries a shell would read differently:

- `pytest` on the selector path resolves to `process.execPath` with the bare `pytest` as the first argument (i.e.
  `node pytest …`), because that is what the entry's value was before.
- `uv run pytest` keeps its command line while the resolved command stays `uv` with `run pytest` as arguments.

Both are recorded in `matrixRunners` with comments saying so, and pinned by tests, rather than being quietly corrected
inside a refactor. They are pre-existing oddities on a path reached only when a matrix declares a `testSelector` for
those runners; whether either is reachable in practice, and what the right behaviour is, is a separate question from
where the knowledge lives.

## Verification

- `tests/unit/check-resolver.test.ts` — every shape: template substitution, selector appended to a known runner, the
  plain command (including a Node-launched `tsc`), the error for a selector a command cannot express, the `kata/`-scoped
  row resolving into the nested project with its selector rewritten, the two preserved quirks, and whole-matrix
  resolution with de-duplication by kind/command/args/cwd.
- The existing matrix and seal suites (quality-gates e2e, seal preflight, repair scope) pass unchanged, which is the
  evidence the executed checks are the same.
- Full suite: 542 tests in 63 files, all passing; `tsc --noEmit` clean; `dist/cli.js` rebuilt.
