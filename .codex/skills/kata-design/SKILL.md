---
name: kata-design
description: Creates or refines the technical design and acceptance contract. Use when requirements, architecture, acceptance criteria, or project constraints need clarification before implementation.
---

# /kata-design

platform: codex


Use this skill to inspect the Kata design workflow entrypoint.

## Skill-first operating rule

Prefer the `/kata-design` Skill as the human-facing interface. Use `kata design --change <change-id>` as the deterministic fallback inside the Skill or in non-interactive scripts. If the user passes an explicit task id (e.g. "/kata-build my-task"), use it as the immutable anchor for all subsequent operations; do not re-discover via `kata status` or same-branch resolution. If the user gives a short instruction, natural-language hint, or no parameters, discover the active/same-branch task with `kata status`, follow relation redirects, and ask for a concise confirmation only when multiple choices remain.

## Startup checklist

Before doing task work, run the project orientation command:

```bash
kata status
kata orient --role <designer|implementer|reviewer|judge|distiller> --platform codex --task-kind <read|implementation|security>
kata hooks activate --change <change-id> --role <designer|implementer|reviewer|judge|distiller> --platform codex
```

Treat skill use as an interactive agent workflow, not a parameter-only command. First discover the active or same-branch task and any relation redirects; if the task, role, task kind, or target platform is ambiguous, present concise options and ask the user to confirm or type a value. Do not make the user remember command-line flags. After confirmation, run `kata orient` with the resolved values, then read the returned task, state, context, required files, guard instructions, relation redirects, and next skill before editing. The hook activation links platform write hooks to the active Kata task so phase/role scope is enforced while you work.

## Phase-boundary pause

Treat `nextAction.requiresUserConfirmation=true` as a hard stop. Do not invoke the next /kata-* skill automatically. At model trust boundaries, stop so the user can use the host platform's own model selector before continuing. Kata has no model routing configuration or route artifact.

This is mandatory at trust boundaries:

- `implementation_gate`: stop after design and before the first build; a platform-neutral handoff packet is already available for any receiving platform.
- `review_gate`: stop after /kata-verify passes before /kata-review.
- `judge_gate`: stop after review before /kata-judge.
- `archive_gate`: stop after judge before /kata-archive.

## CodeGraph-assisted code search

After reading required context and before broad file scans, use CodeGraph when code understanding, impact analysis, or test targeting is needed:

```bash
kata codegraph status
kata codegraph explore "<feature, symbol, module, or error>"
kata codegraph impact "<symbol-or-file>"
kata codegraph affected <changed-file>...
```

Use CodeGraph to find likely source files, call paths, dependents, and affected tests. Then verify with direct file reads and focused `rg` searches before editing or reviewing. If CodeGraph is unavailable or stale, note the fallback and use `rg` plus requiredReads; do not block the workflow solely on CodeGraph.

## Portable context handoff

Before accepting work from another agent or platform, create or verify the canonical repository packet, read every path in its requiredReads field, then acknowledge the packet with the actual platform and role.

Run kata handoff verify --task <change-id> --id <handoff-id>, kata handoff show --task <change-id> --id <handoff-id>, then kata handoff acknowledge --task <change-id> --id <handoff-id> --platform codex --role <role>.

The packet's allowed writes and guard instructions are authoritative. Model selection belongs to the host platform and never bypasses CI, tests, Reviewer, or Judge.



```json kata-command-manifest
{
  "id": "kata-design",
  "slashCommand": "/kata-design",
  "cli": "kata design --change <change-id>",
  "phase": "design",
  "summary": "Creates or refines the technical design and acceptance contract. Use when requirements, architecture, acceptance criteria, or project constraints need clarification before implementation."
}
```

## Trigger scenarios

- User asks for technical design or implementation plan.
- Acceptance criteria or constraints are not yet concrete enough to build.
- Agent must align design with AGENTS.md and .llmwiki before editing code.

## Input signals

Keywords and intents that should trigger this skill:

- `design`
- `plan`
- `proposal`
- `architecture`
- `acceptance`
- `requirements`
- `方案`
- `技术设计`

## Output goals

- Produce a bounded design.
- Clarify acceptance criteria.
- Capture durable decisions into wiki candidates where useful.

## Invocation

```bash
kata design --change <change-id>
```

The invocation is the deterministic CLI fallback for scripts and CI. In normal agent use, prefer conversation: discover candidates, recommend defaults, ask for confirmation, then run the resolved command.

## Guard enforcement

guard enforcement: CLI/CI-only

## Host model selection

Kata does not configure or route host-platform models. If this phase needs a different model, use the host platform's own selector before continuing; model choice is outside Kata state and does not create a route artifact.

请在当前平台的模型选择器或平台配置中完成切换，然后继续本次 Kata 命令。

## Knowledge capture during design

Design decisions often establish lasting constraints and norms. Capture them as you go:

1. After accepting or rejecting an approach, run:
   ```bash
   kata wiki ingest --from docs/decisions/<decision-log>.md
   ```
   This creates a `candidate` wiki record linking the decision to source evidence.

2. If you identify new rules, conventions, or architectural constraints, write a brief summary page and ingest it:
   ```bash
   kata wiki ingest --from .llmwiki/concepts/<topic>.md
   ```

3. These candidates are available to future tasks once promoted. The earlier you capture, the less context later agents will miss.