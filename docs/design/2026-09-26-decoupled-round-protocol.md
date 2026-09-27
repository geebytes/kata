# Decoupling the review round from the host platform — a skills-first redesign

**Status:** active design, not yet a governed change. Builds on `docs/design/2026-09-21-adversarial-execution-control-optimization.md`
§3.2.1, which specified the capability contract and left the host executor unimplemented; the executor now exists
(`host/executor.ts` + `host/pi-adapter.ts`, `host/run-round.ts`) and this document is what the first real runs taught about it.
**Evidence:** two certified rounds of `adversarial-admissibility` on 2026-09-25/26 (`revision-5db843a10894a7aa`,
`revision-abb103276cf43b90`), the coupling inventory in §1, and the two blocking findings those rounds returned about the adapter itself.

---

## 0. The rule this design is organised around

> **A skill may carry an instruction. A skill may never carry a fact about the host.**

The receipt exists because of one measured sentence in the schema:

> *"`executedInFreshContext` was a boolean the agent wrote about itself … a context the agent describes as fresh **is not a capability**."*

A skill is spoken by the session. The receipt's entire content is *"the host says this run was isolated, bounded and measured"*. So the
substitution "skill for adapter" is not a weaker option — it is the exact regression the contract was written to close, and §4 is where that
rule lands rather than where it is argued.

---

## 1. Where the coupling is today, measured

**Kata's side is neutral and says so in four places.**

| Fact | Evidence |
|---|---|
| the request carries no platform | `ReviewRunRequest` = `runId · requestSha256 · node · revisionId · manifestHash · briefSha256 · reviewIrSha256 · candidateFreezeSha256 · budget · requiredCapabilities · resultSchemaVersion` |
| the capability vocabulary is neutral | four names; the implementation half is explicitly *"the host platform, outside this repository"* |
| the receipt's host field is free text | `ReviewExecutionProvenance.platform: string` — deliberately not an enum, unlike the **skill-install** layer's `PlatformDefinition { id: Platform; skillsDir; … }`, because a skill file must land in a directory and a receipt must not be checkable against a list of blessed platforms |
| the executor is opaque | `execute` runs `sh -c <declared command>` with two env vars and a timeout; *"kata does not decide how a session is isolated — the command does"* |
| the boundary is asserted, not promised | a test walks `src/` and fails if anything imports `host/`, because *"if kata could call it, the authorised party would be producing its own independence evidence"* |

**The host side is coupled in exactly one file**, and that is the whole inventory: the binary (`spawn('pi', …)`), the flags
(`--mode json`, `--no-session`, `--tools`), the model default, the JSONL event shapes, and the capability list.

**But the coupling that matters is not the binary — it is this: the host writes the receipt.** Everything else a host supplies is an
input; the receipt is the *output the gate believes*. Today it is produced by `host/run-round.ts` from a runner that lives in `host/`
as a **reference with one implementation**, so:

1. the party whose independence is in question authors the artefact that certifies it, within the policy limits the schema admits;
2. the runner's envelope logic — the part that makes a receipt mean something — is a file each host is invited to copy, which is how
   single-implementation contracts drift;
3. a capability claim is unfalsifiable in practice: the constant `['fresh_context','read_only_fs','bounded_tools','budget_enforced']`
   was returned for a process that never started, and the adapter still called the round `completed` — the blocking finding
   `aad-r7-f4` from the first round this flow ever executed.

---

## 2. The redesign's one structural move: **the host streams, kata judges and writes**

```text
TODAY
  kata ──packet──▶ host command ──spawn──▶ session
                      │  counts events, enforces the envelope,
                      │  writes the receipt        ← the host authors the artefact
                      ▼
                   receipt ──▶ kata reads it as evidence

PROPOSED
  kata ──packet──▶ host command ──spawn──▶ session
                      │  launches, maps the platform's stream to a neutral vocabulary,
                      ▼  and writes NOTHING but that stream
  kata ◀──NDJSON events──────────┘
    ├─ counts tool calls, output bytes, hypotheses, wall clock   ← enforcement, in kata
    ├─ falsifies the capability claim against the events          ← §3
    └─ writes the receipt from what it observed                   ← the artefact kata can name
```

