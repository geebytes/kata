# Independent adversarial review: cost optimization under a quality constraint

**Status:** active design. Judgment layer (B), benchmark corpus (A) and the capability/boundary contract are implemented in
`adversarial-admissibility`; the **retrieval layer and the host executor are not** — §3.3 and §3.2.1 are corrected below.
**Decision scope:** governed Kata change `adversarial-admissibility`, and the Stage 1 change it feeds.
**Source material:** `docs/verfify.md`, the current adversarial implementation, two independent passes against
`revision-4eae642da67cbbee` of `adversarial-admissibility` (2026-09-22), and a gateway cache probe (2026-09-22).

**Architectural stance (decided):** the optimization is a *judgment-foundation* redesign (B), refereed by a *measured*
benchmark corpus built first (A), with host trust supplied by a *capability contract* that fails closed (A). The three
decisions are not independent — B is what makes cheap-and-sufficient provable, A/A are what make its inputs and its
claims checkable. §6 records what follows from them.

## 0. Objective, stated as the constraint it is

`docs/verfify.md` defines the objective correctly, and this document adopts it verbatim:

```text
minimize(tokens, latency)
subject to:
    criticalRecall   >= baseline
    falsePassRate    <= baseline
    reproducibility  >= baseline
```

Every proposal below is therefore judged twice: what it saves, and what it could cost in recall. A change that
cannot show both is not ready. Cost reduction that lowers critical recall is a **failed** optimization, not a
trade-off — §「如何证明压缩后质量没下降」 in `docs/verfify.md` is the authority for that rule.


### 0.1 Two governance rules added after the first real measurements (2026-09-22)

The objective above is necessary but was not sufficient: it says what to minimize, not how a claim about minimizing is
allowed to be made. Two rules close that, and every section below is now subject to them.

1. **No cost claim without a same-revision comparison.** A lever is adopted only after an A/B on one frozen revision
   showing the cost median fell and no quality rate degraded. Unit tests, a passing seal and a green Verify prove
   correctness, never cost — this is the exact substitution that made the first round of this work "implemented
   everything, reduced nothing".
2. **No mechanism without a consumer.** Every guard, field or layer must name who calls it and what would break if it
   were deleted. Measured: **nine of the ten distinct defects** found by the first two independent passes were
   violations of this rule — an exported function with no production caller, a predicate behind an optional field, a
   gate short-circuited to `0 >= 0`, a second derivation nobody needed, a corpus class nothing could measure.
## 1. Where the cost actually is

The measured baseline (strict verify node, 2026-09-21): **128 tool calls, 2,627 s, ~8.9M tokens, 6 attempts** — and
`docs/verfify.md`'s earlier observation, **125 tools, 8.3M tokens, 43+ min, 81 truncations**. Both are the same
shape: the semantic bound held (six attempts) while the runtime did not.

### 1.1 Measured against the artifact Kata actually ships

The issued brief for `review-record-integrity` (`revision-181acf2e2d561a4c`, `review` node) is **21,708 characters**.
Section by section:

| Brief section | chars | What it is for |
|---|---:|---|
| header incl. `Paths under review` | 1,651 | 26 owned paths on **one 993-char line** |
| The claims under test | 364 | cold-round framing |
| Evidence the author recorded | 1,448 | 7 envelopes |
| Sealed evidence you may read instead of re-running | 2,112 | read-not-rerun contract |
| Where to start reading | 1,675 | 14 entries; only 6 are in the delta |
| Writing as you go | 1,189 | ledger protocol |
| How to spend a turn | 1,298 | **prose instruction** |
| Use the cheapest instrument that can answer | 2,911 | **prose instruction** |
| Findings by class | 2,831 | class history |
| This is a delta pass | 3,207 | delta + findings restated |
| What to do / Rules / Required result | 2,812 | contract |

Three findings fall straight out of the numbers, and none of them needs a new architecture:

1. **The brief contradicts itself about scope, and the contradiction is at the front.** The header lists all **26**
   owned paths as `Paths under review`; the delta section at the bottom states that only **6** paths changed. Ten of
   the fourteen reading-set entries are outside the delta. A reviewer told "these 26 are under review" and "only
   these 6 changed" will re-derive the 20 that did not — which is precisely the cost the delta mechanism exists to
   avoid, defeated by the header.
2. **The same finding is reproduced in full twice.** `seal-persists-refused-owned-paths` appears as 1,131 chars in
   *Findings by class* and again as 1,095 chars in *This is a delta pass*. Kata already stores findings once and
   renders a stable id; the id plus severity plus disposition is what a reader needs, and the two verbatim copies
   are ~1,095 characters of pure duplication per round.
3. **~4,209 characters (19% of the brief) are prose instructions that the platform does not enforce.** *How to spend
   a turn* and *Use the cheapest instrument that can answer* tell the reviewer to batch commands, prefer mutation
   over probes, and stop at six attempts. `docs/verfify.md` §9 states the correct home for this: a hard resource
   envelope enforced by the orchestrator. Until then the same text is paid for every round while remaining
   unfalsifiable — the 2,627 s pass ran with all of it in context.

### 1.2 What the implementation actually enforces today

The gap is narrower than "no control plane exists". A survey of the current source shows a great deal of the
supporting machinery already built, and **not consulted at the point where it would bind**:

| Mechanism | Exists? | Enforced? |
|---|---|---|
| Reading set with line counts | yes (`buildReadingSet`, bounded at 40, labelled a sample) | advisory; `not a boundary` |
| Sealed evidence paths the reviewer may read instead of re-running | yes (`evidenceEnvelopePaths`) | advisory prose |
| Per-batch progress ledger | yes (`appendProgressLine` / `adversarial note`) | opt-in; this round recorded **0 lines** |
| Check-level reuse | yes (`check-reuse.ts`, `checkInputFingerprint`) | for the *seal*; the reviewer still re-runs |
| Delta scope measured mechanically and gate-verified | yes (`changeSurfaceAgainstWorkspace`, delta block) | yes — but the header contradicts it (§1.1) |
| Fresh-context proof | **no** — `executedInFreshContext` is an agent assertion | nothing |
| Wall time / tool count | **no** — `--elapsed-ms` / `--tool-uses` are CLI arguments | nothing |
| Hard hypothesis / tool / time budget | **no** | nothing |
| Tool-result cache, semantic dedup, progressive hydration | **no** | nothing |

The consequence is the ordering below: the affordable, high-yield work is to **make the existing advisory machinery
bind and stop paying for the contradictions**, and only then to build the executor contract that makes the remaining

### 1.3 The brief's information policy, and why "no author claims" over-corrects

This is a cost section. It is separated from §2 because the interference it records is **not** a judgment-foundation
defect: the same brief, the same predicate and the same gate produce a materially cheaper round when the brief carries
the right *facts* — and **nothing in the independence property is lost by carrying them**.

#### 1.3.1 The measured brief, field by field

Brief measured: strict verify node, `revision-281b83290ee86e83`, `mode: cold`,
`briefSha256 e414c4f6b964b5bb78dbe2b08bafc38f7de9ce5f2c94d2659a4fdfcaefcafb40`.

| Measure | Value | Note |
|---|---:|---|
| `briefs[0].text` (the prompt verbatim) | **15,631 chars** | ≈4.0–4.5K tokens at ~3.8 chars/token |
| landed copy (`tmp-verify-brief.txt`) | 15,709 **bytes** / 2,071 words / 211 lines | bytes ≥ chars under UTF-8; the delta is the trailing newline |
| wrapper JSON | 16,852 bytes | JSON escaping, not prompt |
| `Paths under review` | **24 paths on one line** | matches the *full* scope, while the change has 6 AC rows |
| `## Where to start reading` | 6 entries, all "added in this change" | includes `tmp-verify-brief.json` — **the brief's own JSON**, 0 lines |
| `## Findings recorded so far` | `(none recorded yet)` | cold round |
| `## Already known, already decided` | `(nothing has been dispositioned for this task)` | cold round |
| `## The claims under test` | "**no author claims are given**" | the policy under analysis |

Intended content per the file's own fields: `mode`, `scope` (`{kind}`), `revisionId`, `manifestHash`, `issuedAt`, `text`.

#### 1.3.2 What the cold framing removes, and what it should remove

The framing's stated purpose is sound and is stated in the brief itself:

> *"a reviewer asked to check someone's claims checks only those claims"*

That is a real effect and the correct target. But *claims* and *facts* were removed together, and only the second is a
reduction in independence. The brief's own instructions demand the removed material back:

> *"For each claim above, and for the change as a whole: 1. Read the actual repository… 2. Decide what to attack first.
> There is no claim list: form your own hypothesis about where this change is wrong."*

*"For each claim above"* refers to a section that is empty by policy; *"there is no claim list"* is stated as a feature.
The reviewer therefore pays the **orientation cost every round** — and the earlier passes measured the consequence in
their own words: *"three consecutive rounds rewrote experiments for the same class of property… because the properties
were re-probed instead of promoted"*.

The correct partition is not "less context" but **facts vs. advocacy**:

| Class | Examples | Independence risk | Verdict |
|---|---|---|---|
| Task facts | acceptance criteria text; per-AC check id, command, selector, assertion target; declared test paths; revision, manifest and evidence hashes; the mechanically computed delta; prior findings with severity, location and disposition; the non-negotiable invariants | none — each item is independently re-checkable against the repository | **must be in the brief** |
| Author conclusions | "this is fixed"; "tests pass"; verdicts; confidence | high — the reviewer checks only the stated claims | **must be excluded** |
| Author advocacy | "pre-existing, unrelated"; "out of scope"; rationale for an implementation choice; what the author tried | high — and it is the cheapest falsifiable surface (the very class the record-integrity change exists to kill) | **excluded; if it must be reported at all, machine-generate it** |

The third row is the non-obvious one. Removing the author's self-report does **not** remove the defect class — it moves
it. Either the reviewer re-derives the same class from zero (what happens today) or the platform generates the record
mechanically so there is no prose left to attack (what AC-2/AC-3 of `review-record-integrity` build). **Excluding prose
and generating records are complements, not substitutes.**

#### 1.3.3 Why the cold framing is defensible, and where it stops

**It is defensible**, for reasons worth recording rather than discarding:

- **Fagan inspection (1976)** has reviewers work from a predefined checklist independently of the author's oral
  explanation; the author answers questions only in clarification. Independence of *derivation*, not of *facts*.
- **Bacchelli & Bird (2013)** found author narration measurably redirects reviewer attention — the empirical basis for
  withholding it.
- **N-version programming** rests on *diverse failure modes*: reviewers fed the same framing collapse toward the same
  mode, which is precisely the independence being purchased.

**It stops** at the point where the withheld material is an independently re-checkable fact. Inspection methodology
withholds the author's *interpretation*; it does not withhold the *requirements* or the *artifacts*. A Fagan reviewer
without the checklist is not an independent reviewer, only an uninformed one — which is the state §1.3.2 measures.

#### 1.3.4 Recommendations that need none of the Phase 0–4 architecture

Ordered by measured yield. R1–R3 are brief-assembly changes only; R4 is the one that requires §3.2.

1. **Carry the acceptance criteria and their checks verbatim.** AC-1..AC-6 text plus, per AC, the check id, command,
   selector and what the assertion actually asserts. This is the strongest single lever: the reviewer's most valuable
   question is *"does this evidence actually test this criterion"*, and today it cannot ask it without first
   reconstructing the criteria. **Cost risk: none — this is the gate's own contract entering the brief.**
2. **Carry prior findings by class with dispositions, even in a cold round.** Already designed (the brief has a
   `## Findings by class` section, populated from durable sources per the content-binding rule); the earlier failures
   show the mechanism works and that the cost of *not* having it is a re-derivation per round. Cold should remove the
   author's framing, not the lineage.
3. **Fix the two brief defects that inflate it (§1.1), and drop the self-referential entry.** The `Paths under review`
   header must state the delta the pass is about, not the raw owned set; a finding must be rendered once with its id
   referenced thereafter; `tmp-verify-brief.json` must not be listed as a path under review.
4. **Make the budget machine-readable before it is machine-enforced.** Even before §3.2.2's executor, putting
   `{maxHypotheses, maxToolCalls, maxWallMs}` into the brief as *data* (with `budget_exhausted` already derivable per
   §2.3) changes what the reviewer can report truthfully. Today's ~4,209 characters of cost prose are unfalsifiable
   *and* unpaid-for in any enforcement sense — the 2,627 s pass ran with all of it in context.

The measurable claim to defend: **rounds stay at or below the six-attempt semantic bound *and* the reviewer no longer
pays orientation cost per round** — with critical recall unchanged.

#### 1.3.5 What the four recommendations cost, measured on the shipped renderer

Measured 2026-09-22 on the real 6-AC task `adversarial-admissibility`, same revision, cold round, by rendering the brief
both ways through `renderAdversarialBrief`:

| Fact the reviewer needs | before | after |
|---|---|---|
| the criterion's text | absent | present |
| the check command that answers it | absent | present |
| the selector that check runs | absent | present |
| what the assertion actually asserts | absent | present |
| the budget, as data a host can parse | absent (numbers were prose/table only) | present as a fenced JSON object |

**Cost: +85 characters on a 12,058-character brief — +0.7%.** That is what "cost risk: none" measures out to, and it is
the whole of the claim this subsection is entitled to make: the four facts are *present or absent*, and the price of
their presence is under one percent.

Two further measurements belong to the same recommendations and are recorded where the mechanism lives rather than here:

- **The acceptance contract is cheap in the IR too.** On the same task, narrowing a round to one affected criterion
  took the IR from 5,874 to 3,741 characters (**−36%**), because the IR is the executor's input and the fixed prose
  does not dominate it the way it dominates the brief.
- **The freeze anchor removes a real invalidation.** Before §7.4's freeze anchor, sealing byte-identical content under a
  changed check set produced a new revision id *and* a different `reviewIrHash`, which expired a completed
  certification (`stale_revision`). Measured after: same content → the pass stands; changed bytes → `stale_revision`.

