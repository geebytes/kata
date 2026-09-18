# M1, M3 and M4: the brief asks the reviewer to read, and hands it a starting set

The pass-cost proposal measured seven passes on one task: a median of **16 minutes** on a 48-core machine that sat at load
5. The cost is not compute, it is the reviewer's own turn loop — and the brief asked for that loop to be spent re-deriving
what the gate had already recorded. These are the three cheapest of its four mechanisms.

## M1 — the brief points at sealed evidence

- A **Sealed evidence you may read instead of re-running** section lists each envelope with its `checkId`, exit code,
  command and **path on disk**, and flags the ones that are **project-declared checks** ("read its result, do not re-run
  it").
- The rule is stated with its exception: *do not re-run a check whose sealed evidence covers this revision — the full
  suite above all*; when the round's focus **is** suite-global behaviour, say so and run it once.
- The price is stated rather than hidden: a global claim's independence drops from **re-derived** to **inspected**, which is
  worth paying only because the gate re-runs the suite at seal time on that same revision.
- Measured on the real task: 16 evidence entries, 4 of them enumerating the project's own checks with flagged paths.

## M3 — the cost signal, both ways

- Into the record: **`toolUses`** beside `elapsedMs` (`--tool-uses`), so the two terms the proposal separated — running
  things, and the reviewer's turns — are separable in the record and `adversarial status` can show a trend.
- Into the brief: a **Pacing yourself** section, one line long: independent commands belong in **one** invocation. Every
  separate invocation is a full turn, and the turn term is where the minutes are.

## M4 — a starting set, bounded

The brief derives a **Where to start reading** list from what it already knows: the changed paths (F2's change surface)
first, then the files the acceptance matrix ties to the same criteria. Framed as *"a starting set, not a boundary — reading
beyond it is expected"*, because the proposal's own evidence is that the largest defect of the measured session sat in a
file the author had not mentioned.

Two corrections found by running it against the real task, and worth recording:

1. **A clean working tree is not "nothing to read".** The first version derived the set from the change surface alone,
   which is *unchanged* at the moment a brief is rendered after a seal — so the section degenerated to "explore freely".
   The sealed revision's own content is the unit under review, so its owned set is the floor.
2. **Seven hundred entries is not orientation.** With the owned-set floor the set became 702 paths — a wall, and the
   opposite of the proposal's point. It is now bounded (40) and labelled a sample, which is what a starting set is.

## Verification

- `tests/unit/adversarial-review.test.ts` — the reading list names envelopes and flags declared checks, the rule and the
  stated trade are present, the exception is stated, the pacing line is present, a matrix check is listed without the
  flag; and the reading set is framed as a starting set with its reasons, including the plain "cannot name a starting set".
- A real `adversarial brief --json` on `skill-identity-idempotency-versioning`: 14 reading-set entries, 16 sealed-evidence
  lines with 4 flagged paths, brief size 15 028 chars.
- Full kata suite: 713 tests in 84 files; `tsc` clean; `dist/cli.js` rebuilt.
