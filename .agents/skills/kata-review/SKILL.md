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

Before doing task work, resolve the task and read its authoritative packet. `kata-cli status` reports the phase, the
next skill and the candidates; it is deliberately **light** and does not build task context.

**If the user already supplied an explicit task id, skip `status` entirely.** The id is the anchor, and `orient`
builds the one authoritative context:

```bash
kata-cli orient --change <change-id> --role <designer|implementer|reviewer|judge|distiller> --platform pi --task-kind <read|implementation|security>
kata-cli hooks activate --change <change-id> --role <designer|implementer|reviewer|judge|distiller> --platform pi
```

Otherwise discover the task first — `status` is enough to decide whether there is one candidate or a choice to put
to the user — and then run both commands above with the resolved values:

```bash
kata-cli status
```

Treat skill use as an interactive agent workflow, not a parameter-only command. First discover the active or
same-branch task and any relation redirects; if the task, role, task kind, or target platform is ambiguous, present concise options and ask the user to confirm or type a value. Do not make the user remember command-line flags. After
confirmation, run `kata-cli orient` with the resolved values, then read the returned task, state, context, required files,
guard instructions, relation redirects, and next skill before editing. Pass `--with-context` to `kata-cli status` only
when you want that projection without a packet. The hook activation links platform write hooks to the active Kata task so
phase/role scope is enforced while you work.

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

## Node contract

What this node consumes, produces, and asks. The input of a node is the **deterministic output of the previous node**,
not a summary of it: hand a reader the artefact itself, so the next node can be pointed at the same thing.

**Inputs**

- **the review request: each claim, its reading set, the evidence its tier requires, the deadline and the probes** — from `kata-verify` — `kata-cli ledger run --change <id> --out <path>`

**Outputs**

- **the structured review result returned by the subagent and recorded by the invoking Skill** — `kata-cli review --change <id> --result-file <path> → .kata/tasks/<id>/review.json`
- **the decision derived from the evidence** — `kata-cli ledger decide --change <id>`

**Interaction**

- **the judge's model is chosen on the host platform, and kata records only which choice was made** — `kata-cli gate approve --task <id> --boundary <implementation_gate|review_gate|judge_gate|archive_gate> --choice <continue_current|switched|delegated>`
## Independent review, on the evidence ledger

Both nodes below must answer to a **different context than the one that wrote the change**. The same context that
implemented a change shares its assumptions, its blind spots and its reading of its own evidence, so its own confirmation
is the weakest possible evidence that the change is sound.

What makes the pass independent is not a field in a record: it is that **every claim rests on evidence a verifier
re-executed**, and that the decision is derived from that evidence by a pure function rather than reported by the party
being judged. The ledger does not verify *who* wrote a claim, and it does not pretend to — `limits` in the approval
record says exactly that.

Do this:

1. Read what the ledger already decides, and what it cannot:
   ```bash
   kata-cli ledger status --cost --change <task-id>   # per claim: state, reasons, evidence, challenges, cost
   kata-cli ledger decide --change <task-id>          # pass | fail | insufficient, with the reasons
   ```
2. Issue the review request. It carries the claim's reading set, the evidence type and strength that claim requires, a
   numeric deadline, and the probes a reader must answer — and it deliberately carries no platform, session, model or
   receipt, because assurance is a separate axis:
   ```bash
   kata-cli ledger run --change <task-id> --out request.json
   ```
3. **Dispatch exactly one subagent with the ReviewRequest as its only payload.** The subagent receives the request file, reads no author-written brief, stays read-only on the code under review, and returns a structured result to this Skill. The Skill writes that result through the only result path:
   ```bash
   kata-cli review --change <task-id> --result-file result.json
   ```
   Do not launch a separate process or use a process fallback.
4. **A probe is not a quiz.** `ledger answer` records the command that was run and what it printed, and a probe is answered once — so a wrong answer cannot be retried until something passes. Answering from having read the revision is
   the only way to get them right:
   ```bash
   kata-cli ledger ask --change <task-id>              # the probes this ledger asks, derived from its own claims
   kata-cli ledger answer --change <task-id> --probe <id> --command "<what you ran>" --observed "<what it printed>"
   ```
