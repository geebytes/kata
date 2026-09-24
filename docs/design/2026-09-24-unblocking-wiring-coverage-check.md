# Unblocking `wiring-coverage-check`, and two mechanisms it exercised

It was the cheapest of the four superseded changes by my own measurement — 11 owned paths, one drifted — and it is now at `verify PASS`
with a current revision, `obl 0`, `implReady true`, `govReady true`. Seven steps, and four of them found something about the platform
rather than about the change.

## What was blocking it, in the order the blocks appeared

1. **Its node record was gone.** A node keeps one record, the third round overwrote the second, and a later `waive` replaced the record
   with `findings: []` and a claim of having found nothing — so its six open obligations named finding ids that no record explained.
   Restored from `docs/design/2026-09-23-wiring-coverage-check-findings.md`, which I committed verbatim before the waive for exactly
   this reason, via `adversarial record --from-file` bound to the round's own brief (`193d264d…`) and revision (`4d540d50…`).
2. **Its review record named seven wiki candidates, one of which is now `stale`.** `evaluateWikiClosure` accepts only records whose
   status is `candidate` or `verified`, so a closure that was valid when written became `candidate_missing` without anything about the
   knowledge changing. Re-recorded with the six that read, and the stale id deliberately left out — naming it is what makes the closure
   invalid.
3. **Its revision was superseded**, by later edits to `src/cli/ops.ts` and its own repaired tests.

## Two findings about the mechanisms this exercised

**`findings rout` closes obligations by finding id, so a destroyed record makes routing impossible for exactly the findings whose
record was destroyed.** `wcc3-f2-delta-surface-hides-workflow-paths` is assigned to `kata-gate-surface` by the routing table and could
not be routed, because it "was not found in the review record or an adversarial pass". Its obligation was closed with a recorded
absence whose reason states that this is the gap rather than a property of the repair. Seven other findings routed cleanly, which is
the first real use of the command.

**And `adversarial status` still reports obligations more weakly than the rule judges them.** After the seven obligations were disposed
and the absence recorded, `status` reported `answeredBy: none` for all of them while the seal accepted every one. So `rba5-f3`'s defect —
the report computing `answeredBy` with a weaker predicate than the criterion — is still present one layer down. It is worth recording
rather than fixing here: it is the same class as three repairs on this line, and it needs its own falsifier.

## And a prediction I got wrong

I expected a hard deadlock: a superseded revision with open obligations whose dispositions bind content the revision no longer
describes, and a seal that refuses while obligations are open. **Running the seal falsified it.** The seal mints a revision from the
current content, and the dispositions were recorded against that same content, so they bind and every obligation resolved. The
constraint is the one already recorded — **freeze content, record dispositions, seal immediately** — and it holds.
