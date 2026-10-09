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

## The third independent round: three more, and one about my own falsifiers

Round 3 (`adversarial`, `revision-636c49466287aa5e`) returned **fail** on C2 — the two enumerations still disagreed — and it
found something worse than a code defect: **one of my falsifiers was invalid.**

| finding | measured | repair |
|---|---|---|
| a git-ignored directory as the declaration **root**: the seal records its content, the ledger refused it | `seal = [src/pkg/build/out.js]`, `ledger = ERROR never content` — and the guard stayed green, so my "the only deliberate difference is the sentinel" claim was false | the filter is for what a declaration **silently pulls in**; a declaration is the operator's own statement, and the identity has always honoured it without a cap or a filter. The ledger now records what the seal records and **reports** the never-content root in the freeze payload |
| a declared **FIFO** made `ledger freeze` **hang** | the loop stat-ed first and branched itself, so a non-dir/file fell through to `readFile`, which blocks on a pipe with no writer — no refusal at all | every declaration goes through `declaredContentPaths`, which classifies it as unreadable; one call, no branch of the ledger's own |
| a backslash declaration (`src\pkg`) was reported unreadable | the raw spelling was stat-ed before the canonicalisation the seal applies first | same repair |
| **E3 was a syntax error** | `--id E3` was `supported` because the module failed to transform; the legal equivalent mutation left every case green, so the "canonicalises" assertion was not load-bearing | E3 is now a **legal** mutation of `normalizeDeclaredPaths`, and the guard asks that function directly (`normalizeDeclaredPaths(root, ['..'])` must throw, `['./src/pkg', 'src/pkg/']` must be `['src/pkg']`) — it reddens **by assertion**, 26 ms |
| E4 reddens a precondition, not the comparison | recorded | stated in the falsifier table rather than left implicit |

**What is still different between the two, stated precisely (the previous claim was too broad).** Two differences, not one:
the seal records the digest of its `[missing]`/`[unsupported]` sentinel string for a declaration it cannot read where the ledger refuses by name, and
an empty expansion is a refusal here because a subject with no paths cannot satisfy its own schema. Everything else — which
paths a declaration covers, in which coordinates, after which canonicalisation — is one answer, and it is the shared
function's.

## The fourth independent round: the guard was comparing a proxy, again

Round 4 (`adversarial`, `revision-bd5417edfdb8f783`) returned **fail** on C2 with one major and two minors, and the major is
the same sentence the design document had already written about round 1: *the guard certifies agreement with a proxy.*

- **F1 (major).** The plain-directory case compared the ledger with `listRepositoryFiles(root, { under })` — **the same
  function the ledger calls, with default options** — so a mutation in *how the ledger calls it* was invisible. Measured:
  adding `maxFileBytes: maxTreeHashFileBytes` to the ledger's call left the file 19/19 green, while a declared directory
  holding a 3 MB file recorded a set the seal does not, and editing that file left the frozen subject byte-identical.
  **Repair:** the reference is now `computePathDigests` (the seal), and the fixture holds a 3 MB file so a budget applied on
  one side only changes that side's set. The mutation reddens **three** cases by assertion.
- **F2 (minor).** E4 reddened a *precondition* of the comparison rather than the comparison. A depth cap inside the walk
  moves both sides of every equality assertion — the seal reads the same function — so no equality can catch it. **Repair:**
  the depth probe is its own case, asking the shared derivation directly, so E4 reddens by assertion in a case whose title is
  about depth.
- **F3 (minor).** The empty-expansion refusal misnamed its cause for a plain empty directory. **Repair:** the message now
  says *the declaration covers no files: an empty directory, or one whose contents are all never content*.

**And a hole I found myself while this round was running** (in a scratch copy, because editing the checkout would have voided
its readings): every case in the guard declared **one** path, so a mutation expanding only the first declaration stayed green
(9/9). A subject that covers one of several declared paths is this change's defect in its plainest form. The guard now has a
two-declaration case; that mutation reddens it by assertion.

**The falsifier audit the round was asked for** (it is now part of dispatch preparation, after round 3 found E3 reddening
because it did not parse): every falsifier parses; E1, E2, E3, E5, E6, E7 redden for their own reason and their legal
equivalents redden identically; E4 was the one wrong-reason case and is repaired above. Two new falsifiers cover the two
guard gaps (the call shape, and the first-declaration-only expansion).

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

