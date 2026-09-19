# Skill-first: the new surfaces reach the skill, not just the CLI

`AGENTS.md` states the constraint plainly: the `/kata-*` skill is the human-facing entrypoint and `kata-cli` is the
execution layer **used inside skills**. I had built C1's batch surface, `scope change|declare|boundary`, the instrument class
and the boundary closure, and wired them all into the **CLI** — which means a run following the skill would never touch
them. That is the same defect as C1's missing producer, one layer up: **a capability reachable only by a flag nobody is told
to pass is a capability most runs will not use.**

## What the skills now say

- **`/kata-build`** — *Repair batches, and growing the audited surface*: repair a pass's blocking/major findings
  **together** and seal **once** (that batch is what makes the next round a delta), check it with
  `adversarial status --change`, record surface growth with `scope change --reason`, and **declare an instrument** with
  `scope declare` + `scope boundary` when the task wrote its own verification tooling — because a declared instrument is
  judged against a **declared** boundary instead of being audited like a deliverable.
- **`/kata-verify`** — *Findings about a declared instrument*: within the declared coverage is a real gap and gets
  repaired; beyond it is closed with the declaration as the reason, which is the one case a blocking/major finding may be
  closed rather than repaired, and it requires the finding to quote a dimension declared in advance; **no declaration means
  no exclusions**.

## The correction, and how it was made

The first attempt to insert the `/kata-verify` text **replaced its existing body instead of prepending to it**, deleting the
frozen-tier, repair-loop and Wiki-closure guidance — caught by `tests/golden/adapters.test.ts`, which failed on a string
that had stopped existing. The file was restored from `git` and the insertion redone **into the existing returns**, anchored
on the two `case` blocks' own first lines, so the surrounding text could not be clobbered. The golden test is what made a
600-line deletion visible in seconds rather than at review.

## Verification

`tests/golden/adapters.test.ts` (9), `tests/unit/repair-vocabulary.test.ts` (6) and the generated-asset guard (48) all pass;
the skill assets were re-rendered; full kata suite: **804 tests in 99 files**; `tsc` clean; `dist/cli.js` rebuilt;
`kata-cli scope --help` on the rebuilt binary shows the four subcommands the skill text now teaches.
