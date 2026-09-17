# Evidence eligibility is structural

The architecture review's L3-08 finding: whether a matrix row was satisfied — "this acceptance criterion is evidenced
at integration level", "this blocking finding has been resolved" — was decided by substrings. `evidenceMatchesRow`
required `decl.kind === evidenceKind` and `evidenceCommand.includes(decl.command)`, with two hardcoded regexes for
`vitest run` and `tsc`, and `selectorMatches` was containment-based too. The check's `kind` was itself guessed from the
check's *name* by `inferEvidenceKind`. A rename, a wrapper script, or a differently worded but equivalent command
changed the verdict without changing what actually ran. That predicate decides row satisfaction in the Judge, in
verify's readiness and in whether a repair obligation is closed.

## What is one identity now

- A matrix declaration may carry an `id` (`MatrixEvidenceItem.id`), and the runner stamps the resolved check with the
  same id: `resolveCheckForRow` uses `evidence.id` when present, else derives `matrix:<ac>:<kind>:<selector>`. The
  evidence envelope records it as `checkId` (and the seal records its provenance as `checkSource`), which L3-01's
  preflight already surfaces.
- `evidenceMatchesRow(row, command, kind, checkId?)` compares **identity first**: when the declaration and the envelope
  both carry an id, the ids must be equal (and the kind and verification level must still hold). The textual comparison
  survives only as the fallback for declarations without an id and for artefacts recorded before ids existed, so
  existing repositories keep working while new evidence is judged structurally.
- Every caller passes the envelope's `checkId`: the shared evidence-adequacy evaluator (Judge and verify), repair
  obligation closure, and the upstream-requirement coverage check.

Because identity now decides, the substring heuristics can no longer make a renamed or wrapped check look like the
declared one — and an unrelated check that merely mentions the declared command's text no longer satisfies the row.

## Verification

- `tests/unit/evidence-eligibility.test.ts` — a declared id matches evidence whose command text says something else
  entirely (the wrapper case) and rejects an unrelated check that happens to mention the declared text; kind and
  verification level still apply; declarations without an id and envelopes without a `checkId` fall back to the textual
  comparison rather than being rejected.
- Full suite: 517 tests in 59 files, all passing; `tsc --noEmit` clean; `dist/cli.js` rebuilt.
