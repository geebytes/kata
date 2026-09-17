# One Comet compatibility resolution path

The architecture review's L1-06 finding: compatibility was resolved two ways. `loadCometCompatibility()` was
synchronous and bundled-only; `loadCometCompatibilityAsync()` resolved runtime probe → workspace override → comet
package → bundled and recorded which layer answered. Only the init wizard used the async one, so `installComet`'s
version assertion, `verifyComet`, `cometVersion` and `readCometCompatibility` all judged an installed Comet against
kata's frozen baseline — even when `comet compat --json` could answer authoritatively. On top of that,
`cometVersion()` returned the baseline's `minVersion` in a field named `version` and reported `compatible: true`
unconditionally, so a report about the *supported window* read as a report about the *observed version*.

## What is one resolution path now

- **`resolveCometCompatibility(options)`** is the single entry point. It probes the installed binary first (passing the
  resolved binary path where the caller has it), then the workspace override, then the `@rpamis/comet` package, then
  kata's bundled manifest, and the answer's `source` says which layer it came from. The old async name is kept as a
  deprecated alias so existing callers keep working while they migrate.
- **The answer is remembered per process.** Callers that cannot await read the snapshot through
  `loadCometCompatibility()`, which now returns the resolution this process made instead of choosing a layer of its
  own. An explicit `root` still reads *that* workspace, and an explicit manifest path still reads that file; the
  synchronous view never claims to have observed a runtime it did not probe.
- **Every version judgement asks it.** `installComet` asserts the installed version against the resolved window (with
  the resolved binary), `verifyComet` does the same and now reports the window it judged against —
  `{ minVersion, maxVersion, source }` — and `readCometCompatibility(root?)` returns that same window with its
  provenance, which `kata-cli comet version` prints as `compatSource`.
- **The misleading report is gone.** `cometVersion()` had no callers and described the baseline window under a name
  that read as an observed version while claiming `compatible: true` without checking anything.

## Verification

- `tests/unit/comet-compat-resolution.test.ts` — the workspace override is reported as `workspace-override`, an absent
  one falls back to `kata-bundled`, an installed binary's `compat` answer wins and is reported as `runtime` (driven by
  a stub binary), the synchronous accessor answers with the resolved snapshot while an explicit root is read from that
  root, and the window report carries its provenance.
- Full suite: 492 tests in 53 files, all passing; `tsc --noEmit` clean; `dist/cli.js` rebuilt.
