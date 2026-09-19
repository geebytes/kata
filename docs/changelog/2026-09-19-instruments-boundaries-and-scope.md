# Instruments, declared boundaries, and scope that has to be a decision (§21.1–§21.3)

§21's measurement is the one that says this is a platform failure rather than a discipline one. Of 24 rounds on a real
task, product-layer findings **stopped after r18**; every round after was about the tooling introduced mid-task to satisfy a
process rule — `scripts/assert_acceptance_claims.py`, its carrier, its mirror, its tests. Five consecutive rounds were an
arms race against **one guard's coverage boundary**, and such a search has no terminating condition: it finds the unguarded
dimension every time, until the guard is deleted or its boundary is declared.

## §21.1 — a third class of owned path: the instrument

`instruments: []` on the task record, with `isInstrumentPath` / `instrumentPaths` and a **`findingLayer`** that says which
layer a finding sits in (`deliverable` / `governance` / `instrument`).

**Declared, never inferred.** Inferring "this script looks like tooling" would re-open the very question the declaration
exists to settle, and a task that has not decided whether a path is an instrument has not yet had the conversation that
stops the arms race. §21.1 offered "ownedPaths tiers, or an `instruments: []` list"; this is the list, because a tier would
have to be guessed per path while a list is a decision someone made.

## §21.2 — a declared boundary makes boundary-attacks closeable

`boundaries[]` per instrument: what it covers, what it does **not**, and **one** canonical statement of that, which is
checked to exist. Findings are classified `within-declared-coverage` or `beyond-declared-coverage`, and:

- **`within` must still be repaired** — nothing is loosened for a real gap;
- **`beyond` is closeable with the declaration as the reason**, and that is the **one** exception to I1 (`blocking`/`major`
  cannot be deferred). It is not a loophole: the classification requires the finding to **quote a dimension someone
  declared in advance** (`classifyFindingCoverage` refuses otherwise, and names what the instrument did declare), the
  reason is still required, and the closure is reported with its dimension and canonical statement.
- **No declaration means no exclusions**: a guard with no stated boundary is answerable for everything it could cover, and
  the classification says so rather than assuming a boundary.

## §21.3 — growth is a recorded decision (C1's missing half)

`scope-changes.json` via `recordScopeChange`, which requires a reason, refuses a change that changes nothing, refuses
overlapping ownership unless taken on deliberately, and **records the complete resulting scope** — because a diff cannot say
what the scope was before the first change, and guessing would report the original scope as growth. The **base revision is
read here, not supplied**: a caller passing the revision they are about to seal would make the following delta empty, the
same mistake C1's batch base was renamed to prevent.

`unreportedScopeGrowth` reports the case the measured task showed four times: a declared path the record has never seen.

## §21.4 — convergence as a query

`findings list` now reports **layer × severity** and tags every finding with its layer, so "are we converging, and on what"
is one command while the loop is happening. Assembling the by-layer table by hand took reading ~10 round records; the
answer — *the product stopped producing findings and everything after was the tooling* — was visible only in hindsight.

## The command surface

`kata-cli scope show | change | declare | boundary`, and `scope show` also runs the boundary validator, so a declaration
that does not hold is reported rather than discovered when a finding is closed against it.

## Verification

`tests/unit/instrument-boundary.test.ts` (10): declaration-not-inference for the instrument class and the layer of each
path; the four boundary refusals (undeclared instrument, missing statement, empty boundary, and a well-formed declaration
passing); classification beyond-versus-within, including that a real gap in a covered dimension is still `within` and that
no declaration means no exclusions; the I1 exception with and without a reason; scope change requiring a reason and
refusing a no-op; the base revision being read rather than supplied; unreported growth; and the CLI handlers for `declare`,
`boundary`, `change` and `show`. Full kata suite: 801 tests in 99 files; `tsc` clean; `dist/cli.js` rebuilt.

## What this does not excuse (§21.6)

Two ingredients of the loop are outside the platform's reach: repairs that reintroduced the class of defect they were fixing
(four of six) and single-finding rounds (three cycles of six). §21.1–§21.4 remove the structural amplifier; C1 and §17.3's
definition of done address the rest.
