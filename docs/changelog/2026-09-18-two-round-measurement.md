# The two-round measurement exists (the proposal's §6 acceptance, as a test)

The pass-cost proposal's §11 named its largest unverified assumption — *"把 2 行修复的 pass 从 10–22 分钟压到 2–3 分钟"* —
and said it had never been run, because nothing recorded a pass's duration. F2, M1/M3/M4, M2 and K1–K4 are delivered; what
was missing is the **loop** that produces the numbers.

## What the test drives

`tests/unit/two-round-measurement.test.ts` runs both rounds on a fixture whose checks are shell commands, so every number
is a real number about kata's own machinery rather than arithmetic in a document:

1. **Round one** — `collectEvidence` runs the checks; `computePathDigests` records a per-path table; `createTaskRevision`
   seals it. The revision's `pathDigests` must match what was measured.
2. One file changes.
3. **The delta** — `diffPathDigests` names **exactly the file that moved** and not the one that did not.
4. **The derived checks** — `deriveRelevantChecks` on that surface with no matrix **falls back to the full set**, with the
   reason stated. That is the safe direction the design demanded, and the test asserts it rather than assuming it.
5. **Both rounds on the record** — a `cold`/`full` round (12 min, 40 turns) and a `verify`/`delta` round (3 min, 11 turns),
   with the baseline **snapshotted** by the write that replaced it, so the saving is computable: **540 s and 29 turns**.

## What it does and does not prove

- It proves the **mechanism** end to end: the change surface is derived from content, the delta names only what moved, the
  fallback is taken when the mapping is unknown, the round's mode/turns/duration are recorded, and the baseline survives
  the replacement of the record.
- It does **not** prove the headline projection. The fixture's rounds are *constructed* costs, and the real question — how
  much wall clock a narrower pass saves on a real task — still needs a real pass. What the test establishes is that the
  number is now **obtainable** rather than remembered: `elapsedMs`, `toolUses`, `mode` and `scope` are on the record, and
  `adversarial status` computes `deltaSaving` from the snapshot.

## Verification

Full kata suite: 725 tests in 86 files; `tsc` clean; `dist/cli.js` rebuilt.