- **Round 5 — two compile-valid mutations that filtered `.json`** (one on the ledger's side of the comparison, one inside the
  seal's `computePathDigests`): both left all 21 cases green, because every fixture declared a directory or a file inside an
  ignored one, and the only `.json` in the tree was git-ignored. The fixture now carries plainly declared files of four
  extensions (`data.json`, `README.md`, `helper.py`, `notes.txt`), declares two of them as files, and puts a `.json` in the
  second declaration; both mutations now redden by assertion (E10, E11). The lesson is narrower than "add more files": a
  comparison is only as strong as the *kinds* its fixture carries, and a per-extension filter is the same defect in miniature.

**A mutation that leaves a selector green is a finding about the selector**, not a passing test — this repository has paid for
that repeatedly, so each one is run before the round is dispatched and recorded here.

## What the rounds taught about this guard

Five rounds of independent review found the same shape five times, each one level deeper: a separate ignore table; a walk that
looked like the identity's but rebuilt its own keys; a normalisation the seal applied and the ledger did not; a falsifier that
was a syntax error; a comparison against a proxy instead of the seal; and finally a fixture that carried only one kind of
declaration, so a per-extension filter on either side stayed green. The guard now compares the ledger's freeze against
`computePathDigests` — the seal's own expansion — over a tree that holds plain files of four extensions, a plainly declared
file of each kind, a second declaration, a git-ignored path, a path deeper than any cap, a file above the tree-hash budget, a
sentinel, and a symlink. Each of those payloads exists because a round showed the guard was silent without it.

### Round 6: the lesson was not another kind, but where the expectation lives

Round 6 found three more one-sided filters that left every selector green: dropping explicitly declared `.md` names on the
ledger's side, dropping declared `.txt` names on the seal's side, and dropping extension-less names. It also found a shape
where the two sides genuinely disagreed — a declared broken symlink, which the seal records as the digest of `[missing]` and
the ledger refused — and it asked the question round 5's repair should already have answered: the fixture is only ever as
strong as the kinds it carries, so adding one kind per round cannot converge.

Two changes answer it, and neither is another kind:

1. **One derivation instead of two.** `freezeSubject` asked the shared enumeration for a *path list* and then read and hashed
   every file itself. That list was the seam: a filter on it changed the ledger's answer only, and no amount of fixture could
   close every possible key. The ledger now asks `computePathDigests` — the seal's own traversal — for the content set and its
   digests, so the set is produced once and there is nothing left for either side to filter.
2. **The expectation is written down.** The guard used to compare the ledger against the seal, which is exactly what a filter
   *inside* the shared traversal defeats: both sides move together and agree. `CONTENT` in
   `tests/unit/the-two-enumerations-agree.test.ts` is now the authority — every kind a filter could key on, written as a list —
   and it is asserted before the comparison (`recorded` must equal `CONTENT` *and* the seal's map). Measured: a filter that
   drops `.md` inside the traversal, which the old guard could not see at all, now fails three cases.

**The one deliberate difference is now stated in C2 rather than hidden by an over-claim.** A declaration the seal answers with
a path the seal can only answer with a sentinel digest (`hashContent('[missing]')`, `hashContent('[unsupported]')` — a dangling symlink, a FIFO) is still refused by name, because a sentinel in a
*declaration* cannot be told from a file deleted after it, and the operator should fix the declaration instead of freezing on
top of it. The guard asserts both halves of that sentence, so neither can move alone. Kinds carried by the fixture, for the
record: an ordinary file, a nested directory, six extensions, a multi-dot name, a name with no extension, a dotfile, a
non-ASCII name, a name with spaces, a case variant, an empty file, a nested kept directory, a file above the tree-hash budget,
a file exactly at it, a hard link, a path twelve segments deep, a git-ignored file, a nested git-ignored directory, a file
excluded through `.git/info/exclude`, a FIFO, a broken symlink, and the set of names the identity table excludes.

### Round 7: the expectation has to come from outside the code under test

Round 7 accepted change #1 and #2 above and then defeated #2 on its own terms. `CONTENT` is a **finite** oracle, so the
guard's discriminating power is exactly the kinds it lists: a one-sided `delete` keyed on `.rs` after the seal's call left the
ledger recording `[b.ts]` while the seal returned `[a.rs, b.ts]`, with all four selectors at 22/22. Shared filters escaped the
same way — `.rs` inside the traversal, a name-length test, `.yaml`, and a reversed walk sort (invisible because both
assertions sorted) — because the fixture carried none of those kinds. Writing the expectation down had made the bound
*visible*, not smaller.

The repair is not a longer list, it is an oracle the code cannot move:

- **Generated kinds.** `generatedTree(seed)` draws 26 files per seed across twelve stems (spaces, non-ASCII, uppercase,
  digits, over-long names, dotted names, underscores), twenty-four extensions (including multi-dot, uppercase, and none at
  all), depths from one to twelve, dotfiles, an empty file and a file exactly at the tree-hash budget — over six seeds. A
  filter keyed on a kind has to match **no** generated kind to escape, which is a very different bar from "no listed kind".
- **The expectation is what the test wrote.** The assertion is against the generator's own return value, never against
  `listRepositoryFiles`, `computePathDigests` or `declaredContentPaths` — machinery a filter inside either side of the
  comparison can move. `Object.keys` (insertion order) is compared, so a reversed sort fails too.
- **`CONTENT` is now described as what it is**: a readable sample that names the shapes worth reading, not the authority.

Measured after the repair: round 7's exact repro (one-sided `.rs` delete) fails two cases; a shared `.rs` filter fails two; a
name-length filter fails one.

Round 7 also found two smaller things, both repaired rather than argued away: the `neverContent` report the design promised
did not exist (`declaredContentPaths` returned it and `freezeSubject` dropped it), so `ledger freeze` now names a declaration
root that is itself never content; and C2 said "one deliberate difference" while the design stated two (a sentinel
declaration, and a declaration covering no content) — the second is now asserted on **both** sides, the seal's empty answer
and the ledger's named refusal, because an unasserted difference is a sentence rather than a rule.

### Round 8: no fixture can witness every kind, so the property is enforced structurally

Round 8 reproduced round 7's shape with one substitution — `.pyc` in place of `.rs` — and defeated both the generated oracle and
the shared-traversal case:

```
Object.assign(digests, sealed);
for (const key of Object.keys(digests)) if (key.endsWith('.pyc')) delete digests[key];
```

With a tree holding `mod.ts`, `thing.pyc` and `tool.exe`, the ledger recorded `[mod.ts, tool.exe]` while the seal returned all
three, and **all 25 declared selector cases passed**. Its reading of the cause is the one that matters: the generator's
`EXTENSIONS` was itself a list, and `.pyc` — the case this whole change exists for — was not on it. `C2` had claimed the guard
"does not depend on a filter's kind being enumerated", which was an over-claim; the design's weaker sentence ("a filter has to
match no generated kind") was the true one.

That is the end of the road for witnesses: for **any** finite fixture, a filter keyed on a kind outside it escapes, and the
kinds are unbounded. So the property is now enforced where it cannot be stepped around, and stated for what it is:

1. **The seam is gone.** `freezeSubject` keeps no map of its own: the value handed to `subjectOf` is the value
   `computePathDigests` returned. There is no longer a line for a filter to be added to.
2. **A structural guard holds that shape.** `tests/unit/the-recorded-digests-are-the-seals-map.test.ts` parses
   `src/store/ledger.ts`, finds `freezeSubject`, and asserts that the identifier given to `subjectOf` is the one the seal's call
   was bound to, and that the body contains nothing that could alter an object — no `delete`, no `Object.assign`, no assignment
   into a property or element. Measured: a `.pyi` filter (a kind no fixture witnesses) leaves all four behavioural selectors at
   25/25 **and fails this guard**; a `.rs` filter fails the behavioural cases as well. Reintroducing the seam fails here
   whatever kind it keys on, which is the property no behavioural test can hold.
3. **`C2` now says what is true.** "The ledger records the seal's content set itself rather than a second expansion of it… the
   structural guard is what makes the property independent of that list" — the claim no longer asserts something the fixtures
   cannot deliver.
4. `EXTENSIONS` gained `.pyc`, `.exe`, `.o`, `.obj`, `.class`, `.log`, `.min.js` and a leading-dot name, as witnesses for the
   readable failure message rather than as the property.

The general lesson, written here because it cost three rounds: **a guard that compares two derivations can only witness the
kinds its fixture carries; if the property must hold for all kinds, enforce the shape of the code, not the answer for a list of
inputs.**

### Round 9: a syntax check is a list too, so the property is object identity

Round 9 defeated the structural guard of the previous repair with an expression the scanner could not see: the map was copied
and filtered through a wrapper (`Object.fromEntries(Object.entries(sealed).filter(…))`) and reassigned to the seal's own name,
so the identifier handed to `subjectOf` was still the one the seal's call was bound to and no `delete`, `Object.assign` or
property write appeared in the body. Every declared selector stayed green while the ledger recorded a set the seal did not.

That is the third coat on the same mistake: the guard was a **list** — of kinds (rounds 7–8), then of statements and argument
shapes (round 9) — and the thing being guarded is unbounded. A syntax check can only name the shapes someone thought of, and
the space of expressions is not enumerable.

So the property is now the one thing a wrapper cannot fake: **object identity**. The guard replaces the seal with a frozen
sentinel map and `subjectOf` with a recorder, runs `freezeSubject`, and asserts `toBe` — the map handed on *is* the object the
seal returned.

- A copied-then-filtered map, however it is written, is a different object ⇒ the assertion fails.
- An in-place filter on a frozen map raises, and the sentinel deliberately carries a `.pyi` key so a filter whose predicate
  matches nothing cannot pass by doing nothing.
- `C2` states this and nothing stronger: one derivation, the seal's own object, asserted by identity — the earlier wording
  ("a one-sided filter cannot exist whatever kind") was an over-claim, and round 9 was right to call it one.

Round 9 also found that the sentinel case asserted the seal's **keys** but not its values, which is how the wrong value —
the string rather than the digest of the string — survived three rounds. Probing the seal directly measured it:
`computePathDigests` records `hashContent('[unsupported]')` for a FIFO and `hashContent('[missing]')` for a dangling symlink
(`src/workflow/revision.ts:485,488`), and the case now asserts those exact values.

**The through-line, four rounds deep**: kinds, then statements, then expressions — every guard that was a list lost to
something outside the list. What survived is the property the code has by construction, asserted by identity.

### Round 10: the guard's own inputs were the list, so the invariant moved into the freeze

Round 10 accepted the identity assertion and then defeated it three ways at once, each by moving the *list*:

| shape | what it did | why the guard was silent |
|---|---|---|
| a wrapper **after** `subjectOf` | `{ ...s, pathDigests: Object.fromEntries(Object.entries(s.pathDigests).filter(…)) }` | the guard recorded only the **argument** to `subjectOf`; everything after the call was unguarded |
| a **conditional** copy **before** the call | `if (Object.keys(sealed).some(k => k.endsWith('.mts'))) sealed = Object.fromEntries(…)` | the sentinel's **keys** were a list, and `.mts` was not on it |
| a filter **inside the shared traversal** | `if (file.path.endsWith('.mts')) continue;` in `feedOwnedTree` | seal and ledger agreed — this is content completeness, C1/C3's property, not identity |

It also found a real defect with nothing to do with guards: **a file named `__proto__` was dropped by the seal**, because a
plain object's `__proto__` assignment sets the prototype instead of adding an entry.

That is the end of the road for test-side guards: the invariable lesson is that *the guard's own input is a list too*. So the
invariant moved into the code that writes the record:

1. **The seal marks its own map.** `computePathDigests` defines a non-enumerable symbol on the map and freezes it, and
   `carriesSealMark` asks the object itself (through its property descriptor — indexing by a symbol would need a cast, and
   `as unknown as …` is banned here for the reason that guard exists). A copy built with a spread, `Object.fromEntries` or
   `Object.assign` loses a **non-enumerable** property, so "is this the seal's object" is answerable without naming kinds.
2. **`freezeSubject` refuses twice, at runtime, in the code that writes the record**: it refuses a map that does not carry the
   mark (round 10's conditional copy, and round 10's intra-`subjectOf` filter), and it refuses a subject that does not carry
   *that very object* (round 10's post-call wrapper). A refusal is the right failure mode — a drift that is caught is a
   refusal; a drift that is recorded is a lie.
3. **The map is null-prototyped**, so `__proto__` is a key rather than an assignment to the prototype; the guard's case puts
   that file at the repository root, because inside a directory the key is `src/pkg/__proto__`, which is an ordinary key — the
   first version of that case stayed green and was measured to be inert.
4. **`C2` now states the boundary instead of over-claiming.** The identity half is enforced in the freeze; a change *inside*
   the traversal omits content from the seal and the ledger records faithfully, which is C1/C3's content-completeness property,
   judged by their cases and by the traversal's diff. Round 10 was right that the earlier wording ("a structural guard forbids
   anything between them", "a one-sided filter cannot exist whatever kind it keys on") was false.

Measured falsifiability: removing the mark check reddens the guard; removing the subject identity check reddens it; reverting
the null prototype reddens the `__proto__` case; and round 10's conditional copy now reddens six declared cases, because the
fixture carries a `.mts` file (`worker.mts` in `CONTENT`).

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
