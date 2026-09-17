# One evidence-adequacy evaluation, called by the Judge and by verify

The architecture review's L2-02 finding: the single most consequential product judgement — "is this acceptance
criterion actually evidenced?" — existed twice, and the two copies had already diverged. `quality/judge.ts` carried
one ladder; `evaluateReadiness` in `workflow/orchestrator.ts` carried another that returned the Judge's result type,
so the artefact boundary suggested one evaluator while two existed. Verify's copy knew an `unresolved_repair_obligation`
branch the Judge lacked; the Judge had a `cross_revision_evidence` refusal verify's copy never had. The two disagreed
exactly where the repair path is decided, and nothing tested that they agreed.

## What is one authority now

`quality/evidence-adequacy.ts` holds the ladder once: the freshness filter (`checkFreshness` against the diff hash and
the per-evidence scope hash), the fresh/failing passing-test derivation, the strict-mode blocking-finding rule, and the
ordered classification (`failing_evidence` → obligation → `stale_evidence` → `missing_test_evidence` →
`insufficient_evidence_level` → `blocking_review_finding` → PASS).

What genuinely differs between the two callers is now an input, not a second implementation:

- **`rejectCrossRevision`** — the Judge refuses to judge evidence spanning more than one revision, because a verdict
  computed over mixed revisions would be attached to neither. When set, every criterion fails with
  `cross_revision_evidence`, which is the behaviour the Judge already had.
- **`unresolvedObligations`** — verify carries repair obligations from the review and the Judge, which a Judge verdict
  cannot know about yet. When supplied, the obligation branch sits where verify had it (after failing evidence).

`judge()` is now 105 lines including its types: it calls the evaluator, builds the result and persists `judge.json`.
`evaluateReadiness` is a thin wrapper over the same call. Both keep their exact previous semantics — the merge is
behaviour-preserving, which the suite confirms: no existing test changed, and all 457 pass.

The evaluator also reports `crossRevision` and `revisionIds` to both callers, so the mixed-revision fact is observable
even where the caller chooses not to refuse (verify throws on it earlier, through `revisionIdForEvidence`).

## Verification

- `tests/unit/evidence-adequacy.test.ts` — the shared ladder case by case (fresh pass, failing evidence wins, stale vs
  missing, entrypoint/integration row evidence, blocking finding, and major-in-strict-mode only), plus the two former
  divergence cases asserted in both directions: obligations fail only when the caller supplies them, and mixed
  revisions fail only when the caller refuses them. The last test drives `judge()` over the same case table and asserts
  its verdicts equal the shared evaluator's, which is what will fail if the two ever drift again.
- Full suite: 457 tests in 49 files, all passing; `tsc --noEmit` clean; `dist/cli.js` rebuilt.
