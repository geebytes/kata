## 1. The artifact exists when it is claimed

- [x] 1.1 Write the failing test first (RED): collect a >2 MB check with `checkLogDir` pointing at an **absent** directory and assert `stat(logArtifact)` resolves — it does not today. <!-- comet-task:1-1 -->
- [x] 1.2 Create the evidence directory in `src/workflow/orchestrator.ts` before `collectEvidence` runs, so a first seal has somewhere to write. <!-- comet-task:1-2 -->
- [x] 1.3 Extend the test to a pre-existing directory, asserting the artifact holds the complete output byte count. <!-- comet-task:1-3 -->

## 2. A failed write is reported, not swallowed

- [x] 2.1 Write the failing test first (RED): force an unwritable artifact parent and assert the failure is observable on the process result. <!-- comet-task:2-1 -->
- [x] 2.2 Replace `.catch(() => undefined)` in `src/process/run.ts` with a recorded failure that reaches `ProcessResult`. <!-- comet-task:2-2 -->
- [x] 2.3 Make `src/quality/evidence.ts` omit `logArtifact` when the write failed, and report the reason instead of claiming the file. <!-- comet-task:2-3 -->
- [x] 2.4 Assert the schema still validates an envelope that omits `logArtifact`, and that no envelope can carry it without a file. <!-- comet-task:2-4 -->

## 3. The verdict path is untouched

- [x] 3.1 Assert `exitCode`, `passed`, `logBytes` and `logTruncated` are unchanged for a check whose output is and is not bounded. <!-- comet-task:3-1 -->
- [x] 3.2 Run the full suite and confirm the only failure is the pre-existing locale-dependent `worktree.test.ts` case. <!-- comet-task:3-2 -->

## 4. Documentation

- [x] 4.1 Note the artifact guarantee where the bounded capture is documented (`docs/operations.md` or the changelog entry that introduced it). <!-- comet-task:4-1 -->
- [x] 4.2 Update `docs/design/2026-09-20-check-log-artifact.md` with anything implementation corrected. <!-- comet-task:4-2 -->

## Verification evidence

All four acceptance criteria were verified, three of them through the real commands rather than only in process:

- **AC-1** — `tests/unit/evidence.test.ts`: `logArtifact` resolves and the file is 3 145 728 bytes (3 MB of stdout) when
  the directory exists; `tests/e2e/check-log-artifact.test.ts` does the same through a real `runCommand('build', …, {
  seal: true })`.
- **AC-2** — `tests/unit/evidence.test.ts`: with the directory absent, `logArtifact` is `undefined`, `logArtifactFailure`
  matches `ENOENT`, and `exitCode` is still 0.
- **AC-3** — `kata-cli build --seal` on a scratch task whose `.kata/evidence/` was removed (a genuine first seal) with a
  check printing past the bound: `logTruncated: true`, `logArtifact:
  <root>/.kata/evidence/noisy-seal-noisy.log`, the file exists at 146 176 bytes while the envelope's excerpt is 20 000,
  and `exitCode: 0 / passed: true`. Also asserted in `tests/e2e/check-log-artifact.test.ts`.
- **AC-4** — `tests/unit/process-run.test.ts` (`ok`, `failure` and the artifact channel are independent) and
  `tests/unit/evidence.test.ts` (`exitCode`/`passed` unchanged by a failed artifact write).

Full suite: 883 passed, 1 failed — the failure is the pre-existing locale-dependent `tests/unit/worktree.test.ts` case
(`git` reports 无效引用 in this environment), unchanged before and after this change.

## Known blocker on the seal gate (verify-phase)

`kata-cli verify` requires a green seal, and the seal's `test` check (`npm test`) fails for a reason **this change does
not own**:

- The failing test is `tests/unit/worktree.test.ts` — "reports a repository with no commit to branch from".
- It fails because `src/workflow/worktree.ts:101` classifies git's failure by matching its English prose, and git 2.43
  exits 128 with `fatal: invalid reference: HEAD` (English) / `fatal: 无效引用：HEAD` (this environment's locale) —
  neither matches the regex. The remedy message the code exists to produce is never shown.
- It reproduces identically on a clean tree with this change stashed, and this change's commit touches none of
  `tests/unit/worktree.test.ts`, `src/workflow/worktree.ts` or `src/core/git.ts`.
- Recorded, with the fix, in `docs/design/2026-09-20-worktree-no-commit-message.md`.

Consequently the seal is red for an unrelated defect and this task's `verify` cannot reach a PASS without either fixing
that defect (a separate change, deliberately not folded in here) or waiving the check (which would misrepresent the
suite as green). The four acceptance criteria of **this** change are separately evidenced above, including through the
real commands.
