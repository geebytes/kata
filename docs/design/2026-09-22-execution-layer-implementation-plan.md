# Execution layer (A): implementation face — executable checklist

> **Demoted, 2026-09-22 — see §12 of `2026-09-21-adversarial-execution-control-optimization.md`.** **H1** (a
> repo-internal host executor) is no longer the Stage 1 deliverable. Lever 3 replaces "build an executor" with "do not
> let the author be the executor", and lever 2 removes the need for one: read-only comes from the tool policy rather
> than a sandbox, and a missing telemetry measurement is recorded as `unmeasured` instead of justifying a hand-rolled
> harness. **K1–K5** remain valid as receipt-channel hygiene, to be scheduled once `src/cli/ops.ts` is free.
Status: **plan, not implemented.** Written 2026-09-22 for the change that follows `adversarial-admissibility`.
Scope: K1–K5 (Kata side, this repository) and P1 (Phase 4's Kata-side half). H1 (a host executor) is specified here but
belongs to the host platform, not this repository.

## 0. What "implementation face" means, and where the boundary is

| | Content | State |
|---|---|---|
| **Contract face** | `ReviewRunRequest` / `ReviewExecutionReceipt` shape, binding verification, three refusals, strict-mode requirement | **Delivered** in `adversarial-admissibility` |
| **Implementation face** | A host that actually provides the capabilities, actually measures, and actually writes the receipt | **This plan** |

The contract face is inert without the implementation face: today the gate can *demand* a receipt that nothing can
produce, and a receipt that does exist travels on a channel the reviewer itself writes.

### 0.1 Platform neutrality: decided, and to be preserved

**Decision.** The capability set is the **contract**; the platform is at most **provenance**. The gate must never branch
on a platform name.

Verified as already true (no change needed, but the checklist keeps it that way):

| Check | Result |
|---|---|
| `ReviewRunRequest` fields | `runId`, `requestSha256`, `node`, `revisionId`, `manifestHash`, `briefSha256`, `reviewIrSha256`, `candidateFreezeSha256`, `budget`, `requiredCapabilities`, `resultSchemaVersion` — **no platform field** |
| `ReviewExecutionReceipt` fields | `runId`, `requestSha256`, `capabilities`, `startedAt`, `endedAt`, `telemetry`, `status` — **no platform field**, and `additionalProperties: false` |
| Capability vocabulary | `fresh_context` / `read_only_fs` / `bounded_tools` / `budget_enforced` — environment properties, not product names |
| Platform branches in the gate | **none** (`grep platform src/quality/*.ts` returns only prose meaning "the host") |

Where a platform *does* appear in Kata — `handoff acknowledge --platform`, `src/adapters/platforms.ts` — is the
installation/handoff layer, which is a different mechanism with a different purpose.

**Why this matters for the checklist.** Adding a host must be *adding a realization*, never *changing the contract*. Every
item below is written so that a second host can satisfy it without touching Kata.

### 0.2 The honest ceiling, stated once

The achievable guarantee on a single-user host is **host-authored, measured, bound** — a receipt written by a process
other than the reviewer, carrying values that were measured rather than typed, bound by nonce and hash to the request
Kata issued. It is **not** cryptographic unforgeability: an agent with write access to the receipt path can still write
it. Reaching unforgeability needs a trust anchor the reviewer cannot reach (a signing key held outside the agent's
filesystem view) and is a separate decision. K4 exists to make the documentation say what is true.

---

## 1. K1 — the receipt arrives on its own channel

**Evidence of the gap.** `src/cli/ops.ts`, `record` subcommand:

```ts
const record = await writeAdversarialRecord(root, change, { ...parsed, node, ...binding, ... });
```

`parsed` is the reviewer's own result JSON, so a `receipt` inside it is accepted. The schema declares the receipt as
*"Written by the host, never by the reviewer"* — a claim the write path does not enforce.

**Do.** Add `adversarial record --receipt-file <path>`, read it directly, and refuse a `receipt` present in the result
body with a message naming the channel. The record still *carries* `receipt` (schema unchanged, history readable); what
changes is which input may supply it.

**RED**

1. A result body containing `receipt` → `recorded: false`, error names `--receipt-file`, and **no record is written**
   (assert the file on disk is untouched, not merely that the command failed).
2. `--receipt-file` naming a receipt bound to a *different* run → `receipt_unbound`.
3. `--receipt-file` naming a valid receipt → recorded, and the persisted record's `receipt.runId` equals the issued
   request's.

**Acceptance.** A receipt cannot reach a record through the reviewer's own file; the refusal names the correct channel;
a bound receipt still records.

**Depends on** K2 (a host cannot produce a bound receipt without the request).

---

## 2. K2 — the request is handed to the host

**Evidence of the gap.** `createReviewRunRequest` builds the request and `persistAdversarialBrief` stores it in the
issued-brief JSON (`entry.runRequest`), but `adversarial brief` prints `briefSha256`, `revisionId`, `mode`, `scopeReason`,
`reverificationCost` and the brief text — **not the request**. A host must find the brief file on disk and parse it,
which is both fragile and unnecessary.

**Do.** Add `adversarial brief --emit-request <path>`, writing the complete `ReviewRunRequest` (including `budget` and
`requiredCapabilities`) as JSON.

**RED**

1. The emitted request is **byte-identical** to `runRequest` inside the issued brief the command just persisted
   (compare `JSON.stringify` of both, not selected fields).
2. Re-issuing the same brief reuses the existing nonce (`runId` unchanged) — no ghost run per invocation.
3. `--emit-request` on a `certification: "reused"` result writes **nothing** and says why: no new brief means no new run.

**Acceptance.** A host can obtain the request without reading Kata's private state; the request it gets is the one the
gate will verify against.

---

## 3. K3 — capability state is visible

**Evidence of the gap.** `adversarial status` reports `recorded`, `status`, `revisionId`, derived `verdict`,
`executedInFreshContext`, `scope`, `mode`, telemetry, `blockingFindings`, `satisfied`, `reason`. It reports **nothing
about capabilities** — a strict node that cannot be certified shows only `satisfied: false`.

The design's Phase 4 requires: *"keep a visible, reasoned legacy path for hosts not yet capable, and report it in
`adversarial status` rather than hiding it."* Today that path is invisible.

**Do.** Extend the per-node projection with: `requiredCapabilities`, `receipt: 'recorded' | 'absent'`, the capabilities
actually advertised, `missingCapabilities`, and whether the node is on the legacy (self-report) path or waived.

**RED**

1. A strict task with no receipt reports the required capability list and `receipt: 'absent'` — not merely
   `satisfied: false`.
2. A receipt missing `read_only_fs` reports `missingCapabilities: ['read_only_fs']`.
3. A waived node reports `waived` **with** its `waivedReason`, so the legacy path is reasoned rather than merely visible.
4. The projection never exposes a raw `verdict` from a stored record (existing invariant; assert it still holds).

**Acceptance.** An operator can answer "can this host certify this node, and if not, what is missing" from `status`
alone.

---

## 4. K4 — the documentation says what is achievable

**Evidence of the gap.** `src/quality/review-execution.ts` states the receipt is *"returned by the executor, never
authored by the reviewer"* and *"a receipt the model cannot author"*; the schema description repeats *"Written by the
host, never by the reviewer."* Per §0.2 the achievable guarantee is weaker. The same file names *"(Pi/Codex)"* as the
host, which reads as a binding when it is an example.

**Do.** Rewrite those comments and the schema description to state: the receipt is **host-authored, measured and bound**;
authorship separation is **process and tool-policy**, not cryptographic; unforgeability requires an external trust anchor
and is out of scope. Replace the platform names with "the host platform", and add a short table of how a host satisfies
each capability **without naming a required implementation**.

**RED.** Documentation only — no test. Verified by a read-through against §0.2, plus a grep asserting no product name
appears in `src/quality/review-execution.ts`.

**Acceptance.** No claim in the code or schema exceeds what the mechanism delivers; no product name reads as a
requirement.

---

## 5. K5 — decide `executedBy`, and make it honest

**Evidence of the gap.** `executedBy` is declared in the record schema (`type: string`, `minLength: 1`) and in
`AdversarialRecord`, and its **only** writer in the whole repository is a test fixture
(`tests/helpers/adversarial.ts:32`). Production code never sets it, so the field is always absent — a slot that implies
provenance and has no producer, which is the class of defect this whole line of work exists to remove.

**Do — the decision.** Populate it **from the receipt** as **provenance only**:

- `status` displays it, so "which host produced this pass" is answerable.
- The gate **must not** read it. Assert this: a record with `executedBy: 'something-else'` and an otherwise valid
  receipt is still `satisfied`.

This is the concrete expression of §0.1: platform is provenance, capability is the contract.

**RED**

1. A record written with a receipt records the host identity the receipt carries.
2. Changing only `executedBy` does not change `gate.satisfied` (provenance cannot gate).
3. If the receipt carries no host identity, `executedBy` is **absent** rather than an empty string — an empty string
   would claim a provenance nobody supplied.

**Acceptance.** The field has a producer or is removed; it never influences admissibility.

**Open decision for the implementer.** If the receipt gains a `platform` field, this is where it is surfaced — but the
field must be **optional and never required**, or the contract becomes platform-coupled by the back door.

---

## 6. P1 — Phase 4's Kata-side half: the corpus shadow comparison

Phase 4 asks to *"run the corpus against the new path in shadow mode … publish the comparison, including every
disagreement sample"* and to *"promote strict/security gating only when the corpus accepts it."* The shadow over
**live** rounds needs H1; the shadow over the **corpus** does not.

### 6.1 A defect this exposes, found while writing this plan

`EvaluationManifest.verifier` is shaped `{ baseline: CorpusObservation; current: CorpusObservation }` — **one
observation per side** — while `scoreCorpus` expects one observation **per case**. Measured:

```
corpus cases: 27 | critical: 21
FULL observation set (a perfect verifier)     -> criticalRecall: 1        falsePassRate: 0
ONE observation (the manifest's actual shape) -> criticalRecall: 0.0476   falsePassRate: 0
```

`0.0476 = 1/21`. So on the real release path the gate reads ~4.8% recall for *any* verifier, perfect or blind. Two runs
of the same shape compare equal and the gate passes — **vacuously**. The gate is mechanically correct and fed a shape
that cannot express the measurement it exists to make. This is the same class as the rest of this line of work: a
declared surface with no producer of the right shape.

**Do.** Change the manifest to carry the full per-case set (`baseline: CorpusObservation[]`,
`current: CorpusObservation[]`), and make an incomplete set an explicit refusal rather than a silent low score.

**RED**

1. A perfect verifier declared over the whole corpus scores `criticalRecall: 1` — the measured failure is that it
   currently scores `1/21`.
2. A declared set missing a critical case's observation is **refused** (`unmeasured` / `skipped`), never scored as a miss.
   An absent observation and a missed defect must not read alike.
3. A blind verifier (all `no_defect_found`) scores `criticalRecall: 0` and `falsePassRate > 0`.

### 6.2 The shadow report itself

**Do.** Add `shadowCorpusReport(corpus, observations)` returning, per case:

```
{ caseId, kinds, critical, expectedVerdict, legacyAccepted, derivedVerdict, agrees, disagreement? }
```

where `legacyAccepted` is the pre-change rule (accept the observation's declared verdict at face value) and
`derivedVerdict` is what the new rule concludes (a `no_defect_found` on a critical case is a false pass, not a pass).
Surface it through the eval report so the comparison is published, not computed and discarded.

**RED**

1. Every corpus case appears in the report — the comparison covers the same entries for both paths (Phase 4's stated
   acceptance).
2. A case where the legacy rule accepts and the new rule refuses is reported as a **disagreement with its case id**, not
   folded into a count. Phase 4 requires every disagreement sample to be published.
3. An empty observation set produces an empty report **and** an explicit "nothing compared" marker — an empty comparison
   must not read as "no disagreements".

**Acceptance.** The comparison is reproducible, covers identical entries on both sides, and every disagreement is named.

---

## 7. H1 — the host executor (specified here, implemented elsewhere)

Not this repository. Recorded so the boundary is unambiguous and so a second host can follow it.

> **Corrected 2026-09-22, by measurement: the recommended realisation is a `subagent` round, not a supervisor process.**
>
> This section was written on an assumption — that a subagent's telemetry could only be its own report, which is the
> self-report the receipt exists to replace. Measured on this host, twice: a subagent round returns
> `Agent completed in 20.5s (2 tool uses, 52.7k token)` to its **caller**, and the count tracked the activity exactly
> (two `read` calls, nothing else). The number is the platform's accounting, not prose the reviewer wrote.
>
> What that buys, against the supervisor route in the steps below:
>
> | | supervisor process | **subagent round** |
> |---|---|---|
> | `fresh_context` | the launcher remembering `--no-session --no-context-files --no-extensions` | **the platform creates the session** |
> | `read_only_fs`, `bounded_tools` | the launcher writing the `--tools` allowlist correctly | the platform's tool allowlist |
> | telemetry | the launcher parsing an event stream | **the platform's completion report** |
> | artifacts needed | supervisor + adapter + reference command | **none** |
>
> The node's required set is `['fresh_context', 'read_only_fs']` (`requiredCapabilitiesForNode('review')`), which a
> subagent round satisfies directly — the closure is exact rather than approximate. This is also how a coding agent
> normally works, which is not a small consideration for a mechanism a human has to operate.
>
> **Residual weakness, stated rather than hidden.** The numbers reach the receipt through the **calling session**, because
> the caller is what writes the file: the telemetry is relayed from the platform by the author's agent. Mitigations, in
> order of strength: have the receipt carry the platform's identifiers (child session id, the completion line) so an
> auditor can cross-check it against the platform's own record; and note that capability *names* cannot be inflated at all
> — the gate checks them — so the surface a relaying session can distort is numbers, not capabilities.
>
> **`budget_enforced` is the one capability a subagent round does not get for free.** The caller can bound wall clock
> (the launch takes a timeout) and tools, but it cannot stop a round at the Nth tool call or the Nth output byte; those are
> checkable after the fact, not enforceable during. It must therefore not be claimed, and no node that requires it may be
> certified this way — which is the existing fail-closed behaviour, not a new rule.
>
> **What remains valid.** `kata-cli adversarial execute` and `host/executor.ts` stay as the **declared-command** route
> (option A): they are what a project declares when it wants an out-of-process round with a real event stream, and the
> contract is unchanged either way. They are a supported alternative, no longer the recommended realisation.

A conforming executor, for one host:

1. Reads the request emitted by K2.
2. Starts a session that did not author the change, with no inherited context.
3. Restricts the session to read-only tools.
4. Enforces `budget` (`maxHypotheses`, `maxToolCalls`, `maxOutputBytes`, `maxWallMs`) and reports exhaustion rather than
   running on.
5. Measures telemetry from the session's own event stream — tool calls, output bytes, tokens, truncations.
6. Writes the receipt itself, to the path K1 reads.
7. Reports `executor_unavailable` when it cannot provide a required capability, instead of emitting a weaker receipt.

**Reference realization (Pi), to show the capability set is satisfiable with existing facilities:**

```
pi -p --tools read,grep,find,ls --mode json --no-session --model <host-chosen>
```

`-p` + `--no-session` → `fresh_context`; `--tools` allowlist → `read_only_fs` and `bounded_tools`; a wrapper enforcing
the envelope → `budget_enforced`; `--mode json` → telemetry. **This is one realization, not the contract** — a second
host satisfies the same four capabilities however it can.

**Acceptance (verified on the host).** A real strict round records a receipt; removing the tool restriction is refused
for `capability_missing`; exceeding the envelope yields `budget_exhausted` and is **refused** rather than filed as "no
defects found".

---

## 8. Sequencing

```
K2  ──► K1        (a host needs the request before a bound receipt can exist)
K3, K4, K5        (independent of the above; K5's "from the receipt" wants K1)
P1.1 ──► P1.2     (the shadow comparison is meaningless until the observation shape is right)
H1                (host side; K1 + K2 are its prerequisites)
```

K1–K5 and P1 are each TDD-sized and independently testable. None of them requires a host to exist, which is what makes
them deliverable before H1.

## 9. Open decisions

1. **Where the executor lives** — project-local (`.pi/extensions/`) or global (`~/.pi/agent/extensions/`). Affects
   who can use it, not the contract. **Mostly answered by the correction above**: on the recommended subagent route there
   is no artifact to place — the round is a platform facility the calling agent invokes — so this decision narrows to the
   optional declared-command route.
2. **Whether to add an external trust anchor** for genuine unforgeability. Out of scope here; needs its own design.
3. **Whether `executedBy` should instead be removed.** Recommended against: with K1 it has a real producer, and
   "which host produced this" is worth being able to answer.
