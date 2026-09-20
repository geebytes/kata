## 1. Reproduce the deadlock through the seal

- [x] 1.1 Write the failing test first (RED): a matrix-less task carrying an unresolved obligation refuses to seal, and the refusal never reaches the checks. <!-- comet-task:1-1 -->
- [x] 1.2 Confirm the same fixture shows the resolver never running — the ordering is the defect, not the refusal. <!-- comet-task:1-2 -->

## 2. One rule for answerability

- [x] 2.1 Extract the obligation→evidence answerability question into one exported function used by the resolver. <!-- comet-task:2-1 -->
- [x] 2.2 Give it a dry mode the preflight can call: "would this obligation be resolved by this evidence set?" <!-- comet-task:2-2 -->
- [x] 2.3 Assert the resolver's outcome and the preflight's dry verdict agree for every obligation shape (scoped, unscoped, matrix, matrix-less) — jointly, in one test. <!-- comet-task:2-3 -->

## 3. The preflight denies only what the run cannot answer

- [x] 3.1 Deny an obligation that would still be unresolved after the run's evidence, and only that. <!-- comet-task:3-1 -->
- [x] 3.2 Keep the refusal's force: an obligation this run cannot answer still blocks, with the criterion named. <!-- comet-task:3-2 -->
- [x] 3.3 Make the message say which case it is, so it is not a trap for the reader. <!-- comet-task:3-3 -->

## 4. End-to-end, and the case that found it

- [x] 4.1 Seal a matrix-less task that carries an unresolved obligation and assert it resolves and closes. <!-- comet-task:4-1 -->
- [x] 4.2 Assert the matrix paths are unchanged, against the existing matrix tests rather than duplicated ones. <!-- comet-task:4-2 -->
- [x] 4.3 Close `check-log-artifact-missing`'s held-open batch through the fixed path — the case that surfaced the deadlock. <!-- comet-task:4-3 -->
- [x] 4.4 Full suite green. <!-- comet-task:4-4 -->

## 5. What implementation and the review pass found beyond the design

Recorded in `docs/design/2026-09-20-repair-obligation-deadlock.md`. Each is the same family — two places disagreeing, or
a refusal swallowed — and each was repaired with a test of the shape that exposed it.

- [x] 5.1 **Closure ran before resolution** (`closeBatchAfterSeal` before `resolveObligationsForRevision`), so every
  batch's first successful seal refused on `answered: []`, one run late and swallowed by `.catch(() => null)`. <!-- comet-task:5-1 -->
- [x] 5.2 **Closure did not mark its answered findings `fixed`**, so a closed batch still read as unrepaired to the round
  framing; a failure to record it is now an error rather than a silent `false`. <!-- comet-task:5-2 -->
- [x] 5.3 **`TrackedFinding.source` was ambiguous** — the bare node name made an adversarial `review` finding and a
  `review.json` finding indistinguishable, so a write hit the wrong record. The label now names the record. <!-- comet-task:5-3 -->
- [x] 5.4 **The review pass found the design's own failure mode**: the dry run counted a deferred (frozen-tier) check as
  evidence the run would produce, so the seal passed while the obligation stayed open. Measured: planned verdict `true`
  against the same rule over what that plan produces, `false`. Both sides now filter by `deferredChecks`. <!-- comet-task:5-4 -->
- [x] 5.5 **`adversarial record` opened a batch but created no obligation**, so a finding that arrived in the verdict had
  nothing that could answer it. <!-- comet-task:5-5 -->
