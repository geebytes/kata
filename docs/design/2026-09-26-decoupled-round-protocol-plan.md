# Technical plan: the decoupled round protocol

**Companion to** `docs/design/2026-09-26-decoupled-round-protocol.md` (the design and its rationale). This document is the *how*: the
protocol, the module layout, the exact predicates, what each refusal says, what reddens when, and the acceptance criteria a governed
change would carry.

---

## 1. Module layout

| path | what it owns | why there |
|---|---|---|
| `src/quality/round-protocol.ts` | the event vocabulary and a parser: one line → one typed event, or a refusal with the line number | a data contract; the only thing a host must satisfy |
| `src/quality/round-runner.ts` | enforcement, accounting, capability falsification, receipt construction, status derivation | this is the logic that makes a receipt mean something, so it belongs where it is versioned and tested once rather than copied per host |
| `schemas/round-events.schema.json` | the line schema, with a unique `$id` (the bundled-schema invariant) | one definition, so a second host's parser and kata's cannot drift |
| `src/cli/ops.ts` (`adversarial execute`) | launches the command, feeds stdout lines to the runner, writes the receipt | the receipt's author becomes kata |
| `host/pi-adapter.ts` | launches a pi session, maps its JSONL onto the event kinds, nothing else | all platform coupling, one file, outside `src/` |
| `host/executor.ts` | **deleted** or reduced to the protocol's prose | its logic moves to `src/quality/round-runner.ts`; a reference with one implementation is what host authors copy and drift from |

`src/` still never imports `host/`, and the test that asserts it stays.

---

## 2. Protocol v1

### 2.1 The interface

```bash
KATA_REVIEW_PACKET=<path>       # the packet: { request, brief }
KATA_REVIEW_PROTOCOL=1          # the version kata speaks; a host that does not know it must fail rather than guess
kata-cli adversarial execute --change <id> --node review --packet <p> --executor "<cmd>" [--receipt-out <p>]
```

**Corrected after the audit** (`2026-09-26-decoupled-round-protocol-conflicts.md` G1): the variable the host is **no longer handed** is `KATA_REVIEW_RECEIPT` — it used to be where the host wrote the artefact. `--receipt-out` stays and now names where **kata** writes the receipt it derived. The `--receipt-file` flag belongs to `adversarial record` (the operator hands kata the receipt) and is **unchanged**; an earlier draft of this plan declared it deprecated, which was a factual error: it is how a receipt reaches a record at all.

The host's entire job: **write one JSON object per line on stdout, in order, and exit.** Nothing else it writes is read.

### 2.2 The events

```ts
export type RoundEvent =
  | { kind: 'launched'; protocol: number; capabilities: ExecutorCapability[]; platform?: string; sessionId?: string }
  | { kind: 'tool_call'; tool: string; target?: string }
  | { kind: 'output'; bytes: number }
  | { kind: 'telemetry'; tokens?: number | null; truncations?: number | null }
  | { kind: 'result'; text: string }
  | { kind: 'ended'; status: 'completed' | 'budget_exhausted' | 'timeout' | 'cancelled'; reason?: string };
```

Rules the parser enforces, each with its refusal:

| rule | refusal |
|---|---|
| the first line is `launched`, exactly once | `round_protocol_error` — *"the first line was `<kind>`, not `launched`"* |
| `launched.protocol` equals kata's version | `round_protocol_error` — *"this host speaks protocol N, kata speaks 1 …"* |
| every subsequent line parses and its `kind` is known | `round_protocol_error` — *"line 17 is not a protocol event: `<first 60 chars>`"* |
| no line follows `ended` | `round_protocol_error` — *"line 22 followed `ended`"* |
| `result` appears at most once | `round_protocol_error` |
| a line longer than 32 MB | `round_protocol_error` — a bound so a host cannot buffer kata out of memory |

A `result` line carries the whole record as JSON-escaped text, so it can be tens of kilobytes; the parser does not cap line length below the
bound above, because **the brief once shipped as one 125 KB line and every reviewer tool refused to open it** — the same mistake must not
appear one layer down.

### 2.3 What the host must not do

* **Write a receipt.** The host is not handed `KATA_REVIEW_RECEIPT` at all. A host that still writes to the path it used to be given produces a
  file nothing reads, and one that reports a status by writing it there has reported nothing — which is the honest failure mode: the artefact is
  no longer a channel, so a stale host cannot be mistaken for a current one.
* **Claim a capability it cannot demonstrate.** See §3.
* **Report a status kata has not derived.** `ended.status` is recorded as the host's own report; kata's derivation wins, and a disagreement
  is preserved in the receipt as `hostReported`.

### 2.4 The execution registry — what makes *"kata wrote it"* checkable at admission

Found by the audit (`…-conflicts.md` G2), and without it the redesign buys nothing at admission: a hand-written receipt would pass the same
binding and capability checks a kata-written one does.

