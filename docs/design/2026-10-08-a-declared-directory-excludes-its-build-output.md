# A declared directory excludes its build output

**Date**: 2026-10-08
**Change**: `a-declared-directory-excludes-its-build-output` (current_worktree / tdd / strict)
**Source**: `docs/superpowers/reports/2026-10-08-declared-directory-expansion-includes-caches.md` (reported from the `zenmpai`
checkout, where it blocks the review phase outright), verified against this repository before anything was written.

## The defect, reproduced

Two enumerations answer "what content does this change own", and they answer differently:

| consumer | site | excludes `__pycache__`? |
|---|---|---|
| revision identity (the seal) | `src/core/repository-identity.ts:25-38` `ignoredDirectoryNames`, reached through `isIgnoredRepositoryPath` | **yes** |
| ledger subject (declared-directory expansion) | `src/store/ledger.ts` `walkFiles` — `if (entry.name === '.git' \|\| entry.name === 'node_modules') continue;` | **no** |

`freezeSubject` expands a declared directory through `walkFiles` unconditionally, so the cache paths enter
`subject.pathDigests`. Reproduced out of tree at `67d43f3` (a fixture with `ownedPaths: ["src/pkg"]`):

```text
ledger freeze          → pathDigests: src/pkg/__pycache__/mod.cpython-312.pyc, src/pkg/mod.py
ledger plan            → sampling.seed contains the .pyc; at rate 0.2 promoted contained two .pyc paths
rewrite the cache      → ledger run refuses:
  the frozen subject describes content that has moved since it was frozen
  (src/pkg/__pycache__/mod.cpython-312.pyc): the request would brief a reviewer on content that is no longer the change
```

The consequence is not a nuisance: `verify` runs the acceptance commands, running a Python suite rewrites `.pyc` files, and
`ledger run` sits between `verify` and `review` — so **the documented order cannot produce a review request** for any change
that declares a directory containing a test package. The drift message names a `.pyc` and says only "Re-freeze … first", which
is true and useless: the next test run moves it again.

## Root cause

**One fact, two implementations.** "This path is not content" is already decided by `ignoredDirectoryNames` /
`ignoredPathPrefixes` / `isIgnoredRepositoryPath` in core, with a comment explaining why each entry is there. The ledger's
walk never asked that predicate and re-decided the question with two string comparisons. This is the failure mode this
repository keeps recording — a second derivation of a fact that already has one — and it is why the two walks disagree on
caches, on `dist`, on `.pytest_cache` and on `.mypy_cache`.

The second half of the report follows from the first: the sampling seed is built from the declared content
(`contentPaths: Object.keys(current.pathDigests)`), so the caches that the freeze recorded are also promoted to the reviewer's
reading list. Fixing the freeze fixes the sampling surface for the same reason, in the same place.

## Decision

**Option A: one predicate, two consumers.** `walkFiles` stops deciding and asks `isIgnoredRepositoryPath` (the same predicate
the identity walk uses), so a path that is not content cannot be recorded as content by either enumerator, and neither can
drift from the other without a test failing.

**Why not the alternatives.**

- **B — keep two rules and only report the difference.** It leaves the sampling surface holding compiled artefacts and leaves
  the drift refusal firing on build output, which is a rule that no operator can satisfy for long. Reporting a consequence
  the mechanism created is not a repair.
- **C — let `ledger run` re-freeze when only non-content paths moved.** It treats the symptom at one of the two consumers and
  silently rewrites the subject; the seed would still sample caches. At best a companion to A.

**Boundary, stated so it can be argued with.** The predicate applies to **directory expansion**. A file declared explicitly
(including one inside `dist/` or `__pycache__/`) is still recorded, because declaring a file is a statement about that file
rather than a request to enumerate a tree. Nothing in the drift rule is loosened: a declared source file that is edited or
deleted still refuses, and the control below pins that.

