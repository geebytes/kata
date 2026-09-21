## Why

An unresolved repair obligation blocks the run that would produce the evidence answering it.

`collectSealPreflight` (check 5) denies a seal while any obligation lacks a `resolvedAt`, and it runs at
`orchestrator.ts:443`. `resolveObligationsForRevision` — the only path that ever sets `resolvedAt`, since
`reopenObligation` has no production caller and there is no CLI — runs at `orchestrator.ts:646`, after the checks. So the
seal refuses to let the run produce the evidence it is asking for, and neither `build --seal` nor `verify` can get past it
(`verify` fails the criterion with `unresolved_repair_obligation`).

The deadlock was unreachable because check 5 returned early for a task with no `acceptanceMatrix`. Removing that early
return — necessary in `major-finding-closure`, because closure resolves from acceptance ids and evidence rather than
needing a matrix — made it reachable on the default task shape that `/kata-open` produces.

It has also never been exercised end to end: both existing obligation tests call the resolver directly, so no test seals a
task carrying an unresolved obligation and asserts the seal resolved it.

## What Changes

- The acceptance-to-evidence question moves into **one** function that both the preflight and the resolver call, so the two
  cannot drift about whether a given obligation is answerable.
- The preflight asks it in a dry mode: it denies only the obligations that would **still** be unresolved once this run's
  evidence exists.
- The refusal distinguishes the two cases in its message — an obligation this run will answer, versus one it will not and
  which therefore still needs evidence or a matrix.
- An end-to-end test seals a matrix-less task carrying an unresolved obligation, which is the shape nothing covered.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `model-policy-and-evidence`: an obligation answerable by the current run does not block that run; the seal and the
  resolver decide answerability by one shared rule; the refusal states which case it is.

## Impact

- `src/workflow/seal-preflight.ts`, `src/quality/repair-obligations.ts`, `src/workflow/orchestrator.ts`, and their tests.
- Unblocks the closure of `check-log-artifact-missing`, whose repair batch is held open by exactly this deadlock.
- Design: `docs/design/2026-09-20-repair-obligation-deadlock.md`, including the three rejected options and why the
  invariants reject them.