* **`execute` records the run** in the task store — `runId`, `requestSha256`, the derived status, the counts, the refusals — before it exits.
  This is the same store-of-record shape the falsifier ledger already uses for dispositions, and it is written by the command that observed the
  run rather than by the party being certified.
* **`record` requires the receipt's `runId` to appear in that registry as a completed run.** A receipt with no executed run behind it is refused
  by name, whatever else validates about it.
* **The registry is append-only and never rewritten**, so a later re-run cannot retroactively legitimise an earlier artefact.

This does not make forgery impossible — the schema's own sentence stands: *"authorship separation is process and tool policy, not
cryptography"*. It makes an unexecuted receipt **refused rather than plausible**, which is the strongest claim available here and one kata can
actually check.

---

## 3. Capability falsification, exactly

| capability | predicate kata evaluates on the stream | on failure |
|---|---|---|
| declared at all | `required ⊆ launched.capabilities` | `executor_unavailable`, naming the missing ones |
| `read_only_fs` | no `tool_call` names a mutating tool: `{write, edit, bash, shell, patch, apply_patch, notebook}` | `capability_refuted`, naming the call |
| `bounded_tools` | every `tool_call.tool` is in the node's allowlist — the packet's implied set, `{read, grep, find, ls}` for both nodes | `capability_refuted`, naming the tool |
| `budget_enforced` | kata counts tool calls, bytes and wall clock itself and stops the round; the host's cooperation is not required | kata's stop is the enforcement |
| `fresh_context` | **recorded, not gated** in v1: the first `telemetry` line's `tokens`, if the host reports one, is stored on the receipt as `firstTurnTokens` | none — a threshold nobody has calibrated would be a rule that is wrong most of the time, and stating that is better than inventing one |

`read_only_fs` and `bounded_tools` share a shape but are not one predicate: an allowlist can be bounded and mutating (a node that permits
`bash` under a budget). For this node the allowlist happens to be read-only, which is why both are evaluated rather than one standing in for
the other.

---

## 4. Kata's status derivation

Evaluated in order; the first that applies is the round's status, and the receipt is written only for `completed`.

| # | condition | status | receipt |
|---|---|---|---|
| 1 | the stream is malformed (§2.2) | `executor_unavailable` | none |
| 2 | `launched` absent, or a required capability missing | `executor_unavailable` | none |
| 3 | a capability refuted by the stream (§3) | `executor_unavailable` | none |
| 4 | tool calls, output bytes or hypotheses exceed the packet's envelope | `budget_exhausted` | none |
| 5 | the wall clock exceeds `budget.maxWallMs` | `timeout` | none |
| 6 | no `result` event | `executor_unavailable` | none |
| 7 | otherwise | `completed` | **written by kata** |

**Every path but 7 writes no receipt**, which is today's rule (`aad-r7-f4`) raised from *"the session produced no result"* to *"kata watched the
whole round and this is what it saw"*.

**And this relocates a decision, which the audit flagged as the strongest objection to the whole design** (§4 of the audit document). The prior
design put enforcement outside kata deliberately: *"Kata does not decide how a session is isolated — the command does — and that is what keeps a
change to kata from loosening the envelope it certifies."* Under this plan a kata change *can* loosen it. Three things answer that, and the third
decides it: kata already owns the envelope's numbers (the packet's budget is derived from `MEASURED_REVIEW_PASS_COST` × `REVIEW_HEADROOM`; the
executor only obeyed them); the reason enforcement lived outside was that kata could not *observe*, which is precisely what a stream changes; and
**the control against loosening already exists** — `tests/unit/review-budget-envelope.test.ts` asserts every limit sits above the cost the recorded
passes actually incurred, so widening the envelope requires lowering a limit below its measurement, which that test refuses.

```ts
// what kata writes, and all it writes
{ runId, requestSha256, capabilities, startedAt, endedAt, telemetry, status, … }
// capabilities: what the host launched with, minus anything refuted (empty in practice, since a refuted claim refuses the round)
// telemetry:    counted by kata (toolCalls, outputBytes) + declared by the host (tokens, truncations) — null where unmeasured
// executor:     copied from `launched` (platform, sessionId) — kata has no platform of its own to name
```

---

## 5. `adversarial execute`, concretely

The streaming comes free: `runProcess` already takes `onOutput(chunk)`, so no new spawn helper is needed.

```ts
const parser = createRoundParser({ protocol: KATA_REVIEW_PROTOCOL, allowlist, requiredCapabilities: request.requiredCapabilities });
const run = await runProcess('sh', ['-c', executor], {
    cwd: root,
    env: { ...process.env, KATA_REVIEW_PACKET: packetPath, KATA_REVIEW_PROTOCOL: String(KATA_REVIEW_PROTOCOL) },
    timeoutMs: request.budget.maxWallMs + 30_000,
    onOutput: ({ stream, text }) => { if (stream === 'stdout') parser.feed(text); },
});
const outcome = parser.finish({ exitCode: run.exitCode, signal: run.signal, exitedAt: Date.now() });
if (outcome.receipt) await writeFile(receiptOut, JSON.stringify(outcome.receipt, null, 2));
```

