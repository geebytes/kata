# Installation

## Prerequisites

- Node.js 20+
- An AI coding tool. Kata auto-detects Codex, Claude Code, OpenCode, Cursor, Windsurf, Cline, RooCode, Gemini CLI, GitHub Copilot, and a generic fallback.
- Optional: a structural code index CLI such as `codegraph` for faster code navigation. Kata works without it.

## Local setup

```bash
cd /app/kata
npm install
npm run build

# verify
node dist/cli.js discover
```

To use `kata` as a shell command, add an alias or symlink:

```bash
# alias approach
alias kata="node /app/kata/dist/cli.js"

# or symlink (requires /usr/local/bin in PATH)
sudo ln -sf /app/kata/dist/cli.js /usr/local/bin/kata
```

## Platform setup

Kata auto-detects your platform via `kata init`:

```bash
# Interactive selectable TUI: language, scope, detected platforms
kata init

# Non-interactive: auto-detect and install all detected project platforms
kata init --yes

# Explicit platform
kata init --platform codex
kata init --platform claude-code
kata init --platform opencode

# Initialize project Wiki from a custom documentation path
kata init --platform codex --wiki-from docs/developer

# Install without creating .llmwiki
kata init --platform codex --no-wiki

# Install globally (e.g. for Claude Code)
kata init --platform claude-code --scope global

# Dry-run to preview
kata init --platform codex --dry-run

# Print the install/update report when you need machine-readable output
kata init --platform codex --json
kata update --platform codex --json

# Verify installed artifacts
kata doctor --platform codex
```

Installer commands (`kata init`, `kata update`, and `kata uninstall`) are silent on success by default so AI tools can run them without flooding chat. Use `--json` for diagnostics or scripts that need the full report.

The language selected during `kata init` is installed as an agent response contract, not only as Skill display text. Choosing `中文` writes a rule into generated Skills, platform rules, `AGENTS.md`, and `.kata/skills-index.md` requiring all user-facing natural-language responses to be Chinese. The selection is persisted in `.kata-config.json`, so future `kata update` runs keep the same response language even when no `--language` flag is provided. Code, commands, paths, API names, and logs may remain in their original form.

### Codex

Installs Skills into `.codex/skills/kata/`. Commands include `/kata`, `/kata-open`, `/kata-design`, `/kata-build`, `/kata-verify`, `/kata-archive`, `/kata-hotfix`, `/kata-tweak`, and `/kata-wiki-enrich`.

### Claude Code

Installs Skills into `.claude/skills/kata/`. Uses Claude Code's native hook/sub-agent capabilities for enhanced automation.

### OpenCode

Installs Skills into `.opencode/skills/kata/` and command bridge files into `.opencode/commands/`. Compatible with OpenCode's Skill and slash-command style dispatch.

### Additional platforms

Kata uses a Comet-style platform registry for detection and install paths. Cursor, Windsurf, Cline, RooCode, Gemini CLI, and GitHub Copilot receive generated skills where supported plus platform rules in their native rule format. See `docs/platform-adapters.md`.

### Generic fallback

When no specific platform is detected, Kata installs a generic fallback into `.kata/skills/`. Works with any AI coding tool via explicit CLI commands.

## Project initialization

```bash
cd your-project
kata init
```

When run in an interactive terminal, `kata init` opens a Comet-style setup wizard with selectable options. In scripts or CI, use `kata init --yes` to install all detected supported project platforms without prompts.

`kata init` is the single project bootstrap command. It coordinates:

1. Comet binary detection/installation and project initialization via `comet init`.
2. Kata platform detection and Skill installation.
3. Project trigger files (`AGENTS.md` Kata block and `.kata/skills-index.md`).
4. `.kata/` layout and governed Wiki records.
5. `.llmwiki/` initialization from `docs/` or `--wiki-from`.

If a compatible structural code index CLI such as `codegraph` is available, Kata may report an optional indexing step. This is a navigation accelerator only; `.llmwiki` and the governed workflow do not depend on it.

This creates the `.kata/` directory structure:

```
.kata/
├── rules/            # approved policies and ADRs
├── wiki/             # governed Wiki records (JSON)
├── tasks/            # task state and events
├── evidence/         # command/CI/reviewer envelopes
├── schemas/          # installed JSON Schema copies
└── runtime/          # session pointers (gitignored)
```

For project-scoped installs, Kata also writes two project trigger files:

- `AGENTS.md` receives a managed `Kata Agent Contract` block.
- `.kata/skills-index.md` lists installed `/kata-*` Skills and the startup command.
- `.llmwiki/` is initialized from `docs/` when that directory exists, unless `--no-wiki` is set.

Wiki initialization is managed by the `kata` binary:

```bash
# Default: use docs/ when present
kata init --platform codex --root /app

# Explicit source path
kata init --platform codex --root /app --wiki-from docs/developer

# Skip Wiki initialization
kata init --platform codex --root /app --no-wiki
```

If `.llmwiki/` already exists, Kata preserves it and reports `wiki.status = "existing"`.

The contract tells any AI coding tool to begin non-trivial work with:

```bash
kata orient --change <change-id> --role <role> --task-kind <kind>
kata hooks activate --change <change-id> --role <role>
```

That orientation command links repository instructions, `.llmwiki` entry files, model routing, role handoff guards, and the next suggested Skill. The Wiki still only improves project understanding; CI, tests, Reviewer, and Judge remain responsible for code correctness.

When switching tools on the same branch, use the built-in context handoff instead of copying a chat summary:

```bash
kata handoff create --task <change-id> --from implementer --to reviewer --platform opencode
kata handoff verify --task <change-id> --id <handoff-id>
kata handoff acknowledge --task <change-id> --id <handoff-id> --platform codex --role reviewer
```

The packet is local to one Git worktree and branch. It captures task context, authoritative Wiki references, evidence paths, permissions, and Git freshness anchors; it does not synchronize multiple clones or guarantee actual host model selection.

When the task is archived or you intentionally leave the Kata workflow, clear the active hook scope:

```bash
kata hooks deactivate
```

## Update and uninstall

```bash
# Update Skills to latest
kata update

# Update specific platform
kata update --platform codex

# Uninstall Skills (preserves user files)
kata uninstall

# Dry-run uninstall
kata uninstall --dry-run
```

## CI setup

For CI pipelines, run:

```bash
npx @kata-dev/kata discover
npx @kata-dev/kata init --platform generic
```

This installs the generic fallback without requiring an interactive AI tool.

## Scopes

| Scope | Location | Use case |
|-------|----------|----------|
| `project` | `.codex/`, `.claude/`, `.opencode/` | Per-repo Skills |
| `global` | `~/.codex/`, `~/.claude/`, `~/.opencode/` | User-wide Skills |

## Safe migration

1. `kata init --dry-run` — preview changes
2. `kata init` — install without overwriting user files
3. Verify Skills work: run `/kata status` in your AI tool
4. To roll back: `kata uninstall` removes only Kata-owned generated files
