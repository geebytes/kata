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

## The first independent round: one predicate was still a second walk

Round 1 (`adversarial`, `revision-dad8093cca7a7cce`) returned **fail** with three majors, and the first two are the same
finding twice: **the identity walk is not a predicate.** It filters three ways, and the repair only adopted one of them.

| what the identity walk does | what the repaired expansion did | measured consequence |
|---|---|---|
| consults the repository's own git declaration (`gitIgnoredPaths`, `repository-identity.ts:147`, used at `:194`) | nothing | a git-ignored file under a declared directory was recorded as content, so editing it moved the frozen subject — the reported defect, in another form |
| has no depth cap | stopped at depth 8 | a source file ten levels down was invisible, so editing real code moved nothing |
| speaks in repository coordinates | built keys from the raw declaration | declaring `src/pkg/` recorded `src/pkg//mod.ts` |

And the third major is about the guard: `the-two-enumerations-agree` **never invoked the identity walk** — it compared the
ledger against `isIgnoredRepositoryPath`, so it could not fail when the two *enumerations* drifted. Its title named two
enumerations; its body called one. That is this repository's recurring finding, and it was in the guard written to prevent
exactly this.

**The repair is to stop enumerating in the ledger at all.** The declared-directory expansion now calls
`listRepositoryFiles(root, { under })` — the identity's own walk, the same one the revision manifest uses — and removes
`walkFiles` entirely. Consequences, each with its own case:

- git-ignored paths, cache names, build output, tool state and deep paths are excluded or included exactly as identity says,
  because there is only one answer;
- keys are built from the normalised declaration, in the coordinates the walk speaks;
- a declaration that expands to nothing says so (`the declared paths hold no content to freeze: …`) instead of failing on
  `$.pathDigests must NOT have fewer than 1 properties` — a message about the record, naming nothing about the declaration;
- the guard calls the walk: `recorded === await listRepositoryFiles(root, { under })`, with preconditions that the fixture
  really holds a git-ignored file and a ten-level-deep file, so a fixture that stopped exercising the rule cannot make it
  pass.

**The lesson, recorded because it is the third time in this repository's recent history.** "One predicate, two consumers"
was still two consumers: a predicate is not an enumeration. If a second place must agree with a first, it has to *call* the
first — copying its filter, or asking the part of it that looks like a rule, leaves the rest of the first one's behaviour
unshared. The guard has to call the same thing too, or it certifies agreement with a proxy.

## The second independent round: the walk was shared, the coordinates were not

Round 2 (`adversarial`, `revision-3ac1409491ff8292`) returned **fail** with four majors, and the first two are one finding: the
expansion called `listRepositoryFiles` but then **rebuilt the keys itself** — `file.slice(declared.length + 1)` on the raw
declaration — instead of using the path the walk returned, and it never canonicalised the declaration the way the seal does
(`normalizeOwnedPaths`, which `revision.ts:94` calls).

| input | measured |
|---|---|
| `./src/pkg` | keys `./src/pkg/d.ts`, and `./src/pkg/sted/deep.ts` for `src/pkg/nested/deep.ts` — the slice landed mid-name |
| `./src/pkg` with `{a,b,aa,ab}.ts` | four files collapsed onto **two** keys, so editing a source file left the frozen subject byte-identical |
| `src/pkg/build` (a git-ignored directory as the declaration root) | its build output was recorded, so a rebuild moved the subject — the reported defect, for a root instead of a file inside one |
| `.` / `..` | accepted and walked outside the repository (`../oob.txt` recorded) where the seal refuses them |
| a symlinked declared directory | traversed by the ledger, dropped by the identity walk from the root |

The round also found something about this change's **own record**: `ledger evidence replace` replaces the evidence set but
leaves the claims' `evidenceIds` alone, so the bindings I passed in the same document were ignored — C3 cited the
two-enumerations falsifier, C4 cited the sampling one, and the real-move falsifier was bound to no claim at all, so C4 would
have stayed certified even if its own selector were deleted. That is repaired here (the bindings are now each claim's own
selector) and the tool behaviour is a successor finding.

**The repair, third time and at the class.** The enumeration and the canonicalisation moved to
`core/repository-identity.ts` — `normalizeDeclaredPaths` (the seal's rule, now literally the same function) and
`declaredContentPaths` (what a declaration covers, in the walk's own coordinates, with three named outcomes: paths,
unreadable, and a **root that is never content**). The ledger records the paths that function returns, so there is no key
construction left to get wrong; a declaration root that is never content is refused by name rather than expanded; `..` is
refused with the seal's message; and the guard now compares the frozen subject with **`computePathDigests`** — the seal's own
expansion — because that is the derivation that must agree, rather than a third opinion.

**What is deliberately still different, stated so it can be argued with.** The seal records `[missing]` and `[unsupported]`
sentinels for a declaration it cannot read; the ledger refuses such a declaration by name. That difference is intentional and
pre-existing (a sentinel is indistinguishable from a deleted file at the ledger's readers), and it is the one place where the
two expansions answer differently.

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

**Where a criterion has no mutation of its own, said precisely (corrected by round 1).** AC-4 *does* have one — M-caches-5
reddens its deleted-file case for its own reason (`toContain('src/pkg/extra.ts')`), and an earlier version of this paragraph
claimed otherwise. AC-3 is the one without: E4 and E1/E3 all move the same policy, so what reddens the sampling case is a
shared mutation, not an AC-3-specific one. That is stated here rather than papered over with a mutation that reddens for an
unrelated cause.

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
