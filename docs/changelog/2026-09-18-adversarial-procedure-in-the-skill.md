# The adversarial procedure reaches the skill text

A mechanism nobody is told to use is the same as no mechanism. F2/F3/F5 and the `--elapsed-ms` measurement were all
implemented, and all of them needed an agent to *know* to use them: report the pass's duration, record a delta pass with
the same `--since` kata measured, disposition a minor finding instead of silently dropping it, say how many findings the
last repair caused.

## What changed

The verify/review adversarial section (`src/adapters/phase-guidance.ts`) now states the procedure where the agent reads it:

- **step 3** records the pass *and its wall-clock duration* (`--elapsed-ms`), with the reason: it is the only place the
  number exists, and §11 of the design could not answer "what does a narrower pass save?" without it. It names
  `deltaSaving` and says plainly that the first passes report "not measurable yet" — because that is the honest answer.
- **step 4** says that a delta brief is recorded with the same `--since`, that **kata measures the change surface itself**,
  and that a hand-written `scope` is a scope the gate will refuse (`delta_stale`) — and right to.
- **step 6** says a confirmed finding has a disposition (`findings defer --reason …`), that `blocking`/`major` cannot take
  one, and that `findingOrigins.causedByPreviousRepair` is where "fix one, grow two" becomes a number.

The **printed `recordCommand`** in `adversarial brief` now carries `--since` (when one was used) and
`--elapsed-ms <milliseconds …>`, so a caller who copies the line does the right thing without reading the guidance.

## Verification

- `tests/unit/adversarial-procedure.test.ts` — the duration flag, the `deltaSaving` reference and the stated reason; the
  delta recording rule and the no-hand-written-scope rule; the disposition instruction with the blocking/major refusal; and
  that the rendered shipped skill carries `--elapsed-ms` **only** for the two concluding nodes.
- Full kata suite: 657 tests in 82 files; `tsc` clean; `dist/cli.js` rebuilt.
