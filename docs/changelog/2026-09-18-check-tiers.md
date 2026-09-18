# Checks can declare a tier, and the frozen tier is opt-in

The last item of the workflow notes: one seal ran lint + typecheck + the project's full suite + 12 matrix evidence
commands serially, ~15 minutes, and the notes asked for a fast seal with the full suite at the point the artefact is
frozen.

Making that the *default* would quietly weaken seals, so it is not the default. A project declares it:

```jsonc
{ "quality": { "buildChecks": [
    { "name": "lint", "kind": "lint", "command": "make", "args": ["lint"] },
    { "name": "suite", "kind": "test", "command": "make", "args": ["test"], "tier": "frozen" }
] } }
```

- **`tier: 'seal'` is the default** — with the field absent, every check runs exactly where it ran before, in every
  project. Nothing changes until a project opts in.
- A `frozen`-tier check is **deferred at seal** and **named**: `diagnostics.deferredChecks`, a `skipped` progress event
  with `reason: 'frozen_tier'`, and `tier` in `--list-checks` — so "declared but not run" is a decision the reader can
  audit before and after sealing.
- `build --seal --frozen` runs them; that is the flag the freeze points (judge/archive) use.
- A frozen check that another check **covers** is not run even then (the pointer from the previous commit wins), because
  running it would be the duplicate that pointer exists to remove.

## Verification

- `tests/unit/check-tiers.test.ts` — no tiers means everything runs; a frozen check is deferred with its reason and no
  `started` event; `includeFrozen` runs it; a covered frozen check still does not run. Full kata suite: 606 tests in 73
  files; `tsc` clean; `dist/cli.js` rebuilt.
