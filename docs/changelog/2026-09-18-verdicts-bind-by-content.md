# Every verdict binds by revision id **or** by content

The same defect the handoff receipts and the adversarial records had, in the five places that were left: a review, a
judgement, a verification and a user's choice at a gate were bound to the revision **id** alone. The id covers the
manifest hash *and* the check ids, so sealing byte-identical content again issues a new id — and every one of those
verdicts expired. Measured consequences: the platform/model choice was re-asked at each phase transition, the review had
to be re-run, and the distillation verdicts went stale, all for an artefact nobody had changed.

## What changed

**One module, one rule** — `src/workflow/verdict-binding.ts`:

- `currentRevisionIdentity(root, taskId)` is the single place a verdict's identity is read, and
  `revisionBindingFields(identity)` the single place it is spread into an artefact;
- `bindsToRevision(artifact, current)` accepts a verdict that names the **same revision** or the **same content**, and
  refuses one that names neither. With nothing sealed, a verdict that names no revision stands (a choice recorded before
  the first seal is early, not stale) while one naming a revision that is gone does not.

**Writers stamp both fields**: `verify.json`, `review.json` (both the approval and the findings writer), `judge.json`, and
the user-choice gate — the caller's revision id is kept and the current content identity is added. The four schemas allow
`manifestHash`.

**Readers apply the rule instead of comparing ids**: the verify-node readiness summary, the review entry that re-enters
implementation, the distillation clearance/judgement gates, the review-approval and review-recording paths, and the
user-choice gate. A verdict from before this arrangement still works — it has the id.

## Verification

- `tests/unit/verdict-binding.test.ts` — the rule itself (same revision, same content under a new id, different content,
  legacy id-only artefacts, nothing sealed, no verdict), plus an end-to-end pair of seals over byte-identical content
  with different check sets: the revision ids differ, the manifest hashes match, an approved review stays cleared, and a
  recorded choice is still valid rather than re-asked.
- Full kata suite: 597 tests in 71 files; `tsc` clean; `dist/cli.js` rebuilt.
