# The review record answers a request

**Change:** `the-review-record-answers-a-request`
**Status:** approved design
**Reported by:** the `zenmpai` change `photo-observation-provider-layer`, which could not record its second independent round.

## 1. The measured deadlock

The reported chain, run step by step in that checkout:

```
kata-cli verify …                       success: true  phase: review      (the gate is recreated)
kata-cli gate approve …                 {"approved":true}
kata-cli review --confirm-host-model    success: true  phase: review      (re-entry)
kata-cli review --result-file tmp/review-result-r11.json
  → success: false
    "A review result is already recorded for this revision. Re-enter review before recording a replacement."
```

**Re-entry changes nothing**, which is what makes the message's remedy unreachable. Read from the branch that is supposed to
provide it (`src/workflow/orchestrator.ts:1918-1944`), the enter step rewrites the record only when:

```ts
if (revisionId && !bindsToRevision(previous, recordBinding)) {  // ① the record is stale by content → archive, then placeholder
} else if (isReviewPlaceholder(previous)) {                     // ② it is already a placeholder → rewrite the placeholder
}                                                              // ③ otherwise: leave it exactly as it is
```

The reported record falls in ③: it **binds** the current revision (`revision-467e63b2ddec42b0`) and is **not** a placeholder
(`reviewRoute: 'adversarial'`, one minor finding). Verified against the live record after the successful re-entry: `review.json`
still carries the round's findings and `reviewRoute`, and `review-history.jsonl` gained no row. So the recorded result blocks a
replacement, and the action the refusal names does not clear it.

## 1b. The first draft of this design was wrong, and an existing guard said so

The first version fixed the deadlock at the re-entry layer: re-entering review would archive the recorded round to
`review-history.jsonl` and write the placeholder, so the remedy the refusal prints ("re-enter review") would clear the record.
Implementing it turned two existing cases red —

```
tests/unit/review-cli-io.test.ts:390
  never rewrites a recorded empty round back into a placeholder when review is re-entered
  "The recorded round must survive: a placeholder rewrite would erase the declaration."
```

— and the comment above them records why they exist (F-3): the *result* face had been tightened to "a placeholder is not a
result" while the *write* face still tested `findings` is empty, so re-entering over a legitimately empty result silently
replaced it and the `--result-file` guard then allowed a second round over a record that was already recorded. The decision
they encode is deliberate: **a recorded round is never replaced by the act of re-entering.**

So the re-entry layer is not where this defect lives, and the refusal's remedy sentence was simply out of date. The fix belongs
at the recording layer, which is what AC-2 does: the record now says **which request it answered**, and a record that answered a
different one does not block the answer to this one. Measured against the reported chain, that alone releases it — the second
round's request had a changed subject (the claims had been restated), so it can be recorded without re-entering anything.

AC-1 was re-stated to pin the deliberate decision instead of contradicting it, and the change's contract was re-opened to carry
the corrected statement (the record had no revision, no ledger and no review record yet, so nothing was discarded).

## 1c. The review round refuted the first fix: the subject is content-addressed

The independent round (`review.json`, R1-F1 blocking) reproduced the reported case against the **real** freeze chain and showed
that `subjectRevision` cannot carry the question at all:

```
freezeSubject → restateClaim (statement changed) → freeze
  subject before = rev:758a09916721daa8
  subject after  = rev:758a09916721daa8      ← unchanged, while the question changed
  second --result-file → refused, "already recorded ... for the same request"
```

`subjectRevision` is `rev:<digest of the frozen path digests>` (`src/kernel/subject.ts`), so it answers "which content", never
"which question". The AC-2 guard could not see this because its fixture **hand-writes `subject.json`** with a revision
inconsistent with its own `pathDigests`, bypassing the freeze chain — the same "a check that cannot fail" class this repository
keeps finding. R1-F4 is the same defect one layer down: an evidence verdict compares `subjectRevision` too, so a restated claim
keeps its old evidence and still reads `supported` (`restateClaim` only increments `reopens`, which staleness never reads).

**Chosen direction (user decision, option 1): the subject identity covers the question, not only the content.** Concretely:

1. `freezeSubject` computes the revision over the declared paths **and** the claim set as declared at that moment (each claim's
   id, statement and dependencies), so a restatement produces a different subject.
