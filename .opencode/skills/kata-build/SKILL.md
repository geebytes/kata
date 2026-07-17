---
name: kata-build
description: Implements the accepted task slice with hard verification evidence. Use when the design and acceptance contract are ready for code or documentation changes.
---

# /kata-build

platform: opencode


Use this skill to inspect the Kata implement workflow entrypoint.

## Skill-first operating rule

Prefer the `/kata-build` Skill as the human-facing interface. Use `kata build --change <change-id>` as the deterministic fallback inside the Skill or in non-interactive scripts. If the user gives a short instruction, natural-language hint, or no parameters, discover the active/same-branch task with `kata status`, follow relation redirects, and ask for a concise confirmation only when multiple choices remain.

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

## Skill automation contract

The Skill MUST run these commands itself. Do not ask the user to copy or type them unless the platform cannot execute shell commands.

Skill-first means the slash command is the agent interface and the CLI is the internal execution layer. The user may provide no task id, a natural-language task hint, or only "continue"; the Skill must discover candidates and ask for a short confirmation only when needed.

1. Run `kata status` to read the active or current-branch discovered task, relation redirects, phase, next skill, task title, acceptance criteria, and context summary.
2. Do not require the user to pass parameters. Resolve the task id from active task, same-branch task, relation redirects, or the `recommended` task/action from `kata status` or `kata collect`. If multiple plausible tasks remain, show concise options and ask the user to choose or type a value.
3. Resolve role and task-kind from phase and user intent; if ambiguous, present recommended options and ask for confirmation. Do not default across trust boundaries without confirmation.
4. Run `kata orient` without `--change` when using the active/single discovered task, or with `--change <id>` after the user confirms a task id. Parse its relation redirects, handoff id, state, task, requiredReads, nextAction, and context fields.
5. Run kata handoff verify for that id; stop on an invalid result.
6. Read every requiredReads path from the packet.
7. Run kata handoff acknowledge with platform opencode and the current role.
8. For build, first complete TDD and focused tests (先完成 TDD 与聚焦测试). Do not seal evidence before coding (不要在编码前封存证据). For current_worktree tasks, declare task-owned files with `--owned-path <path>` before sealing. `--seal` creates one immutable revision; `revision_superseded` means an owned file changed and requires Build for a new revision, while workspace drift outside ownership does not invalidate the sealed revision.
9. After the phase command returns, read `completion.userMessage` first, then `nextAction.slashCommand`, `nextAction.cliCommand`, `recommended.reason`, and `askUser` from the command result. Always tell the user the current phase and the next recommended operation. For every successful phase command—especially `/kata-build <task> --seal`—the final user-facing response MUST end with `completion.userMessage` verbatim. This is not optional: never finish with only a test summary, and never wait for the user to ask “what next”. If `completion` is absent, explicitly render the current phase and `nextAction.slashCommand`. Prefer the slash command, for example `/kata-verify <change-id>`; show the CLI command only as fallback.
10. Stop after this Skill's own phase command. If the returned `nextAction.requiresUserConfirmation=true`, do not invoke the next /kata-* skill. At model trust boundaries, wait for the user to use the host platform's own selector before continuing.

Do not create a receipt for read-only search, explanation, or orientation-only work.

```json kata-command-manifest
{
  "id": "kata-build",
  "slashCommand": "/kata-build",
  "cli": "kata build --change <change-id>",
  "phase": "implement",
  "summary": "Implements the accepted task slice with hard verification evidence. Use when the design and acceptance contract are ready for code or documentation changes."
}
```

## Trigger scenarios

- User asks to implement an approved Kata task.
- The current phase is plan/implement and acceptance criteria are available.
- Agent needs to make code/docs changes while collecting evidence.

## Input signals

Keywords and intents that should trigger this skill:

- `build`
- `implement`
- `code`
- `落地`
- `实现`
- `修改代码`
- `执行计划`

## Output goals

- Apply the smallest coherent change.
- Collect fresh test/build evidence.
- Capture implementation discoveries into .llmwiki when relevant.

## Invocation

```bash
kata build --change <change-id>
```

The invocation is the deterministic CLI fallback for scripts and CI. In normal agent use, prefer conversation: discover candidates, recommend defaults, ask for confirmation, then run the resolved command.

## Guard enforcement

guard enforcement: CLI/CI-only

## Host model selection

Kata does not configure or route host-platform models. If this phase needs a different model, use the host platform's own selector before continuing; model choice is outside Kata state and does not create a route artifact.

OpenCode：如需切换模型，先执行 `/models` 并在其交互界面完成选择，再运行本次委托的 Kata 命令。

## Knowledge capture during implementation

Implementation reveals concrete constraints that design alone cannot foresee:

1. If you discover an unexpected limitation, workaround, or invariant, document it:
   ```bash
   kata wiki ingest --from src/<relevant-file>.ts
   ```

2. If you establish new conventions (naming, structure, error handling), write a short convention note and ingest it:
   ```bash
   kata wiki ingest --from docs/conventions/<topic>.md
   ```

3. Don't wait for archive. Mid-task capture means the knowledge is available for the verification phase and for future tasks.