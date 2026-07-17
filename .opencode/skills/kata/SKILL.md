---
name: kata
description: Shows Kata task status and available next actions. Use when the user asks what to do next, wants Kata status, or needs workflow dispatch.
---

# /kata

platform: opencode


Use this skill to inspect the Kata dispatch workflow entrypoint.

## Skill-first operating rule

Prefer the `/kata` Skill as the human-facing interface. Use `kata status` as the deterministic fallback inside the Skill or in non-interactive scripts. If the user gives a short instruction, natural-language hint, or no parameters, discover the active/same-branch task with `kata status`, follow relation redirects, and ask for a concise confirmation only when multiple choices remain.

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
  "id": "kata",
  "slashCommand": "/kata",
  "cli": "kata status",
  "phase": "dispatch",
  "summary": "Shows Kata task status and available next actions. Use when the user asks what to do next, wants Kata status, or needs workflow dispatch."
}
```

## Trigger scenarios

- User asks what Kata phase or next action applies.
- Agent needs to resume an existing Kata task.
- Agent needs a safe entrypoint before choosing a phase skill.

## Input signals

Keywords and intents that should trigger this skill:

- `status`
- `next`
- `resume`
- `continue`
- `dispatch`
- `what now`
- `当前阶段`
- `下一步`

## Output goals

- Report current phase.
- Return the next /kata-* skill or CLI command.
- Surface wiki/model/gate orientation requirements.

## Invocation

```bash
kata status
```

The invocation is the deterministic CLI fallback for scripts and CI. In normal agent use, prefer conversation: discover candidates, recommend defaults, ask for confirmation, then run the resolved command.

## Guard enforcement

guard enforcement: CLI/CI-only

## Host model selection

Kata does not configure or route host-platform models. If this phase needs a different model, use the host platform's own selector before continuing; model choice is outside Kata state and does not create a route artifact.

OpenCode：如需切换模型，先执行 `/models` 并在其交互界面完成选择，再运行本次委托的 Kata 命令。

## Smart dispatch

Read the current task state and upstream artifacts to determine the next action:

```bash
kata status  # show current phase and next skill
```

For a specific change:

```bash
kata status --change <change-id>
```

With one active or same-branch task, the output includes a `nextSkill` field that tells you which /kata-* command can happen next. With multiple same-branch tasks, `kata status` returns `candidates` and a `recommended` action. Prefer the recommendation and ask the user for a short confirmation instead of asking them to remember command-line flags or change ids.

Skill-first rule: treat slash-command Skills as the user interface and CLI commands as the deterministic execution layer inside the Skill. A user should be able to say `/kata-build 修复代码规范` or `继续`; the Skill must discover the task, relation redirects, current phase, and next action before asking for missing choices. Do not ask the user to run `kata build --change ...` unless the host platform cannot execute shell commands.

Workflow control is task-scoped: Change is the target/scope container, Task is the smallest governed control unit, Artifact is evidence, and Step is agent-local execution detail. Do not drive build/review/judge from a Change directly; resolve the canonical Task first.

If a placeholder task or earlier change is covered by a more specific governed task, do not ask future agents to guess. Record the relation:

```bash
kata tasks relate --from <source-task> --to <target-task> --type <covered_by|superseded_by|duplicate_of|merged_into> --reason "<why>"
```

`kata status --change <source-task>` and `kata orient --change <source-task>` follow terminal relations and return `relationRedirects`.

For change-to-task, task-to-change, and change-to-change context, use the generic graph:

```bash
kata relations add --from change:<change-id> --to task:<task-id> --type contains --reason "<why>"
kata relations add --from task:<task-id> --to change:<change-id> --type implements --reason "<why>"
kata relations show --id change:<change-id>
```

Ownership and lineage edges enrich context. Only task-to-task terminal control edges should redirect `status`/`orient`.

Recommendations are derived from upstream platform outputs in this order: blocking `review.json` findings, failed `judge.json` repair scopes, failing evidence, failed `verify.json` repair scopes, `hardVerify` awaiting verify, `review` awaiting Judge, then ordinary build/design work.

If `nextAction.requiresUserConfirmation=true`, stop at that boundary. Do not invoke the next skill automatically. At `implementation_gate`, let the user choose current-platform execution, a low-tier delegated slice, or another platform. At `review_gate` and `judge_gate`, let the user use the host platform's own model selector before continuing. Kata does not configure, route, or verify host-platform models. `archive_gate` remains an explicit user archive decision.

The phase dispatch mapping is:

| Phase | Next Skill |
|-------|-----------|
| `intake` | `/kata-design` |
| `plan` | `/kata-build` |
| `implement` | `/kata-build` |
| `hardVerify` | `/kata-verify` |
| `review` | `/kata-judge` |
| `judge` / `distill` | `/kata-archive` |
| `archive` | `/kata` (dispatch) |

If running inside a platform that supports slash commands and `nextAction.requiresUserConfirmation` is not true, invoke the suggested /kata-* skill directly. Otherwise use:

```bash
kata <design|build|review|judge|verify|archive|hotfix|tweak> --change <change-id>
```

You can also check Comet directly:

```bash
kata comet verify  # check if Comet is installed and compatible
kata comet version # show compatibility and installed versions
```

## Wiki maintenance

The project wiki (`.llmwiki/` + `.kata/wiki/`) accumulates knowledge across tasks. Over time, sources drift, links break, and candidates pile up.

Periodically run:

```bash
kata wiki lint
```

Fix reported issues: broken wikilinks, orphaned pages, missing frontmatter. Re-run until clean.

## Ongoing discipline

- If you discover a decision, constraint, or norm **during** task work, capture it immediately via `kata wiki ingest --from <source-path>`. Don't wait for archive.
- If the user says “记住这个”, “沉淀到 wiki”, “以后都按这个”, “record this rule”, “add to wiki”, or gives an equivalent durable-knowledge instruction, do **not** treat the chat transcript itself as authoritative. Create a concise source note under the task-owned path or docs/conventions, then ingest/register it as a governed Wiki candidate. Ask a short confirmation only when the instruction is ambiguous.
- Do not promote conversation-derived knowledge directly. It must remain a candidate until reviewed/promoted; stale ideas and temporary discussion should not pollute authoritative Wiki.
- Before starting a new task, run `kata wiki orient` to refresh context.