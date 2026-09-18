# Re-entering the phase you are already in is free (C6)

§17.4 records the failure: **an interrupted seal left the phase set at `hardVerify`, and the re-run failed with
`Illegal transition from hardVerify to hardVerify` while all six checks passed.** The gate refused to re-answer a question
about content that had not changed — which is the one thing a content-addressed system must do for free.

## What changed

`isIdempotentPhaseEntry(from, to)` — true when `from === to` — and `transition()` answers it **before** the legality check,
returning the state as it stands with no event appended and no state write.

## Why it is not folded into `isLegalPhaseTransition`

That function is also what **recovery replays events against**. A self-transition that read as legal there would let a
corrupt event log look like a legitimate chain, so C6 is a separate question asked by `transition()` and nowhere else —
and the test asserts the separation rather than trusting it.

A caller cannot tell "moved" from "already there": the returned record is identical. That is the point — re-running a gate
over unchanged content must be free, and a caller that could detect the difference would be tempted to branch on it.

## Verification

`tests/unit/idempotent-phase-entry.test.ts` (3): re-entering writes nothing (the state record is `toEqual` the one before,
and the event log's line count is unchanged); `isLegalPhaseTransition` still rejects a self-transition while
`isIdempotentPhaseEntry` accepts it and rejects a real move; and the seal's re-run from `hardVerify` resolves rather than
throwing.

Full kata suite: 769 tests in 95 files; `tsc` clean; `dist/cli.js` rebuilt.
