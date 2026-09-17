# One distill gate, reading the evidence the task recorded

The architecture review's L3-07 finding: readiness for distill was decided by a third validator. `state.ts` decided all
three conditions itself — fresh passing evidence, reviewer clearance, a Judge PASS — and re-derived the Judge's validity
rules (task-id match, result, revision binding, every acceptance PASS, evidence containment) a third time, after the
Judge producer and verify's readiness (L2-02) already held two copies. Its input was not the recorded evidence set but
a single synthetic file, `.kata/evidence/<taskId>-hard.json` — a second copy of the task's *first* test envelope, written
beside the real evidence files and distinguished only by its name. A projection, not the set.

## What is one authority now

**`workflow/distill-gates.ts`** owns the three rules and each is exported on its own so a caller can ask one of them:

- `freshPassingTestEvidence(root, taskId, currentDiffHash)` — the recorded passing test evidence that still describes
  the current revision (revision-bound evidence must belong to a revision whose status is `current`; repository-scoped
  evidence must match the current diff hash).
- `evaluateReviewClearance(root, taskId, revisionId?)` — approved, backed by `reviewEvidence`, free of blocking
  findings, bound to the sealed revision; the reason names which of those failed
  (`not_approved` / `no_review_evidence` / `blocking_findings` / `stale_review`).
- `evaluateJudgePass({ root, taskId, currentDiffHash, freshEvidence })` — a PASS bound to that same revision (or diff),
  every acceptance PASS, and the Judge having accepted the very evidence the gate is looking at
  (`not_passed` / `stale_judgement` / `no_evidence` / `failing_acceptance` / `evidence_not_accepted`).

`evaluateDistillGates` reports all three; `assertDistillGates` fails closed with the same user-facing message, and
`state.ts`'s transition now calls that instead of its own copy.

**The gate reads the set.** `readRecordedEvidence(root, taskId)` in `quality/evidence.ts` returns every
`.kata/evidence/<taskId>-*.json` envelope, schema-validated, filtered to the task; the orchestrator's evidence reader
and the Wiki candidate's back-links use it too, so "the evidence a task recorded" has one definition.

**The `-hard.json` projection is gone.** The gate no longer needs it, the Wiki candidate path reads the set, so
`writeEvidence` no longer writes the duplicate envelope. The fixture that asserted `evidenceCount: 2` in a workflow test
was counting that duplicate: the same envelope twice, once under its own name and once as the projection. The recorded
set for a sealed task is now exactly what the seal recorded.

**The review artefact got the schema it was missing.** `review.json` was read by the clearances, the navigation summary
and the orchestrator without a declared shape; `schemas/review.schema.json` now describes what the producers write
(`status: pending|approved`, the optional revision binding and review evidence, findings validated against the finding
schema), and the clearance reads it through `readValidatedOptional`.

## Verification

- `tests/unit/distill-gates.test.ts` — the passing case; the recorded set being read rather than one filename (a failing
  envelope written before the passing one); evidence belonging to another task ignored; a review without review evidence,
  with blocking findings, and bound to another revision; a Judge PASS that accepted different evidence, one recorded
  against another diff, a FAIL, and a failing acceptance — each with the reason the gate reports.
- Full suite: 474 tests in 51 files, all passing; `tsc --noEmit` clean; `dist/cli.js` rebuilt.
