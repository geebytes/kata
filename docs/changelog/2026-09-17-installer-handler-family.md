# The installer and runtime family leaves the entry point

L0-01's first handler family: `init` / `update` / `uninstall` / `discover` / `doctor`, their typed invocation parser,
the runtime refresh they trigger afterwards, and the human rendering of an update report.

`src/cli/installer.ts` owns 297 lines that were in `cli.ts`:

- `parseInstallerArgs` (with `parsePlatform`, `parseScope` and `parseLanguage` — the family's own argument readers);
- `runAggregateUpdate` — "update every managed and detected platform" — and `runDoctorCommand` with its
  `aggregateDoctorSummary`;
- `RuntimeRefreshResult` with its per-stage outcome types, `runRuntimeRefresh`, `runtimeRefreshTimeoutMs` and
  `withTimeout`;
- `formatUpdateReport`, `renderUpdateSummary`, `formatRuntimeRefresh` — the update family's human rendering, which the
  boundary now receives as a caller-supplied shape (the previous commit).

`cli.ts` (2454 lines, from 2728 before this slice) keeps dispatch: it parses the invocation, calls the handler, and prints
what comes back. The module imports the output boundary, the adapters and the process facility, and **nothing imports the
entry point back** — the direction the extraction needs to stay one-way.

## Verification

- `tsc --noEmit` clean; the full kata suite passes (565 tests in 67 files), including the installer suite that drives
  `init`/`update`/`uninstall`/`discover`/`doctor` end to end and asserts the human and JSON output contracts.
- `dist/cli.js` rebuilt.
