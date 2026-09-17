# The seal preflight reports every blocker, not just the first

The architecture review's L1-02 finding: `cmdBuild` was one 300-line function that performed repair re-entry dispatch,
the implement-mode early return, **nine sequential early-return preflight validations**, revision creation, evidence
collection, requirement-evidence binding, obligation resolution, wiki closure and the phase transition. Two consequences
followed from the fail-fast preflight:

- A task with three independent closure problems was told about **one per run**.
- Every run of that repair loop paid the **whole evidence cost again** before reaching the next blocker.

## What this pass delivers

**`workflow/seal-preflight.ts` collects the blockers.** The nine validations are pure reads now, and their results are
one ordered list:

- matrix required but absent (`missingMatrix`), matrix invalid (`matrixErrors`);
- upstream coverage required but absent (`missingUpstreamCoverage`), upstream coverage invalid (`coverageErrors`);
- a legacy task with unresolved repair obligations (`unresolvedObligations`);
- owned paths that could not be resolved (`missingOwnedPaths`);
- a review repair whose manifest has not changed (`repairRequired`);
- a bounded repair that touched files outside its accepted scope (`unrelatedRepairPaths`);
- ownership overlapping another active task (`ownershipConflicts`);
- invalid waivers (`waiverErrors`);
- incomplete path coverage, including unresolved CodeGraph candidates (`pathCoverage`).

Each blocker keeps **the message and diagnostics key its early return used**, and the order is the order the early
returns had — so the first blocker is exactly what the old code produced, and everything that reads or asserts on the
result is unaffected. `cmdBuild` now returns the first blocker's shape plus `diagnostics.blockers` (every blocker, with
its own diagnostics) and `diagnostics.blockerCount`; when there is more than one, the error text says how many and lists
them. Fail-closed is unchanged: any blocker is still a refusal, and nothing is sealed.

Stages whose *input* is invalid are skipped rather than run — a matrix that does not exist cannot be validated, and a
matrix that does not validate cannot be checked for path coverage — which is what keeps the collected list from
reporting phantom blockers (and from spawning CodeGraph for a matrix that is already refused).

**Two supporting extractions**, because the preflight could not ask the orchestrator for them without a cycle:

- `workflow/seal-reads.ts` — `readActiveReviewRepairBaseline` and `readActiveRepair`, the seal path's reads, moved out
  of the orchestrator.
- `quality/check-resolver.ts`'s `dedupeChecks` (from L1-03) is what `matrixChecks` uses, so the seal and the matrix walk
  share one identity tuple.

## What is left of L1-02

The sealing *sequence* (revision → evidence → requirement binding → obligation resolution → wiki closure → transition)
is unchanged and still inline in `cmdBuild`; extracting it into a `sealBuild` unit is the second half of the finding.
The validators were the half that carried the user-visible cost, which is why they came first.

## Verification

- `tests/e2e/seal-preflight-blockers.test.ts` — two independent problems (missing upstream coverage and uncovered matrix
  paths) are reported together with `blockerCount: 2`, the first keeping its original diagnostics key and each carrying
  its own; a legacy task with one unresolved obligation reports exactly that one blocker with the original sentence; a
  consequence (an invalid matrix path) is reported alongside its cause rather than one per run; and a task whose owned
  paths cannot be resolved still collects the other blockers beside `missingOwnedPaths`.
- Every existing seal suite passes unchanged (quality gates, repair scope, seal preflight output, ownership conflicts,
  workflow resume), which is the evidence the first blocker and the success path are byte-compatible.
- Full suite: 554 tests in 65 files, all passing; `tsc --noEmit` clean; `dist/cli.js` rebuilt.
