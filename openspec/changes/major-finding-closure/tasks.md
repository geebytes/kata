## 1. A terminal finding becomes an obligation

- [x] 1.1 Write the failing test first (RED): record a `blocking`, a `major` and a `minor` review finding and assert the obligations created — it is one today. <!-- comet-task:1-1 -->
- [x] 1.2 Decide by `isTerminalSeverity` in `persistBlockingFindings` instead of the literal `'blocking'`. <!-- comet-task:1-2 -->
- [x] 1.3 Assert the three gates that must agree still do: a `minor` finding creates no obligation, and neither gate stops on it. <!-- comet-task:1-3 -->

## 2. An obligation resolves without a matrix

- [x] 2.1 Write the failing test first (RED): resolve an obligation on a task that has no `acceptanceMatrix`. <!-- comet-task:2-1 -->
- [x] 2.2 Map by acceptance ids and passing evidence for the revision, with the matrix as enrichment rather than a precondition. <!-- comet-task:2-2 -->
- [x] 2.3 Assert the matrix path is unchanged: a task **with** a matrix still resolves only on matrix-matched evidence. <!-- comet-task:2-3 -->

## 3. The batch closes, and the framing follows

- [x] 3.1 Write the failing test first (RED): drive a matrix-less task to a terminal finding, repair, re-seal, and assert the batch closes with the finding named in `answered`. <!-- comet-task:3-1 -->
- [x] 3.2 Assert `kata-cli adversarial brief` stops describing a repaired finding as unrepaired once the batch has closed. <!-- comet-task:3-2 -->

## 4. The documented command works

- [x] 4.1 Write the failing test first (RED): `adversarial finding add --change <id> --node <node> --from-file <json>` fails with an ENOENT about a task named `add`. <!-- comet-task:4-1 -->
- [x] 4.2 Read `--change` from the flag in the `finding` branch, so the action word is not read as the task id. <!-- comet-task:4-2 -->
- [x] 4.3 Assert the missing-`--change` path fails with a usage error rather than resolving the action word. <!-- comet-task:4-3 -->
- [x] 4.4 Check every other `parseChangeArg(rest)` call site for the same shape, and fix or record each. <!-- comet-task:4-4 -->

## 5. Documentation and the end-to-end proof

- [x] 5.1 Regenerate the Skills from `phase-guidance.ts`; the documented invocation must be verified working, not edited to match a broken command. <!-- comet-task:5-1 -->
- [x] 5.2 Close `check-log-artifact-missing`'s open batch through the fixed path, proving AC-2/AC-3 on the case that found the defect. <!-- comet-task:5-2 -->
- [x] 5.3 Full suite green. <!-- comet-task:5-3 -->

## 6. What implementation found beyond the design

The three layers below are recorded in `docs/design/2026-09-20-major-finding-closure.md`; layers 2 and 3 surfaced only
because the previous layer let the next seal run far enough to fail.

- [x] 6.1 **Layer 2 — nothing created an obligation for an adversarial finding.** `persistBlockingFindings`' only caller was
  `recordFinding` (review findings); an adversarial finding reached the platform through `addAdversarialFinding`, which
  persisted none. Repaired: adding a terminal adversarial finding now persists one. <!-- comet-task:6-1 -->
- [ ] 6.2 **Layer 3 — a pre-existing deadlock, NOT repaired here.** `collectSealPreflight` refuses on unresolved obligations
  *before* the checks; `resolveObligationsForRevision` — the only resolution path — runs *after* them. So an unresolved
  obligation blocks the run whose evidence would answer it, and no CLI can resolve one by hand. Removing check 5's early
  return for a matrix-less task (required by D2, since closure no longer needs a matrix) makes this reachable on the
  default task shape. Closing it means deciding when an obligation may be answered by evidence the current run is about to
  produce, which changes what the seal means and does not belong in this change. What this change does is stop the
  platform passing silently: the seal now refuses instead of leaving the batch open forever. <!-- comet-task:6-2 -->
