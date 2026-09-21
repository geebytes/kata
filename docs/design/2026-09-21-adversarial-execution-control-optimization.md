# Independent adversarial review: cost optimization under a quality constraint

**Status:** proposed; not implemented by `review-record-integrity`  
**Decision scope:** a later, separate governed Kata change  
**Source material:** `docs/verfify.md`, the current adversarial implementation, and the strict verify-node run recorded on 2026-09-21.

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
claims mechanically true.

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

### 3.3 Retrieval layer — subordinate to sufficiency

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

## 4. Delivery plan

Ordered by dependency, not by effort. Phase 0 comes first because A/A's acceptance criterion is a *measured* comparison, and
a benchmark that does not exist cannot referee the phases that follow.

### Phase 0 — The verifier benchmark (the referee)

Build the corpus **before** changing behavior, and make it the acceptance gate for every later phase.

**Corpus composition** — each entry is a `(revision, expected-critical-findings, expected-pass/fail)` triple:

- **historical defects** — replay real ones, starting with `seal-persists-refused-owned-paths` from the 2026-09-21 strict
  pass, and the four same-family defects closed under `major-finding-closure` / `repair-obligation-deadlock`;
- **seeded defects** — injected into known-good revisions: prompt-injection text in a comment/commit message/evidence log,
  stale or mismatched evidence, evidence citing a path absent from the revision, a `refuted` with no readable
  observation, foreign-worktree drift, duplicate equivalent queries, and a budget-exhausting revision;
- **mutation cases** — for each *checker* this repository owns (claims, adequacy, obligations, scope guards), the mutation
  that must be caught; the `change-record-has-no-test-for-its-central-claim` finding showed this class is where silent
  gaps live;
- **known-good revisions** — clean passes, so false-positive rate is measured rather than assumed;
- **malicious fixtures** — records engineered to pass under today's predicate (the §2.1 minimal record) and to fail under
  §3.1's.

**Measured per entry**: critical recall, false-pass rate, precision, reproducibility across N repeats, tool calls, wall
time, output bytes, tokens and truncations where the host exposes them.

**Acceptance rule for every later phase**: critical recall and false-pass rate no worse than the recorded baseline;
reproducibility no worse; cost reported as measured distributions. A phase that improves cost while lowering critical
recall is rejected — not negotiated.

### Phase 1 — Judgment layer: the admissibility predicate

The core change, and the one that must land before the others can be judged.

- `ReviewState` (coverage / hypotheses / findings) replaces the free-form `attempts`; `verdict` is **removed** from the
  record schema and computed by Kata.
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
- Telemetry (`toolCalls`, `outputBytes`, `tokens`, `truncations`, wall time) is receipt-stamped; the `--elapsed-ms` /
  `--tool-uses` CLI arguments are retired.
- The hard envelope is enforced by the executor; exhaustion returns `budget_exhausted`, which Phase 1's predicate already
  refuses.
- Isolation/lease for attribution (§3.2.3): strict review requires a task-scoped snapshot, foreign drift is reported
  separately, and `scope_unattributable` blocks before brief issuance.

**Acceptance**: an invented receipt is refused; a budget-exhausting corpus entry yields `budget_exhausted` and blocks; a
concurrent unrelated edit cannot enter the delta or supersede the binding; strict nodes on hosts without the capability
fail closed rather than degrading.

### Phase 3 — Retrieval layer: evidence graph and targeted hydration

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
| Caching contaminates independence | Only facts are cached (hashes, slices, envelopes, test outcomes, graph facts) | `docs/verfify.md`: cache facts, never judgments |
| CodeGraph is incomplete for this repository | Graph output is a navigation candidate, never admissible evidence | Observed: the index covers 4 TS nodes and points at the parent repo |
| Benchmark is expensive to build | It is Phase 0, and it is what makes every later phase's claim checkable | Without it, "quality did not drop" is unverifiable prose |

## 5.1 Acceptance items this design inherits from a closed change

Four rounds of independent adversarial review on `review-record-integrity` produced six findings that could not be
repaired inside that change, because repairing them means changing what a revision's content identity *is* — a
semantic change to AC-2/AC-4, not a defect fix. They are recorded in
`docs/design/2026-09-21-review-record-integrity-fourth-pass.md` and become **acceptance items** here rather than
optional improvements:

1. **The change surface must be defined by content identity, not by declaration.** `revision.pathDigests` is computed
   over `ownedPaths` at seal time, so a committed change outside the declaration escapes *both* sources the record and
   the delta compare against (`git status` is clean; the digest table never had the path). Measured: one commit touched
   `.gitignore`, `docs/guide.md` and `src/a.ts`; the record reported only `src/a.ts`. The retrieval layer's evidence
   graph (§3.3) is the natural home for a declaration-independent snapshot.
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

1. Finish the current `review-record-integrity` loop (it has an open review round, and it shares `adversarial.ts`).
2. Open one governed architectural change — suggested name `adversarial-admissibility` — with this document as its design
   input and the Phase 0 corpus as its first acceptance criterion.
3. Land Phase 1 alone, on the corpus, before Phase 2. If the predicate cannot be made to hold recall, the remaining phases
   are moot and the finding belongs in this document, not in a later phase's scope.
4. Do not claim a cost reduction until the corpus compares both paths on defect recall and false-pass behaviour.
