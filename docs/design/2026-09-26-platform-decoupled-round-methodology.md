# A round-certification methodology that does not depend on the host platform

> Status: **proposal**, written after the decoupled round protocol landed and after four dispatches on one revision produced no
> acceptable record through the subagent route. It is the answer to a question the previous documents left open: the host contract
> removed the *host's* power to certify, but left one process fact inside the judgment predicate, and that one fact is what keeps the
> methodology pinned to a platform.
>
> Every claim about this repository is measured and names a file or a command. Every claim about the industry practice below links a
> source, and the sections that borrow a standard say what it costs to follow it.

## 1. The reframe: every mature system concentrates trust in one named component

The question is not "how do we make the host trustworthy". It is **"which component do we trust, and is it small enough to be the only
one"**. The systems that solved this class of problem all answer it the same way:

| System | What is trusted | What is not | Source |
|---|---|---|---|
| SLSA provenance | **`builder.id`** — "the transitive closure of all entities that are trusted to faithfully run the build and record the provenance" | the build script, the dependencies, the artifact | [slsa.dev/spec/v1.1/provenance](https://slsa.dev/spec/v1.1/provenance) |
| in-toto + Sigstore | the **OIDC identity** and the transparency log | whoever produced the artifact | [occasio agent-attestation v1](https://github.com/occasiolabs/occasio/blob/main/spec/agent-attestation/v1/README.md) |
| Proof assistants | the **kernel** — small, auditable, deterministic | **the model that proposed the proof** | [lean-llm-starter](https://huggingface.co/Snapkitty/lean-llm-starter): "treats the language model as an untrusted proposal engine and Lean 4 as the trusted verification kernel" |
| **This repository, today** | **the host process that ran the round** — a whole platform-shaped component, declared as `--executor "<command>"` | the session | `src/quality/review-execution.ts`, `schemas/adversarial-review.schema.json` |
| **This repository, proposed** | **the judgment predicate and the commands that decide it** — inside kata | **who ran the round, how it was launched, how independent it was** | §3 below |

**The reframe in one sentence**: escaping platform coupling is not "find a host contract every platform can implement" — it is
**demote the executor to an untrusted proposer and move trust into a judge that reads only the artifact**.

This is not a new position for this repository: §2.2 of `2026-09-21-adversarial-execution-control-optimization.md` already states the
admissibility predicate as five conjuncts over the **record** (covered / discharged / grounded / bounded / consistent) and adds *"the
LLM supplies hypotheses and counterexamples; admissibility is decided by deterministic code over an auditable artifact."* What
follows is the part that design did not finish: **one of those conjuncts still reads a process fact.**

## 2. The single remaining coupling, measured

`src/quality/adversarial.ts`:

```ts
requiresExecutionReceipt:
    task?.workflowProfile?.reviewMode === 'strict' || task?.workflowProfile?.reviewMode === 'security',
```

and `src/quality/review-execution.ts:189`:

> *"no execution receipt was recorded, so {node} cannot be certified: a context the agent describes as fresh is not a capability"*

So certification — for the two escalated tiers — rests on **the existence of a receipt from a host process kata launched**. Three
consequences, all measured on this line:

1. **A host that cannot launch an isolated process cannot run an escalated change at all.** Measured: `adversarial-admissibility` and
   `review-record-integrity` have sat with every criterion implemented and every obligation disposed, unable to certify.
2. **The subagent route cannot be certified even when its facts are true.** Measured over 74 rounds: `kata-reviewer` genuinely had a
   fresh context and genuinely could not write, and produced no receipt.
3. **The relay route is documented and refused.** `schemas/adversarial-review.schema.json` describes `receipt.executor` as *"On a
   subagent round the telemetry is relayed by the calling session"*, with `platform` / `sessionId` / `completionReport`; and a
   relay-shaped receipt is refused by `adversarial record` with `receipt_unwatched` (measured).

**Everything else in the methodology is already platform-neutral**: the sealed revision is content-addressed (`src/quality/revision`
paths, `pathDigests`), the brief is a text artefact, the gate reads a schema, the falsifier ledger stores observed exit codes. **The
only platform-shaped fact in the judgment is "a process we launched watched this round".**

## 3. What the standards already provide (do not invent these)

### 3.1 Attribution — OpenTelemetry GenAI semantic conventions

The gap measured on this platform is exact: `pi -p --mode json --subagents-workflow-file=…` emits `tool_execution_start/end` with a
`toolName`, and **no field identifies which agent the call belongs to** (`agentId`, `sessionId`, `jobId`, `parentId`, `thread` were
each checked; none exists), and the child's events are **not nested** inside the parent's tool result. `subagent_inspect` states it
excludes *"complete child output … selected tools"* by design.

That gap has a **standard name** — it does not need a local invention:

| Convention | Meaning |
|---|---|
| `gen_ai.agent.id` | "The stable unique identifier of the invoked GenAI agent"; explicitly *not* an in-memory instance id |
| `gen_ai.operation.name` ∈ `invoke_agent`, `execute_tool`, `plan`, `invoke_workflow` | the operation vocabulary |
| spans | *invoke agent client/internal* span, *plan* span, *execute tool* span, nested — "the tool or task spans produced from the plan are typically sibling operations under the same `invoke_agent` span" |

Source: [semantic-conventions-genai · gen-ai-agent-spans](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md)
(status: Development). **Cost to adopt**: kata's six event kinds become a projection of these spans; the refutation rules
(`read_only_fs` by a write `execute_tool`, `bounded_tools` by an off-allowlist one) then apply to any platform whose instrumentation
follows the convention — and a platform that emits no `gen_ai.agent.id` is one that cannot run an escalated change, *stated as such*
rather than discovered mid-round.

### 3.2 Isolation — the kernel, not a declaration

"Read-only" is currently a capability a host **advertises** and kata refutes from the stream. It can also be a fact the **kernel**
enforces: `bwrap`/Landlock/seccomp namespaces ("the agent gets read-write access only to your current working directory; the rest of
`$HOME` stays hidden" — [ai-bwrap](https://github.com/didvc/ai-bwrap), [bubblewrap](https://github.com/containers/bubblewrap)). This
matters for the methodology because it **removes the requirement to trust the tool list**: a session inside such a namespace cannot
write outside its budget whatever it is told, and the property is platform-independent in the sense that matters — it does not
depend on the agent framework, only on the host OS.

### 3.3 Attestation envelope — in-toto + Sigstore, with a weaker-evidence grade

[AI-Agent Behavioral Attestation v1](https://github.com/occasiolabs/occasio/blob/main/spec/agent-attestation/v1/README.md) (Draft 1)
attests *what an agent did in one bounded session*: every governed tool call, every blocked attempt, the active policy, over a
**hash-linked audit chain** (`prev_hash → hash`, GENESIS sentinel), wrapped in an in-toto Statement and signed with **Sigstore
keyless (GitHub OIDC)**. Its verification model is three independent checks — signature, predicate↔payload equivalence, and
re-walking the chain — and it names the weaker case explicitly:

> `policy.source: inferred` — no `policy_loaded` event was found in the slice, so the producer hashed the policy file at attest time,
> which may have been edited after the run ended. **Verifiers SHOULD treat `inferred` as weaker evidence … and surface this
> distinction to the user.**

**Two things to take.** First, the shape: our receipt + run registry is a hand-rolled instance of this predicate, and the industry
form carries a signature from a platform identity rather than a self-written file — which is the *only* thing that makes "who
attested" answerable without trusting the attester. Second, the precedent: **a weaker tier is normal and must be labelled, not
hidden** — which is exactly the `provenance: observed | relayed` distinction proposed in §4.3.

### 3.4 Judgment — the proposer/checker split, which is what actually removes the coupling

The proof-assistant pattern is the reference implementation of "we do not need to trust the proposer": a model writes a proof, a
**kernel** of a few hundred lines decides it, and the kernel is the only component that must be correct. Applied here, the kernel is
not a proof checker but **the commands kata can run**: a falsifier (`kata-cli falsify`), a deterministic class check
(`tests/unit/class-invariants.test.ts`), a content comparison (`lane`, `pathDigests`).

This is the load-bearing idea of the whole proposal, and it is a **measured** property of this line rather than a hope: the falsifier
mechanism has caught seven decorative checks, three mis-derived identities and one hand-written coverage marker, at **zero token
cost**, because re-introducing a defect and watching a check move colour is deterministic.

## 4. The proposed methodology

### 4.1 Judgment rests on the artifact, and the artifact must carry its own refutation

Every finding must arrive as one of two shapes:

- **reproducible** — carries a command that a deterministic party runs; the finding is confirmed when the check reddens under the
  re-introduced defect and is green with it absent (this is `kata-cli falsify` today, and the ledger already stores
  `{before, mutated, after}`);
- **declared unreproducible** — carries the reason it cannot be reduced to a command (a criterion whose wording is wider than its
  selector; a document that disagrees with the code). These are **not** accepted as evidence; they are accepted as **claims to be
  adjudicated**, and they must be routed by §4.2.

**Why this removes the platform coupling**: a fabricated record cannot produce a reddening check. The independence of the round stops
being the thing that makes the finding meaningful — **the finding carries its own proof, and the proof is judged by kata**. A record
written by the session under review is then no more dangerous than a proof written by the student: it either verifies or it does not.

### 4.2 Unreproducible findings are adjudicated by class, not by re-review

Measured on this line: the most valuable findings were class-level statements ("the check reads a declaration while the message claims
reality"), and no single falsifier can express them. So they are handled by the mechanism that already exists for exactly this
purpose: **the class table** (`src/quality/class-coverage.ts`) plus a **covering check that reddens when the class returns**
(`tests/unit/class-invariants.test.ts`, checks A–D and G, each mutation-verified).

The workflow is then:

1. a finding that cannot be reduced to a command must **name a class**;
2. a class is admissible only when it has a covering check;
3. `roundMayClose` refuses to close a round while an open terminal finding names an uncovered class.

This is the termination condition the loop lacked, and it is platform-free: it reads the record and the repository.

### 4.3 Provenance is graded and displayed, never implied

| grade | meaning | how it is obtained |
|---|---|---|
| `observed` | a process kata launched emitted the events, kata counted and refuted them, and kata wrote the receipt | today's process route (`adversarial execute`) |
| `relayed` | the events were produced by a party that is not kata, with a session identifier and the platform's completion report quoted verbatim | the subagent route — **accepted, marked, and shown**, following the `policy.source: inferred` precedent |
| `held` | neither: a record with no run behind it | refused (`receipt_unwatched` today) |

The gate then decides **which grades each tier accepts**, instead of the current all-or-nothing: an escalated tier may require
`observed` for the node whose entire purpose is a controlled second look, while the always-run node accepts `relayed` — and both are
reported by `adversarial status` so an operator sees which kind of evidence they are standing on.

### 4.4 Landing the judgment in code, not in prose

The five conjuncts of §2.2 today are partly enforced and partly aspirational (`grounded` is a naming rule; `bounded` reads a boolean).
The methodology requires each conjunct to be a predicate over the record, evaluated by `src/quality/` — with the same rule this line
applies everywhere: **a conjunct that cannot be evaluated is not a conjunct, and a condition the gate judges by must appear in the
brief** (`tests/unit/every-gate-condition-is-stated-in-the-brief.test.ts`).

## 5. Migration, in the order the dependencies allow

| # | Step | What it unblocks | Cost |
|---|---|---|---|
| 1 | **Take `executedInFreshContext` out of the judgment** (keep it as record metadata, report it, do not gate on it) | every escalated change that cannot certify its host — including the two blocked now | one predicate change + one brief line; **it does not weaken the refutation rules**, which stay |
| 2 | **Require every finding to be `reproducible` or `declared unreproducible`**, and route the latter through the class table | makes the artifact self-refuting; removes the need to trust the record's author | schema + brief + gate; the falsifier ledger already stores what is needed |
| 3 | **Align the event vocabulary with OTel GenAI** (`invoke_agent` / `execute_tool` / `gen_ai.agent.id`) | the subagent route becomes `observed` on any instrumentation-following platform | the six event kinds become a projection; `round-boundary` gains a case |
| 4 | **Accept `relayed` with `sessionId` + verbatim completion report** | the relay route stops being documented-and-refused | schema + gate + status; replaces the current `receipt_unwatched` blanket refusal |
| 5 | **Lean on the kernel for isolation** where available (`bwrap`/Landlock), keeping the stream refutation as the portable fallback | "read-only" stops being a capability a host must promise | host-side; no kata change beyond documenting the two forms |
| 6 | **Benchmark-gated rollout**: the corpus in §4 Phase 0 of the optimization design decides whether 1–5 hold | makes every step above falsifiable | already planed; nothing new |

**Step 1 is the cheapest and the most consequential**, and it is the direct answer to "can read-only and who-reviewed be ignored":
**they can be ignored exactly to the degree that the judgment stops reading the process** — and of the two, `who reviewed` costs
nothing to drop today (the observed route already needs no identity), while `read-only` is dropped only in its *declared-conflict*
form and kept as either a stream refutation or a kernel guarantee.

## 6. Honest limits

1. **Reproducibility covers part of the findings.** This line's best findings were prose-level, and step 2 forces them into the class
   table — which is a real constraint on what a round may report, not a free win.
2. **The standards are drafts.** occasio's predicate is Draft 1, OTel's GenAI conventions are *Development*; adopting them means
   accepting they will move. That is still cheaper than six local event kinds, but it is not free.
3. **`relayed` is weaker and stays weaker.** Labelling it does not make the telemetry true; it makes the weakness auditable.
4. **Quorum is not free.** The two most expensive rounds on this line (874K and 658K tokens) produced zero accepted records, so
   comparing methods must use **cost per accepted finding**, never cost per round.
5. **A kernel-level guarantee is only as good as the platform's OS access.** Where `bwrap` is unavailable, isolation falls back to
   the stream refutation — portable, weaker, and stated as such.

## 7. What this refuses

- **Do not make the host contract universal.** That would move every platform's specifics into kata, the change this document exists
  to avoid.
- **Do not accept a session's own report as evidence** at any grade; `relayed` is accepted as *citable*, `held` never.
- **Do not let a step land on an impression.** Every step above reports a delta against the corpus, or it is not landed.
