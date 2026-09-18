# The per-platform renderer wrappers became a facade production uses (L1-08, option B)

The review found five six-line files (`pi.ts`, `codex.ts`, `claude-code.ts`, `opencode.ts`, `generic.ts`) that each
re-exported `renderSkill` with a platform default, imported by nothing but the golden test — a surface that read as a
supported adapter API and was not one. The reviewer's options were to delete them (A), make them real (B), or keep them
(C); the user chose **B**.

## What changed

- **`src/adapters/facade.ts`** — the one place a platform name becomes a renderer: `renderSkillFor(platform, command,
  options)` and `platformDefaults(platform)`.
- **`ownership.ts` now writes every skill file through the facade**, so the function the goldens exercise is the function
  that writes the files. That is what makes it a facade rather than a test-only wrapper — option B's whole point.
- The five per-platform modules remain, as **thin named wrappers over the facade**, for external consumers that import
  `adapters/opencode.js`; they delegate now instead of each re-implementing the default.
- They also gained the **`options.language`** parameter they were missing: their old signature
  (`(command, platform = '<platform>')`) was strictly narrower than production's three-argument call, so the package's
  Chinese skill text shipped through a path no test could reach.

## Verification

- The goldens drive the facade for every platform, and a new assertion pins that each wrapper renders exactly what the
  facade renders for that platform — the default argument being the only difference.
- Full kata suite: 684 tests in 84 files; `tsc` clean; `dist/cli.js` rebuilt.
