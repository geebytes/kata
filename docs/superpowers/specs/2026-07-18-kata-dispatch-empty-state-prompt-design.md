# Kata Dispatch Empty-State Prompt Design

## Goal

Make the human-facing `/kata` Skill respond conversationally when `kata status` finds no active or same-branch task, without changing the CLI's structured JSON contract.

## Design

The deterministic CLI continues to return its existing dispatch payload:

- `phase: "dispatch"`
- `candidates: []`
- `recommended: null`
- `nextAction: null`

The `/kata` Skill treats that exact state as an empty-task interaction, rather than displaying raw diagnostics or asking the user for a task id. It responds:

> 当前分支没有活跃的 Kata 任务。你想开启什么工作？请用一句话描述目标，例如“修复登录超时”或“新增导出功能”。

When the user supplies a natural-language goal, the Skill invokes the `/kata-open` interaction flow. That flow first explains and confirms isolation, development, and review modes, then invokes `kata open` with all three explicit flags.

## Boundaries

- Do not change the `kata status` JSON schema or field values.
- Do not create a task from the empty-state response.
- Do not ask the user for `taskId`, `change id`, or CLI flags.
- Existing candidate and recommended-task prompts remain unchanged.

## Tests

Update manifest/golden tests for the generated `/kata` Skill instructions to assert the empty dispatch state is rendered as the natural-language prompt and routes the next user response to `/kata-open`.

