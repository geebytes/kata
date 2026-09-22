# Wiring coverage: the three mechanical checks as a standing tool

**2026-09-22 · change `wiring-coverage-check`**

## What this adds

`npm run check:wiring` — three deterministic checks over a declared surface, at **zero model cost**, with findings that
name a location and an exit code that distinguishes three states.

| check | question | measured on `master` at the time of writing |
|---|---|---|
| `reference` | an exported symbol the production code never references | **40 findings** (and 38 more kept alive only by tests) |
| `declared-member` | a member of an `export const X = [...] as const` list nothing consumes | **11 findings** |
| `mutation` | a refusal guard that can be disabled with the suite still green | 31 guards enumerated; see the withdrawal below |

Exit codes: **0** clean · **1** findings · **2** the instrument could not run. The third state is the point — a check that
reports "clean" when it could not do its job is the defect class this change exists to detect.

## Why the two reference checks are not a regex

The harness that produced the first measurement used `[^\]]*` to match a declared list, which spans newlines: an apostrophe
in prose inside a multi-line list was read as a string boundary and produced rows like
`s findings, which the review node resets at the start of a round`. Roughly four of its eleven rows survived. The parser
here scans, tracking string state, comment state, bracket depth **and brace depth**.

Brace depth was added after the first run reported `platformDefinitions -> 'Gemini CLI'` and similar: without it, a property
value inside an *object* element of the array counted as a member of the list. Labels that are consumed by iteration are
not findings, and they were 15 of the first run's 11 findings inflated by another 4 — measured, then fixed.

## Two defects this found in itself

Both were caught by checking the instrument against independently reproducible facts rather than against its own output.

1. **A missing `g` flag made the reference check nearly useless.** `new RegExp('\\b' + name + '\\b')` without `g` returns
   only the first match per file, so a symbol **used inside the file that declares it** looked exactly like a symbol with no
   consumer. Measured effect: **148 findings instead of 40**, including `runWiringCheck`, `issueAdversarialBrief` and
   `evaluateAdmissibility`. Caught by re-verifying three names with a whole-repo search.
2. **The default surface included `tests/`.** Test files legitimately contain code as data — this repository's own
   `wiring-check-reference.test.ts` holds a fixture declaration in a string literal — so the check reported findings about
   a fixture. The default is now `src`; including tests is opt-in.

## Withdrawal: the `15/30` decorative-guard figure does not reproduce

The optimization document reported that **15 of 30** refusal guards on one surface could be disabled with the suite still
green (§17.8). Re-measuring the same four-file surface with the rebuilt check on the merged tree gives:

| | 2026-09-22 (first run) | re-measured |
|---|---|---|
| guards enumerated | 31 | 31 |
| noticed | 15 | **29** |
| collapse (discounted) | 1 | 1 |
| **decorative** | **15** | **0** |
| wall clock | ~10 min | 557 s |

**Every one of the 15 named sites comes back noticed when mutated individually.** The enumeration reproduces and is asserted
by a test; the classification does not reproduce and is withdrawn in §17.8 and §17.9 of the optimization document, with the
replacement numbers. The most likely cause is a defect in that run's harness — the third member of a family already recorded
there: a mutation that reddens many files at once reading as "detected", a partial mutation leaving the suite green reading
as "blind", and now **a green suite that means the harness never ran the tests it thought it ran**.

The guard **set** is therefore what this change asserts (`tests/unit/wiring-check-self-validation.test.ts`), because the set
is reproducible and the classification was not.

A second correction from the same re-measurement: §17.1's split of the dead exports into "24 referenced nowhere" plus "15
kept alive only by tests" was **mismeasured**. The union of 24 names stands — each was re-verified by whole-repo search — but
38 of the 40 findings have a test reference, not 15.

## Repairs pinned

Two repairs to the preceding change were measured as **unpinned** — reverting each left its full suite completely green
(§19). Both are now held by tests in `tests/unit/unpinned-repairs.test.ts`:

- **R1**: every field the rendered adversarial brief prescribes is accepted by the record writer. This was the `blocking`
  finding whose consequence was that a reviewer following the brief verbatim could record nothing, destroying a real pass.
  The test builds a record out of the template's own keys, so a field the writer has since retired fails it.
- **R10**: a corpus case whose reproduction requires a *refusal* must not answer `no_defect_found`.

The R10 assertion was deliberately **not** generalised into "any case whose reproduction mentions a refusal": two
guard-false-negative cases describe a refusal that is itself the defect on an otherwise clean revision, so their correct
answer is `no_defect_found`. The general rule was written first, failed on exactly those two, and was replaced after being
checked against the corpus.

## What this does not do

- **No `kata-cli` subcommand.** `src/cli.ts` and `src/cli/ops.ts` belong to another change; the consumer here is
  `npm run check:wiring`, which is a production consumer rather than a test.
- **No repository-wide mutation run by default.** The surface is what the caller declares; the mutated run costs a full
  suite per guard (557 s for 31) and is executed as evidence, not on every test run.
- **No claim of coverage it has not measured.** What is measured is in the table above.

## Verification

`npx tsc --noEmit` clean. Full suite **147 files / 1084 tests / 0 failed**. The mutated run over the four-file surface:
31 guards, 29 noticed, 1 collapse, 0 decorative, 557 s, run in a scratch copy with the caller's tree byte-identical
afterwards (asserted).