**Trade-off, disclosed.** After this change both enumerations agree that a directory's build output is not content — including
for a project whose deliverable happens to live under `dist/`. That is already the identity's rule (the seal has excluded
those names all along); this change makes the ledger stop disagreeing with it rather than inventing a new exclusion. A
deliverable under such a name is still declarable as a file.

## Acceptance criteria

| AC | What it asserts | Selector |
|----|-----------------|----------|
| AC-1 | Declaring a directory records no build/cache path under it, so a test run that rewrites a `.pyc` cannot move the subject | `tests/unit/a-declared-directory-excludes-what-is-not-content.test.ts` |
| AC-2 | The two enumerations answer the same question the same way — one predicate, and a guard that fails if either drifts | `tests/unit/the-two-enumerations-agree.test.ts` |
| AC-3 | The sampling surface holds no build/cache path, so a reviewer is not handed a compiled artefact | `tests/unit/the-sampling-surface-holds-no-caches.test.ts` |
| AC-4 | A genuine content move still refuses, and the refusal names the source path that moved | `tests/unit/a-real-content-move-still-refuses.test.ts` |

Each selector is its own file: acceptance criteria that share a file collapse into one check under `dedupeChecks`, and the
verification then reports `insufficient_evidence_level` — measured on this repository.

## Falsifiers — run, and what they actually did

Each mutation was applied to production code, the selector run, and the file restored byte-identically (`cmp`):

- **M-caches-1 — the walk decides the question itself again** (`isIgnoredRepositoryPath(...)` → the old two-name comparison):
  reddens **five** cases across AC-1, AC-2, AC-3 and AC-4's cache half. This is the mutation that reproduces the reported
  defect.
- **M-caches-2 — a second predicate that differs by one name** (`... || entry.name === '.pytest_cache'`): reddens the AC-2
  agreement case, which is exactly the drift that guard exists to catch.
- **M-caches-3 — a declared path that cannot be read is silently skipped** (`unreadable.push(path)` → `continue`): **did not
  redden AC-4.** Recorded because the first version of this section claimed it would: the drift comparison diffs the frozen
  subject against a freshly computed one, so a file skipped in *both* is still reported as removed. The mutation tests
  nothing about AC-4's property.
- **M-caches-4 — the exclusion widened to everything** (`|| true`): reddens all three AC-4 cases, though the first two redden
  on the subject schema's "at least one path" rule rather than on the drift assertion — over-exclusion is caught, but by a
  different guard.
- **M-caches-5 — the drift check stops counting removals** (`[...diff.changed, ...diff.added, ...diff.removed]` →
  `[...diff.changed, ...diff.added]`, in `src/store/review-request.ts`, which is declared for exactly this): reddens AC-4's
  deleted-file case for the right reason (`expected … to contain 'src/pkg/extra.ts'`).

**What M-caches-3 taught, and what it changed.** AC-3's property follows from AC-1's exclusion, and AC-4 is a control rather
than a claim about new behaviour — so two of the four acceptance criteria do not have a mutation *of their own* that fails for
their own reason. That is stated here rather than papered over with a mutation that reddens for an unrelated cause, and the
declared surface grew by one file (`src/store/review-request.ts`) so that AC-4's drift half could be shown to fail at all.

**A mutation that leaves a selector green is a finding about the selector**, not a passing test — this repository has paid for
that repeatedly, so each one is run before the round is dispatched and recorded here.

## Ownership

`src/store/ledger.ts` and `docs/operations.md` are shared with active changes; the conflicts are recorded as audit facts by
`scope change` rather than narrowed away, which is this repository's standing practice.

## What this change does not do

- It does not change what a revision's identity covers (the identity walk is the reference implementation here, not the
  subject of the fix).
- It does not touch `evidenceIds`, the ledger's question identity, or the review-record binding — those are separate,
  already-sealed changes.
- It does not add `PYTHONDONTWRITEBYTECODE`-style advice: requiring an author to rewrite Kata's own acceptance command would
  turn a mechanism defect into a discipline.
