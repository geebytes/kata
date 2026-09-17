# The output context becomes a leaf module

L0-01 extracts command handler families out of `cli.ts`. The first obstacle is that a handler needs to write through the
invocation's output context, and the context lived inside the entry-point module — so a handler module would either
import the module that routes to it (a cycle) or take the context as a parameter through every call site.

`src/cli/output.ts` now owns it: `OutputContext`, `createOutputContext`, `currentOutput`, `setOutput`, and the argv
readers (`isJsonOutput`, `isQuietOutput`, `isDefaultSilentInstallerCommand`). `cli.ts` imports and re-exports the two
public accessors, so callers and tests that know the entry point keep working.

Why a setter rather than only a getter: `main` swaps the context for the duration of an invocation (that is what makes an
in-process invocation isolated) and restores it in a `finally`. Nested calls keep accumulating flags exactly as the
previous OR-ing did, because an installer path calls workflow code in-process.

This is the threading L0-03 deliberately deferred ("the threading belongs with the handler-family extraction"); doing it
as its own step keeps the pending handler moves mechanical.

## Verification

- `tsc --noEmit` clean; the full kata suite passes (565 tests in 67 files), including `tests/unit/output-context.test.ts`,
  which asserts the boundary behaviour this module now owns: argv derivation, stream overrides, an isolated in-process
  invocation writing nothing to the process streams, and restoration after a failed invocation.
- `dist/cli.js` rebuilt.
