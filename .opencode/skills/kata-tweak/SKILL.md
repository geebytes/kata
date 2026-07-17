---
name: kata-tweak
description: Runs the lightweight tweak path for local docs, prompt, copy, or configuration changes. Use when the user asks for a small non-bug adjustment.
---

# /kata-tweak

platform: opencode


Use this skill to inspect the Kata tweak workflow entrypoint.

## Skill-first operating rule

Prefer the `/kata-tweak` Skill as the human-facing interface. Use `kata tweak --change <change-id>` as the deterministic fallback inside the Skill or in non-interactive scripts. If the user gives a short instruction, natural-language hint, or no parameters, discover the active/same-branch task with `kata status`, follow relation redirects, and ask for a concise confirmation only when multiple choices remain.

## Startup checklist

Before doing task work, run the project orientation command:

```bash
kata status
kata orient --role <designer|implementer|reviewer|judge|distiller> --platform opencode --task-kind <read|implementation|security>
kata hooks activate --change <change-id> --role <designer|implementer|reviewer|judge|distiller> --platform opencode
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

Run kata handoff verify --task <change-id> --id <handoff-id>, kata handoff show --task <change-id> --id <handoff-id>, then kata handoff acknowledge --task <change-id> --id <handoff-id> --platform opencode --role <role>.

The packet's allowed writes and guard instructions are authoritative. Model selection belongs to the host platform and never bypasses CI, tests, Reviewer, or Judge.



```json kata-command-manifest
{
  "id": "kata-tweak",
  "slashCommand": "/kata-tweak",
  "cli": "kata tweak --change <change-id>",
  "phase": "tweak",
  "summary": "Runs the lightweight tweak path for local docs, prompt, copy, or configuration changes. Use when the user asks for a small non-bug adjustment."
}
```

## Trigger scenarios

- User requests a small local improvement.
- Change is limited to docs, prompt text, copy, config, or minor workflow wording.
- Full feature design would be disproportionate.

## Input signals

Keywords and intents that should trigger this skill:

- `tweak`
- `small change`
- `docs`
- `prompt`
- `copy`
- `config`
- `微调`
- `文档`
- `配置`

## Output goals

- Apply a bounded lightweight change.
- Run proportional verification.
- Avoid expanding into unrelated implementation work.

## Invocation

```bash
kata tweak --change <change-id>
```

The invocation is the deterministic CLI fallback for scripts and CI. In normal agent use, prefer conversation: discover candidates, recommend defaults, ask for confirmation, then run the resolved command.

## Guard enforcement

guard enforcement: CLI/CI-only

## Host model selection

Kata does not configure or route host-platform models. If this phase needs a different model, use the host platform's own selector before continuing; model choice is outside Kata state and does not create a route artifact.

OpenCode：如需切换模型，先执行 `/models` 并在其交互界面完成选择，再运行本次委托的 Kata 命令。

