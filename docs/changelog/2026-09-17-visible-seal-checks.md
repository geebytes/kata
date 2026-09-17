# The seal check set is declared, inspectable, and says where it came from

The architecture review's L3-01 finding: a human-facing document inside an install-managed directory decided what the
acceptance gate executed. `resolveBuildChecks` preferred the project's `quality.buildChecks`, then discovered checks
from `AGENTS.md` and every `.agents/skills/*/SKILL.md` (`make <target>` lines under an acceptance-gate heading), then a
TypeScript/Vitest fallback. Because `.agents/skills/**` is written by `kata update`, the set a seal runs could change
with no change to the repository at all — and nothing answered "what will this seal run?" before it ran. The only
pre-run signal was a timeout budget generous enough to accommodate the most expensive possibility.

## What is visible now

**Every resolved check carries its origin.** `CheckCommand` has `source` (`configured`, `discovered`, `matrix`,
`fallback`, `explicit`) and an optional stable `id`; the evidence envelope records both, so a gate's provenance is
auditable after the fact and not only inferable from its command text.

**`kata-cli build <task> --list-checks` answers the question before anything runs.** It reports the resolved set — id,
name, kind, command, args, origin, timeout, and `lastDurationMs`/`lastExitCode` from the evidence this task recorded
last time — and runs nothing. The preflight and the seal call the same resolver, so what a caller inspects is what
actually runs.

**Discovery is a suggestion the project can refuse.** `quality.discoverChecks: false` in `.kata-config.json`, or
`--no-discover-checks` / `--discover-checks` for one run. With discovery off and nothing declared, the fallback set
applies and the report says `fallback` for each check — the report never hides which source answered.

One deliberate deviation from the review's wording ("keep discovery behind an explicit opt-in flag"): discovery stays
on by default. Turning it off by default would silently replace a project's declared gate (`make test`) with kata's own
fallback in every repository that relies on discovery — a fail-open change to what a seal proves, made for auditability
it can get instead from provenance plus an explicit switch. The project's own remedy (declare `quality.buildChecks`)
remains the recommendation, and it is now documented in `docs/configuration.md`.

## Verification

- `tests/e2e/seal-check-preflight.test.ts` — a configured check is reported with `source: 'configured'`, its timeout,
  and null last-run fields, and reporting it records no evidence; a discovered check is labelled `discovered` and
  disappears (leaving the labelled fallback set) when discovery is refused; a sealed task's checks report the duration
  and exit code of their last run; and a sealed run's evidence carries the resolved `checkId` and `checkSource`.
- Full suite: 508 tests in 57 files, all passing; `tsc --noEmit` clean; `dist/cli.js` rebuilt.
