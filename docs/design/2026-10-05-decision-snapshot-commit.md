# Decision Snapshot Commit Design

**Change:** `decision-snapshot-commit`
**Date:** 2026-10-05
**Status:** accepted and in implementation (pending verification)
**Source research:** `tmp/review-loop-methodology-report.md` (spike draft; this document is the governed design)

## 1. Problem and decision

`review-loop-verdict-unification` made the review-loop verdict a single pure derivation, but repeated review found a different failure class: one command could read the current revision pointer more than once, then combine authorization, route, and written round data from incompatible observations. A local "read it once" repair prevents accidental intra-command disagreement, but it does not prevent a seal from moving the revision between authorization and a later write.

This change adopts a bounded **review decision snapshot and optimistic commit validation** design:

1. The review decision family obtains one explicit, already-read snapshot for all business authorization and route calculation.
2. A writer validates that snapshot under the existing task lock immediately before writing. A changed identity produces the existing superseded/retry-required outcome and must not write an outcome for the newer revision.
3. A machine-checked inventory prevents undeclared direct readers inside this family.
4. A small declarative model checks record state, binding, and `read A → seal B → commit A` sequences before an independent reviewer is asked to find individual sites.

The second pointer read in step 2 is deliberate compare-and-commit validation. It is not a second business decision and must be the only permitted post-snapshot direct read in the family.

## 2. Scope and non-goals

### In scope

- Review-entry, review approval, review repair authorization, review-round writing, and Judge verdict writing paths.
- Review-clearance consumers that decide from the Review artefact: `distill-gates.ts` and the archive security gate.
- The shared revision/identity and task-lock primitive they use.
- A static reader inventory, a deterministic reference model, focused unit tests, and workflow entrypoint tests.

### Explicitly out of scope

- Decision families whose inputs are not Review artefacts (for example scope mutation, context construction, CLI display, and evaluation fixtures). They retain their own reader semantics rather than inheriting a review decision snapshot.
- Changing strict review gate semantics, allowing an iteration cap, or treating `insufficient` as pass.
- A global private/raw-reader ban, ESLint-boundaries adoption, or a `fast-check` dependency. The first two over-couple unrelated families; the last is premature while the state product is finite and readable in Vitest.
- Moving or deleting compatibility projections merely because they have no current source reader.

## 3. Architecture

### 3.1 ReviewDecisionSnapshot

Introduce a review-family snapshot abstraction in `src/workflow/revision.ts`. Its exact TypeScript field names follow existing record-read types, but its contract is fixed:

- It carries the one current-revision record read used by the decision, including the full identity `(revisionId, manifestHash)` when usable.
- It carries the review inputs already needed by the decision (for example review-record/round-history reads) rather than allowing a consumer to obtain a fresh pointer read.
- It records the identity the later commit must validate.
- Consumers receive this object or an identity derived from it; they do not call `readCurrentTaskRevision*` themselves for a business choice.

`navigation.ts` remains a consumer of review-loop assessment, not a global owner of revision reads. `repair-entry.ts` and `orchestrator.ts` receive/forward the snapshot through authorization, approval, repair, and round-writing paths.

### 3.2 Commit validation

A write follows two phases:

1. **Read/evaluate (unlocked):** load the snapshot and derive the proposed review/repair/round outcome. This phase may run normal local evaluation but must not hold a task lock across slow work.
2. **Validate/write (locked):** use the existing `withTaskLock` boundary to re-read only the current revision identity and compare it to the snapshot identity. On equality, perform the append/transition. On inequality, perform no stale write and return the established superseded/retry-required path.

Only a usable identity is eligible for a current-bound write. `absent` and `unreadable` retain their existing named refusal behavior; they are never coerced into an identity and never validated as current.

This is optimistic concurrency, not an attempt to make filesystem reads globally atomic. It fixes the relevant safety property: a decision computed for A cannot be persisted as a decision for B after a concurrent seal.

### 3.3 Bounded machine-checked reader inventory

`tests/unit/review-decision-snapshot-inventory.test.ts` will inspect the declared review-family files with TypeScript AST or the project’s existing wiring-check pattern. It must report all sites, not merely pass/fail.

Allowed direct current-pointer calls are limited to:

- the named snapshot factory; and
- the named commit-time identity validator.

The allowlist is a typed/documented inventory with a reason for every site. Test fixtures are excluded by path, not by string-pattern loopholes. A new direct reader in `navigation.ts`, `repair-entry.ts`, or `orchestrator.ts` fails locally until it is either routed through the snapshot or explicitly added to the design and guard as a validator.

