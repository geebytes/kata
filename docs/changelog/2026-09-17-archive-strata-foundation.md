# Archive strata-foundation, and what the two archive entry points do differently

`strata-foundation` is archived: `openspec/changes/archive/2026-09-17-strata-foundation/`, delta specs merged into the
five main specs under `openspec/specs/` (+19 requirements), design doc and plan annotated, `archived: true`. The
archive commit carries the record reconciliation and the re-verified report that preceded it.

Two operational notes came out of this, both about the tooling rather than the change.

**The two archive entry points behave differently.** `comet classic archive <change>` (the subcommand under the
Classic group) fails with `Unsupported OpenSpec status: expected JSON` once the change is ready to archive: it
re-observes OpenSpec status through the artifact-requirements path and parses the result as JSON, and that
observation does not come back as JSON in this repository. The documented entry point, `comet archive <change>`
(what `docs/` and the archive skill tell you to run), completes all 8 steps. Nothing was hand-edited to work around
this: the archive was performed by the documented command, and no state was forged — `archive_confirmation` was
written by its own transition, and `archived`/`verify_result` by theirs.

**Comet change runtime state is now ignored.** The guards and check runs write per-change runtime files under
`openspec/changes/**/.comet/` (`checks/`, `state-events.jsonl`, `trajectory.jsonl`, `run-state.json`,
`checkpoint.json`, `artifacts.json`, `context.md`, `skill-snapshots/`, `archive-requirements.json`). They were never
versioned — the repository tracks only the durable artifacts (`.comet.yaml`, `.openspec.yaml`, `.comet/handoff/`,
`.comet/subagent-progress.md`) — so `.gitignore` now says so explicitly, which also keeps the Ambient Resume probe
from reading them as unattributed worktree changes.
