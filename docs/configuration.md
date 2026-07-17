# Configuration

Kata reads configuration from `.kata-config.json` in the project root.

## Example

```json
{
  "language": "zh",
  "modelPolicy": {
    "defaultTier": "economy",
    "tiers": ["economy", "capable", "frontier"],
    "defaultSelection": "current",
    "repairLimit": 2,
    "defaults": {
      "retryBudget": 3,
      "diffBudget": { "maxFiles": 5, "maxLines": 200 }
    },
    "roles": {
      "implementer": {
        "tier": "economy",
        "retryBudget": 3,
        "diffBudget": { "maxFiles": 5, "maxLines": 200 }
      },
      "reviewer": {
        "tier": "capable",
        "retryBudget": 2
      },
      "judge": {
        "tier": "frontier"
      }
    },
    "routingMode": "budget",
    "modes": {
      "budget": {
        "defaultTier": "economy",
        "description": "Prefer cheaper models; escalate on harder work or repeated failures."
      },
      "quality": {
        "defaultTier": "capable",
        "description": "Use capable models for most implementation work."
      },
      "deep": {
        "defaultTier": "frontier",
        "description": "Use frontier models for deep architecture, security, and debugging sessions."
      }
    },
    "taskPatterns": {
      "read": {
        "tier": "economy",
        "reason": "read/search/orient stays cheap"
      },
      "implementation": {
        "tier": "capable",
        "reason": "implementation needs stronger tool use"
      },
      "security": {
        "tier": "frontier",
        "reason": "security-sensitive work requires frontier reasoning"
      }
    },
    "routing": {
      "economy": {
        "provider": "openai",
        "model": "gpt-5-mini",
        "costRatio": 1,
        "platformOptions": {
          "codex": { "model": "gpt-5-mini" },
          "opencode": { "model": "openai/gpt-5-mini" }
        }
      },
      "capable": {
        "provider": "anthropic",
        "model": "claude-sonnet-4.5",
        "costRatio": 5,
        "platformOptions": {
          "claude-code": { "model": "sonnet" },
          "opencode": { "model": "anthropic/claude-sonnet-4-5" }
        }
      },
      "frontier": {
        "provider": "openai",
        "model": "gpt-5",
        "costRatio": 20,
        "platformOptions": {
          "codex": { "model": "gpt-5" },
          "opencode": { "model": "openai/gpt-5" }
        }
      }
    }
  }
}
```

## Response language

`language` is a project-level agent response contract:

| Value | Effect |
|-------|--------|
| `zh` | Generated Skills, platform rules, `AGENTS.md`, and `.kata/skills-index.md` require user-facing natural-language responses in Chinese. |
| `en` | Generated Skills, platform rules, `AGENTS.md`, and `.kata/skills-index.md` require user-facing natural-language responses in English. |

`kata init` writes the selected language into `.kata-config.json`. Later `kata update` runs reuse that value even when `--language` is omitted.

Machine-readable protocol fields, command names, paths, API names, logs, and status enum values may remain in their original form.

## Project quality checks

Kata does not hard-code host-project commands such as `make pyrightcheck`. Build evidence is resolved in this order:

1. Explicit project configuration in `.kata-config.json` under `quality.buildChecks`.
2. Project constraints discovered from `AGENTS.md` and `.agents/skills/*/SKILL.md` `Acceptance Gate` code blocks.
3. Kata's own fallback checks, used only when the host project declares no quality gate.

Example explicit project configuration:

```json
{
  "quality": {
    "buildChecks": [
      { "name": "lint", "kind": "lint", "command": "make", "args": ["lint"] },
      { "name": "typecheck", "kind": "typecheck", "command": "make", "args": ["typecheck"] },
      { "name": "pyrightcheck", "kind": "typecheck", "command": "make", "args": ["pyrightcheck"] },
      { "name": "test", "kind": "test", "command": "make", "args": ["test"], "timeoutMs": 120000 }
    ]
  }
}
```

`name` is used in evidence file names, so two checks with the same kind do not overwrite each other. For example, `make typecheck` and `make pyrightcheck` become separate evidence files.

## Model tiers

Three capability tiers:

| Tier | Use for |
|------|---------|
| `economy` | Fast, cheap implementers |
| `capable` | Reviewers, repair |
| `frontier` | Judge, complex reasoning |

Tiers are vendor-neutral role policy names. The optional `routing` block maps each enabled tier to a concrete provider/model for platforms that support model selection. Escalation follows `economy → capable → frontier`.

## Model routing diagnostics

Model policy is configured directly in `.kata-config.json`. There are no CLI commands for model configuration or routing. Kata does not switch models automatically or record model selection. The `modelPolicy` object controls:

| Field | Description |
|-------|-------------|
| `defaultTier` | Default model tier (`economy`, `capable`, `frontier`) |
| `defaults.retryBudget` | Max retries before escalation suggestion |
| `roles.<role>.tier` | Minimum tier for implementer / reviewer / judge |
| `routing.<tier>.platformOptions.<platform>` | Platform-specific model name hint per tier |

At trust boundaries, `kata status` and `kata orient` return `nextAction.recommended` with role and tier guidance. The user chooses the actual model in their host platform's selector. Kata does not enforce which model is used; correctness belongs to tests, Reviewer, and Judge regardless of which model was selected.

## Budgets

| Setting | Default | Description |
|---------|---------|-------------|
| `retryBudget` | 3 | Max retries before escalation |
| `maxFiles` | 5 | Max files per repair scope |
| `maxLines` | 200 | Max lines per repair scope |

## Escalation triggers

- Hard failure exceeding retry budget
- Structured output validation failure
- Source conflict with rules/ADRs
- Security-sensitive scope
- Budget exceeded
- Ambiguous acceptance criteria

## Role permissions

| Role | Can write |
|------|-----------|
| `implementer` | `src/`, `tests/`, task artifacts |
| `reviewer` | `review.json` only |
| `judge` | `judge.json` only |
| `distiller` | Wiki candidates only |
| `approver` | Full access including verified Wiki |

Protected paths (`docs/superpowers/rules/`, `wiki/verified/`) require `approver` role. Path traversal (`../`) is rejected.
