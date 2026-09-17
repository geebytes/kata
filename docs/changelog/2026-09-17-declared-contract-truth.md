# Make the declared contracts true

Four gaps found by the architecture review, all of the same class: the repository declared something that the code
did not actually do. None of them changes the lifecycle; each one makes a promise real.

## The Comet compatibility window could not be written from the published bundle

`src/comet/compat.ts` reads `comet-compat.yaml` as an inlined asset, so reads work in the single-file bundle — but
`updateCometCompatibility` in `src/comet/install.ts` wrote it through
`new URL('../../comet-compat.yaml', import.meta.url)`, which resolves above the package root once the code is bundled
into `dist/cli.js` (and `package.json` ships only `dist`, so the yaml is never beside the bundle either). Anything
that learned a new version window therefore threw `ENOENT` *after* npm had already replaced the binary, inside the
`catch` that was supposed to treat the mismatch as recoverable. A window recorded by one install also had nowhere to
live.

The window is now recorded in the workspace, at `.kata/comet-compat.yaml`, where it survives package upgrades and is
never part of the package: `persistCometCompatibilityOverride(version, root?)` writes it and returns whether it
succeeded, both loaders layer it ahead of the bundled baseline (`runtime probe → workspace override → comet package →
bundled`) and report provenance as `source: 'workspace-override'`, and a failed write is reported instead of thrown —
an install that already succeeded must not fail because kata could not record a window. Both loaders take an optional
`root`, so the same behaviour is testable without touching a real workspace.

## Verify's `nextAction` had two shapes

The verify PASS branch in `src/workflow/orchestrator.ts` hand-built a partial action object (`nextSkill`,
`requiresUserConfirmation`, `modelOrPlatformSwitchAllowed`, `trustBoundary`) while every other path went through
`nextActionForTask`. Agents reading the field had to handle both, and the partial one had no `slashCommand`,
`cliCommand`, `role` or `reason` — on exactly the gate the workflow most wants the user to act on. The branch now
calls `nextActionForTask` with the same gate reasons the other surfaces use (`review_fresh_implementation` /
`judge_reviewed_change`), so the field always carries the full contract.

## Configuration rejected two canonical evidence kinds

`src/core/config.ts` validated `quality.buildChecks[].kind` against its own list of seven kinds, while
`EvidenceKind` has nine: a configured check could not declare `integration` or `entrypoint` — the two kinds the
acceptance matrix requires for integration and entrypoint rows, which are also the ones a project would want to
declare explicitly instead of leaving to name-based inference. The canonical list now lives in
`src/quality/evidence.ts` as `evidenceKinds` (with `EvidenceKind` derived from it) and configuration validates against
it, so the union and its validation cannot drift again.

## The repository declared another project's quality checks

`.kata-config.json` declared `make lint`, `make typecheck` and `uv run pytest tests/test_workflow_asset_*.py` — the
k2skills workspace's checks. This repository has no `Makefile` and no such test files, so a seal here failed at the
first check ("No rule to make target 'lint'"; the pytest run collected 0 items). It now declares this repository's
own checks: `npm run typecheck` and `npm test`. Declaring them is also the review's recommended remedy for the
discovery path, which otherwise turns any `make …` line under an "Acceptance Gate" heading — including one inside an
install-managed skill file — into a mandatory seal gate.

## Verification

- `node_modules/.bin/tsc --noEmit` clean; `node scripts/build.mjs` rebuilds `dist/cli.js`, and the bundle no longer
  contains the path-addressed write: it now contains `join(root, ".kata", "comet-compat.yaml")`.
- New focused tests: `tests/unit/comet-compat-workspace-override.test.ts` (bundled fallback, record-and-reload,
  override precedence on the async path, non-fatal failed write) and `tests/unit/config-evidence-kinds.test.ts`
  (`integration`/`entrypoint` accepted, unknown kind rejected, every canonical kind accepted).
  `tests/e2e/workflow-resume.test.ts` now asserts the complete `nextAction` shape on the verify PASS branch.
- Full suite: 422/423 pass. The single failure is pre-existing and environmental —
  `tests/unit/installer.test.ts` spawns the hardcoded path `/home/work/.nvm/versions/node/v22.23.1/bin/node`, which
  this machine does not have. That test file was not touched here, and until that path is replaced with
  `process.execPath` the declared `npm test` check will fail on any machine without it, which means a seal in this
  repository cannot pass on such a machine.