The parser splits chunks on `\n` and keeps the remainder, so a line split across two chunks is one event. `finish()` applies §4 in order and
returns either a receipt or a refusal with a reason and the offending line.

---

## 6. Skills

Both are generated from `src/adapters/manifest.ts`, like every other skill in this repository, and neither may restate a per-round value —
the brief owns those.

### `kata-review-round` (the reviewer's standing procedure)

The meta-instructions that are **not** round-specific: your brief is the whole instruction set; read it in full first; persist as you go; **emit
a record as soon as you have findings and improve it afterwards**; the last record is the record; a thorough investigation that emitted
nothing has produced nothing. It deliberately does **not** list the record's fields or the gate's conditions: those are rendered into each
brief by kata, and restating them here would be the second derivation of a rule the brief already owns — which is measured as the reason 28
rounds produced nothing while a dispatch prompt carried the missing requirement by hand.

### `kata-host-adapter` (the operator's procedure)

How to implement an executor for any platform: launch an isolated session with that platform's own flags; map its stream onto the six event
kinds; declare only the capabilities actually provided; write no receipt; never report a status you did not derive. Its reference is §2 and
the schema, not a file to copy.

---

## 7. Migration

| step | change | what it breaks, and for how long |
|---|---|---|
| 1 | `round-protocol.ts` + `round-runner.ts` + the schema, with tests | nothing |
| 2 | `execute` switches to the stream, records the run in the registry, and writes the receipt; the four landed statements the audit lists (`schema:254`, `review-execution.ts:13` and `:119`, `ops.ts:467`) are corrected in the same step, and `review-execution-receipt.test.ts`'s two premises move (audit T2, T3) | `host/run-round.ts` stops working — the window between steps 2 and 4 |
| 3 | the capability-refutation checks | nothing |
| 4 | `host/pi-adapter.ts` rewritten as a streamer; `host/run-round.ts` deleted; `host/executor.ts` reduced to prose; `host-executor.test.ts`'s twelve cases move into `src/` (audit T1) | nothing |
| 5 | the two skills generated | nothing |
| 6 | `/kata-open` with §8 as acceptance criteria | — |

Steps 2 and 4 land in one commit so the window never exists outside it.

---

## 8. Acceptance criteria for the governed change

1. **`execute` writes the receipt from the stream.** A run whose host also supplies `--receipt-file` is refused with `receipt_file_deprecated`
   naming the protocol, and no receipt is written from that file.
2. **A capability the stream contradicts is refused.** A `tool_call` naming `write` under a declared `read_only_fs` produces
   `capability_refuted` naming the call, and no receipt. Mutation: removing the predicate reddens the case.
3. **A stream that ends without `result` produces no receipt,** whatever the host's `ended` says. Mutation: accepting `ended` as the
   conclusion reddens the case.
4. **Kata's count wins over the host's report.** A host that ends `completed` after exceeding the tool budget produces `budget_exhausted`
   with kata's count, and its own status is preserved as `hostReported`.
5. **The protocol is one versioned definition.** `schemas/round-events.schema.json` has a unique `$id`, every event kind in
   `round-protocol.ts` appears in it, and a host declaring another protocol version is refused by name.
6. **A receipt with no executed run behind it is refused.** `execute` records the run; `record` refuses a receipt whose `runId` is not in that
   registry as a completed run, and the refusal names the registry. Mutation: dropping the lookup reddens the case.
7. **The adapter holds no enforcement.** `host/pi-adapter.ts` contains no receipt construction and no budget arithmetic, asserted by a test
   over its source; the only capability text in it is the declaration it makes about what it launched.

---

## 9. Risks and open questions

| risk | why it is acceptable, or what would close it |
|---|---|
| the round's output arrives as one long `result` line | bounded at 32 MB and JSON-escaped; measured against today's largest record (45 KB) it is four orders of magnitude of headroom |
| a host that hangs without emitting | the wall clock still terminates it (`timeoutMs`), and a round with no `result` writes no receipt |
| kata now holds the enforcement logic, so a bug there weakens every host at once | that is the trade for one implementation instead of N copies, and it is where the test suite already lives |
| `fresh_context` remaining ungated | stated in §3 as a recorded measurement rather than a rule; a calibrated threshold would need a second host's data first |
| **open:** does `capabilities` still mean anything once kata has refuted it? | proposal: keep the field, and have the receipt carry the *declared* set only when nothing was refuted (which is the only case a receipt exists), so the field stays a fact rather than a claim |
| **open:** should the receipt record the host's `ended.reason`? | proposal: yes, under `executor.reason`, because a host's own account of a `budget_exhausted` is evidence about the host, and it costs one field |