5. **Record what you found as evidence, not as a claim about yourself.** A counterexample is a challenge the author has to
   answer, and it is recorded as one; it is withdrawn only when the ledger can see that it does not reproduce:
   ```bash
   kata-cli ledger challenge add --change <task-id> --claim <id> --command "<what reproduces it>" --fails-on <revision>
   kata-cli ledger challenge check --change <task-id>
   ```
6. **Never write the code under review.** A review that repairs what it reviews has replaced the judgement rather than
   informed it, and its evidence would be its own work. Report it; the author repairs it. When a check can only be
   falsified by a test that does not exist, report that as a gap rather than authoring the test here.

What the gate refuses, so the request can be satisfied rather than guessed at: an unreadable ledger is refused (written
and unparseable is not the same fact as never written); a verdict outlives its content, so a declared path that moved
after the decision refuses the approval and names it; and under the strict tier the assurance floor is `observed`, so
evidence nothing re-executed cannot carry it.## Skill automation contract

The Skill MUST run these commands itself. Do not ask the user to copy or type them unless the platform cannot execute shell commands.

Skill-first means the slash command is the agent interface and the CLI is the internal execution layer. The user may provide no task id, a natural-language task hint, or only "continue"; the Skill must discover candidates and ask for a short confirmation only when needed.

1. Run `kata-cli status` to read the active or current-branch discovered task, its relation redirects, the phase and
   the next skill. Status is light: it reports the dispatch decision, not task context — step 4's `orient` is the
   packet that carries `task`, `state`, `requiredReads` and `context`. **When the user supplied an explicit task id,
   skip this step and go straight to step 4.** Do not add `--with-context` here; the packet already carries it.
2. Do not require the user to pass parameters. Resolve the task id from active task, same-branch task, relation redirects, or the `recommended` task/action from `kata-cli status` or `kata-cli collect`. If multiple plausible tasks remain, show concise options and ask the user to choose or type a value.
3. Resolve role and task-kind from phase and user intent; if ambiguous, present recommended options and ask for confirmation. Do not default across trust boundaries without confirmation.
4. Run `kata-cli orient` without `--change` when using the active/single discovered task, or with `--change <id>` after the user confirms a task id. Parse its relation redirects, handoff id, state, task, requiredReads, nextAction, and context fields.
5. Run kata-cli handoff verify for that id; stop on an invalid result.
6. Read every requiredReads path from the packet.
7. Run kata-cli handoff acknowledge with platform pi and the current role.
8. Run this Skill's phase command and collect normal evidence. The next phase creates a fresh packet.
9. After the phase command returns, read `completion.userMessage` first, then `nextAction.slashCommand`, `nextAction.cliCommand`, `recommended.reason`, and `askUser` from the command result. Always tell the user the current phase and the next recommended operation. For every successful phase command—especially `/kata-build <task> --seal`—the final user-facing response MUST end with `completion.userMessage` verbatim. This is not optional: never finish with only a test summary, and never wait for the user to ask “what next”. If `completion` is absent, explicitly render the current phase and `nextAction.slashCommand`. Prefer the slash command, for example `/kata-verify <change-id>`; show the CLI command only as fallback.
10. Stop after this Skill's own phase command. A Skill invocation has exactly one phase-command authority: Build may invoke only `kata build`; it MUST NOT invoke verify, review, judge, archive, or any other `/kata-*` command after Build returns. The same rule applies to every phase Skill: render its next action for the user, then end the invocation. If the returned `nextAction.requiresUserConfirmation=true`, do not invoke the next /kata-* skill. At model trust boundaries, wait for the user to use the host platform's own selector before continuing.

Do not record ledger evidence for read-only search, explanation, or orientation-only work: a claim nobody made does not
need evidence, and a verdict is only required for the claims a change declares.

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

