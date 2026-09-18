# The handoff and delegation family leaves the entry point

The two ways work crosses a boundary between agents: a **handoff** is the structured packet one role leaves for the next
(create, show, verify, acknowledge), and a **delegation** is the prompt that tells another platform's agent to pick a task
up. They travel together because a delegation ends in a handoff, and they share the packet hashing, the candidate
discovery and the platform recommendation.

`src/cli/handoff.ts` owns 176 lines; `cli.ts` is 947 lines, from 2728 before the L0-01 slices.

## Verification

- `tsc --noEmit` clean; the full kata suite passes (610 tests in 74 files), including the context-fabric and welcome
  suites that drive handoff create/verify/acknowledge through `main`; `dist/cli.js` rebuilt.
