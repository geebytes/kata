# Wiring coverage: the three mechanical checks, as a standing tool

**2026-09-22 · governed change `wiring-coverage-check` · profile `current_worktree` / `tdd` / `std`**

## Why this exists

Two independent adversarial passes over `adversarial-admissibility` produced 13 findings collapsing to 10 distinct
defects, and **all ten were the same shape: a mechanism that exists, is documented, and is not wired** — an exported
function with no production caller, a predicate behind an optional field, a gate short-circuited to `0 >= 0`, a second
derivation nobody needed, a corpus class nothing could measure.

That class is **deterministically detectable without a model**, and the measurements of 2026-09-22 put numbers on it. They
also bounded it honestly: the two reference-based checks reach only **2 of the 10**, and what reaches the rest is a
mutation check. Ranks and numbers come from `docs/design/2026-09-21-adversarial-execution-control-optimization.md` §12 and
§17–§19, which is the authority for everything this change implements.

## What is delivered

One command, `npm run check:wiring`, over a declared surface, with findings that name a location.

### Check A — reference

An exported symbol the production code never references. Measured basis: **24 dead exported symbols and 15 test-only
ones** in `src/` (119 files, 578 exported symbols), each spot-checked by whole-repo search and each occurring exactly
once, in its own declaration.

### Check B — declared-member

A member of an `export const X = [...] as const` list that nothing consumes. Measured basis:
`unmeasuredMetrics -> {tokensUsed, costCredits, escalationCount}` and `nextActionReasons -> adversarial_verify_pending`.

**It needs a real parser first.** The measurement harness used a regex whose `[^\]]*` spans newlines, so an apostrophe in
prose inside a multi-line list was taken for a string boundary and produced rows like
`s findings, which the review node resets at the start of a round`. Of 11 reported rows roughly 4 survived. Shipping the
regex would ship a check that is wrong in the direction of noise, so AC-2 requires the parser.

### Check C — mutation, prospective

On a declared surface, enumerate every `if (...)` whose body contains a refusal (`satisfied: false` / `ok: false` /
`reason:` / `throw`), disable each in turn, run the suite, and report the ones nothing notices. Measured basis: **31
guards on `adversarial-admissibility`'s declared surface, 30 valid mutations, 1 discounted as a type collapse that
reddened 16 files at once, and 15 that left the suite completely green.**

"Decorative" means exactly one thing: *no test exercises that refusal*, so its behaviour can regress silently. It does
**not** mean the refusal is unreachable, and the report says so — the distinction is what keeps the number honest.

## Design constraints that come from the measurements, not from taste

These are not style; each was paid for once already.

1. **The mutation runs in a scratch copy.** Never in place. Reverting a repair in a live worktree supersedes the revision
   that worktree sealed — measured, and the reason the 2026-09-22 run happened in `tmp/seed-bench/`.
2. **A broken mutation must not read as a detection.** A mutation that reddens many files at once is a compile/type
   collapse; the check reports the failing-file count per mutation and discounts a collapse above a threshold.
3. **An unapplied mutation is reported as unapplied**, counted on neither side. A guessed identifier made a module throw
   and every importer go red, which read as "detected" — the first R3 attempt.
4. **A partial mutation must not read as blind.** The first R6 attempt reverted one of two halves; the suite stayed green
   and it looked like an unpinned repair.
5. **Exit codes carry three states**: `0` clean, `1` findings present, `2` the instrument could not run. An instrument
   failure that exits `0` is the same defect class this change exists to detect.
6. **The scratch copy needs a working test environment**, which is not free: `src/ tests/ schemas/ docs/ scripts/
   evals/ .agents/` and the root config, with `node_modules` resolved from the ancestor checkout. Four environment
   failures had to be separated from real ones. The check documents what it copies.

## Self-validation, because a mechanism with no referee is the defect

AC-4: the change ships a test that runs the checks against **the material they were built from** — the 15 decorative
guards and the 24 dead exports measured on 2026-09-22 — and asserts they are reported. An instrument that cannot
reproduce the findings that motivated it is not evidence that it works.

AC-5 closes the two repairs measured as **unpinned**:

- every field the rendered adversarial brief's result template prescribes is accepted by the record writer (R1 — the
  blocking finding whose failure destroyed a real pass, and which no test held);
- every corpus case's `expectedVerdict` is consistent with its own `reproduction` (R10).

Both were written as assertions during the measurement and both fail when the defect is present.

## What this change does not do

- **It does not wire a `kata-cli` subcommand.** `src/cli.ts` and `src/cli/ops.ts` are owned by `adversarial-admissibility`,
  which is still active; editing them would supersede its sealed revision. The consumer in this change is
  `npm run check:wiring`, and the CLI subcommand is a follow-up once those paths are free. This is recorded here so that
  "a mechanism whose only consumer is a test" — check A's own finding — cannot be levelled at it later: the script is a
  production consumer, not a test.
- **It does not run repository-wide.** The mutation surface is what the caller declares; a repo-wide sweep is a different
  cost and is not claimed.
- **It does not claim coverage it has not measured.** Check C's reach on a novel codebase is unknown; what is known is
  that on the surface it was built for it found 15 guards, and AC-4 holds it to that.

## Acceptance mapping

| AC | check | evidence |
|---|---|---|
| AC-1 | one command, located findings, three exit states | `tests/unit/wiring-check-command.test.ts` |
| AC-2 | A reports the 24; B parses multi-line declarations | `tests/unit/wiring-check-reference.test.ts` |
| AC-3 | C mutates a scratch copy, discounts collapse, reports failing-file counts | `tests/unit/wiring-check-mutation.test.ts` |
| AC-4 | the checks reproduce the 15 measured guards | `tests/unit/wiring-check-self-validation.test.ts` |
| AC-5 | R1's round-trip and R10's corpus consistency are pinned | `tests/unit/unpinned-repairs.test.ts` |

Each AC declares its **own** selector. The change that preceded this one declared the same selector for two ACs, so the
seal minted one evidence item and the second AC had none — a declaration defect, not a work defect, and not repeated here.
