# One bounded execution model for Git Flow

The architecture review's L5-03 finding: `core/git-flow.ts` held two incompatible execution models. The non-interactive
path used `execFileSync('git', args, { stdio: 'ignore', timeout: 120_000 })` — bounded but with its output thrown away —
while branch creation inside `initializeGitFlowProject` went through `runInteractiveGitFlow`, which spawned git with
`stdio: 'inherit'` and **no timeout, no captured output and no abort path**. So the operation with the largest blast
radius (creating or switching a branch) was the one that could hang an invocation, bypassed the CLI's output contract
entirely, and left nothing behind: `GitFlowState` recorded only `status` and the command vector, so a failed branch
creation said `failed` and nothing else.

## What changed

- **Both paths are bounded and go through one facility.** The non-interactive path uses `runProcessSync` with
  `KATA_GITFLOW_TIMEOUT_MS` (default 120 s, configurable 1–600 s), keeping its output so a failure can report it; the
  interactive path uses `runProcess` with a new `inheritOutput` option — the child keeps the terminal (a prompt needs
  it) and is **still bounded, still in its own process group, and still cancellable**. The installer's probe and
  install go through the same facility.
- **Interactive output is an explicit opt-in, and it is recorded.** `GitFlowPlan.interactive` marks it,
  `GitFlowInitializationResult.interactive` reports it, and `GitFlowState.interactive` keeps it in the persisted record —
  so an audit trail says whether a child wrote to the terminal.
- **The branch operation reports what happened.** `applyGitFlowPlan` fills `reason` and a truncated `output` from the
  runner when it fails, and says `no_branch_command_recorded` when it was asked to apply a plan that had nothing to
  run. `GitFlowState` carries those fields, and `schemas/task.schema.json` was extended to accept them (the persisted
  profile is schema-validated, so the record and the schema moved together).
- `runProcess` gained the `inheritOutput` option: inherited streams mean nothing is captured (the result reports empty
  streams, documented), while the timeout, the process-group kill and the abort path all still apply.

## Verification

- `tests/unit/process-run.test.ts` — an inherited-output child reports empty captured streams, and **a child that would
  hang is still cut off at its timeout** (exit 124), which is the guarantee the previous interactive spawn lacked.
- `tests/unit/git-flow.test.ts` — a failing branch command now reports the runner's message as `reason` and `output`; an
  interactive initialization is marked `interactive: true` in the result while running the same command vector.
- The existing Git Flow e2e suite (branch preparation, deferred initialization, dirty-worktree handling) passes
  unchanged.
- Full suite: 550 tests in 64 files, all passing; `tsc --noEmit` clean; `dist/cli.js` rebuilt.
