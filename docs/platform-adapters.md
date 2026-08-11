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

This keeps `kata-cli init` plan-driven instead of scattering platform-specific branches through the CLI.

## Supported platforms

| Platform | Project skills dir | Global env override | Hooks | Model selection |
|----------|--------------------|---------------------|-------|-----------------|
| Codex | `.codex/skills` | `CODEX_HOME` | yes | yes |
| Claude Code | `.claude/skills` | `CLAUDE_CONFIG_DIR` | yes | yes |
| OpenCode | `.opencode/skills` | `OPENCODE_CONFIG_DIR` | no | yes (`/models`) |
| Pi | `.agents/skills` | `PI_CODING_AGENT_DIR` | no | yes (`/model`) |
| Cursor | `.cursor/skills` | — | no | yes |
| Windsurf | `.windsurf/skills` | — | yes | yes |
| Cline | `.cline/skills` | — | no | yes |
| RooCode | `.roo/skills` | — | no | yes |
| Gemini CLI | `.gemini/skills` | — | yes | yes |
| GitHub Copilot | `.github/skills` | — | yes | yes |
| Generic | `.kata/skills` | — | no | no |

Pi is detected via `.agents/skills` or `.pi` markers. Project installs land in the Agent Skills standard directory `.agents/skills/<command>/SKILL.md`, which Pi discovers recursively. Global installs target the shared Agent Skills directory `~/.agents/skills/<command>/SKILL.md`, which Pi discovers as one of its native global load paths (alongside `~/.pi/agent/skills/`); when `PI_CODING_AGENT_DIR` is set, global installs instead land in `$PI_CODING_AGENT_DIR/skills/`. Because `~/.agents/skills/` follows the cross-harness Agent Skills standard, a single global install is immediately usable by Pi and any other compatible harness. Pi reads `AGENTS.md` as project/global context, so the Kata Agent Contract written there is honoured; Pi has no separate "rules" file concept, so no platform rule file is installed. Pi exposes no declarative `PreToolUse` hook, so the Kata write guard is CLI/CI-only on this platform; switch models with the `/model` command.

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

Hook config is merged with existing user hooks. `kata-cli uninstall` removes only Kata-managed hook entries and preserves unrelated user hook commands.

## Active-task hook guard

Platform hooks become strict only after a task is activated:

```bash
kata-cli hooks activate --change <task-id> --role implementer
kata-cli hooks status
kata-cli hooks deactivate
```

Activation writes `.kata/runtime/active-task.json`. The installed `kata-hook-guard.mjs` reads that file, the current task phase, and the write target supplied by the host platform hook payload.

The guard blocks:

- code/test writes during `intake`, `plan`, and `archive`
- protected rules and verified wiki writes unless the active role is `approver`
- reviewer/judge/distiller writes outside their structured artifact scope
- traversal or absolute paths that escape the project root

If no active task exists, the hook exits successfully. This keeps platform hooks safe for ordinary non-Kata work and makes Kata enforcement explicit.

## Diagnostics

Use `kata-cli doctor` after installation or update. Without `--platform`, it checks all detected project platforms. With `--platform <name>`, it checks only that adapter.

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
