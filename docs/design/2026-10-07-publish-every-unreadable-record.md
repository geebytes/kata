# Publish every unreadable record

`publish-every-unreadable-record` · isolation `current_worktree` · development `tdd` · review `strict`

## 1. Why

The predecessor change (`harden-ledger-discovery-contract-v2`, merged as `c871a29`) closed the class *an absence and an
unreadable file must not be representable by the same value anywhere a decision or a report reads it* for the ledger, the
review record and the sealed pointer. Its eleventh independent round found the same class in the one reader it had not
covered: the status summary's own file reader.

`src/workflow/navigation.ts:762-767`:

```ts
async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}
```

Every error — ENOENT, a parse failure, a permission error, a directory where a file was expected — becomes `null`. Ten call
sites read through it: the evidence files (`:199`, `:777`), `review.json` (`:217-218`), `judge.json` (`:286-287`),
`verify.json` (`:290-291`) and `task.json` (`:294`). A corrupt one of those is therefore indistinguishable from a missing one
at every surface that publishes it.

Three consequences were measured, not inferred:

| # | shape | what happens |
| --- | --- | --- |
| 1 | `current-revision.json` corrupt **and** no `review.json` | `currentRevisionUnreadable` is published and the route is `repair_unreadable_current_revision` (2300) — correct — while `reviewFindings` is `0`, because the refusal list is `blockingRead.ok ? blockingRead.openProblems : unreadableProblems` and the blocking reader succeeded on the empty record. Reproduced by round 11 (`expected 0 to be >= 1`) and by this change's own probe. |
| 2 | `judge.json` or `verify.json` corrupt | read as absent: `judgeResult` / `verifyResult` are simply unset, and no refusal is published anywhere. |
| 3 | the pointer **and** `review-rounds.jsonl` corrupt | `assessReviewLoop` returns one `kind`, so one of the two refusals is published and the other is not. |

## 2. Boundary — what this change does **not** take

Measured before scoping, because the class is wider than the summary:

- `readValidatedOptional` (`src/core/schema.ts:332-340`) is **already** three-state-correct: it answers `null` only for
  `ENOENT` and re-throws everything else. The schema-validating path needs no repair.
- The remaining instances are **caller-side**: 42 `.catch(() => null|undefined)` sites in `src/`, of which five read records
  (`src/wiki/provenance-gate.ts:37`, `src/quality/change-record.ts:327`, `src/quality/review-ir.ts:273`,
  `src/workflow/verdict-binding.ts:106`, `src/workflow/revision.ts:110`). Those are a different shape — a *correct* reader
  whose signal the caller discards — and each needs its own decision about what the caller should do instead (refuse?
  publish? throw?). They are **out of scope** and named as the successor `unreadable-is-not-absent-in-every-caller`.

This change closes the class only where the reader itself cannot tell, which is the one place a fix at the reader is the
right fix.

## 3. Mechanism

### 3.1 One three-state reader

New `src/core/record-read.ts`:

```ts
export type RecordRead<T> =
  | { kind: 'absent' }
  | { kind: 'usable'; value: T }
  | { kind: 'unreadable'; detail: string };

export async function readRecordState<T>(path: string): Promise<RecordRead<T>>;
```

`ENOENT` is `absent`; every other failure — parse, read, or a non-object where a record was expected — is `unreadable` with
a detail that names the file. This is the vocabulary the family already uses (`ArtefactRead`, `CurrentRevisionRead`,
`InitiativeReadState`), so no new concept is introduced.

The reader therefore accepts an optional semantic shape guard. A parsed object is only `usable` after that guard accepts it; a
nested value a consumer will immediately dereference (for example `judge.json.acceptance`) is part of the record's shape,
not an unchecked payload. This keeps a parseable but malformed record from escaping the reader and crashing a later
consumer instead of becoming a named refusal.

### 3.2 The summary publishes each one

`navigation.ts` drops its local `readJsonFile` and reads through `readRecordState`. Each unreadable record is published
under its own name, in the same shape the predecessor established for the ledger and the record:

| artefact | status field | problem id |
| --- | --- | --- |
| sealed pointer | `currentRevisionUnreadable` | `current_revision_unreadable` |
| review record | `reviewRecordUnreadable` | `review_record_unreadable` |
| evidence ledger | `ledgerUnreadable` | `ledger_unreadable` |
| `judge.json` | `judgeUnreadable` | `judge_unreadable` |
| `verify.json` | `verifyUnreadable` | `verify_unreadable` |
| `task.json` | `taskUnreadable` | `task_unreadable` |
| an evidence file | `evidenceUnreadable` (the file named in the detail) | `evidence_unreadable` |
| review-round history | `reviewHistoryUnreadable` (existing) | — (existing field) |

Absence stays what it is: a record nobody wrote publishes nothing and routes exactly as it does today.

