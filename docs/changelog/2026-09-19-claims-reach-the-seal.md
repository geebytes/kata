# The claims reach the seal (C3, wired)

The mechanism landed first (`7eee82e`); this wires it, which is the part that makes the measurement mean something: a false
sentence in an acceptance statement must fail **the seal**, on the revision it describes, rather than being caught by the
next independent round.

## What changed

- **`resolveSealChecks` merges `resolveClaimChecks`** into the set the seal runs, so a claim's check is resolved, executed,
  recorded and bound to the revision exactly like every other check. `build --list-checks` shows them, with their claim ids.
- **`validateClaims` runs as a preflight blocker**: a claim whose check cannot fail (no expected exit code, no command, a
  duplicated id) stops the seal *before anything runs*, with its own diagnostics and a remedy. A decorative check is
  precisely what a false sentence hides behind, so it is refused rather than left to a reviewer to notice.
- **`evaluateClaims` reports by claim id** — in the success path *and* in the failing-evidence path, which previously
  returned only counts. The seal's error text now names a contradicted claim with its sentence and the command that
  disagrees with it, and `failingChecks` names every failed check by id, so "sealing failed" is answerable without opening
  the evidence files.

## Two rules worth stating

- **A claim passes on evidence, and evidence that does not exist cannot be a pass.** If other checks produced evidence and
  the claim's check did not run, the claim is a failure.
- **…unless the seal never asked.** A seal given an explicit check set (`options.checks`) runs a narrow, deliberately
  non-project set, so claims are not resolved at all and are not evaluated — reported as absent, never as contradicted. The
  alternative would make a debug seal announce that the project's sentences are false.

## Verification

- `tests/e2e/claims-fail-the-seal.test.ts` (3) drives the real `runCommand('build', …, { seal: true })` path: a claim whose
  check cannot fail is refused up front; a true claim seals and is reported by id; a contradicted claim fails the seal with
  its sentence and the command's actual exit code in the message.
- `tests/unit/claims.test.ts` (7) covers the refinement above — absent evidence with other evidence present is a failure,
  and an empty evidence list is reported as "not asked" rather than "false".
- Full kata suite: 761 tests in 93 files; `tsc` clean; `dist/cli.js` rebuilt.
