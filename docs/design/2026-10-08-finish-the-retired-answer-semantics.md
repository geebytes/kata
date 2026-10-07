# Finish the retired answer semantics

**Change:** `finish-the-retired-answer-semantics`
**Status:** approved design
**Scope:** close the leftovers the archived change `bind-discovery-observations-to-questions` recorded but did not repair, because repairing them inside that change would have moved its sealed content and voided the two independent readings that satisfied its quorum.

## 1. Problem

`bind-discovery-observations-to-questions` retired the gate power of a `ProbeAnswer`: an answer is append-only audit history, it cannot increase either discovery count, cannot satisfy the non-standard discovery floor, and cannot create a review-request gap. Two independent reviewers confirmed that behaviour, and neither found a path from an answer to a decision.

Both rounds also reported four artifacts of the retirement, all below the blocking severities, and all recorded in that change's `review.json` rather than repaired:

| # | Where | What |
| --- | --- | --- |
| 1 | `tests/unit/discovery-floor-fail-closed.test.ts` — `still reads a legacy resolved challenge, so a pre-existing record is not silently demoted` | The case asserts only that two *other* refusal codes are absent. A legacy `resolved` record carries no `falsifierEvidenceId`, so it is not an attempt under the new projection and the decision raises `discovery_floor` — and a reader that silently **dropped** the record raises exactly the same codes. The two states are indistinguishable on the asserted subset, so the case cannot guard its own title. Its property is guarded elsewhere (`still reads a legacy record whose required fields are all present`), which makes this a redundant vacuous case rather than an unguarded property. |
| 2 | `src/cli/ledger.ts` — the `ledger ask` note | The user-visible string still ends `because one question answered twice is one reading`. An answer is no longer a reading anywhere else in this codebase, and no test asserts the string. |
| 3 | `src/store/review-request.ts` — `buildReviewRequest` | The request carries **every** stored probe, unfiltered by revision, and each entry drops `subjectRevision`. Measured: a request built at `rev:7ea2ab14145fe8c5` still handed the reviewer two questions stored against `rev:93208fecfaab9f0b`, and one of them expected a digest prefix the file no longer has — a question that cannot be answered truthfully. Advisory only (no gate reads a request's probes), but it asks a reviewer to do work that cannot succeed. |
| 4 | `src/store/ledger.ts` — the reporting counts | `probesAsked`/`probesAnswered`/`probeResponseRate` are the only answer-raised numbers left, and a reviewer reading them could mistake them for a discovery count. The comment beside the rate was already corrected to "**reporting only**" in `b356847`; what no surface does is prove it, and this change keeps the wording rather than renaming a report field (see §6). |

One dead export belongs to the same cleanup: `readProbeAnswers` (`src/store/ledger.ts:550`) has zero consumers — the state-returning `readProbeAnswersState` is the reader every caller uses.

## 2. Decisions

1. **A request asks about one revision.** `buildReviewRequest` keeps only the probes whose stored `subjectRevision` equals the revision the request names, and reports the rest in a `withheldProbes` list — present only when non-empty, the same shape as `unreadableArtefacts` — carrying each question's `id`, `claimId` and its `subjectRevision` (or `null` for a legacy record written before that field existed). Withholding is not deleting: the questions stay in `probes.json`, and `ledger ask`'s own rule ("only a question that is still current counts as already asked") already treats them as not-asked.
2. **A case must be able to fail.** The legacy-record case asserts the property its title names: that the record **is read**. It asserts the record is present in the ledger read and that the decision is a decision (not an unreadable refusal) while still refusing the floor — so a reader that drops records without a falsifier reddens it.
3. **The surfaces say what the code does.** The `ledger ask` note states the de-duplication ("a question already asked is not asked again"), not a reading; the reporting-count comment stops claiming the floor reads it; the dead export goes.

## 3. Behaviour

### 3.1 Request scope

```
probes:  only those with probe.subjectRevision === request.subjectRevision
withheldProbes?: [{ id, claimId, subjectRevision: string | null }]   // present only when non-empty
```

A ledger whose probes are all legacy therefore produces a request with no probes and a `withheldProbes` list that names each one — an honest "no current question" instead of an empty array that reads as "nothing was asked".

### 3.2 The legacy-record case

The fixture keeps writing the same legacy record. The case adds the assertions that distinguish *read* from *dropped*:

- the ledger read holds the record (`readLedger(...).challenges` contains it), and
- the decision is not an unreadable refusal, and
- the floor still refuses it, because a record that names no declared falsifier is not an attempt.

### 3.3 The surfaces

- `ledger ask`'s note: `... is not asked again, because one question answered twice is one question` — and the surrounding sentence already explains the refusal, so no behaviour claim changes.
- `src/store/ledger.ts`'s reporting-count comment: states that the rate is reporting-only and that the discovery floor reads the challenge projection, matching the note on `probe-answers.json` above it.
- `readProbeAnswers` is removed; `readProbeAnswersState` (its three-state twin, used by `ledger ask`/`answer`) is untouched.

## 4. Tests and falsifiers

| AC | Selector | Reversible falsifier (single site, in the file it guards) |
| --- | --- | --- |
| AC-1 | `tests/unit/review-request-is-handed-over.test.ts` | delete the `subjectRevision` filter in `buildReviewRequest` (carry every stored probe): the case asserting a stale question is withheld must redden |
| AC-2 | `tests/unit/discovery-floor-fail-closed.test.ts` | filter `readLedger`'s `challenges` to records carrying a `falsifierEvidenceId`: the legacy-record case must redden |
| AC-3 | `tests/unit/probe-answer-binding.test.ts` | restore the `one question answered twice is one reading` wording in the `ledger ask` note: the case asserting the emitted note does not call an answer a reading must redden |

Every mutation is applied to a committed tree and restored byte-for-byte, with the SHA checked. The final verification additionally runs the full suite and `tsc --noEmit`.

## 5. Ownership

All six code/test paths are shared with active changes, so the declaration is applied with `--allow-ownership-conflicts` and the conflicts are recorded as an audit fact rather than resolved by narrowing the repair:

| Path | Also owned by |
| --- | --- |
| `src/cli/ledger.ts`, `src/store/ledger.ts` | `harden-ledger-discovery-contract` (plan), `verdict-readings-per-run` (implement), `repair-discovery-floor-semantics` (intake) |
| `src/store/review-request.ts` | `harden-ledger-discovery-contract` (plan), `review-loop-verdict-unification` (hardVerify) |
| `tests/unit/discovery-floor-fail-closed.test.ts` | `harden-ledger-discovery-contract` (plan), `repair-discovery-floor-semantics` (intake) |
| `tests/unit/probe-answer-binding.test.ts` | `harden-ledger-discovery-contract` (plan) |
| `tests/unit/review-request-is-handed-over.test.ts` | — (this change only) |

Consequence, stated rather than discovered later: an edit by one of those changes to a shared path makes this change's revision `superseded`, and the reverse is true too.

## 6. Rejected alternatives

- **Renaming `probesAnswered`/`probeResponseRate`.** A report field is a contract with whoever reads `ledger status --cost`; renaming it to fix a comment is churn in a surface nothing depends on. The comment is corrected instead, and the names stay because "how many probes were answered" is what they count.
- **Asserting the note string verbatim.** A snapshot of prose reddens on every wording change and guards nothing about behaviour. The case asserts what must not appear — that the note does not call an answer a reading — plus that it still says the question is not asked again.
- **Filtering stale probes out of `probes.json`.** Deleting audit history to fix a request is the destructive version of the same repair, and `ledger ask` already re-asks a question whose revision has moved.
- **Repairing these inside `bind-discovery-observations-to-questions`.** That change was sealed and reviewed; a repair would have moved the content and voided both quorum readings. The items were recorded and are closed here instead.

## 7. What this change does not claim

It does not make a probe answer authenticated, does not add per-command attestation, and does not touch the host boundary (no extension, provider, session or model is read or written). It does not fix the caller-side `catch(() => null)` class — five record-reading call sites discard a reader's three-state answer — which is the subject of its own change. And it does not enable `noUnusedLocals` repository-wide (284 findings on this tree), which would move the owned paths of every active change.
