# Kata Platform Adapters

Kata follows the Comet adapter pattern: one platform registry, one installer, and small format adapters for platform-specific files.

## Registry

Platform metadata lives in `src/adapters/platforms.ts`.

Each platform declares:

- skill directory for project/global scope
- optional detection paths
- optional rules directory and rule format
- optional command bridge support
- capability flags such as skills, hooks, subagents, and model selection

This keeps `kata init` plan-driven instead of scattering platform-specific branches through the CLI.

## Model selection contract

Kata does not own model selection, route models automatically, or write model route artifacts. Model policy is configured declaratively in `.kata-config.json` under `modelPolicy.roles`. At trust boundaries (`review_gate`, `judge_gate`), Kata pauses so the user can choose the model in their host platform's selector before continuing.

If a platform supports native model selection and the user has configured tiers in `modelPolicy.routing`, adapters may optionally expose that configuration as a hint. The adapter must not switch models without user consent. Correctness still belongs to evidence, Reviewer, and Judge regardless of which model was selected.

## Installed artifacts

For each selected platform, Kata installs:

- `skills/<skill>/SKILL.md` entries generated from the normalized Kata skill manifest
- platform rules, when supported, containing the Kata Agent Contract
- managed hook guard scripts and platform hook configuration, when supported
- OpenCode command bridge files in `.opencode/commands/*.md`, so `/kata-*` style commands can be invoked naturally
- project support files for project scope: `AGENTS.md`, `.kata/skills-index.md`, and optional `.llmwiki`

Rules are formatted per platform:

- Markdown rules: `rules/kata-agent-contract.md`
- Cursor MDC: `rules/kata-agent-contract.mdc`
- GitHub Copilot instructions: `instructions/kata-agent-contract.instructions.md`

Hooks are formatted per platform:

- Codex / Claude Code: `settings.local.json` with `hooks.PreToolUse`
- Gemini CLI: `settings.json` with `hooks.BeforeTool`
- Windsurf: `hooks.json` with `hooks.pre_write_code`
- GitHub Copilot: `.github/hooks/kata-guard.json`

Hook config is merged with existing user hooks. `kata uninstall` removes only Kata-managed hook entries and preserves unrelated user hook commands.

## Active-task hook guard

Platform hooks become strict only after a task is activated:

```bash
kata hooks activate --change <task-id> --role implementer
kata hooks status
kata hooks deactivate
```

Activation writes `.kata/runtime/active-task.json`. The installed `kata-hook-guard.mjs` reads that file, the current task phase, and the write target supplied by the host platform hook payload.

The guard blocks:

- code/test writes during `intake`, `plan`, and `archive`
- protected rules and verified wiki writes unless the active role is `approver`
- reviewer/judge/distiller writes outside their structured artifact scope
- traversal or absolute paths that escape the project root

If no active task exists, the hook exits successfully. This keeps platform hooks safe for ordinary non-Kata work and makes Kata enforcement explicit.

## Diagnostics

Use `kata doctor` after installation or update. Without `--platform`, it checks all detected project platforms. With `--platform <name>`, it checks only that adapter.

The doctor command checks:

- generated skills
- platform rules
- hook guard script and hook config
- platform command bridge files such as OpenCode commands
- project trigger files
- `.llmwiki` presence for project scope

It returns JSON with `ok`, `checks`, and a `summary` of `missing` and `conflicts` so scripts can fail fast before a broken adapter setup reaches an agent session.

## Current boundary

This change lands the registry, detection, rules, OpenCode command bridge, and active-task hook enforcement. Future work can make hook payload extraction richer for additional host tools, but unsupported/unknown payloads intentionally pass through rather than risk false positives.

The operating contract remains:

> Wiki helps agents avoid project-context mistakes; CI, tests, Reviewer, and Judge prevent code-correctness mistakes.
