# One repair authorization and one repair transition

The architecture review's L1-01 and L3-06 findings: leaving a gate to re-enter implementation was three hand-written
functions. `reenterImplementForReviewRepair`, `reenterImplementForVerifyRepair` and `reenterImplementForRepair` each
read their own artefact, decided their own authorization, appended the state event, rewrote `current-state.json` and
wrote `repair.json`. The repairable-scope sets were duplicated verbatim and had already drifted — the verify copy
authorised `revision_superseded`, the judge copy did not until drift deadlocked it. The evidence-drift rule was
implemented twice, and the state machine kept a second, hand-written entrance for those backward links
(`repairReturnPhases`, with the append re-validating the same rule).

## What is one authority now

**`workflow/repair-entry.ts` decides.** One authorizer per entry phase, and `authorizeRepair(entryPhase, …)` routes to
them. Each returns a typed verdict — `authorized`, the entry phase, the repair payload to record (`null` when the entry
carries nothing), and the user-facing `denial` when it refuses — instead of throwing from three places:

- `authorizeVerifyRepair` — a verify FAIL whose failed acceptance scopes are all in `repairableVerifyScopes`, or a
  re-seal when verify failed without blaming an acceptance; an absent verdict enters without a repair record.
- `authorizeReviewRepair` — blocking findings, strict-mode major findings, or a superseded sealed revision; the
  findings are copied in the producer's shape (`id`, `severity`, `message`, `path`, `acceptanceId`).
- `authorizeJudgeRepair` — a judge FAIL whose scopes are all in `repairableJudgeScopes`, or a superseded revision,
  recording the baseline it supersedes.

**`state.transitionForRepair` performs.** It checks the entry phase and the repair-return legality, takes the task
lock, appends the state event, writes the current state, and writes `repair.json` — one place, driven by the verdict.
The three orchestrator functions collapse into one wrapper that authorizes and then transitions.

**The record and its vocabulary moved to `quality/repair.ts`** (`RepairReason`, `RepairRecordShape`, `RepairPayload`),
so the seal path, the authorization and the transition all name the same type instead of a local copy.

## Divergence the merge exposed

- The repair record's `findings` copied `title` and `fix` from review findings — fields the review producer never
  writes (`ReviewFinding` is `id`/`taskId`/`severity`/`message`/`path`/`acceptanceId`). The e2e fixtures had invented
  them, so the tests asserted a shape the product could not produce. The record now carries the producer's fields, and
  the fixtures write schema-valid findings.
- `verify.json` had no declared shape, so the verify authorizer could only guess at it. `schemas/verify-result.schema.json`
  now describes what verify writes, and the authorizer reads it — an absent verdict still means "nothing to repair
  against", but a drifted one is an error rather than an absence.

## Verification

- `tests/unit/repair-entry.test.ts` — a table per gate over entry phase × artefact outcome × drift state: repairable
  and non-repairable scopes, the re-seal case, the no-verdict case, blocking/strict-major/minor-only findings, an
  unbound review, judge PASS with and without drift (asserting the recorded baseline), and the phase routing.
- Full suite: 487 tests in 52 files, all passing; `tsc --noEmit` clean; `dist/cli.js` rebuilt.
