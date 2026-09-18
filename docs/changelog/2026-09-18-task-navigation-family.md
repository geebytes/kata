# The task/navigation family leaves the entry point

The commands almost every session runs first, and the ones that have to agree about what a phase means: `status` (local
and dispatcher), `tasks`, `orient`, `hooks`, the handoff surface's packeting helpers, the candidate list and its
recommendation, and the role table `roleForPhase` resolves against `workflow/navigation.ts`.

`src/cli/tasks.ts` owns 639 lines that were in `cli.ts`, and `cli.ts` is 1784 lines — from 2728 before the L0-01 slices,
and 2454 after the installer family. `roleForPhase` is re-exported from the entry point so the callers that know it by
that path (and the tests that assert the resolver's role table) keep working.

The family imports the navigation tables, the hook runtime, the layout helpers and the output boundary; nothing imports
the entry point back, which is the direction every extraction in this series has to keep.

## A note on the mechanical part

The extraction itself is scripted — find each top-level declaration, cut to its closing brace, restore its imports — and
the interesting failures were all about **which** declarations constitute the family: `roleForPhase` compiles only with
`activeRoleForPhase` (it did not, briefly, and every workflow command recursed until the stack blew), and
`resolveTaskForCurrentBranch` needs the local `ResolvedTask` type it is declared beside. Both are the kind of thing the
test suite caught within one run, which is why each family is verified by the full suite rather than by inspection.

## Verification

- `tsc --noEmit` clean; the full kata suite passes (610 tests in 74 files), including the next-action resolver, the
  non-interactive `open` and the installer suites that drive these handlers through `main`; `dist/cli.js` rebuilt.