**What this does not measure, and must not be read as measured.** The claim's other half — that critical recall is
unchanged — needs a verifier scored against the corpus on both shapes, i.e. real independent passes. The corpus and the
release gate for that comparison exist (§4 Phase 0, and `checkReleaseGates`' `verifier-critical-recall`); the passes
themselves are host-side and are not something this document can self-certify.
| Tool-result cache, semantic dedup, progressive hydration | **no** | nothing |

The consequence is the ordering below: the affordable, high-yield work is to **make the existing advisory machinery
bind and stop paying for the contradictions**, and only then to build the executor contract that makes the remaining

## 2. The judgment foundation, stated precisely

This is the architectural root, and it is narrower and more damning than "the prompt is too weak".

### 2.1 What the gate treats as a conclusion today

`evaluateAdversarialGate` (`src/quality/adversarial.ts`) returns `satisfied: true` on this condition, verbatim:

```text
revision matches (or code surface unchanged with claims re-verified)
+ record.status !== 'waived'
+ record.executedInFreshContext === true      ← agent assertion
+ record.briefSha256 was actually issued       ← real check
+ record.attempts.length > 0                  ← arity only, never content
+ no attempt cites an undeclared test path     ← real check
→ satisfied
```

Three properties of a real conclusion are **absent from the predicate**:

1. **`verdict` is never read.** It appears in the type, the brief template, and the record schema — and in no branch of
   the gate. `verdict: 'inconclusive'` — the reviewer stating *"I did not reach a conclusion"* — satisfies the node.
2. **`attempts[].outcome` is never read.** The only consumers are the brief renderer (echoing it to the next round as
   reference) and the CLI's own progress print. Nothing requires an attempt to converge to `refuted` or `confirmed`.
3. **The absence of findings is treated as a result.** `findings: []` with no blocking/major entry is the passing case,
   and it is indistinguishable from a pass that produced no *attempt* worth trusting.

So the smallest record that passes a strict node is:

```json
{ "status": "recorded", "executedInFreshContext": true, "briefSha256": "<issued>",
  "verdict": "inconclusive",
  "attempts": [{ "hypothesis": "—", "method": "—", "outcome": "inconclusive" }],
  "findings": [] }
```

That is not a quality *risk*. It is a missing state: **the judgment foundation has no representation for "not concluded".**
`docs/verfify.md` names this as the platform demanding hand-written records while giving them no validator; the precise
form is that the one field carrying the conclusion is decorative.

### 2.2 What "a conclusion that holds" must mean

A review conclusion is admissible only when each of its parts is **independently checkable from the record**, and the
record must be unable to express "I looked and found nothing" without also expressing **what was looked at and why that
is enough**. Formally:

```text
admissible(conclusion) ⇔
      covered   : every criterion and every changed path is claimed by ≥1 hypothesis
    ∧ discharged : every hypothesis reached refuted | confirmed | ruled_out, with a cited observation
    ∧ grounded   : every `refuted` cites evidence readable at this revision (source slice, sealed envelope,
                   permitted test, deterministic analysis) — not prose
    ∧ bounded    : no hypothesis was abandoned to a resource limit while unexamined, and any limit hit is
                   reported as such rather than as absence of defects
    ∧ consistent : no confirmed defect of blocking/major severity is excluded from findings
```

Each conjunct is a predicate over the **record**, checked by the gate — not a sentence in the brief. This is the whole
of "verifier as a verification *system*": the LLM supplies hypotheses and counterexamples; admissibility is decided by
deterministic code over an auditable artifact.

### 2.3 The four states, replacing the present binary

| State | Meaning | Gate outcome |
|---|---|---|
| `no_defect_found` | coverage complete, all hypotheses discharged, none confirmed | **satisfied** |
| `defects_found` | ≥1 confirmed defect at any severity | satisfied, but blocking/major → repair obligation |
| `inconclusive` | coverage incomplete, or a hypothesis was abandoned to a limit | **refused** (`incomplete_conclusion`) |
| `budget_exhausted` | a hard limit was hit with hypotheses still open | **refused** (`budget_exhausted`), and the unexamined
set is named so the next round's scope is chosen from facts |

The last row is the load-bearing one: a truncated pass becomes a **reported, actionable** state instead of a silent
pass. Today's 81 truncations and 2,627 s pass both terminate as "satisfied with zero findings" whenever nothing was
written down, which is exactly the shape that must be impossible.

### 2.4 Why this is the root cause of the cost, not a separate quality issue

The two complaints are one defect seen from two sides. A predicate that ignores the conclusion cannot reward a
targeted, sufficient investigation — so the only way a reviewer can defend its answer is to *over-investigate*, because
the record is read by a human for persuasion rather than by a gate for admissibility. Cost control by prompt is then
doomed: the reviewer that stops at six attempts cannot prove sufficiency, so it continues, reads broadly, and pays
4,209 characters of instruction telling it to be cheap while nothing in the system asks it to be *sufficient*.

Make the predicate read the conclusion and both move together: a cheap, targeted pass becomes **provable**
(coverage + discharge + grounding are all satisfiable with a small, sharp hypothesis set), and an unbounded pass
becomes **pointless**, because extra reading no longer strengthens an answer the gate cannot read.

The current implementation explains the gap:

- `src/quality/adversarial.ts` accepts `executedInFreshContext` as an agent assertion; the CLI has no host-session visibility.
- `src/cli/ops.ts` accepts `--elapsed-ms` and `--tool-uses` from the caller when recording a result.
- `renderAdversarialBrief()` gives the verifier broad repository-reading freedom and has no explicit instruction/data boundary for repository text, logs, fixtures, or evidence.
- `buildAdversarialBrief()` derives delta scope through `changeSurfaceAgainstWorkspace()`; that path reads repository-wide `git status` data. In a `current_worktree` with concurrent writers, foreign paths can enter the review input and can supersede an otherwise-green revision.
- The brief carries useful prior history but no persistent, runtime-enforced hypothesis ledger, output cache, or stop state.

The goal is **not** to make review shallower. It is to relocate deterministic accounting, isolation, evidence selection, and termination from the model prompt to a trusted executor while preserving the reviewer's semantic judgment and counterexample construction.


## 3. Target architecture

Three layers, in dependency order. The judgment layer (3.1) is the reason the other two exist: without it, isolation and
retrieval make a *cheap* pass, not a *sufficient* one.

```text
┌─ Judgment layer (B) ──────────────────────────────────────────────┐
│  admissibility predicate over the record — coverage, discharge, │
│  grounding, boundedness, consistency; four states, two refusable │
└──────────────┬───────────────────────────────┬───────────────────┘
               │                               │
┌─ Execution layer (A) ──────────┐   ┌─ Retrieval layer (support) ─┐
│ host capability + receipt      │   │ ReviewIR, evidence graph,   │
│ hard budget, immutable telemetry│   │ content-addressed cache,    │
│ isolated/leased attribution     │   │ diff-anchored graph, hydration│
└─────────────────────────────────┘   └─────────────────────────────┘
```

### 3.1 Judgment layer — the admissibility predicate

#### 3.1.1 The artifact a pass must produce

Replace the free-form `attempts`/`findings` pair with a **review state** whose shape makes the five conjuncts of §2.2
checkable. The reviewer supplies content; the shape is Kata's:

```jsonc
{
  "coverage": [                              // what this pass claims to have covered
    { "criterionId": "AC-3", "paths": ["src/quality/change-record.ts"] },
    { "criterionId": null,   "paths": ["src/workflow/orchestrator.ts"] }   // changed path outside any row
  ],
  "hypotheses": [                             // the only free-form field, and it is not the conclusion
    {
      "id": "h1",
      "claim": "<what is asserted false>",
      "targets": ["AC-3", "src/quality/change-record.ts"],
      "method": "mutation | source-read | sealed-evidence | permitted-test | deterministic-analysis",
      "outcome": "refuted | confirmed | ruled_out | abandoned",
      "observation": {                        // required unless outcome === 'abandoned'
        "kind": "source | evidence | test | analysis",
        "ref": "<path#Lx-Ly | evidence id | check id + selector | analyzer name + result>",
        "observed": "<what was actually observed, not what was expected>"
      },
      "abandoned": { "limit": "budget | time | tools", "why": "<the limit that stopped it>" }
    }
  ],
  "findings": [ /* unchanged: id, severity, message, path, disposition */ ]
}
```

Three properties of this shape carry the architecture:

- **`coverage` is a claim the gate can falsify.** Kata knows the acceptance criteria and the changed paths, so
  "every criterion and changed path is claimed" is a set operation, not an opinion.
  `changeSurfaceAgainstWorkspace` already produces the changed-path set mechanically; `acceptanceIdsByCheckId` already
  maps criteria to rows. The predicate reuses both.
- **`observation` is required to discharge a hypothesis.** `outcome: refuted` with no readable `ref` is not a
  discharge — it is prose, and the whole point of §2.2's `grounded` conjunct is that a `refuted` must cite something a
  third party can open at this revision. A `kind: source` reference is checked against the revision's own content hash,
  so a citation of code that no longer exists at this revision is refused.
- **`abandoned` is a first-class outcome.** This is what makes `budget_exhausted` expressible instead of silently
  equivalent to "no defects": a hypothesis stopped by a limit is recorded *as stopped*, and the gate refuses the pass
  with the abandoned set named so the next round's scope is chosen from facts.

#### 3.1.2 The predicate

```text
admissible(record, revision) ⇔
    coverage   : ⋃ hypotheses.targets ⊇ acceptanceCriteria ∪ changedPaths(revision)
    discharge  : ∀ h ∈ hypotheses: h.outcome ≠ 'abandoned' ∨ recorded-abandonment
    grounding  : ∀ h ∈ hypotheses with h.outcome ∈ {refuted, confirmed, ruled_out}:
                   readable(h.observation, revision)
    bounded    : ¬(∃ h: h.outcome = 'abandoned')                      // for a *passing* verdict
    consistent : no confirmed blocking/major defect absent from findings

verdict(record) =
    'budget_exhausted'  if any hypothesis was abandoned to a limit
    'inconclusive'      if coverage or discharge is incomplete
    'defects_found'     if any hypothesis was confirmed
    'no_defect_found'   otherwise
```

`readable(observation, revision)` is the grounding check, and it is deliberately narrow: a source citation must resolve
to a path in the sealed revision with a matching content hash; an evidence citation must resolve to an envelope bound to
this revision; a test citation must be in the declared set (`undeclaredTestPaths` already implements exactly this rule and
is reused, not re-written); an analysis citation must name a deterministic analyzer whose output is in the record.

**The verdict is derived, not declared.** The reviewer writes hypotheses and observations; Kata computes the verdict from
them. This removes the decorative field entirely rather than adding a check to it — a reviewer cannot *claim*
`no_defect_found` over incomplete coverage, because the field it would claim it in no longer exists.

#### 3.1.3 What this does to the two failure modes

| Today | After |
|---|---|
| `verdict: inconclusive` passes the node | `inconclusive` is computed from incomplete coverage/discharge and **refused** |
| 81 truncations terminate as "satisfied, 0 findings" | a limit hit produces `budget_exhausted` with the abandoned set **named and refused** |
| Extra reading cannot be shown to have been necessary | Coverage ∧ discharge is provable with a small hypothesis set, so a *sufficient* targeted pass is admissible and a sprawling one buys nothing the gate can read |
| Six attempts is a prompt request | Six attempts is not a limit at all; the limit is a *budget*, and hitting it is a reported state |

### 3.2 Execution layer — capability contract and hard budget

> **Corrections, 2026-09-22.** The subsections below were written before the execution side was built or measured, and
> three of their emphases are now wrong. They are marked here rather than silently rewritten, because the reasoning
> that produced them is the reason the corrections are needed.
>
> - **Read-only comes from the tool policy, not from a sandbox.** `read,grep,find,ls` and nothing else is already
>   read-only by construction. Granting `bash` is what makes a sandbox necessary — the sandbox was a consequence of a
>   tool decision, not a requirement. Where a pass must genuinely execute something, the right shape is a narrow
>   `reproduce_declared_check(checkId)` that runs one declared check inside the frozen sandbox, never raw shell.
> - **The author must not be the executor.** If the host provides no execution capability the node fails closed
>   (`executor_unavailable`). A receipt the change's own author assembled is not evidence, and "the host session" is
>   the platform's own fresh session — a harness must not hand-assemble freshness flags, because forgetting one fails
>   silently and nothing detects it.
> - **Telemetry may be absent; it may not be fabricated.** A missing measurement is recorded as `unmeasured`. Making
>   `telemetry` required is what pushed toward a hand-rolled executor; the field is subordinate to the objective, not
>   the reverse. This is the §0.1 rule applied to a schema field.
>
> What survives unchanged: the capability vocabulary, the `executor_unavailable` fail-closed rule, the request/receipt
> binding by `runId` + `requestSha256`, and the refusal to certify a pass the gate cannot check.

#### 3.2.1 Why the CLI cannot verify this itself

Kata is a CLI: it cannot start a subagent and cannot inspect the host's session. The current design is honest about this
and then asserts the property anyway — `executedInFreshContext` is the executing agent's statement, and §2.1 shows it is
load-bearing in the passing predicate. That is a trust gap in the *judgment* predicate, not merely a quality nicety.

So the property moves to a capability contract. A host that can run an isolated executor **advertises it** and returns a
receipt the model cannot author:

```jsonc
// ReviewExecutionReceipt — written by the executor, never by the reviewer
{
  "requestSha256": "…",                    // binds to the issued ReviewRunRequest
  "runId": "…",                            // one-time nonce from the request
  "capabilities": ["fresh_context", "read_only_fs", "bounded_tools", "budget_enforced"],
  "toolPolicySha256": "…",
  "startedAt": "…", "endedAt": "…",
  "telemetry": { "toolCalls": 41, "outputBytes": 812034, "tokens": 1183941, "truncations": 0 },
  "status": "completed | budget_exhausted | timeout | cancelled | executor_unavailable"
}
```

`ReviewRunRequest` (issued by Kata, content-addressed) carries the revision/manifest identity, the brief hash, the Review
IR hash, the **hard** budget, and the result schema version. The gate refuses a record whose receipt does not match the
request nonce and hash, or whose `capabilities` does not include the set strict/security requires.

**Fail-closed, not degrade.** A host without `fresh_context` support cannot satisfy a strict/security node: the node is
`executor_unavailable` and blocked. It is never silently downgraded to "the agent said it was fresh", because that is the
state §2.1 just identified as unsound. `docs/verfify.md`'s warning — that caching facts across runs is fine while caching
judgments is not — falls out of this too: the receipt carries telemetry and capability, never a prior verdict.

#### 3.2.2 Budget as the mechanism, not the suggestion

The brief's "aim for at most six attempts" and its ~4,209 characters of cost guidance are replaced by an envelope the
executor enforces and the receipt reports:

```jsonc
{ "maxHypotheses": 6, "maxToolCalls": 48, "maxOutputBytes": 2000000, "maxWallMs": 900000 }
```

**The numbers above were an illustration, and implementing them verbatim was a defect.** Measured on 2026-09-22: an
independent pass executed honestly under exactly that envelope was killed at the wall limit after 15 minutes, having made
**70 tool calls** over 32 turns and still working. Both limits sat *below* the round they were bounding, and
`budget_exhausted` is a refused verdict — so a strict review on this repository was **structurally impossible**, not
merely expensive. The envelope is now derived from measurement instead:

| Limit | Was (illustrative) | Now (derived) | Base |
|---|---|---|---|
| `maxWallMs` | 900,000 | 3,940,500 | slowest recorded pass, 2,627 s × 1.5 |
| `maxToolCalls` | 48 | 215 | most recorded tool calls, 143 × 1.5 |
| `maxOutputBytes` | 2,000,000 | 64,693,181 | a whole pass's measured payload, 43,128,787 B × 1.5 |
| `maxHypotheses` | 6 | 6 | unchanged: a semantic bound, not a resource limit |

`MEASURED_REVIEW_PASS_COST` and `REVIEW_HEADROOM` in `src/quality/adversarial.ts` hold the bases and the factor, and a
test refuses any limit below its measurement — so the envelope cannot drift back to a number nobody measured. The same
lesson as Phase 0: **a value taken from an example is not a value; it is a guess wearing a number's clothes.**

The executive difference from today: **the executor returns `budget_exhausted`, and because §3.1.2 derives the verdict from
the record, that state is refused rather than filed as "no defects".** The prose can then be cut to a few lines, because
the rule it describes is no longer a request.

#### 3.2.3 Attribution and isolation

`changedGitPaths()` reads repository-wide `git status`, so in a shared `current_worktree` it cannot attribute a path to one
task — and today that set flows straight into the delta and the brief header (§1.1, the 26-path list). Strict review
therefore requires attribution the workspace cannot lie about:

- an isolated worktree **or** an exclusive task-write lease held from pre-build snapshot to seal;
- the review delta built from *that* task's revision manifest, never from live workspace status;
- foreign drift surfaced as `workspaceDriftPaths` in a **separate, non-review** field, and a strict pass refused with
  `scope_unattributable` before the brief is issued.

This is the same rule the record-integrity change established ("declared ownership ∪ paths this revision changed") applied
at the boundary where the workspace stops being a trustworthy source.
#### 3.2.4 Content identity and execution isolation

> **Decision D (adopted 2026-09-21):** revision identity is frozen *before* a check runs, and checks run only against a private materialization of that frozen content. Neither revision identity nor review scope may be inferred from `git status` after checks have executed.

`changedGitPaths()` is a post-hoc working-tree observation. It is therefore unfit as the authority for a revision: committing before seal makes it empty, an untracked author file can be missed, and a check-created `check-ran.txt` can be mistaken for author work. `ownedPaths` has the opposite failure: it is a declaration and cannot prove it includes every path the revision actually changed.

At seal start, before evidence collection or any subprocess, Kata creates this immutable object from the author workspace:

```jsonc
// ContentSnapshot — content identity, not a task declaration
{
  "entries": { "src/a.ts": "sha256:…", "docs/guide.md": "sha256:…" },
  "hash": "sha256(sorted(path, digest) entries)",
  "capturedBeforeChecks": true
}
```

- `entries` contains every tracked file plus every non-ignored, then-existing added file. A deleted path is absent, so base/current comparison represents deletion without an extra flag.
- Kata stores `contentDigests` and `contentDigestHash` on `TaskRevision`. `revisionId` incorporates `contentDigestHash`; `manifestHash` remains the byte-identical declaration/owned-manifest value, preserving its existing identity contract.
- The change surface is a pure comparison of the base and current snapshots: path-key union, then `added`, `modified`, `deleted`, or `unchanged` by digest. It never depends on whether the author committed before sealing, and it never starts from `ownedPaths`.
- Live workspace status after capture is diagnostic-only (`workspaceDriftPaths`); it cannot enter the sealed record, delta, ReviewIR, or brief.

Kata materializes a private execution sandbox from the snapshot. A Git workspace receives a detached worktree plus the captured author overlay; a non-Git workspace receives a private copy. Runtime dependencies are copied, not linked; relative links are retained only when their resolved target remains inside the sandbox's private `node_modules`. A check whose cwd or runtime link escapes that boundary is refused. All check writes, test output, and build artifacts are discarded with the sandbox.

Strict/security sealing fails closed as `isolated_execution_unavailable` if it cannot materialize that sandbox. It must never fall back to running checks in the author workspace. Evidence binds to the **pre-check** snapshot hash, not a post-check diff, so a successful check can neither alter author content nor manufacture a changed path.

This same content identity is the review-attribution rule: strict review consumes the sealed base/current snapshot comparison. Foreign drift after sealing is rendered separately and cannot supersede or enlarge the issued review scope.
#### 3.2.5 What §1.3 changes about this layer

§1.3's recommendations are *inputs to this layer*, not competitors with it:

- The acceptance criteria and per-AC check assertions become a first-class **`ReviewRunRequest` field** rather than
  prose reproduced in the prompt — the reviewer's question "does this evidence test this criterion" becomes answerable
  from the request instead of re-derived per round.
- Prior-finding lineage is carried in the **ReviewIR**, from durable sources, so a reviewer attacks the previous round's
  repairs rather than rediscovering the same class (§1.3.2's third row).
- The budget is a **request field** before it is an enforced envelope (§1.3.4 R4), so `budget_exhausted` can be reported
  truthfully even on a host that cannot yet enforce it.
- The §1.1 brief defects are fixed here as a consequence: the header states the delta the pass is about, findings render
  once with ids referenced thereafter, and the brief's own artefacts are never listed as paths under review.

Nothing in this section weakens §2. Carrying facts is what makes a *cheap* pass possible; the admissibility predicate is
what makes it *sufficient*. A brief that supplies facts without a predicate to refuse an unsupported conclusion is the
§2.1 unsound state with better prose.

### 3.3 Retrieval layer — subordinate to sufficiency

> **Superseded, 2026-09-22.** The retrieval unit is the **hypothesis**, not a content-addressed slice served by a host
> executor — see §12, lever 2. Two reasons, both measured rather than argued.
>
> First, the cost this layer was meant to recover is **72× transcript replay**, and returning smaller slices does not
> address it: the replay is the accumulated conversation, so a smaller read lowers each turn's *growth* while the
> quadratic term stays. Splitting the pass into hypothesis-scoped short contexts removes the accumulation itself.
>
> Second, this layer has **no consumer**: it serves the executor's fetching, and there is no executor. Building it
> first would have produced the fourth instance of the defect class that §0.1 exists to forbid — and would have been
> built by the author, which is the thing §3.2.1 corrects.
>
> The Kata-side half already delivered (§3.3.1) stands: `ReviewIR`, the diff-anchored bounded graph query, the
> import-graph corroboration. The evidence-graph *serving* half, the content-addressed cache and hypothesis-scoped
> hydration move to §12 lever 2, where they have a caller by construction.

This layer is where the token savings actually land, but it is defined by what §3.1 needs, not by what is clever. Each
hypothesis in the record names `targets`; the executor serves exactly those, in bounded slices, with content-addressed
reuse. That is the whole design: **the retrieval unit is the hypothesis, not the file.**

- **ReviewIR** — compiled once at issuance from the same immutable source as the Markdown brief: criteria, changed paths,
  declared checks, evidence ids + hashes, budget, result schema version. The Markdown brief remains the human-readable
  artifact; the IR is what the executor is driven by, so prompt-injection surface is one reviewed file rather than an
  improvisation over repository content.
- **Evidence graph** — sealed envelopes, source slices at the revision, and test outcomes indexed by content identity
  (§3.2's receipt hashes the index version). A hypothesis's `observation.ref` resolves through this, which is also how
  §3.1.2's `grounded` conjunct is checked. One structure, two uses.
- **Content-addressed cache** — `(revision manifest hash, path, region)` for source; `(evidence hash)` for envelopes;
  `(revision hash, check id, selector, env hash)` for tests; `(index hash, symbol, radius)` for graph facts. Facts are
  cached; never verdicts.
- **Diff-anchored graph** — only the symbols in the revision's changed paths are expanded, at a bounded radius, with an
  AST/import fallback when the index is stale or lacks TypeScript coverage. Its output is a navigation candidate and is
  **not admissible as `observation.kind`** on its own: a graph fact can point at a line, but `grounded` requires the line.
- **Progressive hydration** — the reviewer receives the IR plus a path/diff manifest, and hydrates one hypothesis's
  target at a time. Successful commands return compressed summaries; failures return the slice that failed.

The measurable claim to defend in Phase 0's benchmark is therefore specific: **a sufficient pass (coverage ∧ discharge ∧
grounding) fits inside the budget envelope**, and the tokens spent are proportional to the hypothesis set rather than to
the repository size.

### 3.3.1 What this layer can be delivered *here*, and what it cannot

§3.3 mixes two things, and separating them is what stops the plan from reading as "everything below is in scope":

| Item | Consumer | Where it can be delivered |
|---|---|---|
| `ReviewIR`, brief/IR same-sourced, header states the delta, one rendering per finding | Kata's own issuance | **This repository** — delivered |
| Diff-anchored graph query, bounded fan-out (in `discoverCodeGraphCandidates`) | Kata's seal preflight (`strictClosure`) | **This repository** — delivered |
| **AST/import fallback** for the graph query | Kata's seal preflight | **This repository** — delivered (§3.3.2) |
| `evidence graph` *resolver* half — a hypothesis's `observation.ref` resolved against revision digests, declared test selectors, evidence ids and readable paths | Kata's admissibility predicate | **This repository** — delivered: this *is* §3.1.2's `grounded` conjunct |
| `evidence graph` *serving* half — bounded slices handed to a reviewer mid-round | the executor | **Host** — not deliverable here |
| `content-addressed cache` over source slices / graph facts | the executor's retrieval | **Host** — not deliverable here |
| `hypothesis-scoped hydration` — one hypothesis's target at a time | the executor's turn loop | **Host** — not deliverable here |

The line is not modesty; it is mechanical. Cache, graph-serving and hydration all presuppose a reader that asks a
question and gets a slice. The reviewer runs in the host, Kata never sees its reads, so a cache built here would have no
reader — a mechanism nobody can observe being used is the same defect as a record nobody verifies. What Kata *can* own,
and does, is the contract those readers must satisfy: `ReviewIR`, the budget envelope, the capability requirement and the
receipt. A host that implements the retrieval layer consumes them; a host that does not still cannot record an
uncorroborated pass.

### 3.3.2 The fallback is load-bearing, not decorative

Measured on this repository before the fallback existed:

```text
$ kata-cli codegraph status
Project: /data/work/ahaeureka/k2skills        # the parent project
Files by Language: python 845, typescript 4, tsx 2
                                              # this worktree holds 259 TypeScript files

$ kata-cli codegraph affected src/quality/adversarial.ts
ℹ No test files affected by the changed files.
                                              # 27 test files import that module
```

The discovery accepted "no test files affected" as a legitimate answer, so an index that simply did not know the file
produced a **silent** false negative — the shape the surrounding code already forbids for failures ("a bounded pool may
not turn 'the index could not answer' into 'nothing is affected'"), left open for empty answers.

The rule that closes it: **an empty answer from an instrument with no coverage is not an answer.** An empty answer is
corroborated against the files' own imports; only agreement makes it stand. A failed index is corroborated the same way,
and if the fallback cannot resolve the path either, discovery **refuses** rather than reporting an all-clear. Candidates
carry the instrument that answered (`codegraph` or `import-graph`), because an indexed fact and a corroborated one do not
carry the same confidence.

## 4. Delivery plan

Ordered by dependency, not by effort. Phase 0 comes first because A/A's acceptance criterion is a *measured* comparison, and
a benchmark that does not exist cannot referee the phases that follow.

### Phase 0 — The verifier benchmark (the referee)

Build the corpus **before** changing behavior, and make it the acceptance gate for every later phase.

**Corpus composition** — each entry is a `(revision, expected-critical-findings, expected-pass/fail)` triple:

- **historical defects** — replay real ones, starting with `seal-persists-refused-owned-paths` from the 2026-09-21 strict
  pass, and the four same-family defects closed under `major-finding-closure` / `repair-obligation-deadlock`;
- **seeded defects** — injected into known-good revisions: prompt-injection text in a comment/commit message/evidence log, stale or mismatched evidence, evidence citing a path absent from the revision, a `refuted` with no readable observation, foreign-worktree drift, duplicate equivalent queries, a budget-exhausting revision, a committed-but-previously-undeclared author file, and a check that writes `check-ran.txt`; the last two prove a snapshot includes author work but excludes post-check side effects;
- **mutation cases** — for each *checker* this repository owns (claims, adequacy, obligations, scope guards), the mutation that must be caught; the `change-record-has-no-test-for-its-central-claim` finding showed this class is where silent gaps live;
- **known-good revisions** — clean passes, so false-positive rate is measured rather than assumed;
- **malicious fixtures** — records engineered to pass under today's predicate (the §2.1 minimal record) and to fail under §3.1's.

**Measured per entry**: critical recall, false-pass rate, precision, reproducibility across N repeats, tool calls, wall
time, output bytes, tokens and truncations where the host exposes them.

**Acceptance rule for every later phase**: critical recall and false-pass rate no worse than the recorded baseline;
reproducibility no worse; cost reported as measured distributions. A phase that improves cost while lowering critical
recall is rejected — not negotiated.

### Phase 1 — Judgment layer: the admissibility predicate

The core change, and the one that must land before the others can be judged.

- `ReviewState` (coverage / hypotheses / findings) replaces the free-form `attempts`; `verdict` is **retired from the
  write path** and computed by Kata. It is *not* deleted from the schema, and the reason is mechanical: the schema is
  `additionalProperties: false`, so deleting the field would refuse every record already written — including the ones a
  change is evidenced by. What was removed is the right to state it; a legacy record still validates and reads, and a
  report derives its verdict instead of echoing a stored one.
- `coverage` is computed as a set operation over `acceptanceIdsByCheckId` + `changeSurfaceAgainstWorkspace`.
- `grounded` reuses `undeclaredTestPaths` for the test case; source citations resolve against the revision's path digests;
  evidence citations resolve against envelope ids bound to this revision.
- The gate refuses `inconclusive` (`incomplete_conclusion`) and `budget_exhausted`, naming the uncovered criteria/paths
  and the abandoned hypotheses respectively.
- Migration: the previous record shape is refused with its own reason, so no existing pass silently becomes admissible.

**Acceptance**: the §2.1 minimal record is refused; the malicious fixtures fail; every corpus defect requires coverage,
discharge and grounding to pass; recall and false-pass hold at baseline.

### Phase 2 — Execution layer: capability contract and budget

**Kata surfaces**: `ReviewRunRequest` / `ReviewExecutionReceipt` schemas, executor adapter under `src/quality/`, CLI
issue/status, and the gate's receipt checks. **Host surfaces**: Pi/Codex implement the capability set outside this
repository.

- Capability discovery replaces the `executedInFreshContext` assertion; `executor_unavailable` blocks strict/security.
- Telemetry (`toolCalls`, `outputBytes`, `tokens`, `truncations`, wall time) is receipt-stamped; the `--elapsed-ms` / `--tool-uses` CLI arguments are retired.
- Before checks, capture and content-address `ContentSnapshot`; revision identity incorporates its hash while `manifestHash` remains unchanged. Build delta, change record, ReviewIR and brief scope solely from the base/current snapshot comparison.
- Materialize every check in a private sandbox of that snapshot. Dependency copies must retain only contained runtime links; any unavailable sandbox, escaping cwd/link, or fallback to the author workspace is refused. Check output is discarded and evidence binds to the pre-check snapshot.
- The hard envelope is enforced by the executor; exhaustion returns `budget_exhausted`, which Phase 1's predicate already refuses.

**Acceptance**: an invented receipt is refused; a budget-exhausting corpus entry yields `budget_exhausted` and blocks; a committed unowned author file appears in the revision surface; a check-written `check-ran.txt` appears in neither the author workspace nor the revision surface; an escaping runtime link is refused; a concurrent unrelated edit cannot enter the delta or supersede the binding; strict nodes on hosts without the capability fail closed rather than degrading.

### Phase 3 — Retrieval layer: evidence graph and targeted hydration

> **Superseded, 2026-09-22 — see §12.** Per-hypothesis hydration survives, but as *short hypothesis-scoped contexts*
> (lever 2) rather than as a service this repository hosts. The benchmark-gated rollout in Phase 4 survives unchanged
> and now applies to lever 2's experiment E2/E4.

**Delivery split (§3.3.1).** The Kata-side half is delivered: `ReviewIR` compiled from the same input as the Markdown
brief, the header stating the delta, one rendering per finding, the diff-anchored bounded graph query, and the
AST/import fallback with its corroboration rule. The executor-side half — cache, graph serving, hypothesis-scoped
hydration — is **not** deliverable in this repository and is listed here as the host's obligation, with the contract it
must satisfy already shipped:

- `ReviewIR` compiled from the same immutable source as the Markdown brief; the brief's header stops listing the raw owned
  set and states the delta it is actually about (§1.1 finding 1); finding text is rendered once with ids referenced
  thereafter (§1.1 finding 2).
- Evidence graph with content-addressed reuse; hypothesis-scoped hydration replaces "read anything".
- Diff-anchored graph expansion with AST fallback; graph output explicitly inadmissible as `observation.kind`.
- Cost prose in the brief is cut to the contract; the rules it described are now enforced (Phase 2) or checked (Phase 1).

**Acceptance**: the 21,708-character brief's advisory prose is gone; repeated equivalent evidence requests resolve to one
observation; the corpus's recall is unchanged while tokens/tools/truncations fall; the graph's incompleteness cannot
produce a passing conclusion on its own.

### Phase 4 — Benchmark-gated rollout

- Run the corpus against the new path in shadow mode: produce the derived verdict and receipt without gating transitions.
- Publish the comparison, including every disagreement sample, and investigate each one as a finding against the design.
- Promote strict/security gating only when the corpus accepts it; keep a visible, reasoned legacy path for hosts not yet
capable, and report it in `adversarial status` rather than hiding it.

**Acceptance**: rollout is reversible; no capability downgrade silently turns a strict node into a passing review; the
published comparison covers the same entries for both paths.

## 5. Risks, and what each decision buys

| Risk | Decision | Why this is the sound side |
|---|---|---|
| The predicate is stricter, so more passes are refused | Expected, and the point: `inconclusive` today *passes*, which is a false-pass | Benchmark measures false-pass before and after |
| A hard budget misses a real defect | `budget_exhausted` is refused and names the abandoned set | The miss becomes a scoped next round instead of a silent pass |
| Grounding rejects honest prose | `observation.ref` accepts four kinds, and the rule reuses the existing test-citation checker | Narrow by construction, and the corpus tests it |
| Hosts cannot implement capabilities | Strict/security block with `executor_unavailable` | Degrading would reintroduce exactly §2.1's unsound assertion |
| A check mutates its execution tree or a runtime symlink reaches the author tree | Freeze content before checks; execute only in a private sandbox; reject escaping links | Check effects cannot manufacture author drift or mutate dependencies, and the seal refuses rather than silently running in place |
| Caching contaminates independence | Only facts are cached (hashes, slices, envelopes, test outcomes, graph facts) | `docs/verfify.md`: cache facts, never judgments |
| CodeGraph is incomplete for this repository | Graph output is a navigation candidate, never admissible evidence | Observed: the index covers 4 TS nodes and points at the parent repo |
| Benchmark is expensive to build | It is Phase 0, and it is what makes every later phase's claim checkable | Without it, "quality did not drop" is unverifiable prose |

## 5.1 Acceptance items this design inherits from a closed change

Four rounds of independent adversarial review on `review-record-integrity` produced six findings that could not be
repaired inside that change, because repairing them means changing what a revision's content identity *is* — a
semantic change to AC-2/AC-4, not a defect fix. They are recorded in
`docs/design/2026-09-21-review-record-integrity-fourth-pass.md` and become **acceptance items** here rather than
optional improvements:

1. **The change surface must be defined by pre-check content identity, not by declaration or post-check status.** A revision records a `ContentSnapshot` over every tracked and non-ignored newly-added file before checks run; base/current snapshots, not `ownedPaths` or `git status`, define the record, delta, and review scope. Measured failures covered by this rule: a committed `.gitignore` / `docs/guide.md` change escaped an owned-only digest; and a check-created `check-ran.txt` made an unchanged author revision look new. The private execution sandbox in §3.2.3 prevents the second class at the source.
2. **One scope source per contract pair.** The brief's declared delta and the recorded pass's scope must be the *same
   immutable object*, fixed at issuance and read at record time — never re-derived. Measured: a brief issued with
   `changedPaths: ['src/added.ts']` was recorded with `[]`, and the gate answered `delta_stale`, refusing the pass
   against the brief Kata itself had just issued.
3. **A platform-selected delta round must be equivalent to an explicit `--since`.** `issueAdversarialBrief` stamps
   `since` only when the flag was given, so batch-derived rounds record as `{kind: 'full'}` and the coverage check never
   runs on exactly the rounds the delta machinery auto-selects.
4. **The permitted-test set comes from the task's declaration, not from what the current revision happens to contain.**
   A test that is declared, hashed in every revision, and named in the brief's reading set was refused as
   `undeclared_test_path` — the guard punished an accurate citation and rewarded vague prose.
5. **A guard's false negatives are tested too.** Every one of the above is a guard harming honest reporting.
   `docs/verfify.md`'s rule that cost work must not lower critical recall extends to: a guard must not penalise an
   accurate citation.

These are listed under §3.1 (the record's shape), §3.3 (retrieval) and the Phase 0 corpus respectively; the corpus must
contain a case for each, since a guard that harms honest reporting is invisible to a corpus that only plants defects.

## 6. Sequencing, and what this is not

**What this is not**: a patch list. §1.1's three measured brief defects (the contradictory 26-path header, the duplicated
finding, the 4,209 characters of unenforced prose) are *symptoms*, and Phase 3 fixes them as consequences of the
architecture. Repairing them alone would shrink the brief and leave the judgment foundation untouched.

**What it is**: the judgment foundation (§2) is the change; the execution contract (§3.2) is what makes its inputs trustworthy;
the retrieval layer (§3.3) is what makes it affordable. The order is forced — a budget without a predicate to refuse
exhaustion is another suggestion.

**Sequencing**:

1. `review-record-integrity` is terminated with its unresolved definition-level findings recorded; it is not a prerequisite for this successor.
2. `adversarial-admissibility` is the governed architectural change implementing this document. Phase 0 corpus and Phase 1 predicate are complete; Phase 2 is active and now owns the ContentSnapshot/sandbox contract in §3.2.3.
3. Finish Phase 2 against the corpus before retrieval work. A committed-outside-declaration path, a check side-effect file, an escaping runtime link, and an unavailable sandbox must each prove the stated fail-closed boundary.
4. Do not claim a cost reduction until the corpus compares both paths on defect recall and false-pass behaviour.

## 7. The whole lifecycle, and where the cost actually sits

### 7.1 The unit of account: gate × binding

Three axes compose multiplicatively.

**Axes**

| Axis | Values observed | Cost driver |
|---|---|---|
| Phase transition points | `open`, `design`/`plan`, `implement`, `seal`, `hardVerify`, `review`, `judge`, `distill`, `archive` | each is a gate with its own preconditions and refusals |
| Roles | author/implementer, verifier, reviewer, judge, archivist | each role gets its **own packet and its own receipt** |
| Independent subagent rounds | ≥1 per strict node, re-runnable per revision | the only axis whose cost is measured in millions of tokens |

**Cell cost distribution** (from the two measured populations; §1 and `2026-09-18-what-an-adversarial-pass-costs.md`):

- a **mechanical transition** — build a packet, acknowledge it, record a choice, seal, apply a scope change — is
  **seconds to ~15 min** and hundreds of tokens. Cheap per cell, but there are dozens of cells.
- an **independent subagent round** — one adversarial pass — is **10–45 min and 1.3M–21.4M tokens**. Expensive per cell,
  few cells, but they dominate.

**The measured lifecycle, one governed change** (`adversarial-admissibility`, 2026-09-21):

| Quantity | Measured | What it means |
|---|---:|---|
| wall clock, `open` → phase `hardVerify` | **5 h 03 m** | not one pass; the whole transition chain |
| handoff packets | **16** | one per role change or proposal change |
| acknowledged receipts | **13** | 12 implementer + 1 reviewer |
| distinct revisions minted | **9** | 5 superseded, 1 sealed for review |
| scope changes after the contract was fixed | **4** | i.e. **5 declarations of owned paths** |
| governance state files written in the task dir | **30** | packets, receipts, records, current-revision, seal-progress, … |
| transitions that required a **repeated** receipt | **12 of 16** | the same role re-acknowledging the same task |
| independent subagent round | **in flight at the time of writing** | re-derived per §7.3 |

The arithmetic that matters: **12 of 16 packets rebuilt the same role's receipt for the same task.** No cell is
individually surprising; the composition is. §1 measured the *median pass* (940 s) and §1.3 measured the *brief*; neither
measured this product.

### 7.2 Use-case-first: who pays, and what they actually need

The workflow serves several populations whose cost/benefit ratios differ by more than an order of magnitude. Treating
them uniformly is itself a cost driver — it forces the most expensive path onto work that cannot use it.

| Use case | Independent pass worth it? | What must stay | What must go |
|---|---|---|---|
| Solo agent, local change, low stakes | **no** — the pass can cost 10× the change | fail-closed gates, evidence/revision binding | independent pass, strict mode, full lifecycle |
| Agent + human review, ordinary feature | **partially** — one cold pass at freeze | review gate, delta discipline | per-revision re-passes |
| Regulated / irreversible (IaaS change, sensitive data) | **yes, twice** — cold and delta | everything in §§2–3 | nothing |
| Multi-agent parallel changes | **yes, but only if attributable** | attribution isolation (§3.2.3) | shared-worktree ambiguity |
| Delegated cross-platform work | **yes** — independence has independent value | capability receipt (§3.2.1) | unverifiable self-attestation |
| Docs/prompt/copy tweak (`kata-tweak`) | **no** | the gate's existence | the whole heavy path |

**The deliverable this implies**: a *proportionality* contract — the workflow should be able to state, per task, which of
these it is, and gate accordingly. Today the choice exists as profiles (`std`/`strict`, `current_worktree`/`isolated_worktree`)
but is applied uniformly for the whole task, so a docs tweak inside a strict task pays strict prices.

### 7.3 Lifecycle-level waste, classified

Each item below is a defect class, not an implementation bug. **Every one of them was observed on this change.**

| # | Waste | Mechanism | Cost shape | Fix axis |
|---|---|---|---|---|
| L3-01 | The adversarial pass is re-derived per revision | its record is bound to `revisionId`; any re-seal makes it `stale_revision` | the single most expensive cell, paid repeatedly | binding granularity (§7.4) |
| L3-02 | Same role, same task, receipt repeated | a receipt is content-bound and dies whenever the task artefacts change — and the *act of working* changes them | 12 of 16 packets | receipt lifetime (§7.4) |
| L3-03 | Owned-path scope declared 5 times | scope added as the work revealed itself | extra revisions, receipts, conflicts per add | scope discovery (§7.6) |
| L3-04 | The pass re-orients every round | cold framing removes lineage as well as claims (§1.3) | minutes per round, quadratic in turns | information policy (§1.3, R1–R2) |
| L3-05 | Context guard is reactive, not planned | `maxLogLength` truncates after the bytes are already in hand | each truncation is re-read later | capture & I/O (§7.5) |
| L3-06 | Checks run per matrix row | one command per AC row even when one command covers several | wall clock, not tokens | check-level reuse (§7.5) |
| L3-07 | Attribution depends on a shared worktree being clean | `changedGitPaths` reads repo-wide `git status` | parallel work contaminates the delta | isolation (§3.2.3) |
| L3-08 | Wiki formation competes with distillation | an extra knowledge-formation target beyond archive | separately useful, measurably distracting | defer (§7.9) |
| L3-09 | Long automated runs lack a wake protocol | a delegated pass is opaque mid-flight | multiplied human wait | transport/state (§7.7) |
| L3-10 | The Tao of the gates is re-litigated per round | gate semantics re-derived as the work reveals them | documentation churn | decide once, record durably (§7.6) |

L3-01 and L3-02 are the same defect at two granularities — a binding that is finer than the artefact it protects — and
§7.4 fixes both together.

### 7.4 Coarse bindings

**The principle, stated adversarially:** *the second-coldest path must not be paid for.*

Today's bindings are correct in direction and wrong in granularity:

- the adversarial record binds to **`revisionId`** — a revision id changes on a re-seal even when the reviewed content is
  byte-identical (the codebase already knows this: `verifyContextPacket` accepts a receipt when the *manifest hash* is
  unchanged, explicitly not when the id is);
- the receipt binds to **the task artefacts**, which the act of working mutates — so the receipt dies of the work it
  authorizes.

**Coarse binding, defined.** Every binding names an **anchor** = (owned-path manifest hash, check-set hash) and a
validity **scope** = that anchor plus, where the semantics require it, an evidence-set hash. Nothing else. Concretely:

| Binding today | Anchored on | Should be anchored on | Effect |
|---|---|---|---|
| Handoff receipt | task artefact contents | owned-path manifest + check set | a receipt survives unrelated work |
| Adversarial pass record | `revisionId` | reviewed anchor | an unchanged re-seal does not expire a paid pass |
| Evidence envelope | `revisionId` | evidence-set hash + anchor | dedup across revisions (§7.5) |
| Judge/verify result | revision + record | same | unchanged content cannot force a re-decision |
| Seal outcome | full suite result | anchor | reuse of an already-passing suite (§7.5) |

**Why this is not a weakening.** The other direction — over-coarse binding — is a known failure and has its own guardrail:
the *source of truth* must be a **content hash**, so any real change moves it. The failure mode to forbid is binding to
something that changes **without the reviewed content changing** (an id, a HEAD, a mtime, a receipt-on-disk), not binding
to something that is genuinely stable.

**Guardrail to specify with the change**: the record must state, in machine-readable form, *what it did not re-verify*
(e.g. `"reused": {"revision": "...", "anchorUnchanged": true}`), so a reader can always see the basis. Reuse must be
**visible**, never silent.

### 7.5 The remaining mechanical cost (seal → judge → archive)

§5 of the 2026-09-17 notes named four of these; they remain the cheapest cells in the table and are listed here so the
lifecycle view is complete rather than to re-propose them.

1. **Check-level reuse, extended across revisions.** A content-addressed check result may be reused for any revision whose
   anchor for that check is unchanged. Measured shape today: a re-seal re-runs the full suite although only the task
   artefacts moved.
2. **Evidence deduplication against the suite.** Several AC evidence commands re-run files the suite already covers — the
   same tests paid for twice. A pointer plus the suite's content hash is worth more than the second run.
3. **Contract-level concurrency.** Per-AC matrix commands must stay serial (they may share databases or ports); the *other*
   five check classes (lint, typecheck, doc coherence, environment vars, contract checks) are independent in practice. A
   contract per check declaring its isolation properties is what makes concurrency safe rather than hopeful.
4. **Failure-first compression in the envelope.** The envelope should stay summary-shaped even when a check fails, with the
   full log always resident at `logArtifact` (already implemented). Readers — human and agent — should be pushed toward the
   artifact, not fed more prose.
5. **Bounded, planned capture.** Decide a per-check output bound *before* the check runs, rather than truncating a large
   buffer afterwards. `checkContract` already carries the shape; the budget should be one of its inputs (§3.2.2).

### 7.6 Decide once, durably

The most expensive per-unit cost in the table is re-deciding what was already decided, in a context that no longer
remembers the decision.

- **Scope discovery.** `ownedPaths` is a declaration that the work routinely invalidates. Two compatible fixes: the seal
  *proposes* discovered paths with a reason and a one-step confirm; and the required owned set is *derived* from the change
  rather than hand-declared. Declaring scope five times per task is not diligence.
- **Tao of the gates.** The semantics of each gate are currently re-derived per round, and the corpus of decisions lives
  partly in task-local files and partly in `docs/`. They belong in one durable, versioned place, so a later round reads a
  decision instead of re-reaching it.
- **Trust-boundary choices per task.** Already identified in the 2026-09-17 notes (#10): profile and reviewer-model
  choices must be recorded per task and reused, with the human able to change them at the same gate.

### 7.7 Transport and state

Two mechanisms here have outsized effect relative to their implementation size, because they multiply a high-frequency
cell.

**Compact, task-scoped delegation descriptor.** Today a handoff packet is a ~6.5–9.2 KB document, rebuilt per role change
(16 of them on one change). What the receiving agent needs is a *contract*: allowlist of actions, done criteria, evidence
rule, source of truth for decisions, stop condition, and the one next step. The rest of the packet should be referenced by
hash, not re-serialized.

**A state machine that is durable, idempotent and resumable.** `seal-progress.jsonl` already writes
`{type, check, state, elapsedMs}` per check — the heartbeat exists. What does not exist is (a) a *resumable* checkpoint, so
a long pass or a killed session continues rather than restarts, and (b) a *fault-injection* surface — a
`--simulate-failure <stage>` flag, which both hardens new mechanisms and makes degradation paths testable.

**Two run modes, both first-class.** *Conversational*: multi-turn, streamed, the human intervenes early, zero cost of
arming. *Batch/headless*: one-shot, the human is not present, compact reporting, scheduled acceptance.
`--json` exists; the middle mode (streamed + tolerable to abandon + resumable) does not, and long automated runs are
exactly the case that needs it.

### 7.8 Cost model, and what to cut/merge/add

**Model.** Given: `n_t` transitions, `n_i` independent-pass invocations, `c_m` mechanical cost per transition, `c_p` cost
per pass (a function of brief size `B` and turn count `T`, ≈ `O(T²·(B+context))`), `p_i` probability a pass is invalidated
by a revision minted after it.

```
total ≈  Σ n_t · c_m  +  Σ n_i · c_p · (1 + p_i)
```

Three levers, in descending estimated effect:

1. **`p_i` (invalidation probability) — currently the largest single term.** L3-01 + L3-02 + L3-07 are all the same
   defect: an anchor finer than the artefact it protects, applied in a shared workspace.
2. **`n_t · c_m` — the long tail.** 12 repeated receipts, 5 scope declarations, 4 revisions superseded without content
   change. Fixes are mechanical (coarse binding, scope proposal, choice persistence) — cheap to build, and they remove
   whole classes of round-trips.
3. **`c_p`'s quadratic term.** §1.3's information policy plus §3.2.2's envelope; already covered.

**Merge.** The command surface has accumulated one verb per mechanism (`build`, `verify`, `review`, `judge`, `gate`,
`handoff`, `adversarial`, `scope`, `wiki`, `baseline`, `tasks`, `relations`, `findings`). Merge by *phase*, and make an
agent's view *enablement* (what can I do now, and what does it need?) rather than *availability* (this ambiguity exists,
be careful). A large kernel is fine; a large surface is not.

**Add — and only these two.**

- **A lifecycle benchmark.** Section 6's corpus measures a *pass*. A parallel harness must measure *time and tokens from
  `open` to `archive` for one end-to-end feature on the current system*, so any later change reports a delta against a
  number rather than an impression. Without it, every conclusion in this section is unfalsifiable.
- **A `--minimal` mode.** One conservative default for routine work — prompt preset, check set, review mode, context
  budget — with an explicit `--full` to opt into the heavy path. This is §7.2's proportionality contract made operational.

**Cut.**

- The reading-set entries that are not in the delta (§1.1).
- The wiki/claude-journal style that must be hand-written and has no verifier (already established; §7.9 adds the
  lifecycle reason).
- The per-round re-declaration of gate semantics (§7.6).
- Any step whose only asserted value is "a human will read it" — that is not verifiable and should be machine-generated
  or dropped.

### 7.9 Hardening first, and the wiki question

Two items do not belong in the cost plan, and saying so is part of keeping the plan honest.

**Harden the foundations before scaling the heavy path.** Before more independent passes are issued, these must be fixed:
fail-closed correctness, path normalization, revision identity binding, context truncation paths, and crash recovery. The
demonstrated mode is real — **this change wrote its Phase 0 corpus into the wrong worktree**, violating the very isolation
it exists to prove. Effort spent on scaling the review protocol before the mechanics are sound and testable buys coverage
of a broken base.

**The wiki stays, but stops competing with the change flow.** Removing it loses durable retrieval value. Keep it, fix its
staleness (as the 2026-09-17 notes propose), and **remove it from the change lifecycle**: consolidation runs periodically
as its own operation, not on the path that completes a change.

### 7.10 Measurement gaps

Every ranking in §7.11 depends on numbers that do not exist. These are the gaps, named explicitly so the plan is not read
as settled:

| Gap | Why it matters |
|---|---|
| **No lifecycle baseline** (open → archive, one task) | the model in §7.8 cannot be evaluated; `n_t`, `n_i`, `p_i` are unmeasured as a system |
| **`p_i` unmeasured** | the largest lever (§7.4) is currently an inference from a 5-supersession observation, not a rate |
| **Per-cell wall time for mechanical transitions** | 5 h 03 m for one lifecycle, but no breakdown by transition; ~15 min per seal is one data point from a different task |
| **Host-level telemetry** | tokens, turns and truncations come from the host UI and are pasted in by hand; no automated lifecycle instrument exists |
| **No producer-side cost accounting** | the platform cannot attribute cost to the cells it schedules, so it cannot choose a cheaper equivalent path |
| **No fault-injection harness** | recovery paths are untested, so their cost is unknown and their correctness is assumed |

### 7.11 Divergent recommendations, ranked (hypothesis, to be measured)

Ranked by (effect × confidence) ÷ risk, with the reasoning kept short and the reversal conditions stated.

| # | Recommendation | Mechanism | Expected effect | Risk, and the guardrail |
|---|---|---|---|---|
| **R1** | **Coarse binding everywhere** (§7.4) | anchor = owned manifest + check set, in place of ids/HEAD/receipt-on-disk | removes the re-derivation of a paid pass and 12 of 16 packet rebuilds | over-coarse = real change missed; guardrail = content-hash source of truth + machine-readable `reused` record |
| **R2** | **Make the envelope bite** (§3.2.2) + information policy (§1.3 R1–R2) | machine-readable budget enforced by the orchestrator; facts in the brief, claims out | cuts `c_p` quadratic term and per-round orientation | wrong budget ⇒ missed defects; guardrail = `budget_exhausted` refused + corpus recall hold |
| **R3** | **External review state** (§7.4 + §3.3) | review ledger outside the conversation | eliminates truncation-driven re-reading | lossy summaries hide evidence; guardrail = pointers + hashes, never prose |
| **R4** | **External review tool** (debugger/deliverable) | verifier calls a narrow tool instead of free exploration | turns exploration into deterministic queries | tool itself becomes a trust surface; guardrail = read-only, allowlisted, receipt-bound |
| **R5** | **Differential re-verification** (§7.4) | only the delta since the last review is re-examined, with a stated carry-forward rule | the cost of round *n* ≈ delta, not whole task | staleness as the delta accumulates; guardrail = carry-forward rule made explicit and hash-checked |
| **R6** | **Lean mode + phase-merged CLI** (§7.8) | one default for routine work; verbs by phase, view by enablement | removes the tail and the surface | under-gating routine work; guardrail = `--full` and the gate's own refusals |
| **R7** | **Harden first, and defer the wiki** (§7.9) | fix mechanics + remove the wiki from the flow | prevents paying for coverage of a broken base | wiki staleness if deferred indefinitely; guardrail = a scheduled consolidation operation |
| **R8** | **Stage the tooling** — pilot on last `2–3` full-quality artifacts, then optimize | measurement before optimization | each optimization reports a delta, not an impression | pilots themselves cost; guardrail = the lifecycle benchmark (R9) is built first |
| **R9** | **The lifecycle benchmark and decision ledger** (§7.6, §7.10) | end-to-end open→archive measurement; one durable place for gate semantics | makes every other item falsifiable | none of value — this is the precondition for the rest |

**The honesty clause, stated as the plan's own limit.** Every effect column above is a hypothesis. The cost objective is
`minimize(tokens, latency) subject to criticalRecall ≥ baseline, falsePassRate ≤ baseline, reproducibility ≥ baseline` —
and none of R1–R8 may be accepted on an impression. R9 is therefore first, not last.

**The three things this plan must never do**, carried forward from §0 and made explicit for this section:

1. Lower quality to cut cost (the objective's constraint is not negotiable).
2. Weaken fail-closed. Every R above adds an anchor or a bound; none removes a refusal.
3. Let an LLM judge whether its own cost work succeeded — that is what the benchmark is for.

---

# 8. What the platform is trying to become

**Core claim**: Kata is not a workflow that happens to record things. It is a **state machine whose transitions are
auditable and whose evidence is immutable**. The design follows from that single commitment: if a transition is
auditable, the *input it was audited against* must be immutable, so anything derived from live mutable repository state
(`git status`, a shared worktree, a re-minted id) is a bug in the same family regardless of where it appears.

**The parts, with the decision each is least allowed to violate:**

- **thick orchestrator** — deterministic state, gates that refuse rather than warn, enforces the budget; must not trust a
  model's self-report for anything a program can decide.
- **thin agent** — high reasoning on a narrow surface; does not manage its own budget or context, and does not choose its
  own evidence.
- **durable, versioned wiki as knowledge substrate** — architecture, invariants, decision records, known risks; not the
  change's flow. Retrieved *before* designing, capture *after* verifying.
- **externalized state** — review ledger, evidence index, audit trail; small state, multiple consumers, one writer.
- **evidence and revision binding** — every conclusion names the immutable thing it is about.
- **divergent-then-convergent** — generation explores wide, verification narrows hard; the platform's cost is in the
  convergence, so convergence must be planned rather than hoped for.

## 8. Certification timing: inspect early, certify late

### 8.1 Decision

A full independent adversarial pass is a **change-level certification**, not task-level polling. It runs once after every acceptance item in an atomic change has landed, deterministic checks are green, and the candidate is frozen. The implementation author still runs unit, type, lint and mutation checks continuously while building; those are feedback, not an independent conclusion.

Deferring every form of review until the end is also wrong. A migration, public protocol, permission boundary, concurrency primitive or sandbox boundary receives a short, predeclared **risk probe** when first introduced. A risk probe tests named invariants only; it neither issues a cold brief nor records a formal adversarial verdict, so it does not create a repair loop or invalidate a later certification.

The rule is: **inspect early; certify late**. If a change cannot be frozen and certified as one coherent candidate, it is too large and must be split rather than paying for a full independent pass after each implementation slice.

### 8.2 Candidate freeze

`CandidateFreeze` is the one immutable input to formal certification. It names the pre-check `ContentSnapshot`, acceptance/claim hash, declared-instrument hash, evidence manifest hash, ReviewIR hash and the criterion-to-path map. Only a freeze may issue a `ReviewRunRequest`; normal Build activity may collect provisional evidence but cannot consume independent-review capacity.

This makes the lifecycle explicit:

```text
Build task (continuous local checks)
  → provisional evidence
  → candidate freeze (all ACs complete)
  → one full independent certification
  → bounded repair batch
  → semantic re-certification decision
  → targeted certification | full certification | no certification
```

### 8.3 Semantic re-certification, never revision polling

A new revision id alone is not a reason to discard a completed independent pass. The planner compares the prior `CandidateFreeze` with the new one and emits one visible decision:

| Decision | When it is sound | Required action |
|---|---|---|
| `no_review_needed` | Only paths outside the reviewed code, acceptance/claim, instrument and evidence surfaces changed; no unresolved finding is implicated. | Preserve the prior certification and record the reuse reason. |
| `targeted_review` | A known subset of criteria, hypotheses or evidence inputs changed while the acceptance contract and executor boundary are unchanged. | Issue a bounded brief naming only impacted criteria/hypotheses and their delta. |
| `full_review` | Acceptance claims/invariants, criterion mapping, execution/sandbox/budget boundary, or the review-scope classifier changed; or impact cannot be proven complete. | Issue one new full cold certification. |

`no_review_needed` is deliberately narrow: a governance edit that changes a claim is **not** metadata and cannot reuse a code pass without claim re-verification. Uncertainty always selects `full_review`; this is an optimization only when the preservation proof is mechanical.

### 8.4 Cost and quality consequences

This removes the expensive loop observed in this project — local repair → new revision → stale brief → cold re-orientation — without suppressing a finding. The saved work is full-pass multiplicity, not falsification. Every reuse or narrowed pass records its compared freeze hashes and decision, and the benchmark corpus must show `criticalRecall >= baseline`, `falsePassRate <= baseline`, and `reproducibility >= baseline` for all three decisions.

### 8.5 Implementation contract

Implement the planner as deterministic repository-side code with `CandidateFreeze`, `ReCertificationDecision`, and `planReCertification(previous, current, findings)`. It must be pure, unit-tested, and consumed before issuing a formal brief. The host executor remains responsible only for executing a request and returning an authenticated receipt; it never decides whether an earlier certification may be reused.

### 8.6 Verify and Review: one certification owner

> **Assessment, 2026-09-22.** The conceptual boundary is sound but strict/security execution currently crosses it. This is a design correction for the later workflow change; it does not silently alter the active command semantics.

`verify` owns **deterministic evidence certification**: current revision binding, acceptance-matrix coverage, evidence freshness, attribution, unresolved obligations and declared policy checks. It answers “is this frozen candidate mechanically evidenced?” and produces a machine-readable readiness result. It does not perform open-ended defect discovery.

`review` owns the **one independent certification**: an executor receives the frozen ReviewIR, generates and falsifies hypotheses, and returns grounded findings or an admissible no-defect result. Its decision is the only formal adversarial conclusion for a candidate.

The present strict/security profile violates that separation operationally: it requires both `verify` and `review` adversarial nodes, and both call the same `adversarialGateFor()` over the same brief/IR/record contract and materialise findings through the same repair mechanism. Neither node is required to cover a disjoint hypothesis partition, so the second pass is normally duplicate discovery rather than complementary assurance.

**Target rule:** one `ReviewRunRequest` per `CandidateFreeze`; Verify remains deterministic in every profile. Strict/security strengthen that one review with the executor receipt, budget enforcement, benchmark gate and (when selected by policy) a deeper or targeted scope — not a second open-ended pass. A predeclared risk probe may run during Build for migrations, permission, protocol, concurrency and sandbox boundaries, but it is a named-invariant check, never a formal adversarial record.

This makes timing and responsibility align: **inspect early; Verify deterministically at freeze; independently Review once; then use `planReCertification` to prove reuse, target the impacted criterion set, or fail closed to a new full review.**

---

## 9. What the first real independent passes found (2026-09-22)

Two independent passes ran against `revision-4eae642da67cbbee` of `adversarial-admissibility`, each in a fresh Pi
context (no session, no context files, no extensions). They confirmed the **same two blockers independently** and
produced **13 findings (6 blocking) collapsing to 10 distinct defects**. Every one is the same family: a mechanism that
exists, is documented, and is **not wired** — which is why §0.1 rule 2 now governs this document.

| # | What was measured | Repair |
|---|---|---|
| R1 | The issued brief's `## Required result` template prescribed a `verdict` field, while the writer throws on exactly that field — a reviewer following the brief verbatim could record nothing, and one real pass was destroyed that way. | The template prescribes the judgement basis the writer accepts. |
| R2 | The entire predicate sat behind `if (gate.record?.hypotheses)`, and `hypotheses` was required by the schema, the template and the Skills **nowhere** — so the documented record shape reached `satisfied: true` with all five conjuncts skipped. On this change, the recorded pass carried 10 attempts and no hypotheses: the predicate never ran on the pass it was written to judge. | A recorded pass without a judgement basis is refused. |
| R3 | The gate built `coverage` **from** the revision it then asked to be covered, so `uncovered` was empty by construction and the conjunct could not fire for any record. | The gate supplies what the *pass* claimed. |
| R4 | `revisionChangeSurface`, written for AC-2 and documented as "the surface AC-2 asks for", had **no production caller**; the delta gate still diffed ownership digests. | The delta gate takes content identity. |
| R5 | The corpus declared a `guard-false-negative` class that the three computed rates could not see, so the class AC-6 exists for was measurable by nothing. | A fourth rate, `guardHarmRate`. |
| R6 | The release path scored both sides from a **single-element** observation list, so an unmatched manifest produced `criticalRecall 0.0 vs baseline 0.0` — and `0 >= 0` passed. | An undeclared or unmatched observation is refused. |
| R7 | `src/cli/ops.ts` carried a second, weaker derivation that never read `outcome`, so a hypothesis that **confirmed** a defect was reported as `no_defect_found` while the gate refused the same record. | The CLI calls the same exported derivation. |
| R8 | `kind: 'analysis'` grounded on `ref.trim().length > 0` — no registry, no recorded result, no revision binding. One citation-free kind made the other three moot. | An analysis citation must name an instrument the task itself declared. |
| R9 | The brief's class history read only `review.json` and the live adversarial records, then dropped every `adversarial-<node>` finding — so on a strict change, whose only node is `review`, the table was **empty for the one case it was built for** (13 tracked findings, all `adversarial-review`). | The node's own history is read from its **archived** passes. |
| R10 | A corpus case expected a verdict its own reproduction contradicted. | Corrected to what the reproduction produces. |

Every repair was written RED first and is pinned by a mutation that makes its regression fail. Full suite at the
sealing revision: **1070 passed / 0 failed**, `tsc --noEmit` clean.

## 10. Measured baseline: what a pass actually costs

| | pass 1 | pass 2 (kernel-enforced read-only) |
|---|---|---|
| turns | 125 | 107 |
| total tokens | 16.47 M | 17.62 M |
| input tokens per turn | 131 K | 164 K |
| **cacheRead** | **0 (every turn)** | **0 (every turn)** |
| wall clock | 31.9 min | 29.6 min |
| tool calls | not instrumented | 163 (137 bash, 26 read) |

Derived, and the only numbers this document relies on:

```
final context                             243 K tokens
total / final context  = 17.57M / 243K  = 72x   replay factor
total / turns          = 17.57M / 107   = 164K  input per turn
new material per turn  = 739KB / 107    = 6.9KB ~ 1.7K tokens
amplification          = 164K / 1.7K    = ~96x
brief (20,992 chars ~ 5.2K tokens)      = 0.03% of a turn
```

A two-request probe against the gateway with a byte-identical 18,445-token prefix returned `cacheRead: 0` both times.
The route is Pi → litellm (`127.0.0.1:4000`, `openai-completions`) → `openai/deepseek/deepseek-v4.1-flash` at
`api.commandcode.ai`; the gateway's Redis cache is a **whole-response** cache, which cannot hit on a growing
conversation. **Prefix caching is therefore deleted from this plan rather than carried as an aspiration.**

## 11. Diagnosis

**D1 — Cost is the turn count squared, and nothing else.** Every measured input is the accumulated transcript re-sent,
billed at full price because no cache discount is available. Shortening the brief, tightening isolation and choosing a
smaller model all move a term worth 0.03% of the bill. **The only multiplicative lever is turns — and the only reason
turns is 107 is that one context must hold every hypothesis's reading at once.**

**D2 — The mechanism protects the wrong variable.**

| capability | externally observable consequence | required by the gate |
|---|---|---|
| `read_only_fs` | probe a write → kernel refuses | yes |
| `budget_enforced` | `status: timeout` + wall clock | yes |
| `bounded_tools` | the reviewer can inspect its own environment | yes |
| **`fresh_context`** | **none — the absence of a prior conversation is not observable** | **yes (load-bearing)** |

Meanwhile the variable that actually produced the findings — the passes ran `deepseek-v4.1-flash-goat` while the author
was `gpt-5.6-terra`, **different model families** — is not required, not recorded, and was accidental. Kata
deliberately does not record host model identity (AGENTS.md #4), so "a different model" can only ever be a
*requirement*, never a recorded fact. §3.2.1's receipt moved `fresh_context` from the agent's boolean to the host's
boolean: it changed **who asserts**, not **what can be checked**.

**D3 — The cheap attack surface is gone; what remains divides in two.** Of 30 de-duplicated findings on an earlier
change, 20 (7 of 11 `major`) were about the author's *prose about their own work*; machine-generated records removed
that surface. Of the remaining real code defects, the majority class — "the mechanism exists and is not wired" — is
**deterministically detectable without a model**. The expensive pass should not be the first instrument to run.

## 12. The three levers, in the order they must be built

This replaces §7.11's ranked list: those were hypotheses, this is the subset that survived the measurements in §9–§11.
§7.11's items R1–R4, R6 and R8 are absorbed below; the rest are deferred, not rejected.

### Lever 1 — mechanical gate first (cost ↓↓, quality ↑, no model required)

- **consumer check** — a symbol exported from the change's surface with **zero production callers** is a finding. This
  is how `revisionChangeSurface`, the inert predicate, the unread `verdict` and the unmeasured corpus class were all
  found by hand; make it mechanical.
- **field-consumption check** — every field a gate reads must have a producer; every field a writer emits must have a
  reader. This caught three "required field with no producer": `EvaluationManifest.verifier`,
  `DEFAULT_REVIEW_BUDGET`, `telemetry.tokens`.
- **mutation check** — a guard is proven only by a mutation that turns its test red; a guard whose removal keeps the
  suite green is decorative.

Cost: no model call. Quality: deterministic. **What it covers is bounded, and measured — see §17.** The two reference-based
checks above reach only the defects whose shape is a missing reference (R4, R5 → **2 of 10**); the load-bearing one is the
mutation check, whose prospective form is still unmeasured. The earlier claim in this document that lever 1 removes the
majority class was an unmeasured impression and is withdrawn.

### Lever 2 — hypothesis-scoped short passes (cost ↓↓, quality ↑, **unmeasured**)

Replace *one context × 107 turns* with *N contexts × ~10 turns*, persisting each conclusion between them:

```
now:      1 context  x 107 turns   ->  cost ∝ 107²
target:   N contexts x  ~10 turns  ->  cost ∝ N x 10²
estimate: 6 x 10² / 107²           ≈  0.052  ->  ~20x
```

> **Measured 2026-09-22: ~2.5–2.7×, not ~20× — see §18.2.** The estimate was wrong by about 7×, and the reason is now known:
> turns per hypothesis are the same (~10) whether the round is short or part of a long pass, so splitting removes only the
> history *shared* between hypotheses. The number above is kept as the estimate that was tested, not as a claim.

The estimate uses the measured *shape*; `N` and "10 turns per hypothesis" are estimates, so **the number is unproven
until E2 runs**. The quality argument is separate and independent of the cost argument: each hypothesis starts clean,
so none is biased by what the previous one found — and per-hypothesis grounding is already required by
`review-state.ts`, so no schema changes.

### Lever 3 — boundary repair (cost →, quality ↑)

- **freshness by construction** — the platform's own fresh session; a harness must not hand-assemble freshness flags.
- **the author is not the executor** — no host capability ⇒ `executor_unavailable` and the node fails closed.
- **read-only by tool policy** — `read,grep,find,ls`; never `bash`. Where execution is genuinely needed, expose
  `reproduce_declared_check(checkId)` inside the frozen sandbox, not raw shell.
- **telemetry may be absent, never fabricated** — a missing measurement is `unmeasured`.

> **Do not adopt lever 3 alone.** Its read-only clause removes the reviewer's ability to execute anything; shipped
> without `reproduce_declared_check` it trades empirical power for verifiability and is a **net quality loss**.

## 13. Acceptance, as experiments

| # | Lever | Experiment | Adopt when |
|---|---|---|---|
| E1 | 1 | Run the three mechanical checks over the last change's sealed surface; count the defects they find and their cost. | **Partially run — §17.** A/B cost ≈ 0 and found real defects, but reach only 2 of 10 by construction; the prospective mutation check is the open item |
| E2 | 2 | On **one frozen revision**, run a hypothesis-scoped short pass against the long-pass baseline, with `n` set by the claimed effect (§16.3), and quality measured by seeded-defect recall (§16.4). | Median cost falls by an amount outside the measured noise **and** seeded-defect recall does not fall |
| E3 | 3 | Two probe passes on one revision: (a) tool-policy read-only, (b) sandbox read-only. Compare capability truthfulness and cost. | (a) is at least as truthful, and cheaper or equal |
| E4 | 2 | Corpus rates across E2: `criticalRecall`, `falsePassRate`, `falsePositiveRate`, `guardHarmRate`. | No rate degrades |

E2 is decisive: it is the only experiment that converts a ~20× estimate into a measured number. Read §16 before running it —
**Run, first round — §18.** It returned ~2.5–2.7× rather than ~20×, and the result is outside the noise floor, so n = 1 was
sufficient. The lever survives; the estimate did not.
as originally written (a single run, quality compared against the long pass's own findings) it could only screen for large
effects and could not have proven the claim it was written to prove.

## 14. What this design refuses

- **Claiming a cost win from a quality change.** `adversarial-admissibility` delivered quality and auditability; it did
  **not** reduce cost, and this document does not retroactively claim it did.
- **Building an executor to satisfy a schema field.** The receipt's `telemetry` requirement is what pushed toward a
  hand-rolled harness; the field is subordinate to the objective, not the reverse.
- **Weakening fail-closed to make a gate pass.** A waiver is recorded as a waiver.
- **Adding a mechanism with no consumer.** §0.1 rule 2 exists because violating it was the measured failure mode.

## 15. Open decisions

1. **Lever 2 becomes Stage 1's shape only after E2 — decided: measure first.** Designing Stage 1 around a ~20× estimate
   that turns out to be 1.5× would invalidate the design, and that is precisely the ordering error this document exists to
   correct (§0.1 rule 1).
2. **"The reviewer must not share the author's model family" is a contract — decided: yes**, as a receipt field
   (e.g. `distinct_from_author`) that asserts sameness or difference and never records identity (AGENTS.md #4). It is the
   one variable measured to have actually produced findings — the two passes ran `deepseek-v4.1-flash-goat` against an
   author session on `gpt-5.6-terra`. **Its real cost**: Kata must know who the author is, and author identity is also the
   host's to declare. If the host will not assert it, this cannot be built, and the most valuable variable stays accidental.
3. **Lever 1's checks are a new change — decided: yes**, rather than folded into the existing corpus/gate surface. The
   mechanical checks are a different instrument from the corpus, and they are needed *before* `adversarial-admissibility`
   is archived. The condition attached to that decision: **its own acceptance must include "validated against R1–R10"**,
   or it ships as another mechanism with no referee — the exact defect class it is being built to detect.
   **Its first test cases already exist**: §17.8's 15 decorative guards were handed to that change rather than repaired in the
   sealed line, so the check has a real starting set to be validated against before it is trusted on anything else.
4. **Seeded-defect benchmark before E2 — decided: yes, built forward on the current revision (option A).** Option B
   (reuse the archived `revision-4eae642da67cbbee`, whose defects are genuinely present) was **checked and is impossible**:
   a Kata revision is content-addressed but **content-less** — it stores 660 content digests and not one byte of content.
   Of the 19 paths that differ from today, only **3** match a git blob, **14** were working-tree states that were never
   committed, and **2** were never in git at all. The older revision can be *proven*; it cannot be *reconstructed*. The
   benchmark is therefore built forward: each of R1–R10 is re-introduced by reverting its own fix, and "the defect is
   present" is confirmed by the **R-test that already exists and already goes red under that mutation** — so no new
   oracle has to be invented.

---

## 16. How a cost reduction is verified

This section exists because of the failure that produced it: several rounds of work were reported as cost optimization
while **no artefact in the system could fail for a cost reason**. There was a referee for quality (the corpus) and none
for cost, and an unrefereed metric does not move. §0.1 rule 1 is the policy; this is the procedure.

### 16.1 The control

Exactly one variable may differ between the two arms:

| held fixed | the lever |
|---|---|
| the frozen candidate (`revisionId` / `CandidateFreeze`) | **one** lever — for lever 2, one long pass vs N hypothesis-scoped short passes |
| the brief (`briefSha256`) | |
| tool policy, thinking level | |
| the model | |
| host and gateway | |

Comparing across revisions, across briefs or across models measures something else. The error this rule forbids was
already made once: "the mechanism is implemented" was offered as evidence about cost.

### 16.2 The metric

Primary: **total tokens**, split into `input`, `output`, `cacheRead`, `cacheWrite`. Secondary: wall clock.

The cache split is not optional. `cacheRead: 0` on every turn is what made 17.6 M tokens a full-price replay; where a
provider does offer prefix caching, the same turn count can bill an order of magnitude apart. **A cost figure without
the cache fields is not comparable between runs** — and the receipt schema currently carries `toolCalls`, `outputBytes`,
`tokens` and `truncations`, and **no cache fields at all**.

### 16.3 How many runs — derived from measured variance, not chosen by feel

Two passes, same revision, same brief, same model:

| | pass 1 | pass 2 | spread |
|---|---|---|---|
| turns | 125 | 107 | −14% |
| tokens | 16.47 M | 17.62 M | +7% |

The noise floor is therefore **±7% on tokens, ±26% on turns**, and the sample size follows from the claim:

| claimed effect | runs per arm | why |
|---|---|---|
| ≥ 30% | 1 | far outside the noise |
| 10–30% | ≥ 3 | median and spread needed; n = 1 cannot separate effect from jitter |
| < 10% | — | **not provable at this variance**; abandon the claim rather than publish it |

Report the median and the range. A best-of-n figure is not a measurement.

### 16.4 Quality, in the same run

A cheaper method that misses defects is a failure, not an optimization. Three ways to verify quality, weakest first:

| | method | why it is weak or strong |
|---|---|---|
| a | synthetic corpus cases | measures recall on fixtures, not on the real revision |
| b | "it found what the long pass found" | **the long pass's findings are not ground truth** — they include false ones, and ones caused by the previous repair |
| c | **seeded-defect recall on the same real revision** | **strong: the answer is known** |

(c) is available, and its shape was decided by evidence rather than preference. The cheaper route — reusing the archived
revision, where the defects genuinely are — was checked and **is impossible**: a Kata revision stores content digests and
no content, so of the 19 paths that differ from today only 3 match a git blob, 14 were working-tree states that were never
committed, and 2 were never in git. **A revision can be proven but not reconstructed.**

So the benchmark is built forward on the current revision: each of R1–R10 is re-introduced by reverting its own fix, and
"the defect is present" is confirmed by the R-test that already exists and already goes red under that mutation. Two
cautions, recorded because they are where this will go wrong if it is done casually: the seeds must be built in a scratch
copy (reverting them in the sealed worktree would supersede the revision again), and R3/R4 both edit the same gate, so
seed independence has to be checked rather than assumed. The result is a labelled revision whose seed set is **10 defects
confirmed real by the fact that code was changed to fix them**, each with an existing reproduction — and cost and missed
defects then come from one run, one revision, one known answer.

### 16.5 The platform-side gate: shape and arithmetic, not a threshold

Kata must not gate on an absolute token count: the host, the model and the gateway all sit outside it, so an absolute
threshold is flaky and invites fabrication. The gateable properties are structural, and Kata can check every one of them
without knowing which model ran:

- the same `revisionId` and the same `briefSha256` across both arms (both bindings already exist);
- the same model **class** declared for both arms — asserting sameness or difference, never recording identity
  (AGENTS.md #4);
- `n` sufficient for the claimed effect, per §16.3;
- every data point carries `cacheRead` / `cacheWrite`;
- the claimed reduction is present **in the data** — median and range, not a best case;
- seeded-defect recall does not fall, and false-pass does not rise (§16.4).

This is implementable inside Kata, is independent of the host, and — unlike anything built so far — it can actually
fail for a cost reason.

### 16.6 Known gaps in this plan

1. **The receipt schema has no cache fields.** Until it does, §16.2 cannot be satisfied from receipts and figures are
   not comparable across providers.
2. **E2 was written as a single run.** Per §16.3 that only screens for effects ≥ 30%; it could not have proven a 20×
   estimate that turns out to be 1.5×.
3. **The seeded-defect set has to be built before it can be used.** Re-introducing R1–R10 is mechanical but it is work,
   and it belongs to whichever change owns lever 1's checks (§15, item 3).

---

## 17. E1, first run: what the mechanical checks actually reach (2026-09-22)

Run against the sealed surface of `adversarial-admissibility` (`revision-0ea09d6400926aa5`) — 119 source files, 578 exported
symbols, 19 declared literal lists. Cost: **no model call, about one second.**

### 17.1 Check A — exported symbols with no production reference

**24 exported symbols in `src/` are referenced nowhere in the repository.** Spot-checked by whole-repo search: each occurs
**exactly once**, in its own declaration. The list is not marginal — it includes modules this change touched:

```
deleteWikiRecord      readWikiRecordStrict   validationRevisionId   provenance-gate
readBriefFile         changeRecordHash       computePathDigest      revision
resolvedCheckId       describeFinding        validateBatchRecord    reopenObligation
writeAcceptanceMatrixMigration  isLegacyTask  commandsForPlatform   migrationsPath
recoveryPath  taskProfilePath  evidenceArchiveDir  evidenceFilePath  wikiCandidatesDir
llmwikiDir  handoffBaselinePath  subagentProgressPath  cometCompatibilitySnapshot
```

A further **15** are referenced only by tests (`splitOwnedPaths`, `reviewScopeVerdict`, `isAdmissibleObservationKind`,
`claimsHash`, the eval fixtures…) — production code with no production consumer.

This is the check earning its place: it is free, it is deterministic, and it found a real and previously unlisted set.

### 17.2 Check B — declared members nothing consumes

The regex parser is **broken on this codebase** and the first run proved it: `[^\]]*` spans newlines, and an apostrophe in
prose inside a multi-line list is taken for a string boundary, producing rows like
`s findings, which the review node resets at the start of a round`. Of 11 reported rows, roughly 4 survive scrutiny:

```
unmeasuredMetrics -> tokensUsed | costCredits | escalationCount     (src/eval/runner.ts)
nextActionReasons -> adversarial_verify_pending                    (src/workflow/navigation.ts)
```

A declared metric nothing measures is the same shape as an unmeasured corpus class — **this check is worth keeping, but it
needs a real parser before its count means anything.** Recorded rather than papered over.

### 17.3 The correction: A and B reach 2 of the 10, not the majority

By construction, a reference-counting check can only see a defect whose shape is *a missing reference*:

| defect | shape | reachable by |
|---|---|---|
| R4 `revisionChangeSurface` had no caller | missing reference | A |
| R5 corpus class nothing could measure | missing consumer | B |
| R1, R2, R3, R6, R7, R8, R9, R10 | semantic (a guard on the wrong field, a set that is true by construction, a duplicated derivation, an acceptance rule that accepts anything) | **neither** |

The claim in §12 that lever 1 "removes the majority class from the expensive pass's remit" is therefore **withdrawn**. The
measured bound is **2 of 10**. The load-bearing check is the mutation check, and its prospective form is still unmeasured.

### 17.4 The mutation check, measured as *pinning*

Four defects were re-introduced, one at a time, in a scratch copy; the full suite was run for each. The question this
answers is narrower than "would a mutation check have caught the original", and it is the one that can be answered today:
**is each repair pinned by a test that fails for the right reason?**

| seed | defect restored | suite noticed | failing files | the test that failed |
|---|---|---|---|---|
| R2 | the gate accepts a recorded pass with no judgement basis | yes | **1** | *refuses a pass that carries no judgement basis…* |
| R3 | coverage supplied from the revision (true by construction) | yes | **1** | *asks the pass to cover the content-identity surface…* |
| R6 | the release gate scores an unmatched observation list | yes | **1** | *turns manifest-declared observations into a scored gate* |
| R8 | `analysis` grounds on any non-empty string | yes | **1** | *refuses an analysis observation that names no declared instrument* |

**4 of 4 are pinned**, each by exactly one file and the test that names the behaviour — so these are not compilation
collapses masquerading as detection (the failing-file count is reported for precisely that reason).
>
> **Extended the same day to all ten seeds — §19. The full result is 8 of 10 pinned, not 4 of 4.** The four measured here
> were the first batch; the two that follow were not pinned, and one of them is the blocking repair.

### 17.5 Two ways a seed lies, both hit on the first attempt

The first run produced two false readings, and I caused both:

1. **A broken seed reads as "detected".** The R3 seed used a guessed variable name (`surfacePaths`; the real local is
   `changeSurface`). The module threw, every importer went red, and the result looked like a caught defect.
2. **A partial seed reads as "blind".** The R6 seed reverted only one of the two halves of its fix; the other half still
   refused the manifest, the suite stayed green, and the result looked like an unpinned repair.

Both directions mislead. So the caution already written into §16.4 — *verify the seed* — is not a formality: it is the
difference between two wrong conclusions and one right one. Every seed now states the defect's full mechanism, and a seed
whose anchor is missing is reported as *unapplied* rather than counted on either side.

### 17.6 E1 is two experiments, and only one of them needs seeds

| | question | needs seeds |
|---|---|---|
| **pinning** (§17.4, run) | does the suite notice when a repair is reverted? | yes — the seed *is* the revert |
| **check C, prospective** (open) | on the current tree, which guard can be removed with the suite still green? | **no** |

Prospective check C is the one that measures what lever 1 can actually remove, and it is simpler than this section:
enumerate the guards on the change's declared surface, mutate each, and report the ones the suite ignores. **The seeds
built above are not needed for it — they are E2's labelled benchmark (§16.4).**

### 17.7 A reusable rig, and a boundary that held

The measurement ran in a scratch copy (`tmp/seed-bench/`) whose baseline is **1070 passed / 0 failed**, identical to the
sealed worktree — reached by copying `src/ tests/ schemas/ docs/ scripts/ evals/ .agents/` and the root config, with
`node_modules` resolved from the ancestor checkout. Four environment failures had to be distinguished from real ones along
the way, and each was explained before being excluded. **The sealed worktree was never written to**, which is the whole
reason the copy exists: reverting a repair in place would supersede the revision the change just sealed.

### 17.8 Check C, prospective — and the number E1 was for

31 refusal guards were found on the change's declared implementation surface, and each was disabled in turn in the scratch
copy with the full suite run after it. One mutation reddened 16 files at once and is discounted as a compile/type collapse
rather than counted as a detection.

**Of the 30 valid mutations, 15 left the suite completely green.**

`decorative = 15/30` — **half the refusal guards on this change's declared surface can be removed without a single test
noticing.** "Decorative" means exactly one thing here: *no test exercises that refusal*, so its behaviour can regress
silently. It does not mean the refusal is unreachable.

The list is not marginal:

| site | guard |
|---|---|
| `src/quality/adversarial.ts:852` | `if (retired.length > 0)` — **the refusal of a retired record field** |
| `src/quality/adversarial.ts:997` | `if (!base)` — the delta base |
| `src/quality/adversarial.ts:2231` | `if (!revision)` |
| `src/quality/adversarial.ts:2470` | `if (!scope.ok)` — the delta scope gate |
| `src/quality/revision-delta.ts:66` | `if (!currentDigests)` |
| `src/quality/acceptance-matrix.ts:339` | `if (!declaration.id)` |
| `src/quality/acceptance-matrix.ts:608` | `if (!result.ok)` |
| `src/quality/acceptance-matrix.ts:616` | the affected-test output check |
| `src/cli/ops.ts:46,139,218,295,318,573,615` | seven subcommand routing guards |

The first row is the one that matters most: **it is the guard that refuses a record carrying the retired `verdict` field —
the exact behaviour R1 is about — and nothing tests it.** Removing it re-opens R1 silently. A live instance of the class,
found by a check that costs no tokens.
>
> **Decision, 2026-09-22: these 15 are handed to lever 1's change (§15 item 3), not repaired here.** They are not "something
> built wrong" but "something not covered", and coverage of exactly this kind is that change's acceptance object — so they
> become its first test cases, which validates the change against real material instead of a fixture. Repairing them inside
> `adversarial-admissibility` would open a repair batch, mint a revision and invalidate a Verify PASS over a change whose
> deliverable is complete, in order to add tests for behaviour that is currently correct. The live one
> (`adversarial.ts:852`, the retired-field refusal with no test) is called out as the first of them so it is not lost among
> the routing guards.

### 17.9 What this corrects about lever 1's reach

| check | reach | cost |
|---|---|---|
| A (no production reference) | 2 of 10 by construction | ~1 s, **0 tokens** |
| B (declared, unconsumed) | R5 only; parser needs rewriting first | ~1 s, **0 tokens** |
| **C (mutation, prospective)** | **15 unpinned refusals found on this surface** | ~10 min local test time, **0 tokens** |

The withdrawal in §17.3 stands — A and B are not the majority — but the conclusion inverts at check C: it *does* reach the
R-class defect shape, it needs no seeds, and its cost is wall-clock rather than tokens. **That is the axis that matters**,
and it is the first measurement in this line of work where a cheap instrument demonstrably reaches a defect class the
expensive pass was being paid for.

Still untested, and this is E2's job: whether repairing these 15 (or a sample of them) reduces what the expensive pass
finds. The seeds from §17.4 are that experiment's labelled benchmark.

### 17.10 Three caveats on this number, stated rather than discovered later

1. **30 guards is the surface, not the codebase.** The mutation set was the change's declared `implementationPaths`; a
   repository-wide run would be larger and is unmeasured.
2. **"Decorative" is a statement about tests, not about reachability.** A guard on an input the suite never constructs is
   decorative by this definition even if it is correct and reachable in production.
3. **A wall-clock cost of ~10 minutes is not zero.** The saving is on the token axis (≈ 17.6 M tokens per pass); the test
   runtime is paid in full, and at 31 mutations × 18 s that is the price of the check.

---

## 18. E2, first round: what one hypothesis actually costs (2026-09-22)

One hypothesis, one fresh Pi context (`--no-session --no-context-files --no-extensions --no-skills`), tools restricted to
`read,grep,find,ls`, inside a read-only bind of the repository, against the same sealed revision the long passes reviewed.
The hypothesis was chosen from §17.8's live finding so the round had real work to do.

### 18.1 The measurement

| | long pass (measured, §10) | one hypothesis round | long pass per hypothesis |
|---|---|---|---|
| turns | 107 | **10** | ~10.7 |
| input tokens | 17,620,000 | **657,892** | ~1,762,000 |
| output tokens | — | 3,890 | |
| peak context | 243 K | **50 K** | |
| tool calls | 163 | 23 | ~16 |
| wall clock | 29.6 min | **1.35 min** | ~3 min |
| `cacheRead` | 0 | **0** | 0 |

"The long pass per hypothesis" divides the measured long-pass totals by an **inferred** hypothesis count (it recorded 10
attempts and produced 13 findings), so that column is an estimate; the two measured columns are not.

### 18.2 The result contradicts the estimate, by about 7×

§12 lever 2 estimated **~20×**:

```
6 contexts x 10 turns    vs    1 context x 107 turns
6 x 100 / 107²           =     0.052   ->  ~20x
```

Measured: **~2.5–2.7×.**

- input per turn: 65,788 (round) vs 164,673 (long pass) → **2.5×**
- total per hypothesis: 657,892 vs ~1,762,000 → **2.7×**
- wall clock: 1.35 min vs ~3 min → **2.2×**

**The reason is visible in the table: turns per hypothesis are the same (~10), not different.** The model needs about ten
turns to answer one hypothesis whichever container it runs in, so the quadratic term is not eliminated — only the *shared*
history across hypotheses is. A ten-turn round already accumulates most of its own context, and the fixed base (system
prompt, tool schemas, the round's instructions) is paid again per round.

20× assumed the per-hypothesis round would also be cheaper *per turn*; it is 2.5× cheaper per turn and the same length, and
those two facts multiplied give 2.5×, not 20×.

### 18.3 What survives, and it is worth having

Per §16.3, a ~63 % reduction is far outside the measured ±7 % noise on tokens, so **one run is sufficient** to establish it
— this is the first lever in this document whose effect is both real and measurable with n = 1.

The round also did the work: it returned `outcome: confirmed` with an openable observation — that `applyDisposition`
(`src/quality/finding-disposition.ts`) rewrites the adversarial record through `mutateTaskArtefact` without passing
`writeAdversarialRecord`, so a pre-existing `verdict` survives, `retiredRecordFields` has exactly one caller, the gate never
inspects `verdict`, and the schema still declares the field. **So the cheap form is not cheap by being shallow**: a ten-turn
round falsified a real hypothesis and produced a citation that sharpens §17.8's finding.

### 18.4 What this changes

1. **Lever 2 is worth building, at ~2.5–2.7×, not at 20×.** The decision in §15 item 1 (measure before designing Stage 1)
   just paid for itself: designing around 20× would have produced a Stage 1 justified by a number that is wrong by 7×.
2. **Lever 2 is no longer the headline.** Lever 1 costs **0 tokens** and found 15 unpinned guards; lever 2 saves ~63 % of a
   very large number. Ranked by (effect ÷ risk), lever 1 comes first, and §12's ordering is confirmed rather than changed.
3. **The 2.7× is per-hypothesis and does not include the added orientation cost of N rounds.** Each round re-orients
   against the repository; the long pass oriented once. The measured round carried a deliberately narrow prompt (one
   hypothesis, three hint files); a real one carries the brief's rules, result schema and budget, so **the honest reading is
   2.5–2.7× with upward risk, not a floor.**
4. **The quadratic term is still unaddressed.** Any further gain has to come from reducing *turns per hypothesis* (10 and
   unchanged) or from making each turn cheaper than the ~66 K it currently costs — which is the retrieval layer's original
   job, now with a measured target instead of an aspiration.

### 18.5 Caveats

- **n = 1 on both sides.** The long pass measurements come from two runs that differed by 7 % on tokens and 14 % on turns;
  a single hypothesis round has no second sample at all. §16.3's table says n = 1 suffices for an effect this size, and
  that is the basis, not an assumption of stability.
- **The long-pass hypothesis count is inferred**, so the "per hypothesis" column carries that error.
- **The prompt was narrower than a real round's**, so the measured cost is a lower bound on the real form.
- **Wall-clock here includes model latency only**, measured end to end on one machine; it is not a throughput claim.

---

## 19. E1, full seed set: 8 of 10 repairs are pinned, 2 are not (2026-09-22)

All ten defects were re-introduced one at a time in the scratch copy, each with its full mechanism, and the complete suite
was run after each. A seed whose anchor is missing is reported as *unapplied* and counted on neither side; a mutation that
reddens more than five files at once is discounted as a compile/type collapse.

| seed | defect restored | result | failing files |
|---|---|---|---|
| R1 | the brief prescribes the retired `verdict` field again | **NOT PINNED** | **0** |
| R2 | the gate accepts a recorded pass with no judgement basis | pinned | 1 |
| R3 | coverage supplied from the revision (true by construction) | pinned | 1 |
| R4 | the change surface is the owned-path table again | pinned | 1 |
| R5 | the corpus stops scoring the guard-false-negative class | pinned | 1 |
| R6 | the release gate scores an unmatched observation list | pinned | 1 |
| R7 | the CLI applies its own weaker verdict rule again | pinned | 1 |
| R8 | `analysis` grounds on any non-empty string | pinned | 1 |
| R9 | a node's own history is dropped from the brief | pinned | 1 |
| R10 | the corpus case contradicts its own reproduction | **NOT PINNED** | **0** |

### 19.1 The two unpinned repairs, verified rather than assumed

A green suite after a seed means either the repair is unpinned **or the seed did not take**. Both were checked against the
artefact, not the source line:

- **R1** — with the seed applied, `buildAdversarialBrief()` renders a brief whose result template **does contain**
  `"verdict"`, and the full suite is still green. So the defect is genuinely present and nothing notices.
- **R10** — with the seed applied, the `guard-penalises-an-honest-inconclusive` case declares `no_defect_found` while its
  own reproduction text requires the pass to be *refused*; the full suite is still green.

**R1 is the one that matters.** It was the `blocking` finding whose whole consequence was that a reviewer following the
brief verbatim could record nothing and a real pass was destroyed. **Its repair is held by no test.** The defect could be
re-introduced by a one-line edit to a template and every gate in this change would stay green — which is §17.8's decorative
guard class, one level up: not a guard without a test, but a *repair* without one.

### 19.2 The verification step needed verifying too

The first R1/R10 effectiveness check looked up the R10 case by a guessed id
(`inconclusive-is-not-a-free-pass`) and, on finding nothing, fell back to a looser match that hit a different case — so it
reported "R10 unpinned" without having tested R10 at all. Caught by the assertion failing for the wrong reason
(`expected 'defects_found' to be 'no_defect_found'`), corrected to the real id
(`guard-penalises-an-honest-inconclusive`), and only then did R10's result stand.

That is the third appearance of the same lesson in one day, now at three levels: a **seed** can lie (§17.5), a **mutation**
can lie (the compile-collapse discount, §17.8), and a **verification** can lie (here). The rule that generalises:
*an assertion that fails for a reason you did not predict is reporting on your instrument, not on your subject.*

### 19.3 What this adds to the handoff in §15 item 3

The 15 decorative guards from §17.8 are joined by **two unpinned repairs**, and the second set is the more consequential
because these are repairs to *this change's own acceptance criteria*, not incidental guards:

- `R1` — assert that every field the rendered brief's result template prescribes is accepted by the writer (the
  round-trip that was never tested).
- `R10` — assert that every corpus case's `expectedVerdict` is consistent with its own `reproduction`.

Both are one test each, both were written as assertions in this measurement, and both belong in the lever-1 change's
acceptance rather than in a repair batch on a sealed, verified line.
