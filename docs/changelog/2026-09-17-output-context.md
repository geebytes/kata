# Output behaviour is supplied at the boundary

The architecture review's L0-03 finding: `quietOutput` and `jsonOutput` were mutable module globals, `outputResult` and
`writeUpdateProgress` wrote straight to `process.stdout`, and the entry point reported failures with `console.error`. An
in-process invocation therefore could not supply its own streams — the test suite captured output by monkey-patching
`process.stdout.write` — and rendering mixed update-specific human text with JSON result serialization in the same
untouched-global path.

## What changed

**`OutputContext`** — `{ stdout, stderr, format, quiet, isTTY }` — is created at the boundary:

- `createOutputContext(argv, overrides)` derives `format`/`quiet` from argv (moving the `--json`, `--quiet` and
  silent-installer-command rules into one place) and defaults the streams to the process ones.
- `main(argv, overrides)` accepts a caller's own streams, so an in-process invocation is isolated: the new test asserts
  that a `main(['discover', '--json'], { stdout })` call writes nothing at all to `process.stdout`.
- The rendering boundary reads the context: `outputResult` and `writeUpdateProgress` consult `format`/`quiet` and write
  through the context's stream; the update summary's `--json` hint comes from the context too; and the entry point's
  failure report goes through `context.stderr` rather than `console.error`, so an error is output like everything else.
- `main` restores the context it found, including when the invocation throws, and flags accumulate across nested
  invocations exactly as the previous OR-ing did (the installer path calls workflow code in-process).

**One deliberate limit, stated rather than hidden.** The context is held for the duration of an invocation rather than
threaded as a parameter through all 28 `outputResult` call sites. That threading belongs with the handler-family
extraction (L0-01), and a half-threaded context would be worse than an explicit one with a stated lifetime and a
`currentOutput()` accessor. What the review asked for — invocation-local configuration and streams supplied at the
boundary, errors rendered through the same context, CLI contracts unchanged — is what is delivered.

## Verification

- `tests/unit/output-context.test.ts` — argv derivation (including the silent-installer case) and stream overrides; an
  in-process invocation reaching only the streams it was given (with `process.stdout`/`process.stderr` spies asserted
  untouched); silence under `--quiet` versus JSON output otherwise; and the previous context restored after a failed
  invocation.
- The existing installer suites still capture JSON by spying on `process.stdout` and pass unchanged, which is the
  evidence the default path is intact; the CLI's human and JSON output contracts are unchanged.
- Full suite: 547 tests in 64 files, all passing; `tsc --noEmit` clean; `dist/cli.js` rebuilt.
