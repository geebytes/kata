# A recorded adversarial pass is bound to the brief kata **issued**

`kata-cli adversarial record` used to invalidate its own record. The gate checked a recorded pass by **re-deriving** the
brief and comparing hashes, but a brief's text moves with state that any later action can rewrite:

- the round framing — `resolveBriefMode` reads the previous pass's `mode`, so recording a pass changes the next round's text;
- the reading set — derived from the working tree, so an edit to an owned path changes it;
- `review.json` — the review node resets it at the start of a round, which silently invalidated the *verify* node's pass.

Reproduced on the pre-change tree (both nodes, `brief_mismatch` every time, so the gate could never be satisfied on a task
that did anything at all):

| # | Action | Result before this change |
|---|---|---|
| B | record the pass with the framing the brief carried | `recorded: true, satisfied: false, reason: brief_mismatch` |
| C | record a `--since` delta round | the gate re-rendered a *full* brief, so a delta round could never pass — not even once |
| D | run the review phase, then ask the verify gate | the pass that was satisfied a moment earlier became `brief_mismatch` |

The first fix for the same defect (`2026-09-17`, and §10 of `docs/design/2026-09-18-what-an-adversarial-pass-costs.md`)
narrowed the brief's inputs and declared re-deriving it an identity function. That claim was false — hence this change.
The design doc had already named the right fix: *bind the record to the brief as issued*.

## What changed

- **The issued copy is the binding.** `kata-cli adversarial brief` now calls `issueAdversarialBrief`, which renders the
  brief *and* stores it — text, hash, `mode`, `since`, `issuedAt` — under
  `.kata/tasks/<task>/adversarial-briefs/<node>-<revision>.json` (the last `ADVERSARIAL_BRIEF_HISTORY = 10` per node and
  revision). Re-issuing the same brief is idempotent; the hash is the entry's identity. `buildAdversarialBrief` stays
  pure, and the gate no longer renders a brief at all — rendering is not what makes a brief binding, issuing is.
- **The gate matches the issued pool, not a recomputation.** `evaluateAdversarialGate` takes `issuedBriefSha256s` plus
  `otherRevisionBriefSha256s` instead of `briefSha256`. `issuedBriefPool` classifies every issued brief for the node by
  revision id (the current one *and* the record's own, so a re-seal of unchanged content still matches) and by manifest
  hash. An issued brief for a different revision is refused as `brief_mismatch` ("answered another round's question"); a
  hash kata never issued — invented, mistyped, or absent — is refused as the new **`brief_not_issued`**, whose message
  names the command to run. A record with no attempt is now the new **`incomplete`** rather than `brief_mismatch`, which
  it never was.
- **`record` refuses before it writes.** An unissued hash could never satisfy the gate, and writing it would have
  destroyed whatever pass was already recorded. `kata-cli adversarial record` reports `recorded: false` with the
  actionable error and leaves the previous record untouched.
- **The framing is stamped from the issued brief**, not from a `--mode` flag: the round answered *that* brief, and the
  next rotation reads the mode from the record. Rotation (M2) was previously dead in the CLI path, because the printed
  next rotation reads the mode from the record (a `--mode` flag that disagrees is reported in `modeNote`, not obeyed).
  Rotation (M2) was previously dead in the CLI path, because the printed `record` command never carried `--mode`.
- **A decision survives a pass that stops re-reporting it (D1, second half).** `writeAdversarialRecord` carried a
  disposition onto the finding of the same id, but a later pass that simply does not re-report a deferred nit — the
  deferral *is* the decision — deleted the decision and its id with it. Decided findings (`deferred`/`accepted`) that the
  new record does not mention are re-attached to it. `blocking`/`major` are deliberately *not* carried: they cannot be
  dispositioned (I1), so a carried one could only pin a node that a repair pass had right to clear.

## Verification

- `tests/unit/adversarial-brief-binding.test.ts` (new, 6 tests) — both nodes keep a recorded pass after `review.json` is
  reset, an owned path changes and the framing rotates; a delta round passes; a hash that merely matches the *rendered*
  brief is refused; an invented hash and another revision's hash are refused; and the CLI path stores the issued copy,
  stamps the record's framing from it, refuses an unissued hash without overwriting the good record.
- `tests/unit/adversarial-review.test.ts` — the gate's refusals, rewritten against the issued pool.
- `tests/unit/finding-disposition.test.ts` — the two new D1 tests: a decision outlives a pass that does not re-report it,
  and a repair pass still clears a `blocking` finding (which is never carried).
- `tests/helpers/adversarial.ts` issues briefs rather than rendering them, so every end-to-end fixture walks the path the
  CLI actually produces.
- Full suite: **739 tests in 88 files, 738 passed**. The one failure (`tests/unit/worktree.test.ts` — *reports a
  repository with no commit to branch from*) is pre-existing: it fails identically with this change stashed.
- `dist/cli.js` rebuilt (`node scripts/build.mjs`); the committed platform skill assets needed no regeneration (no
  renderer text changed).

## Still open

- The review node resets `review.json` with `findings: []` at the start of a round (archiving the old ones to
  `review-history.jsonl`). A *review-source* deferral therefore stops being visible in the brief's known-and-decided
  section — the adversarial record now survives its passes, but the review record does not survive its rounds.
  Fixing it means giving `review.json` the same carry-forward, which is a separate change.