### 3.3 The refusal list is a union

```ts
const openProblems = [...(blockingRead.ok ? blockingRead.openProblems : []), ...unreadableProblems];
```

The blocking reader refuses on the first artefact it cannot read, so deriving the published problems from its single
`source` — or, as today, from whether it succeeded at all — leaves the others unnamed. The facts are independent and all of
them are read here, so none can stand in for another (AC-1).

### 3.4 Both refusals when both are unreadable

`assessReviewLoop` stays single-valued: it answers the *route*, and the ladder's existing precedence is the answer (the
pointer's 2300 outranks the round history's 2290, because a change whose content identity cannot be read cannot be repaired
by rewriting its round log). What changes is that the **published** facts come from their own reads rather than from the
assessment's single `kind`:

- `currentRevisionUnreadable` from `sealedRead` (already independent),
- `reviewHistoryUnreadable` from the round-history read itself.

AC-3 is satisfied in this sense: both refusals are published, and the round-history route is not removed — it still routes
2290 in its own state, and is *outranked* rather than suppressed when the pointer is also unreadable. The design records
that precedence explicitly so the AC is not read as a claim about which route wins.
Each unreadable fact also gets its own problem in the published list (`round_history_unreadable` beside `current_revision_unreadable`),
because the count is what the ladder reads: publishing two fields with a count of one would say an operator has one file to
repair when they have two.

**`src/quality/repair.ts` is declared in this change's surface and was not modified.** The design expected the single-value
assessment to need a change; it did not, because the facts are read from their own sources and the assessment keeps its one
job (answering the route). The path stays declared because the design named it, and a declared path that was not touched is a
fact this record states rather than a file the next reader has to check.

## 4. Acceptance and how each one is falsified

Each row has its own selector, so no two acceptance criteria can collapse into one check.

| AC | selector | the mutation that must redden it |
| --- | --- | --- |
| AC-1 union | `tests/unit/workflow-navigation.test.ts` | restore `blockingRead.ok ? blockingRead.openProblems : unreadableProblems` |
| AC-2 three-state reads | `tests/unit/summary-publishes-every-unreadable-record.test.ts` (new) | bypass the acceptance-record semantic guard, so a parseable nested-shape error reaches `.filter()` instead of publishing unreadable |
| AC-3 both refusals | `tests/unit/both-refusals-are-published.test.ts` (new) | derive `reviewHistoryUnreadable` from the assessment's `kind` again |
| AC-4 absence and routes | `tests/unit/summary-carries-its-read.test.ts` | publish a refusal for a record that is merely missing |

`tests/unit/workflow-navigation.test.ts` already carries the four refusal cases from the predecessor (isolated ledger,
isolated record, isolated pointer, both-broken) and gains the pointer-without-record case.

**Measured after commit `cfb21e6`** — each mutation applied to the committed source, its own selector run, the file restored
and its SHA-256 re-checked, then the selector re-run:

| mutation | mutated selector | reddened | restored byte-identical | baseline green |
| --- | --- | --- | --- | --- |
| M1 AC-1 union | `workflow-navigation.test.ts` | yes (exit 1) | yes | yes |
| M2 AC-2 parse-error-as-absent | `summary-publishes-every-unreadable-record.test.ts` | yes (exit 1) | yes | yes |
| M3 AC-3 history-from-assessment | `both-refusals-are-published.test.ts` | yes (exit 1) | yes | yes |
| M4 AC-4 absence-as-refusal | `summary-carries-its-read.test.ts` | yes (exit 1) | yes | yes |

Full suite at that commit: 267 files / 1614 tests; `tsc --noEmit` clean.

## 5. Verification notes

- The whole suite and `tsc --noEmit` must pass; the summary's existing routing behaviour is pinned by
  `tests/unit/summary-carries-its-read.test.ts` and `tests/unit/review-approval-refuses-open-findings.test.ts`, both of which
  must stay green without edits.
- The new reader's `absent` branch is what keeps AC-4 honest: a missing `judge.json` in a change that has not been judged
  must not publish a refusal, or every task in `review` would carry one.
- No consumer of the new fields routes on them; the routes stay where they are (`reviewRecordUnreadable` → review,
  `ledger.state` → ledger, the loop assessment → pointer/round history). The new fields exist so an operator is told which
  file to repair.

## 6. Precedents and lessons

- The predecessor's eleventh round is the source of this change, and its lesson is the sequencing rule this one follows:
  when a round names a class, close the class in one pass, because every partial repair costs a full independent round.
- `readValidatedOptional` is the precedent for the reader's contract: only `ENOENT` is absent. It is cited rather than
  re-derived.
- The predecessor also established the naming convention (`<artefact>Unreadable` + `<artefact>_unreadable`) that this change
  extends to the remaining artefacts of the summary.
