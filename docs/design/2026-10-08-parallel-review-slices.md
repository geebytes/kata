# Parallel review slices: reduce review latency without weakening judgement

**Status:** proposed requirement; not implemented

## Problem

Independent Kata review rounds currently send one complete `ReviewRequest` to one read-only reviewer. The model preserves a simple accountability boundary, but the reviewer must serially inspect every independent risk class. Large reviews therefore accumulate wall-clock latency even where identity/binding, state-machine/concurrency, unreadable-record, and test-falsifiability analysis do not depend on one another.

A helper/scout design that requires one canonical reviewer to re-run every scout investigation is not an efficiency solution: it duplicates the expensive reproduction work. It may broaden discovery, but it need not reduce the critical path and can increase total agent cost.

## Requirement

Introduce a future **parallel-review-slices** mechanism that reduces wall-clock latency for sufficiently broad review requests without lowering review quality or altering the meaning of a passing review.

The mechanism MUST:

1. dispatch only from one frozen, revision-bound `ReviewRequest`;
2. partition the review by explicit, non-overlapping **risk/mechanism classes**, never merely by file;
3. make every slice a formal, read-only review unit with a declared coverage boundary, commands, observations, and findings;
4. retain a mandatory cross-slice integration review for protocol boundaries, caller/consumer mismatches, and state transitions;
5. make slice coverage closed: an unassigned, failed-to-start, timed-out, or unreadable slice is `uncovered`, never an implicit pass;
6. bind every finding and observation to the request, revision, manifest/content identity, responsible slice, command, and observed output;
7. preserve the invariant that a reproducible blocking or security finding cannot be erased by aggregation or majority vote;
8. preserve the current distinction that an absent artefact differs from an unreadable artefact;
9. keep review code read-only; only the established result/ledger paths may persist formal review results;
10. assign every `ReviewRequest.probes` item to exactly one formal owner. `withheldProbes` remain history and are never dispatched as obligations.

## Proposed mechanism

### 1. Freeze and plan

The current review request remains the single upstream deterministic input. Before dispatch, a deterministic `ReviewPlan` derives a finite set of slices:

```text
ReviewRequest (revision, manifest, claims, evidence, probes)
  -> ReviewPlan
       - slice id
       - risk class and declared coverage boundary
       - source/evidence scope
       - assigned probes, if any
       - required output schema
       - integration-slice flag
```

The plan is part of the review record. A slice cannot silently discover a new obligation by reading author-written context outside the request and its declared scope.

### 2. Parallel formal slices

Each slice runs in a fresh, read-only context and returns a structured `SliceResult`, not an informal scout memo:

```text
SliceResult
  - request identity and slice id
  - coverage completed / uncovered with reason
  - commands and observed output
  - findings, each with reproduction material
  - answered probe ids
  - limits and unreadable inputs
```

Suggested initial risk classes:

- identity, revision, and question binding;
- state transitions, concurrency, and recovery;
- fail-closed record/schema/error handling;
- test falsifiability and evidence instrumentation;
- mandatory cross-slice integration.

The integration slice is deliberately not a generic summary. It investigates relationships that cannot belong to a file-local slice: writer/reader pairs, protocol producers/consumers, cross-state paths, and claims whose evidence spans slices.

### 3. Deterministic aggregation

An aggregator validates binding and completeness, deduplicates identical findings, and derives the final review result. It does **not** treat a missing slice as approval and does **not** re-run every slice solely to re-derive its work.

It must refuse aggregation when:

- any slice has a different request, revision, manifest, or content identity;
- required coverage is absent or unreadable;
- a probe has zero or multiple owners;
- a formal finding lacks its required reproduction material;
- a slice result cannot be parsed or validated.

The aggregate preserves each slice's evidence so a later reader can identify who examined which mechanism. It does not merge away a reproducible blocking/security finding.

## Quality model

This design trades a single reviewer’s serial full inspection for explicit collective coverage. Quality is not assumed from parallelism; it comes from mechanically enforced coverage and binding.

| Risk introduced by partitioning | Required compensation |
|---|---|
| Cross-file/protocol defect falls between shards | Mandatory integration slice over declared writer/reader and state boundaries |
| No one owns a risk class | ReviewPlan coverage closure and fail-closed aggregation |
| Finding becomes unverifiable attribution | Per-slice request/revision/manifest/command/output binding |
| A timeout looks like no issue | `uncovered` is a review refusal, not a pass |
| Majority votes away a severe bug | Reproducible blocking/security findings are non-votable blockers |
| Probe double-answer or omission | Each current probe gets exactly one declared owner |

This is materially different from using parallel agents as advisory scouts. Advisory scouts can supplement a review, but only formal slices can remove serial review work from the critical path.

## Cost and latency hypothesis

For independent review classes `A`, `B`, `C`, and integration `I`:

```text
Current wall clock: A + B + C + I
Parallel-slice wall clock: max(A, B, C) + I + aggregation
```

The mechanism should be enabled only when expected independent work dominates fixed dispatch and aggregation overhead. Small or tightly coupled changes remain one complete reviewer.

This is a wall-clock optimization, not a token-cost optimization. Multiple formal reviewers will repeat request context and usually cost more total tokens. The expected benefit is lower latency on broad reviews with at least three independent risk classes; the earlier 1.5–3x range is a hypothesis, not a promised result.

## Validation before adoption

Do not enable the mechanism based on intuition. Run it in shadow mode against a representative historical set of frozen `ReviewRequest`s and compare it with the existing full-review route:

1. wall-clock latency from issued request to review result;
2. total agent/token cost;
3. unique valid findings versus the baseline route;
4. false-positive rate after reproduction;
5. findings found only by the integration slice;
6. uncovered/timeout/error rate;
7. per-risk-class coverage and probe ownership completeness.

Adopt only if the measured latency improvement does not reduce valid-finding coverage or increase unaccounted-for review surface. If it does, retain the current one-reviewer route for that request class.

## Scope and sequencing

This proposal does **not** change the active `close-the-read-and-binding-gaps` change. That change should complete under the existing review protocol. Parallel review slices require a dedicated governed change because they modify review dispatch, result schemas, aggregation semantics, and potentially host execution receipts.

The first implementation change should be limited to planning, schema validation, shadow execution, and metrics. It must not make shadow results gate-determining until the comparison evidence supports a separate approval to change gate behavior.
