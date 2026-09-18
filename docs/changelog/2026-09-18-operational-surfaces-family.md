# The operational surfaces leave the entry point

Evaluation, worktrees, the adversarial review tooling, the collector, CodeGraph and Comet — the commands an operator runs
**about** a task rather than **as** a phase of one. Each is a thin command adapter over one module, with no shared rules
between them, which is why they are one module rather than six: they are the same *kind* of surface, and splitting them
would create six files whose only content is a dispatch arm.

`src/cli/ops.ts` owns 395 lines; `cli.ts` is **650 lines**, from **2728** before the L0-01 slices.

## Verification

- `tsc --noEmit` clean; the full kata suite passes (610 tests in 74 files), including the adversarial, worktree, eval,
  codegraph and comet suites that drive these handlers through `main`; `dist/cli.js` rebuilt.
