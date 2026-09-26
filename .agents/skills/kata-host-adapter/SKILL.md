---
name: kata-host-adapter
description: How to declare an executor for a platform, so an independent review round can be certified on it. Use when a strict or security change reports executor_unavailable, or when writing a host command for a new platform.
---

# /kata-host-adapter

platform: pi

## Response language

所有面向用户的自然语言响应必须使用中文。代码、命令、文件路径、API 名称、日志和协议字段可以保留原文。

# /kata-host-adapter

How to declare an executor for `kata-cli adversarial execute` on your platform. This is the operator's half of the round protocol;
the protocol's own definition is `schemas/round-events.schema.json`, and the reviewer's half is the brief.

## The split

**Kata runs the command, reads the events it emits, counts the round, refutes any capability the stream contradicts, decides the
status, and writes the receipt.** The host launches and describes — nothing else. In particular it does not write a receipt: a
receipt kata did not write has no watched run behind it, and `adversarial record` refuses it.

## What a host must do

1. **Read `$KATA_REVIEW_PACKET`** — a request and the brief the session must be given. Hand the session the **text** of the
   brief, not a path to it: measured, a session given a pointer to a two-sentence brief spent 46 tool calls and 961,381 tokens
   exploring a repository the brief never mentioned.
2. **Launch an isolated session** with your platform's own flags, and make the isolation true rather than asserted — a new process
   or context, and a tool allow-list the platform itself enforces. A prompt that asks the session not to write is not a capability.
3. **Emit one JSON object per line on stdout, in order, and nothing else:** `launched` first, carrying `protocol` and the
   capabilities you actually provide; then `tool_call`, `output` and `telemetry` as they happen; then `result` with the
   reviewer's record verbatim; then `ended`.
4. **Exit.** Kata reads the stream; any other artefact you write is not read.

## Declare only what you provide

`read_only_fs` is refuted by a single mutating tool call in the stream, and `bounded_tools` by a tool outside the node's
allow-list. A claim the stream contradicts refuses the round, and a session that produced no result is refused whatever you report —
so the honest declaration is also the one that passes. That is the point: a capability you can only assert is the self-report the
contract was written to replace.

## Invocation

`kata-cli adversarial execute --change <change-id> --node review --packet <packet.json> --executor "<command>"`

```json kata-command-manifest
{
  "id": "kata-host-adapter",
  "slashCommand": "/kata-host-adapter",
  "cli": "kata-cli adversarial execute --change <change-id> --node review --packet <packet.json> --executor \"<command>\"",
  "summary": "How to declare an executor for a platform, so an independent review round can be certified on it. Use when a strict or security change reports executor_unavailable, or when writing a host command for a new platform."
}
```
