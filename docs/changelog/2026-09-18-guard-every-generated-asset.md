# The generated-asset guard covers every generated asset

The guard added earlier today ("the committed platform assets match what the renderer produces") checked the **skill
files** of **two** platforms. Both limits were wrong, and the working tree showed it an hour later: four files were
modified and the guard stayed green.

- **Command files.** OpenCode also ships `.opencode/commands/<id>.md`, rendered from the same skill text with a different
  wrapper. They had drifted on the very same commit that refreshed the skills — the procedure text added to
  `kata-verify` and `kata-review` was in the skill file and not in the command file.
- **`pi`.** Its platform definition renders into `.agents/` (`platforms.ts:129`), so `.agents/skills/*` was never
  compared at all — twelve tracked files with no check on their freshness.

The lesson is in the first version's own scope: "a generated asset" is not a file, it is **whatever `update` writes**.
Guarding a list someone wrote by hand reproduces the problem one level up.

## What changed

- The guard iterates `codex`, `opencode` **and** `pi`, and for each command checks the skill file *and* — where the
  platform has them — the command file.
- `renderPlatformCommand(platform, command, language)` is exported from `ownership.ts`, so the guard regenerates the
  command files with the wrapper the installer actually uses rather than re-implementing the template.
- 24 cases become **48**.

## Verification

- Corrupting one file of each kind (`.codex` skill, `.opencode` command, `.agents` skill) fails **three** tests with the
  remedy in the message; restoring them is green. The guard can go red on exactly the drift it previously missed.
- Full kata suite: 708 tests in 84 files; `tsc` clean; `dist/cli.js` rebuilt.
