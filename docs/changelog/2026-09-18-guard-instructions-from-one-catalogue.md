# The guard instructions and the enforced policy are one catalogue

L2-06: the same write policy lived in three audiences with no link between them — the typed policy the hook guard
enforces (`policy/hook-policy.ts`, embedded verbatim into the emitted guard), the prose a handoff packet carries ("Write
only to src/, tests/, and task-owned .kata paths.") and the workflow profile's extra instructions. The prose was a
hand-written restatement of the enforcement, and it **had already drifted**: the implementer's sentence did not mention
`packages/`, which the policy allows (and which this repository is built out of). The prose is the text an agent obeys.

## What changed

- `src/policy/guard-instructions.ts` holds the prose beside the policy it describes: `ROLE_WRITE_SCOPE` (one sentence per
  role), `UNIVERSAL_GUARD_INSTRUCTIONS`, the per-role rules, and `profileGuardInstructions` moved down from
  `workflow-profile.ts` (which now re-exports it).
- `HOST_MODEL_POLICY_SENTENCE` is stated once and used by the delegation prompt — the text a receiving agent actually
  reads — instead of being re-worded per surface.
- `roleForPhase` moved next to the table it reads (`workflow/navigation.ts`), completing L2-01's convergence: the reader
  and its data were in different modules, kept in step only by convention.
- `tests/unit/guard-instructions-agree-with-policy.test.ts` asserts the agreement by **probing the policy**: every path a
  role's instruction names is offered to `evaluateHookWrite`, and the paths the policy allows are the ones the sentence
  mentions. A change to one without the other fails.

## Verification

- `tsc --noEmit` clean; the full kata suite passes (615 tests in 75 files); `dist/cli.js` rebuilt.

## Status against the P5 list

**Delivered here:** L2-06 (guard prose from one catalogue, host-model sentence once), L2-07 (handoff one-liners expanded),
L2-01's last edge (`roleForPhase` beside its table).

**Still open, with what each needs:** L4-06 (promotion checks that its validation task actually passed Judge — it needs
the Judge result read at promotion time), L4-07 (an explicit provenance dimension between the two knowledge stores), L2-08
(a reason→message catalogue with the configured language — it touches every user-facing prompt and is the largest of the
seven), L6-02 (the 495-line render ternary → catalogue data, which changes the golden skill text), L3-09 (one mutation
discipline for task-scoped artefacts — `task.json`, `review.json`, `repair-obligations.json` under the task lock). Each is
a behaviour or surface change rather than a move, so each gets its own verified slice instead of being bundled.
