# The workflow family leaves the entry point — L0-01's last handler family

The phase commands (`design` … `tweak`) and everything that decides whether one may run: the flags they take, the handoff
receipt gate, the repair-entry boundary, the workflow profile, and the translation of an orchestrator result into the
completion/next-action shape the skills consume. `roleForCommand`, `boundaryForCommand`, `workflowCompletion`,
`workflowNextReason`, `handoffRole`, `roleForCompletedCommand`, `readWaiversFile`, `readRequirementsFile`,
`gitFlowBranchKindForCommand`, `parseEnumArg` and the two command predicates went with it.

`src/cli/workflow.ts` owns 464 lines; `cli.ts` is **1156 lines**, from **2728** before the L0-01 slices — the entry point
is now dispatch (parse the invocation, call a family, print the result) plus the surfaces that have not been extracted
yet (eval, worktree, adversarial, handoff, delegation, collect, codegraph, comet, the init wizard).

The split that mattered here is the one the review asked to keep: the workflow module owns the **invocation** half, and
`workflow/orchestrator.ts` still owns the phases. A first cut tried to lift `isWorkflowCommand`/`resolveWorkflowProfile`
out while leaving `runWorkflowCommand` behind, which left two modules that could not compile without each other; keeping
the family whole resolved it, and the type errors were the signal.

## Verification

- `tsc --noEmit` clean; the full kata suite passes (610 tests in 74 files), including the lifecycle, resume,
  non-interactive and installer suites that drive these commands through `main`; `dist/cli.js` rebuilt.
