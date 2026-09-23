# wiring-coverage-check — the findings, verbatim, before the node record is waived

Why this file exists: an adversarial node keeps **one** record per node, so the third round overwrote the second round,
and `.kata/` is gitignored — the findings live only inside the task directory. `adversarial waive` replaces that record
again, with a claim of having looked nothing. This is the third round dumped verbatim so waiving the node cannot erase the
evidence, and it is committed because the task directory is not.

Round: revision `revision-4d540d50f0d5895f`, scope `delta` from `revision-109e944617d5d273`, mode `cold`,
5 hypotheses, 10 attempts, 10 findings.

Rounds 1 and 2 are not in this file: round 2's findings were overwritten by this record, and what survives of their ids is
in the change records (`openFindings`) and in the commit messages of this branch, which name each one and its repair.

## wcc3-f1-delta-misses-a-changed-path

**major** — `.kata/tasks/wiring-coverage-check/adversarial-briefs/review-revision-4d540d50f0d5895f.json`

The brief's declared delta holds three paths while the same brief's prose and the change record for the same revision hold five, and the two it drops really changed between the base and current snapshots (676-entry digest tables, five differing paths). changeSurfaceAgainstWorkspace (src/quality/revision-delta.ts:110) builds the brief's list from base.ownedPaths + git status + the current revision's pathDigests, while revisionChangeSurface builds the record's, the gate's remit and the brief's rendered path list from the two sealed snapshots; wcc2-f1 called this pair reconciled by 0148ca0 and this round's payload is the measurement that it is not - the remit was unified, the brief was not.

## wcc3-f2-delta-surface-lags-the-edits

**major** — `src/quality/revision-delta.ts`

The change surface every artefact derives cannot see a repair that edits a file already hashed at both seals. src/workflow/orchestrator.ts (9575d23, 2026-09-23T08:18:30+08:00) and src/adapters/phase-guide.ts line of work (25d7147) plus its two generated Skills were edited and committed inside the base-to-current interval yet appear in neither the five-path surface nor the current record's changedPaths, because a content-digest diff folds a pre-seal commit into both tables; the brief calls its list the complete difference and the record reports 5 of the repair's own paths as changedOutsideOwnership at the base revision, so two readings of "complete" coexist in the artefacts.

## wcc3-f3-declared-member-record-states-answered-findings-open

**minor** — `.kata/tasks/wiring-coverage-check/change-record-revision-109e944617d5d273.json`

The record published for revision-109e944617d5d273 lists 18 open findings including all nine wcc-f* ids, while repair-batch.json batch-1 (base revision-9d3589ce2e7178db, closed 2026-09-23T01:11:45.575Z) names six of those as its members and the batch's own doc reports unresolvedObligations going 6 to 0 at that seal; the file carries no timestamp field, so a reader cannot tell which artefact is the state of record.

## wcc3-f4-double-quoted-list-exemption-untested

**minor** — `tests/unit/wiring-check-false-positives.test.ts`

The f5 widening is asserted in one direction only: the added case reports an unconsumed member from a double-quoted list, while nothing asserts that a double-quoted list consumed by iteration still exempts its members - the suppression half the widening depends on, since all 145 as-const members under src/ became reportable. Reported as a missing test rather than probed.

## wcc3-f5-brief-reading-set-exceeds-its-own-delta

**minor** — `.kata/tasks/wiring-coverage-check/adversarial-briefs/review-revision-4d540d50f0d5895f.json`

The brief's reading set lists seven paths (including scripts/wiring-check.mjs and four selectors this delta does not contain) while its scope object lists three and its delta section five, and the brief then tells the reviewer that reading beyond the set is expected - so the reviewer is pointed outside the remit by the same document that defines the remit.

## wcc3-f6-command-test-does-not-exist

**major** — `tests/unit/wiring-check-command.test.ts`

AC-1's declared selector runs the published wrapper only against a tmpdir fixture with no workflow-profile.json; no declared check runs the published command on a repository-shaped tree, and at this revision that run prints 47 findings (39 reference, 8 declared-member) and exits 1, eight of the findings being the tool's own guard branches in src/quality/wiring-check.ts (lines 37, 42, 47, 52, 57, 62, 116, 119 of its output). Whether that default output is a defect is not decided here; the uncovered surface is.

## wcc3-f7-sealed-evidence-pre-dates-this-delta

**minor** — `.kata/evidence/wiring-coverage-check-AC-2-test-tests-unit-wiring-check-reference.test.ts.json`

The envelopes the brief recommends instead of re-running were written between 2026-09-23T02:42:44.531Z and 02:42:51.238Z, while the delta's commits are dated 2026-09-23T10:10:58+08:00 and later; the AC-2 excerpt records 3 passed and the current count for that surface is 3, so the frozen entry binds that the selector ran, not the assertion the delta added - a re-run would bind it and the brief discourages one.

## wcc3-f8-current-record-drops-a-raised-finding

**major** — `.kata/tasks/wiring-coverage-check/change-record-revision-4d540d50f0d5895f.json`

The current record's openFindings is the same 17 ids as the base record's, so wcc2-f5 and wcc2-f6 - raised by the second round and stated by this batch's own doc to have been repaired here - appear in neither record nor in repair-batch.json batch-2; the record surface is therefore neither the round's finding set nor the batch's, which is the mirror of the asymmetry the batch's doc names for obligations.

## wcc3-f9-ac4-selector-name-stale

**minor** — `tests/unit/wiring-check-self-validation.test.ts`

task.json's AC-4 row still declares the enumeration-only self-validation selector and keeps the withdrawn 15-decorative-guards statement, while the real-material assertion now lives in tests/unit/wiring-check-mutation.test.ts and the design doc's mapping row names that file; the routing note in the batch's doc is the only place the divergence is recorded, and the next round reads the acceptance contract.

## wcc3-f10-declared-delta-refused-by-its-own-gate

**major** — `.kata/tasks/wiring-coverage-check/adversarial-briefs/review-revision-4d540d50f0d5895f.json`

Measured end to end on this round: a pass that answers exactly the delta the brief declares is refused by the gate the round exists to satisfy, and the refusal names the delta. After the admission conjunct was satisfied (every criterion and every changed path the gate knows claimed by a hypothesis target), kata-cli adversarial record returned gate.satisfied false with reason delta_stale, whose own message is that the delta covered three paths but two changed paths are missing from it. The two are docs/design/2026-09-23-first-revision-change-surface.md and tests/unit/wiring-check-false-positives.test.ts - both changes of this very revision, both named in the brief's own Paths under review and Modified list, both published by the sealed change record for revision-4d540d50f0d5895f (counts.changedPaths 5). This is wcc2-f1's class surviving the repair recorded as reconciling it: the record, the gate's remit and evaluateDeltaScope now agree on the five-path surface while the brief still hands out the three-path one, so the round is internally inconsistent - the brief's delta is one of its own surfaces and the gate refuses that surface. The only way this pass becomes admissible is to declare paths the brief never declared, which is the trade the second round reported at 25 paths and this round reports at two. Fix, named so it is not a hunt: the brief's delta must come from the same derivation as the record's (revisionChangeSurface over the two sealed snapshots) or the two must be made one function; the call site is src/quality/adversarial.ts:1727 and the function is changeSurfaceAgainstWorkspace (src/quality/revision-delta.ts:110).

