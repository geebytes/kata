---
name: kata-review
description: Use when an independent Reviewer must record review findings without running Judge.
---

# /kata-review

platform: pi

## Response language

所有面向用户的自然语言响应必须使用中文。代码、命令、文件路径、API 名称、日志和协议字段可以保留原文。


Use this skill to inspect the Kata review workflow entrypoint.

## Skill-first operating rule

Prefer the `/kata-review` Skill as the human-facing interface. Use `kata-cli review --change <change-id>` as the deterministic fallback inside the Skill or in non-interactive scripts. If the user passes an explicit task id (e.g. "/kata-build my-task"), use it as the immutable anchor for all subsequent operations; do not re-discover via `kata-cli status` or same-branch resolution. If the user gives a short instruction, natural-language hint, or no parameters, discover the active/same-branch task with `kata-cli status`, follow relation redirects, and ask for a concise confirmation only when multiple choices remain.

## Startup checklist

Before doing task work, run the project orientation command:

```bash
kata-cli status
kata-cli orient --role <designer|implementer|reviewer|judge|distiller> --platform pi --task-kind <read|implementation|security>
kata-cli hooks activate --change <change-id> --role <designer|implementer|reviewer|judge|distiller> --platform pi
```

Treat skill use as an interactive agent workflow, not a parameter-only command. First discover the active or same-branch task and any relation redirects; if the task, role, task kind, or target platform is ambiguous, present concise options and ask the user to confirm or type a value. Do not make the user remember command-line flags. After confirmation, run `kata-cli orient` with the resolved values, then read the returned task, state, context, required files, guard instructions, relation redirects, and next skill before editing. The hook activation links platform write hooks to the active Kata task so phase/role scope is enforced while you work.

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
kata-cli codegraph status
kata-cli codegraph explore "<feature, symbol, module, or error>"
kata-cli codegraph impact "<symbol-or-file>"
kata-cli codegraph affected <changed-file>...
```

Use CodeGraph to find likely source files, call paths, dependents, and affected tests. Then verify with direct file reads and focused `rg` searches before editing or reviewing. If CodeGraph is unavailable or stale, note the fallback and use `rg` plus requiredReads; do not block the workflow solely on CodeGraph.

## Portable context handoff

Before accepting work from another agent or platform, create or verify the canonical repository packet, read every path in its requiredReads field, then acknowledge the packet with the actual platform and role.

Run kata-cli handoff verify --task <change-id> --id <handoff-id>, kata-cli handoff show --task <change-id> --id <handoff-id>, then kata-cli handoff acknowledge --task <change-id> --id <handoff-id> --platform pi --role <role>.

The packet's allowed writes and guard instructions are authoritative. Model selection belongs to the host platform and never bypasses CI, tests, Reviewer, or Judge.

## Independent adversarial review (clean context)

Both nodes below must answer to a **different context than the one that wrote the change**. The same context that
implemented a change shares its assumptions, its blind spots and its reading of its own evidence, so its own
confirmation is the weakest possible evidence that the change is sound.

Before this Skill's node can conclude — before `kata-cli verify` reports success, and before
`kata-cli review --approve` records an approval — kata requires a recorded adversarial pass over the sealed revision,
or an explicit recorded waiver. The gate is not advisory: the command fails while the pass is missing.

Do this:

1. Render the brief. It is self-contained and states the revision, the claims under test, the recorded evidence and
   the exact result shape:
   ```bash
   kata-cli adversarial brief --change <task-id> --node review
   ```
2. **Run that brief in a clean context.** Use the host platform's own subagent facility — a fresh session, no prior
   conversation, no summary of this one — and hand it the brief text verbatim. Do not run the pass in this context, and
   do not paraphrase the brief: a fresh context has nothing but what the brief says. The brief asks it to try to *falsify*
   every claim, to run the attempts, and to return one JSON object.
3. Record what came back, unchanged:
   ```bash
   kata-cli adversarial record --change <task-id> --node review --from-file <result.json>
   ```
4. Read the gate's answer in the command output. Blocking or major findings from the pass stop the node until they are
   repaired; a pass recorded against an older revision or against a different brief does not satisfy the gate
   (`kata-cli adversarial status --change <task-id>` shows both nodes).
5. Then run this Skill's own command again (`kata-cli review --change --change <task-id>`).

If the pass genuinely cannot run (no subagent facility on this platform, or the revision is trivial), record that
decision explicitly instead of skipping it silently — the gate reports a waiver as a waiver:

```bash
kata-cli adversarial waive --change <task-id> --node review --reason "<why this node proceeds without an independent pass>"
```

Kata cannot start a subagent or inspect the host's session: it renders the brief, checks the result against the revision
and that brief, and holds the gate. Who ran it, in which context, is reported by the executing agent in
`executedInFreshContext`/`contextNote` — the same way host model confirmation is reported.

## Skill automation contract

The Skill MUST run these commands itself. Do not ask the user to copy or type them unless the platform cannot execute shell commands.

Skill-first means the slash command is the agent interface and the CLI is the internal execution layer. The user may provide no task id, a natural-language task hint, or only "continue"; the Skill must discover candidates and ask for a short confirmation only when needed.

1. Run `kata-cli status` to read the active or current-branch discovered task, relation redirects, phase, next skill, task title, acceptance criteria, and context summary.
2. Do not require the user to pass parameters. Resolve the task id from active task, same-branch task, relation redirects, or the `recommended` task/action from `kata-cli status` or `kata-cli collect`. If multiple plausible tasks remain, show concise options and ask the user to choose or type a value.
3. Resolve role and task-kind from phase and user intent; if ambiguous, present recommended options and ask for confirmation. Do not default across trust boundaries without confirmation.
4. Run `kata-cli orient` without `--change` when using the active/single discovered task, or with `--change <id>` after the user confirms a task id. Parse its relation redirects, handoff id, state, task, requiredReads, nextAction, and context fields.
5. Run kata-cli handoff verify for that id; stop on an invalid result.
6. Read every requiredReads path from the packet.
7. Run kata-cli handoff acknowledge with platform pi and the current role.
8. Run this Skill's phase command and collect normal evidence. The next phase creates a fresh packet.
9. After the phase command returns, read `completion.userMessage` first, then `nextAction.slashCommand`, `nextAction.cliCommand`, `recommended.reason`, and `askUser` from the command result. Always tell the user the current phase and the next recommended operation. For every successful phase command—especially `/kata-build <task> --seal`—the final user-facing response MUST end with `completion.userMessage` verbatim. This is not optional: never finish with only a test summary, and never wait for the user to ask “what next”. If `completion` is absent, explicitly render the current phase and `nextAction.slashCommand`. Prefer the slash command, for example `/kata-verify <change-id>`; show the CLI command only as fallback.
10. Stop after this Skill's own phase command. A Skill invocation has exactly one phase-command authority: Build may invoke only `kata build`; it MUST NOT invoke verify, review, judge, archive, or any other `/kata-*` command after Build returns. The same rule applies to every phase Skill: render its next action for the user, then end the invocation. If the returned `nextAction.requiresUserConfirmation=true`, do not invoke the next /kata-* skill. At model trust boundaries, wait for the user to use the host platform's own selector before continuing.

Do not create a receipt for read-only search, explanation, or orientation-only work.

```json kata-command-manifest
{
  "id": "kata-review",
  "slashCommand": "/kata-review",
  "cli": "kata-cli review --change <change-id>",
  "phase": "review",
  "summary": "Use when an independent Reviewer must record review findings without running Judge."
}
```

## Trigger scenarios

- User asks for an independent code review before judgment.
- A completed implementation has fresh evidence.

## Input signals

Keywords and intents that should trigger this skill:

- `review`
- `审查`
- `code review`

## Output goals

- Enter reviewer phase.
- Record review findings only.
- Prepare the task for an independent Judge.

## Invocation

```bash
kata-cli review --change <change-id>
```

The invocation is the deterministic CLI fallback for scripts and CI. In normal agent use, prefer conversation: discover candidates, recommend defaults, ask for confirmation, then run the resolved command.

## Guard enforcement

guard enforcement: CLI/CI-only

## Host model selection

Kata does not configure or route host-platform models. If this phase needs a different model, use the host platform's own selector before continuing; model choice is outside Kata state and does not create a route artifact.

Pi：如需切换模型，先执行 `/model` 完成选择，再运行本次委托的 Kata 命令。

