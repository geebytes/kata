# The skill prose is catalogue data, and rendering stops branching on ids

L6-02: `renderSkill` held a **356-line ternary** keyed on `command.id`, so `adapters/manifest.ts` carried both the
machine-readable catalogue and the human-facing documentation for every command, joined by string comparisons — adding a
command meant adding data *and* a branch, and reworking guidance meant editing prose in the file the installer depends on.

## What changed

- **`src/adapters/phase-guidance.ts`** holds the prose: `phaseGuidanceFor(command)`, `adversarialGuidanceFor(command)`
  (the independent adversarial step, carried by exactly the two nodes that conclude a change) and
  `automationGuidanceFor(command, platform)` (the Skill automation contract, carried by the phases that drive a command
  to a verdict). The three-choice flow that open/hotfix/tweak shared as three copies of one block is now one function.
- `renderSkill` keeps layout and capability substitution only; **no `command.id` branch is left in the renderer**.
- The host-model paragraph inside the shared block comes from `HOST_MODEL_POLICY_SENTENCE` (L2-06) instead of being a
  fourth restatement of it.
- `renderRepairScopeGuide` moved beside the repair vocabulary it documents (`quality/repair-scope-guide.ts`) — it was in
  the renderer, which is where the sentence is used rather than where the list is defined.

`adapters/manifest.ts` is 408 lines (from 780); the catalogue is 471.

## Verification

- `tests/unit/phase-guidance-catalogue.test.ts` — every command gets its own guidance, the three shared commands get the
  same block rendered with their own names, the adversarial step appears only on verify/review, the automation contract
  only on the five phases, and every command still renders through `renderSkill`.
- The golden and installer suites (which drive the whole skill-rendering surface) pass unchanged; full kata suite: 627
  tests in 77 files; `tsc` clean; `dist/cli.js` rebuilt.

**Process note:** the mechanical part of this slice was genuinely fiddly — extracting template literals out of a nested
ternary meant separating *prose* backticks (which must be escaped) from *interpolations* (which must stay live), and two
intermediate passes produced files that did not compile. The suite caught each in one run, and the final catalogue was
rebuilt from the parsed arms rather than patched further.
