# §17.3's Definition of Done, executed rather than described

§17.3 states three conditions plus a stopping rule. A definition of done that lives only in prose is a definition nobody
applies, so each condition is now a test that drives the real command path.

## The four, and what each test asserts

1. **Claims** — every `claims[]` command exits as declared; a true claim seals, a contradicted one fails the seal with its
   sentence, and an **unfalsifiable** claim (no expected exit code) is refused at the declaration.
2. **Code** — the checks derived from the code sub-manifest pass; frozen-tier checks are always included. (Covered by the
   seal's own suite; not re-asserted here.)
3. **Findings** — zero `blocking`/`major`; `minor`/`nit` are recorded and **do not gate**. Asserted against a real sealed
   revision with a real issued brief: a `nit` leaves the gate satisfied while still reporting the finding, a `blocking` one
   stops it.
4. **Stability** — the loop terminates on the manifest hash, not on "one more round found nothing". A verdict speaks for
   the artifact it judged and stops the moment the artifact changes; and a **re-seal of unchanged content is still the same
   artifact**, which is the distinction the id-versus-content binding exists to draw.

## What the test deliberately does not assert

§17.3's parenthetical — *a seeded false claim must red* — is a property of **the check**, and seeding a false statement is
a project-side act (§16's P column; k2skills has one, with a stated retirement condition). What the platform owes is that
the check **can** fail, which it enforces structurally: a claim with no expected exit code is refused, so a decorative
check cannot be declared in the first place.

## Verification

`tests/unit/definition-of-done.test.ts` (5). Full kata suite: 786 tests in 97 files; `tsc` clean; `dist/cli.js` rebuilt.