**Why this is the decoupling and not a refactor.** The host's contract shrinks from *"launch, observe, enforce, and certify"* to **"launch
and describe"** — two things a platform's own launcher can do without knowing anything about kata's gates. The enforcement, the accounting
and the receipt move into `src/`, where they are one implementation, versioned, and tested by the suite rather than copied per host.

**What the host protocol becomes** (a data contract, not a TypeScript interface a host must import):

```jsonc
// one JSON object per line on the executor's stdout, in order
{"kind":"launched","protocol":1,"capabilities":["fresh_context","read_only_fs","bounded_tools","budget_enforced"],"platform":"pi"}
{"kind":"tool_call","tool":"read","target":"src/quality/adversarial.ts"}
{"kind":"output","bytes":4096}
{"kind":"telemetry","tokens":null,"truncations":null}     // what only the host can observe; absent means unmeasured
{"kind":"result","text":"{…the record…}"}
{"kind":"ended","status":"completed"}
```

That is the entire host-facing surface: six event kinds, no TypeScript, no import, no copy of a runner. `.ts`, `.mjs`, `.sh`, or a
platform extension can emit it.

---

## 3. Capability claims become falsifiable by the stream

With kata observing, a claim stops being a statement and becomes a proposition a check can refute:

| capability | how kata refutes a false claim, from the stream alone |
|---|---|
| `read_only_fs` | any `tool_call` naming a mutating tool (`write`, `edit`, `bash`, a redirect) ⇒ **refused**, and the refusal names the call |
| `bounded_tools` | any `tool_call` outside the allowlist the packet's node implies ⇒ **refused**, naming the tool |
| `budget_enforced` | kata enforces it itself now — it has the stream, the clock, and the ability to signal the process |
| `fresh_context` | **partial, and stated as partial** (§6): a session that started with no inherited transcript reports its first turn's input at the brief's order of magnitude; a session handed a conversation reports an order of magnitude more. A proxy, not a proof |

So three of the four move from *"the host says so"* to *"the stream says so"*, and the fourth is narrowed to a measurement with its ceiling
written down — which is the standard this repository applies everywhere else.

---

## 4. Skills-first: which half of the flow is a skill

Two audiences, two generated skills, and the boundary in §0 decides what may go in each.

### 4.1 `kata-review-round` — the reviewer's half (instruction)

What a session inside a round does: read the brief in full; treat it as the whole instruction set; persist as it goes; **emit a record early
and improve it**; the record's required fields; the five gate conditions the brief states; the rule that every criterion the revision changed
must be claimed by some hypothesis's `targets`.

This is instruction, and today it is spread across **three** channels — the brief (kata-rendered), the host prompt inside `host/pi-adapter.ts`
(a literal), and whatever the operator writes in the dispatch — which is precisely why 28 rounds produced nothing while a dispatch prompt
carried the missing requirement by hand. A skill gives it one home, per platform, generated like every other skill in this repository
(`src/adapters/manifest.ts`), so it cannot drift from the brief it is meant to serve.

### 4.2 `kata-host-adapter` — the operator's half (procedure)

How to implement an executor for *any* platform: launch an isolated session with this platform's own flags; map that platform's stream onto
the six event kinds; declare capabilities **truthfully and only the ones actually provided**; write no receipt; and never let a session that
produced no result look completed. Its reference is the protocol in §2, not a file to copy.

### 4.3 What does *not* become a skill

The capability semantics, the envelope, the binding, the receipt, the gate and the refusals. Those are facts and rules the flow *enforces*;
a skill that restates them would be the second derivation of a rule the code already owns — the class this repository has removed eleven times.

---

## 5. Migration, in the order the dependencies allow

