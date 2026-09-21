## Why

A `major` finding stops a node and then cannot be accounted for. `blockingAdversarialFindings` refuses review approval on
`blocking` **or** `major`, the review node opens a repair batch for both, and `isTerminalSeverity` defines exactly those
two as the terminal class — but `persistBlockingFindings`, the only producer of the obligations that closure reads,
skips any severity that is not the literal `'blocking'`. Measured: recording a `blocking`, a `major` and a `minor` finding
produced one obligation.

Observed end to end on `check-log-artifact-missing`: three findings were repaired and re-sealed to a new revision, and the
batch still reported `closed: false, answered: 0`, while `kata-cli adversarial brief` went on saying *"an open major
finding is unrepaired, so this round checks the repair"*. The workflow reports a completed repair as unmade, permanently.

A narrower cause sits on the same path: `resolveObligationsForRevision` runs only when the task has an `acceptanceMatrix`,
and a task opened without one — the `/kata-open` default — has none, so no obligation can resolve there at all.

Separately, on the same command surface: `kata-cli adversarial finding add --change <task-id>` — documented in the
generated review and verify Skills, in the adversarial brief, and three times in `docs/operations.md` — cannot work.
`runAdversarialCommand` reads the task id from a `rest` that still begins with the `add` action word, and `parseChangeArg`
returns the first non-flag token, so the task id resolves to `add` and the command fails with
`ENOENT: .kata/tasks/add/adversarial-review.json`. A reviewer therefore cannot report a finding while the round runs, which
is the one thing the batching rule in that same brief exists to preserve.

## What Changes

- `persistBlockingFindings` decides by `isTerminalSeverity` instead of the literal `'blocking'`, so the severities that
  gate a node and the severities that create an obligation come from one definition.
- `resolveObligationsForRevision` resolves an obligation for a matrix-less task too, mapping it by the task's acceptance
  ids and the passing evidence for the revision, with the matrix as an enrichment of that answer rather than a
  precondition for it.
- The `adversarial finding` branch reads `--change` from its flags, so the documented command works and a missing
  `--change` produces a usage error rather than an ENOENT about a task called `add`.
- The Skills are regenerated from `phase-guidance.ts`; the documented invocation is verified working rather than the
  documentation being changed to match a broken command.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `model-policy-and-evidence`: the terminal-severity rule determines obligations, a matrix-less task can resolve them, and
  the documented `adversarial finding add` invocation works.

## Impact

- `src/quality/repair-obligations.ts`, `src/workflow/orchestrator.ts`, `src/cli/ops.ts`, and their tests.
- Unblocks the closure of any task whose adversarial pass confirmed a `major` finding.
- Design: `docs/design/2026-09-20-major-finding-closure.md`.
