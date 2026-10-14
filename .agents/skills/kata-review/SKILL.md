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
   numeric deadline, and the questions the reader is asked — `probes`, plus `withheldProbes` when the ledger holds
   questions bound to another revision. **Only `probes` is an obligation**: a withheld question is history that cannot
   describe the content under review, so the request does not hand it over and its presence is not a finding. A request with
   `probes: []` and a populated `withheldProbes` is complete. And it deliberately carries no platform, session, model or
   receipt, because assurance is a separate axis:
   ```bash
   kata-cli ledger run --change <task-id> --out request.json
   ```
3. **Dispatch exactly one subagent with the ReviewRequest as its only payload.** The subagent receives the request file, reads no author-written brief, stays read-only on the code under review, and returns a structured result to this Skill. The Skill writes that result through the only result path:
   ```bash
   kata-cli review --change <task-id> --result-file result.json
   ```
   Do not launch a separate process or use a process fallback — but **do check that the subagent can start at all**, because
   a fresh context is a fresh process and it does not inherit everything this one has:

   - **A model provider that this session registered at startup is not visible to the new context.** Where the default
     model comes from such a registration, a dispatch fails with a message like `Model "<provider>/<model>" not found` —
     which reads like a typo and is not one. Give the new context the registration explicitly, or pick a model it can
     resolve on its own. How a platform expresses that is that platform's business; what matters here is that the round
     comes back, because **a round that never started is not a round**, and a finding that never arrived is not a pass.
     If neither is possible, say so and stop rather than reporting the round as done.
   - **The same is true of anything else this session registered at startup** — skills, hooks, providers. A new context's
     capabilities are the ones you hand it, not the ones you happen to have.

   Kata records none of this: the request carries no platform, session or model, and how the round was launched is
   organizational process rather than a checked criterion. The check above is about the round existing, not about what
   kata believes about it.
4. **Answer the questions the request handed you, and only those.** `ledger answer` records the command that was run and
   what it printed, and a question is answered once — so a wrong answer cannot be retried until something passes. Answering
   from having read the revision is the only way to get them right. The request's `probes` is the list; a question it
   withheld asks about another revision and is not yours to answer, and `ledger ask` reporting nothing new is not a gap:
   ```bash
   kata-cli ledger answer --change <task-id> --probe <id> --observed "<what it printed>"
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

7. **An empty question list is a complete request, and the review is still yours to do.** `probes: []` means the ledger has
   no questions for this round — not that the round has nothing to do. The work below is the review itself, and it does not
   wait on a question: reproduce the declared checks, attack them, and record what you found. A round that returns without a
   single measurement has not reviewed anything, and a request whose `probes` is empty is not a finding about the request.
8. **Audit the falsifiers you are handed; do not merely reproduce them.** A declared check is a claim about the code, and the
   claim has been false in three different ways in three rounds: a mutation that did not parse, so every test in the file
   reddened for a reason unrelated to the mechanism; a mutation whose red came from a precondition instead of the comparison
   it names; and a mutation that stayed **green** because the fixture never carried the kind of input it filtered. For each
   declared selector ask: does the mutation parse, does it redden for the reason it claims, and does a *legal* equivalent of
   the same mechanism also redden? A selector that survives a mutation of the property it names is a finding about the
   selector, not a passing check.
9. **Attack both sides of every comparison, and the kinds it carries.** Where a guard compares two derivations, the reference
   can be the side that drifts: a filter applied to the reference alone keeps the guard green while the two disagree. And a
   comparison is only as strong as the kinds its fixture holds — a per-extension, per-size or per-depth filter hides in any
   kind the fixture lacks, so list the kinds the guard does not carry; that list is the finding.
10. **The ledger's own decision is not your verdict.** A counterexample that lives in a path or a call shape cannot be
    expressed as a challenge, so the decision can report a pass while the change still has the defect you just reproduced.
    Report the counterexample as a finding and state the two separately; never soften a reproduced defect into a note because
    the mechanical decision disagreed with you. The reverse also holds: a decision that reports `insufficient` because no
    independent reading exists yet is describing **this round's own absence**, not a defect in the change — the round exists
    to produce that reading, so reporting it as a blocking finding inverts the obligation.
11. **Run readings one at a time, and check the tree after each.** Verifying a falsifier injects the mutation into the real
    checkout and restores it, so two runs at once read each other's injection and can leave the defect behind. Serial is the
    only correct order, and the repository's status after each run is how you know the tree came back.
12. **Name the revision you reviewed.** A result is recorded against the revision that was current when it was written, which
    is not necessarily the one you read. State, in the result itself, which revision your readings apply to.

## Recurrence circuit breaker

When the ReviewRequest carries `recurrencePacket`, this is **not** an ordinary certification round. The packet is emitted only when a mechanizable defect class reappears across more than one recorded round and at least one occurrence is inside a prior repair.

1. Start with the packet's `rounds` and its three `sources` (`review-rounds.jsonl`, `review-history.jsonl`, and the active `review.json`). Reconstruct the sequence of finding → repair → later finding from those records before judging the current implementation. Do not trust the author's prose as the history.
2. Classify the recurrence before proposing another local repair: choose exactly one root-cause conclusion — a real behaviour defect, an unsound instrument, a claim whose subject exceeds what its evidence can decide, a workflow route that cannot execute, or a demonstrated non-recurrence. State the concrete record and source lines that distinguish that conclusion from the alternatives.
3. If the cause is a real defect, instrument or route, report the **class-level** repair and the smallest counterexample. If it is claim scope, identify the narrower branch/derivation/value that the declared falsifier can actually decide. Do not expand the normal review surface or add another hand-written exception list merely to make this round pass.
4. Return the normal structured findings plus a `recurrenceAnalysis` object containing the trigger classes, the root-cause conclusion, the supporting record references, and whether the next action is `repair`, `restate_claim`, or `resume_certification`. A result that omits a root-cause conclusion when the packet was present is incomplete.
5. Do not recommend another ordinary certification round until the recorded root cause has been repaired or the packet has shown that the findings are not one class. The circuit breaker changes the *kind of review*, never the strict gate or the requirement to independently certify the resulting repair.

What the gate refuses, so the request can be satisfied rather than guessed at: an unreadable ledger is refused (written
and unparseable is not the same fact as never written); a verdict outlives its content, so a declared path that moved
after the decision refuses the approval and names it; and the assurance floor is `observed` under `strict` **and** under
`security` — the platform owns execution isolation, so no tier asks Kata for a sandbox — while `security` still asks
for two independent reviewers, always-quorum and the privilege/provenance risk classes, so evidence nothing re-executed
cannot carry either tier.## Skill automation contract

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