| # | step | why this order |
|---|---|---|
| 1 | Move the runner into `src/quality/round-runner.ts` and define the NDJSON protocol in `src/quality/round-protocol.ts` with a schema | the enforcement must be kata's before a host can be asked to stop writing the receipt |
| 2 | `adversarial execute` reads the stream, enforces, and **writes the receipt itself**; a host that writes one is ignored, and the protocol's `ended` line is the only summary kata accepts | one artefact, one author |
| 3 | Add the capability-falsification checks of §3, each with a case that reddens when a host claims what its stream contradicts | a claim without a check is the defect `aad-r7-f4` found |
| 4 | Rewrite `host/pi-adapter.ts` as a ~60-line streamer; keep or delete `host/executor.ts` as documentation | proves the protocol is implementable without the reference's logic |
| 5 | Generate the two skills (§4) from `src/adapters/manifest.ts` | they must be generated like every other skill, or they drift |
| 6 | Open the governed change (`/kata-open`) with these as its acceptance criteria | per the repository's own contract, design precedes a governed change |

**What migration costs:** `execute` grows a stream parser and the receipt writer; the protocol needs a version and a schema; the existing
`host/executor.ts` tests move into `src/`. **What it buys, measured where it can be:** the receipt's author changes from the host to kata; three
capabilities become refutable; a host adapter shrinks from 200 lines with a copied runner to ~60 lines of mapping; and the platform's event
vocabulary becomes the only thing a host must learn.

---

## 6. What this design does **not** fix, stated before it is built

1. **Who runs the adapter is still policy.** Kata launches a command, and nothing stops the author from writing that command. The redesign
   moves the *artefact* out of the host's hands; it cannot move the *launcher*. The schema's own sentence stands: *"authorship separation is
   process and tool policy, not cryptography — a receipt a single-user machine could forge is out of scope here."*
2. **`fresh_context` stays partly a claim**, narrowed to a first-turn-size proxy with its ceiling recorded. Nothing observable distinguishes
   "a fresh session" from "a fresh session that was handed a summary" except that proxy.
3. **A second host is still needed to prove the protocol twice-implementable.** After this redesign it is at least *one versioned protocol in
   one place* rather than a reference copied per host — which is what makes a second implementation worth attempting — but it remains
   single-implementation until somebody writes one.
4. **It does not reduce the loop.** The convergence problem (`docs/design/2026-09-25-why-review-does-not-converge.md`) is orthogonal: this
   document is about *who may certify a round and with what*, not about how many rounds a change needs.


## Addendum (2026-09-27): the host adapter went with the route it served

`host/pi-adapter.ts` was the reference launcher of this design: kata ran it as `adversarial execute --executor "node
host/pi-adapter.ts"`, it spawned an isolated session and mapped that session's stream into the six event kinds, and kata
derived the status and wrote the receipt from what it saw. It is deleted, and this addendum says why rather than leaving a
gap where the file was.

**Its invoker was deleted first.** `kata-cli adversarial execute` was the only thing that ran it — the file's own error
message still told an operator to use the deleted command — and the whole round-shaped route (the protocol parser, the
runner, the registry, the receipt) has since been retired in favour of the evidence ledger. A launcher with no command to
launch it is the same defect this repository removes in code: a declaration with no consumer, except here the declaration
is a 300-line program that nothing type-checks (`host/` is outside `tsconfig.include`) and nothing calls.

**The ledger route does not need a launcher, and that is a design statement rather than an omission.** Assurance on the
ledger comes from the adapter that *decides the evidence*: `inline` runs the declared checks inside kata and records
`observed`; `file` reads results recorded elsewhere and records `relayed`. Both are honest labels about what was verified,
and neither requires a receipt, because the thing being certified is the evidence rather than the process that produced
it. The design's `limits` field carries the boundary in the record itself: *the ledger records what was verified, not who
wrote the claims*.

**What is genuinely gone, so it is not missed later.** The ability to certify that a *review session* ran in an isolated
context. That was the capability the receipt existed for, and the reason it was dropped is that on this platform the
receipt could only be written by the party whose independence was in question (see
`2026-09-26-platform-decoupled-round-methodology.md`, §2). If a future route needs it again, what it needs is not this file
restored: it is a live command that launches the session, an event stream kata can read while it counts, and a store of
record for the runs — which is what this design specified and what its own removal of the round protocol took with it.