`distill-gates.ts`, `cmdJudge`, and `cmdArchive` are inventory consumers: their review-derived decisions receive the same snapshot through `readReviewRecord`, and the Judge writer passes the lock capability from commit validation into its atomic artefact write. Readers outside this bounded family remain follow-up candidates, not silent exemptions.

### 3.4 Reference model and mutation classes

`tests/unit/review-decision-snapshot-model.test.ts` contains a declarative model independent of production readers. It enumerates:

| Axis | Values |
| --- | --- |
| sealed revision read | `absent`, `usable`, `unreadable` |
| round-history read | `absent`, `usable`, `unreadable` |
| round binding | `legacy`, `foreign`, `current` |
| commit movement | `unchanged`, `moved` |

The matrix has 54 combinations before impossible states are explicitly rejected. It also exercises the required sequence:

```text
load snapshot A → seal revision B → attempt commit for A
```

The expected outcome is a non-writing superseded/retry result; no round or review outcome may bind itself to B.

Mutation evidence is class-based, not spelling-based. The declared family includes: dropping the handed-in snapshot, restoring a direct reader at a consumer, dropping `manifestHash` from identity comparison, treating unreadable input as whole history, skipping commit validation, and lowering the route of a terminal assessment. Each mutation must redden a focused selector and restore cleanly.

### 3.5 Entrypoint evidence

`tests/e2e/review-decision-snapshot.test.ts` drives the actual review and Judge workflow paths, creates/moves a revision between the initial read and commit using a deterministic test seam, and asserts that neither command writes a current decision for the later revision. This is required because a unit-only model cannot prove the production command invokes the validate/write boundary.

## 4. Acceptance-criterion mapping

| AC | Mechanism | Evidence |
| --- | --- | --- |
| AC-1 | Snapshot factory plus lock-scoped identity comparison before review-family and Judge verdict writes | `tests/unit/review-decision-snapshot-commit.test.ts`; `tests/e2e/review-decision-snapshot.test.ts` |
| AC-2 | Wiring inventory; snapshots threaded through review entry/approval/repair/round writers and Review-clearance consumers | `tests/unit/review-decision-snapshot-inventory.test.ts` |
| AC-3 | Declarative 54-state matrix, moved-identity sequence, class mutations, and workflow entrypoints | `tests/unit/review-decision-snapshot-model.test.ts`; `tests/e2e/review-decision-snapshot.test.ts` |

## 5. Failure semantics and compatibility

- A moved identity is a structural stale/superseded result, not a silent retry and not a pass.
- Lock scope contains only validation plus the task-artifact write; it must not encompass model execution, independent review, full verification, or external work.
- Legacy/unbound rounds remain readable audit history and never satisfy a current identity comparison.
- Existing public result/route vocabulary is reused where possible. If current code lacks a precise stale result, the implementation must expose it explicitly and test it rather than mapping it to an unrelated refusal.

## 6. Verification and review closure

Before sealing, all three focused selectors, the entrypoint selector, the full TypeScript check, and the full test suite must pass. The static inventory and declarative model run before the independent review so mechanically discoverable reader sites are found locally.

A fresh strict review remains mandatory for the sealed content. Its brief must name the bounded review decision family — including Judge verdict writing and Review-clearance consumers — so reviewers may challenge the inventory/model but cannot turn an unrelated decision family into a retroactive scope waiver.

## 7. Risks and rejected alternatives

| Risk | Mitigation |
| --- | --- |
| Lock held across expensive work | Strict two-phase read/evaluate then validate/write shape |
| Snapshot abstraction expands into a global context | Only review family is in this change; other families get separate follow-ups |
| AST guard becomes an unreviewed allowlist | Every allowance is named, reasoned, and tested; new site output is explicit |
| Model duplicates implementation | Model contains only record states, equality, movement, and allowed outcomes; it must not call production assessment or readers |
| Fresh review still finds a real new class | Keep strict fresh review; do not add an iteration cap or waive it |

## 8. External-practice rationale

The supporting spike consulted stateful/model-testing guidance from Hypothesis and fast-check, mutation-testing guidance from PIT, Rust module privacy as a boundary analogy, and iterative-review literature. The applicable conclusion is not that random/property tests or types prove absence of defects; it is that a bounded reference model, explicit capability boundary, deterministic replay, and class-targeted mutants make the coverage claim inspectable. The complete citations and adoption caveats remain in `tmp/review-loop-methodology-report.md`.
