---
description: Run the kata-collect Kata workflow
---

Equivalent Kata skill: `kata-collect`
Command name: `/kata-collect`

Use the invocation arguments below as the user input for this workflow:

```text
$ARGUMENTS
```

# /kata-collect

platform: opencode


Use this skill to inspect the Kata collect workflow entrypoint.

## Skill-first operating rule

Prefer the `/kata-collect` Skill as the human-facing interface. Use `kata collect` as the deterministic fallback inside the Skill or in non-interactive scripts. If the user gives a short instruction, natural-language hint, or no parameters, discover the active/same-branch task with `kata status`, follow relation redirects, and ask for a concise confirmation only when multiple choices remain.

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
  "id": "kata-collect",
  "slashCommand": "/kata-collect",
  "cli": "kata collect",
  "phase": "collect",
  "summary": "Use when collecting work back from another coding platform after delegated Kata implementation or repair."
}
```

## Trigger scenarios

- User says another platform has finished implementation or repair.
- Agent needs to inspect returned evidence before review, judge, archive, or repair.
- Delegated work must be reconciled into the current branch and Kata lifecycle.

## Input signals

Keywords and intents that should trigger this skill:

- `collect`
- `return`
- `done in opencode`
- `回收`
- `做完了`
- `交回`
- `审计另一个平台`
- `OpenCode 完成`

## Output goals

- Discover the returned task and evidence state.
- Ask the user to confirm the task/platform when ambiguous.
- Run reviewer/judge/archive or produce scoped repair instructions.

## Invocation

```bash
kata collect
```

The invocation is the deterministic CLI fallback for scripts and CI. In normal agent use, prefer conversation: discover candidates, recommend defaults, ask for confirmation, then run the resolved command.

## Guard enforcement

guard enforcement: CLI/CI-only

## Host model selection

Kata does not configure or route host-platform models. If this phase needs a different model, use the host platform's own selector before continuing; model choice is outside Kata state and does not create a route artifact.

OpenCode：如需切换模型，先执行 `/models` 并在其交互界面完成选择，再运行本次委托的 Kata 命令。

## Interactive collection

Do not ask the user for CLI parameters first. Discover the likely returned task, inspect upstream outputs, then ask for confirmation.

1. Run `kata collect` first. It returns same-branch candidates, upstream summaries, and a `recommended` task/action.
2. If the recommendation says `repair_blocking_review_findings`, `repair_failed_judge`, or `repair_failing_evidence`, ask the user to confirm repair and then act as implementer.
3. If the recommendation says `review_fresh_implementation`, ask the user to confirm review and then run reviewer flow.
4. If the recommendation says `judge_reviewed_change`, ask the user to confirm Judge and then run judge flow.
5. Read task state, review/judge/evidence files, and relevant handoff receipts before editing or judging.
6. If evidence is ready and user confirms higher-trust gates, run:
   ```bash
   kata review --change <task-id>
   kata judge --change <task-id>
   ```
7. If Judge passes and archive is appropriate, ask for confirmation, then run archive and perform wiki distillation.
8. If Judge fails, return the repair scope and a ready-to-send prompt for the delegated platform.