2. Staleness is judged against the subject **as declared now**, not the frozen copy: the frozen one says what was asked, the
   recomputed one says what is asked, and a difference is exactly "the question moved".
3. Consequences accepted: every existing ledger whose claims were restated after its freeze will read stale and must be
   re-verified; the review record's release path (R1-F3) and the refusal message (R1-F2) are fixed in the same pass, and
   `review-history.jsonl` gets the superseded conclusion before it is replaced.
4. R1-F5/R1-F6 (judge and verify records carry no question binding; the approval path writes `subjectRevision` with no reader)
   are the same family and are carried by the same mechanism once the identity exists; they are fixed or recorded here rather
   than left as an implicit gap.

## 2. Why the record cannot tell the two rounds apart

A record's binding is content identity only — measured on the record itself, its fields are `revisionId`, `manifestHash`,
`codeManifestHash`, `governanceManifestHash`, `candidateFreezeSha256`, `findings`, `status`, `reviewRoute`. The ledger's
subject — the claim set and plan the request was built from — is **not** part of it. So when the request changes without the
code changing, the record still reads as "this revision has been reviewed", even though it answered a different question.

## 3. Decisions

1. **Re-entry is the human's explicit act of starting a new round, so it archives the old result rather than preserving it in
   place.** The enter branch gains the missing case: a record that binds the current revision is appended to
   `review-history.jsonl` (with its revision, findings, status and `archivedAt`) before the placeholder is written. The old
   conclusion is kept where history is kept; "a recorded result is never silently replaced" still holds, because nothing is
   lost and the archive names what was superseded.
2. **A record carries the subject it answered.** Both write paths (`:1527` for a recorded round, `:1845` for an approval) add
   `subjectRevision` from the ledger's frozen subject, and the "already recorded" test includes it: a record whose subject
   differs from the current one answered a *different* request and does not block recording the answer to this one. A record
   with no `subjectRevision` (written before this change) keeps today's behaviour — it blocks — because we cannot know what it
   answered, and pretending to know is how a stale result would pass as a current one.
3. **The refusal names a remedy that works where it fires.** With (1) the printed remedy becomes true; with (2) the common case
   (a changed request) no longer needs it. The message keeps naming the chain it actually requires.

## 4. Tests and falsifiers

| AC | Selector | Reversible falsifier |
| --- | --- | --- |
| AC-1 | `tests/unit/re-entering-review-archives-the-record.test.ts` | restore the two-branch condition (drop the new third case): the case driving re-entry over a record that binds the current revision must redden — no archive row, and the record still blocks the recording that follows |
| AC-2 | `tests/unit/the-record-answers-a-request.test.ts` | drop `subjectRevision` from the "already recorded" binding: the case recording a round for a changed subject must redden (it is refused again) |
| AC-3 | same file | restore the bare refusal message: the case asserting the message names the reachable chain must redden |

Each mutation is applied to a committed tree and restored byte-for-byte with the SHA checked; final verification runs the full
suite and `tsc --noEmit`.

## 5. Ownership

| Path | Also owned by |
| --- | --- |
| `src/workflow/orchestrator.ts` | `review-reentry-rebuilds-its-gate`, `change-lifecycle-reconciliation`, `task-records-outlive-the-worktree`, `unique-copies-is-one-model` — declared with `--allow-ownership-conflicts`, recorded as an audit fact |
| the two guards, this design | free |

## 6. Rejected alternatives

- **Refuse harder: keep the record and refuse forever.** That is the reported state, and it makes the second independent round
  impossible without hand-editing `.kata` — the unverified hand-written surface the review-record work exists to remove.
- **Let `--result-file` overwrite in place.** It removes the protection that a recorded result cannot be silently replaced, and
  the round that recorded it disappears with no trace.
- **Bind the record to the request only (no archive on re-entry).** It fixes the changed-request case and leaves the
  same-request case refusing with an unreachable remedy — the defect would survive for anyone who re-enters deliberately.

## 7. What this change does not do

It does not change what a round certifies, how findings are graded, or what a repair may be opened from. It does not retro-fit
`subjectRevision` onto records already written: those keep blocking, which is the fail-closed direction, and the remedy for
them is the re-entry this change makes work.
