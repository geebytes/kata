# Acceptance statements become machine-checkable (C3, the largest of the five)

Measured, twice: **a false sentence in the acceptance text passed the seal *and* verify**, and was caught only by the next
adversarial round. Prose has no test; a command does.

## What landed

`src/quality/claims.ts` plus a `claims[]` field on an acceptance item (`core/task.ts`, pinned by
`tests/unit/id-rules-agree-with-schemas.test.ts`-style schema agreement where it applies):

```jsonc
{ "id": "AC-1", "statement": "…",
  "claims": [
    { "id": "no-caller", "statement": "X has no production caller",
      "check": { "command": "scripts/assert_no_caller.py", "args": ["X"], "expect": { "exitCode": 0 } } }
  ] }
```

- **`resolveClaimChecks`** turns each claim into an ordinary `CheckCommand` (`kind: 'claim'`, its own id
  `claim:<acceptanceId>:<claimId>`) and hands it to the same resolver and collector every other check uses — so a claim's
  evidence is recorded, bound to the revision, and eligible for the acceptance row exactly like any other.
- **`evaluateClaims`** answers what the seal needs: which claims ran, which passed, and **which failed**, as
  blocking-class failures with the statement and the command that contradicts it.
- **A claim must be able to fail.** `validateClaims` refuses a claim whose check has no expected outcome, because a check
  that cannot fail is not evidence — the proposal's "mutation-tested" requirement, enforced at the boundary rather than
  trusted to review.

## What it deliberately is not

Claims are **additional** evidence. They never replace the acceptance row's own checks, and they never replace the
independent adversarial pass: a claim proves a sentence about the code, and the pass is what finds the sentence nobody
thought to write. The invariant is the one C3 names — the sentence and the command cannot drift, because editing the
statement is editing the thing the check is attached to.

## Verification

`tests/unit/claims.test.ts`: a true claim's check is resolved with the right id, kind and expectation; a claim with no
expected outcome is **refused** with a message saying why; a failing claim is reported as a blocking-class failure naming
the statement and the command; and claims add to a row's checks without removing any.

`tests/unit/claims.test.ts` (6): a claim resolves into an ordinary check carrying its identity; a claim with no
  expected outcome, no command, or a duplicated id is **refused** with the reason; a contradicted claim is reported as a
  blocking-class failure naming the sentence and the command; a claim with **no evidence at all** is a failure rather than a
  pass; and the claim identity follows the statement, so a rewrite is visible.

  Full kata suite: 757 tests in 92 files; `tsc` clean; `dist/cli.js` rebuilt. `claim` is an evidence kind, and the evidence
  schema's enum was extended with it — pinned, as before, by the kind-drift guard.
