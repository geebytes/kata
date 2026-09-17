# A recorded adversarial pass is bound to the content it reviewed

The other half of the same cost: after a re-seal, the recorded pass reported `stale_revision` and had to be run again —
19 minutes of a subagent's work, for an artefact that had not changed. The revision id covers the manifest hash *and* the
check ids, so sealing again issues a new id even when the owned paths are byte-identical.

## What changed

- `AdversarialRecord` gains `manifestHash`, stamped by kata when a pass is recorded or waived (`adversarial
  record`/`waive` fill it from the current revision; the reviewer is never asked for it, and the record schema allows it).
- `evaluateAdversarialGate` accepts a pass that names the current revision **or** whose `manifestHash` matches the current
  revision's — the same content under a new id is the same conclusion. A genuinely changed content still fails with
  `stale_revision`; a record written before this change keeps working through the revision id.

## Verification

- `tests/unit/adversarial-review.test.ts` — a pass survives a new revision id with the same manifest hash, is refused
  when the manifest hash moved, and a legacy record without the field still binds by id. Full kata suite: 570 tests in
  67 files; `dist/cli.js` rebuilt.
