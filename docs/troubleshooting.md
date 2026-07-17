# Troubleshooting

## Common issues

### `kata: command not found`

Build and link the local project:

```bash
cd /app/kata
npm install && npm run build
node dist/cli.js --help
```

Or add the `dist/cli.js` to your PATH through your shell configuration or a symlink.

### Skills not appearing in AI tool

1. Verify installation: `kata discover`
2. Check Skill directory exists:
   - Codex: `.codex/skills/kata/`
   - Claude Code: `.claude/skills/kata/`
   - OpenCode: `.opencode/skills/kata/`
3. Reinstall: `kata init --force`

### `kata codegraph ...` fails

`kata codegraph` is an optional wrapper around a separately installed structural code index CLI. If the binary is not installed, Kata still works normally.

Use `.llmwiki` and `kata orient` for project context, and normal repository search for code navigation until a structural index tool is installed.

### `kata handoff verify` returns `head_mismatch`, `branch_mismatch`, or `diff_mismatch`

The packet was created for a different Git state. Do not reuse it or copy a prior agent's chat summary. From the current worktree, create a new packet and have the receiving agent verify and acknowledge it:

```bash
kata handoff create --task <id> --from implementer --to reviewer
kata handoff verify --task <id> --id <new-handoff-id>
kata handoff acknowledge --task <id> --id <new-handoff-id> --platform <platform> --role reviewer
```

Handoffs intentionally do not work across different branches, clones, or machines in this version.

### Model routing configuration

Model policy is configured in `.kata-config.json`, not through CLI commands. If a role requires a specific tier, edit the `modelPolicy` section directly:

```json
{
  "modelPolicy": {
    "roles": {
      "reviewer": { "tier": "capable" },
      "judge": { "tier": "frontier" }
    }
  }
}
```

Kata does not own model selection. At trust boundaries, choose the model in your host platform's selector before continuing. Correctness is guarded by tests, Reviewer, and Judge regardless of which model was selected.

### Task stuck in a phase

1. Check current state: `kata status <change>`
2. Verify required artifacts exist in `.kata/tasks/<id>/`
3. If guard blocks transition, check missing evidence/reviewer/judge files
4. Manual recovery: delete stale `current-state.json` and rerun

### Judge always returns FAIL

Common causes:
- Missing test evidence (collect with `kind: 'test'`)
- Stale evidence (diff hash changed — rerun checks)
- Failing tests (fix tests first)
- Blocking reviewer findings (resolve findings)

### Evidence freshness fails

Run `wiki verify` to check if source files changed. If sources changed intentionally, re-collect evidence:

```bash
# Re-run checks to get fresh evidence
npm test && kata verify <change>
```

### Wiki promotion rejected

Check the Wiki record:
1. It must be in `candidate` status
2. Source references must be available
3. Run `kata wiki verify` first to check for drift
4. Run conflict check: ensure no rule/test/code conflicts

### Conversation was not captured into Wiki

This is expected unless the user clearly asked for durable knowledge capture. Kata does not copy chat logs into Wiki automatically. To capture a rule or decision, say something explicit such as “沉淀到 wiki” or create a short source note and ingest it:

```bash
mkdir -p .kata/tasks/<id>/wiki-notes
$EDITOR .kata/tasks/<id>/wiki-notes/<topic>.md
kata wiki ingest --from .kata/tasks/<id>/wiki-notes/<topic>.md
kata wiki register
```

The resulting record is a candidate; promote it only after review.

### Conflicts with approved rules

When a Wiki statement conflicts with `.kata/rules/`:

1. Review the conflicting rule
2. Either update the Wiki statement to align
3. Or update the rule (requires explicit approval)
4. The task enters `needs-clarification` for human review

### Permission denied writing to protected path

Implementers cannot write to:
- `docs/superpowers/rules/`
- `wiki/verified/`
- `.kata/schemas/`

These require `approver` role. If your implementer needs to update these,
escalate to a user with approver permissions.

## Recovery procedures

### Corrupted task state

```bash
# State events are append-only; recover from events
kata status <change>
# If current-state.json is corrupted, delete it and rerun
rm .kata/tasks/<id>/current-state.json
kata status <change>  # auto-recovers from events
```

### Stale Wiki after refactor

Run `wiki verify` after major refactors to mark affected records as stale:

```bash
kata wiki verify
# Review stale records and re-verify or re-promote as needed
```

### Installation/update left project in broken state

```bash
# Full uninstall
kata uninstall
# Re-init
kata init
# User-modified files are preserved and reported as conflicts
```

## Getting help

- Open an issue at https://github.com/your-org/kata/issues
- Include the output of `kata discover` and relevant `.kata/` state
