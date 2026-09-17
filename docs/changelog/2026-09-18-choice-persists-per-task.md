# The trust-boundary choice can persist for the task

The trust boundaries are right — choosing a platform or a model stays a human decision — but the same human was asked the
same question at each of the four boundaries, and the notes recorded reusing an earlier `continue_current` by hand. The
architecture-review fix removed the *unintended* re-asking (a re-seal expiring the gate); this removes the intended-but-
repetitive one, without removing the boundary.

## What changed

- `kata-cli gate approve … --for-task` records the answer **for the whole task**
  (`.kata/tasks/<id>/user-choice-task.json`, schema `task-choice.schema.json`). Without the flag, the behaviour is exactly
  as before: the choice is recorded at that boundary only.
- A later boundary with no decision of its own **reuses** the task-level answer when it still speaks for the content, and
  **materialises that reuse in its own gate file** (`reusedFromTaskChoice: true`) — so the audit trail says where the
  answer came from instead of only reporting it in a status line. The boundary is still created and still recorded; it
  just does not ask again.
- The gate's binding rule is now explicit: it authorises by the revision the caller names, by the sealed revision, or by
  the **content** it was answered about. The case this exists for is unchanged from the review fix — a re-seal of
  byte-identical content issues a new revision id, and asks nothing. A choice that speaks about *different* content does
  not authorise the boundary (tested with a sealed revision and a mismatched content identity).
- A gate approved around the first seal (naming neither revision nor content) still authorises, which is what it did
  before.

## Verification

- `tests/unit/user-choice-gate.test.ts` — the reuse path (later boundary, visible in its gate file), the refusal when the
  task choice speaks about other content, and the existing per-boundary behaviour all pass. Full kata suite: 599 tests in
  71 files; `dist/cli.js` rebuilt.
