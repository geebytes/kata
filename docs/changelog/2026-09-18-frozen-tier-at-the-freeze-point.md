# The frozen tier is wired into the freeze point — and held to

The tier from the previous commit was a capability nothing used: no skill text mentioned `--frozen`, and nothing stopped
a task from concluding while a project's `tier: 'frozen'` verification had never run. A declaration nobody enforces is the
shape the architecture review kept finding, so this closes it in both places.

## What changed

- **`/kata-verify`'s skill text** carries a *Frozen-tier checks* section: ask `kata-cli build --change <taskId>
  --list-checks`, and if a check is listed `"tier": "frozen"`, seal the frozen tier before concluding the node
  (`kata-cli build --change <taskId> --seal --frozen`).
- **Verify enforces it.** `missingFrozenTierEvidence` resolves the project's declared checks and requires passing evidence
  for each frozen-tier one against the sealed revision; a gap refuses the node with the command that closes it
  (`… Run: kata-cli build --change <task> --seal --frozen`) and names the missing checks in
  `diagnostics.frozenTierMissing`.

Projects that declare no frozen tier are unaffected: the resolution is empty, and nothing about verify changes.

## Verification

- `tests/e2e/seal-check-preflight.test.ts` — with a frozen check declared, `--list-checks` shows its tier, and `verify`
  refuses with the command and `frozenTierMissing: ['frozen-suite']`. Full kata suite: 607 tests in 73 files; `tsc`
  clean; `dist/cli.js` rebuilt.
