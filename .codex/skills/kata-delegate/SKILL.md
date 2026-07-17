---
name: kata-delegate
description: Use when delegating a Kata change to another coding platform, agent role, or lower-cost implementer.
---

# /kata-delegate

platform: codex


Use this skill to inspect the Kata delegate workflow entrypoint.

## Skill-first operating rule

Prefer the `/kata-delegate` Skill as the human-facing interface. Use `kata delegate` as the deterministic fallback inside the Skill or in non-interactive scripts. If the user gives a short instruction, natural-language hint, or no parameters, discover the active/same-branch task with `kata status`, follow relation redirects, and ask for a concise confirmation only when multiple choices remain.

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

- `implementation_gate`: stop after design and before the first build; ask whether to keep the current platform/model, delegate a bounded implementation slice to a lower-tier model, or run `/kata-delegate` for another platform.
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
  "id": "kata-delegate",
  "slashCommand": "/kata-delegate",
  "cli": "kata delegate",
  "phase": "delegate",
  "summary": "Use when delegating a Kata change to another coding platform, agent role, or lower-cost implementer."
}
```

## Trigger scenarios

- User wants another platform or agent to implement, repair, review, or judge a Kata task.
- Agent needs to generate a portable handoff packet and target-platform prompt.
- Work should move across Codex, Claude Code, OpenCode, Copilot, Cursor, Windsurf, Cline, RooCode, Gemini, or a generic agent.

## Input signals

Keywords and intents that should trigger this skill:

- `delegate`
- `handoff`
- `opencode`
- `claude code`
- `copilot`
- `cursor`
- `交给`
- `委托`
- `换平台`
- `低阶模型`
- `高阶模型`

## Output goals

- Discover candidate tasks, roles, and platforms.
- Ask the user to confirm or provide missing choices.
- Create and verify a handoff packet plus target-agent prompt.

## Invocation

```bash
kata delegate
```

The invocation is the deterministic CLI fallback for scripts and CI. In normal agent use, prefer conversation: discover candidates, recommend defaults, ask for confirmation, then run the resolved command.

## Guard enforcement

guard enforcement: CLI/CI-only

## Host model selection

Kata does not configure or route host-platform models. If this phase needs a different model, use the host platform's own selector before continuing; model choice is outside Kata state and does not create a route artifact.

请在当前平台的模型选择器或平台配置中完成切换，然后继续本次 Kata 命令。

## Interactive delegation

Do not require the user to pass command-line parameters. Treat natural language as the primary interface.

1. Discover candidate tasks:
   - Run `kata status`.
   - If the user mentioned a change by name or number, inspect that candidate.
   - If multiple same-branch tasks are plausible, present 2–5 options and ask the user to confirm or type a task id.

2. Infer the target role from phase:
   - `plan` or `implement` → `implementer`
   - `hardVerify` → `reviewer`
   - `review` → `judge`
   - `judge` or `distill` → `distiller`
   Ask for confirmation if the user intent conflicts with the phase.

3. Discover platforms with `kata discover`. Recommend one platform based on role and model policy, but ask the user to confirm when more than one suitable platform is available. Let the user type a custom platform name if needed.

4. Ensure the task is ready for delegation:
   - If missing, open it.
   - If in `intake`, design it.
   - Stop and ask before creating broad acceptance criteria that materially change scope.

5. Create and verify the packet:
   ```bash
   kata handoff create --task <task-id> --from <current-role> --to <target-role>
   kata handoff verify --task <task-id> --id <handoff-id>
   ```

6. Generate a target-agent prompt that says:
   - verify/show/acknowledge the handoff
   - read every `requiredReads` path
   - obey `allowedWrites` and guard instructions
   - run the matching `/kata-*` skill or CLI phase
   - stop before phases outside the delegated role

7. Return the prompt and next action to the user.