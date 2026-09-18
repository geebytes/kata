# The init wizard leaves the entry point — the last handler family

`kata-cli init` is the one installer command that asks the user questions (which platforms, which scope, which language,
which Comet options) and the only one whose failure mode is a *sequence* of prompts — a repeated Comet wizard, one per
platform. `src/cli/wizard.ts` owns `shouldUseInitWizard`, `runInitWizardCommand` and the Comet-flag collector, 149 lines that were in `cli.ts`.

**`cli.ts` is 453 lines**, from **2728** before the L0-01 slices. What remains is the entry point itself: the argv
dispatch in `runMain`, the flag readers it needs (`stripOutputModeArgs`, `workflowPlatform`, `isInstallerCommand`),
`getRuntimeCompatibility`, `main`, the `isCliEntrypoint` guard — and three declarations the families had already taken over
(`WorkflowHandoffRole`, `CODEGRAPH_SUBCOMMANDS`/`CodegraphSubcommand`), which the move left behind and the suite did not
notice because nothing referenced them. Every command now lives in a family module under
`src/cli/`, and nothing in those modules imports the entry point.

## A note on how the mechanical part went wrong

This is the slice where the scripted extraction bit: a brace-matching routine that counted `}` inside a doc comment
chopped the file at line 413, which broke the entry-point guard and failed nine suites at once. The failure was loud and
immediate — a truncated file cannot compile — and the fix was to keep the comment with its declaration rather than
counting braces on its text. Recorded because it is the one risk of doing these moves mechanically: the suite catches it,
but only if the whole suite runs after every family.

## Verification

- `tsc --noEmit` clean; the full kata suite passes (610 tests in 74 files), including the wizard, installer and
  non-interactive suites that drive `init` through `main`; `dist/cli.js` rebuilt.
