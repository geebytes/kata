# The generated platform assets have a guard, and are current again

Found on 2026-09-18 while checking an unrelated item: `.codex/`, `.opencode/` and `.agents/` hold rendered copies of
every skill, they are tracked in git, and **nothing checked that they were still current**. When the renderer's prose
changed — including the same day's `--elapsed-ms` / `deltaSaving` / `findings defer` procedure — the committed copies
silently kept the older text, and the drift was even carrying a bug forward: the committed `kata-verify` text still
contained ``kata-cli verify --change --change <task-id>``.

The doubled flag turned out to be a **live renderer bug**, not just stale text:
`` `${command.cli.replace(' <change-id>', ' --change <task-id>')}` `` rewrites a CLI form that already says
`--change <change-id>` into `--change --change <task-id>`. Fixed in the renderer, so every future render is right.

## What changed

- **`tests/unit/generated-assets-are-current.test.ts`** regenerates each platform's skill text with `renderSkill` and
  compares it against the committed file, failing with the remedy in the message ("Run `kata-cli update` … and commit the
  result"). A platform whose assets this checkout does not carry is skipped rather than reported as drift.
- The 31 stale files were re-rendered and are current again — the procedure added earlier today is in them, and the
  doubled flag is gone.

## Verification

- The guard test starts **red on four files** (`codex`/`opencode` × `kata-review`/`kata-verify`) — the two nodes whose
  prose changed today — and is green after the refresh. Full kata suite: 681 tests in 83 files; `tsc` clean; `dist/cli.js`
  rebuilt.

## Why this generalises

Anything the product *generates* and the repository *commits* needs a test that regenerates it and compares — otherwise
"the assets are stale" is only ever discovered by accident, and a stale asset is a promise the product no longer makes.
This is the same lesson as the recorded verdicts, the schema kinds and the guard instructions: what is written twice
drifts unless something refuses the drift.
