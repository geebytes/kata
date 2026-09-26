---
name: kata-review-round
description: The standing procedure for one independent review round. Use when a round is dispatched by hand rather than through a declared executor, or when a reviewer session needs to know what kind of work a round is.
---

# /kata-review-round

platform: pi

## Response language

所有面向用户的自然语言响应必须使用中文。代码、命令、文件路径、API 名称、日志和协议字段可以保留原文。

# /kata-review-round

The standing procedure for one review round. It carries only what a brief cannot, because the brief is rendered per round and
owns every value in it.

## The brief is the whole instruction set

Read it in full before anything else, and read what it tells you to read and nothing more. It states the record's shape, the
conditions the gate applies and the remit under review; this skill deliberately restates none of them, because a rule kept in two
places drifts from the one that is enforced.

**Prefer a declared executor over a hand-written dispatch.** `kata-cli adversarial execute --executor "<command>"` hands the
brief to the session as its prompt, reads the events the round emits, and writes the receipt itself — one channel, no prompt to
reconstruct. The hand-dispatched route exists for platforms without an executor, and it is the route that has produced the failures
this skill is written against.

## Emit early, then improve

Put a first complete record down as soon as you have findings, then keep working. The last record you emit is the record, an
earlier one costs nothing, and a thorough investigation that emitted nothing has produced nothing. Measured on this repository's
own rounds: **28 of 62 produced no record at all**, and the rounds that ran longest wrote the least.

## What a round is not

- **It is not a repair.** A finding is a claim about a place in the code, with what would show it wrong and how far a fix would reach. No
  fix recipe is expected: designing the fix would make this round the change's second author, and duplicate the blind spot it exists to
  escape. (The brief names the fields; this skill does not, because a rule kept in two places drifts from the one that is enforced.)
- **It is not a survey.** The brief names the paths under review. Reading past them spends the round's budget on material nobody
  asked about — measured, a session given a pointer to a two-sentence brief instead of the text explored an entire repository and
  produced nothing.
- **A negative result is a result.** "The mechanism holds under these conditions" is worth recording, and it is not the same claim
  as "I found nothing".

## Invocation

`kata-cli adversarial execute --change <change-id> --node review --packet <packet.json> --executor "<command>"`

```json kata-command-manifest
{
  "id": "kata-review-round",
  "slashCommand": "/kata-review-round",
  "cli": "kata-cli adversarial execute --change <change-id> --node review --packet <packet.json> --executor \"<command>\"",
  "summary": "The standing procedure for one independent review round. Use when a round is dispatched by hand rather than through a declared executor, or when a reviewer session needs to know what kind of work a round is."
}
```
