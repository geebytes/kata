# A declaration can name the check that covers it

Measured cost in the notes: several of the 12 acceptance-matrix evidence commands re-run files the project's full suite
already runs — two passes over the same tests, about a third of one seal's five minutes of evidence time.

## What changed

A matrix evidence declaration may name a **covering check**:

```jsonc
{ "id": "ac-3-replay", "kind": "test", "command": "uv run pytest tests/test_compile_key_replay.py",
  "coveredBy": "discovered:test" }
```

- **The covering check still runs.** It is a real check (usually the project's suite); what is elided is the row's own
  second copy of the same work, so nothing is verified less.
- The covered check is **not executed** (`collectEvidence` skips it) but is not dropped either: it stays in
  `--list-checks`, its declaration keeps its id and name, and the seal reports it under
  `diagnostics.coveredChecks` — so "declared but not run" is something the reader can audit rather than an absence they
  have to notice.
- Eligibility follows the pointer: the row is credited with the **covering check's** evidence
  (`evidenceMatchesRow` matches `decl.coveredBy` against the envelope's `checkId`), and only that check satisfies it.
- Progress events carry a `covered` state with `coveredBy`, so a monitor sees why a check produced nothing.

The pointer is what the notes asked for ("record a pointer: covered by suite @ revision X"). Nothing about how evidence
binds to a revision changed — the covering check's envelope carries the same revision and manifest identity as any other
check's.

## Verification

- `tests/unit/covered-checks.test.ts` — the pointer reaches the resolved check, a covered check produces no envelope and
  no `started` event but a `covered` one, and the row is satisfied by the covering check's evidence and by nothing else.
- Full kata suite: 602 tests in 72 files; `tsc` clean; `dist/cli.js` rebuilt.
