# The installer module splits: guard asset, hook dialects, core

The architecture review's L1-07 finding: `src/adapters/ownership.ts` (980 lines) changed for unrelated reasons at once.
It held install/update/uninstall with the sha256 ownership manifest, skill/hook/adapter/contract file writers, the project
Wiki bootstrap, AGENTS contract and platform-rule rendering, the emitted hook guard program, and four platform
hook-config dialects with their own merge and remove logic — so a new hook-capable platform, a Wiki bootstrap change and
ownership-manifest bookkeeping all edited the same file. And because `discovery.ts` re-exports install/update/uninstall
from it, the ownership module *was* the adapter module's implementation.

## What changed

**Two separations, no behaviour change.**

- **The guard asset → `src/policy/guard-script.ts`.** It is a standalone program: kata writes it into a project or a
  global config directory and the platform runs it on tool calls, so it cannot import anything at run time. Its text is
  assembled from the policy's own source (`renderPolicySource()`), which is exactly why it belongs beside
  `hook-policy.ts` — the rule and the program that enforces it change together (L1-04 made them one source; this puts
  them in one place). `ownership.ts` re-exports `renderHookGuardScript` for callers that know the installer by its path.
- **The four hook dialects → `src/adapters/hook-configs.ts`.** Claude Code and Gemini group hooks under a matcher
  section, Windsurf keeps an array under `pre_write_code`, Copilot's file is kata's alone — each is a descriptor behind
  `{ pathFor, render, merge, remove }`, and the installer asks for the descriptor and then does the file write, the
  ownership bookkeeping and the reporting, which is its own job.

`ownership.ts` is 687 lines now (from 980), and it no longer contains either the emitted program or a platform dialect.

## Note on how the first half landed

The guard-asset half was picked up by a concurrent commit in this repository (`aed3006`, "fix(quality): name evidence
checks so their own schema accepts them") — that commit contains `src/policy/guard-script.ts` and the corresponding
`ownership.ts` reduction alongside its own, unrelated `sanitizeCheckName` fix. This changelog is therefore the record for
both halves of L1-07. The concurrency is real (several agent sessions share this checkout), and both sides now stage
explicit paths rather than `git add -A`.

## Verification

- `tests/unit/hook-configs.test.ts` — each dialect's configuration file and written shape; merging preserves what was
  already in the file and replaces an unparseable one; removal takes out only kata's entries (and empties Copilot's
  file, which is kata's alone) and leaves an unparseable file untouched; an unrecognised format keeps the block wholesale,
  as before.
- The installer suites pass unchanged — a hook file appears, is updated in place and is removed on uninstall, for every
  dialect — which is the evidence the split preserved the wiring.
- Full suite: 562 tests in 66 files, all passing; `tsc --noEmit` clean; `dist/cli.js` rebuilt.
