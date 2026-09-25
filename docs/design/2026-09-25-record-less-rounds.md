# Rounds that produced no record: eight measurements

**Eight of the twenty-five dispatched rounds on this line have produced no record** — and four of them are the four rounds of one change. This document is the conclusion rather than another
dispatch, because the data has been stable across the last three and one hypothesis has been disproved at each stage.

## The measurements

| round | change | tokens | tool uses | minutes | how it ended |
|---|---|---|---|---|---|
| R5 | kata-gate-surface | 874,572 | 141 | 34.7 | budget exhausted inside a confirmation step |
| R6 | kata-gate-surface | 658,523 | 85 | 17.0 | no record; last line was proving a claim |
| R9 | repair-by-another-author | 429,434 | 47 | 8.0 | `stop` — nothing left to say |
| R10 | wiring-coverage-check | 408,722 | 61 | 12.0 | `stop` — "to claim the full remit honestly" |
| R11 | kata-gate-surface | 725,626 | 211 | 35.0 | `stop` — **its worktree was destroyed mid-run, by me** |
| R13 | repair-by-another-author | 486,185 | 68 | 19.0 | `stop` — "since I must cover every path" |
| R4 | review-record-integrity | 1,220,349 | 165 | 50.0 | `stop` — "verify a few claims before writing the record" |
| R5 | review-record-integrity | 437,283 | 48 | 10.0 | `stop` — "verify the headline evidence with targeted greps" |
| **total** | | **5,240,694** | **826** | **≈186** | |

## What is disproved

**It is not the budget.** R9 stopped at 47 tool uses of 215 and R10 at 61 of 215. Failed rounds span 47–165 tool uses (median 76.5);
successful rounds span 64–125 (median 68). **The two distributions overlap completely.** `R11` used 211 and `review-record-integrity`'s
round 4 used 165 — more than any successful round — and both produced nothing.

**It is not the remit size**, as one round earlier suggested: `kata-gate-surface` round 8 reviewed 73 delta paths and produced a
7-finding record in 119 minutes, while `wiring-coverage-check` round 10 stopped on 47 paths.

**It is not the citation guard**, which was over-refusing for several of these rounds and is now a declaration check — `R13` and
`R10` both ran before the fix, but `R11` ran after it and still stopped.

**And it is not the pass's behaviour being different.** Every one of the eight ended with `stopReason: stop` and no error, and five of
the eight ended immediately after a sentence of the same shape: *the last thing I have to do is verify something before writing*. The
record is the pass's only required output, it is the last thing it does, and the pass stops before it.

## What is left, and it is not a claim I can act on

The single common fact is **the pass ending its own turn with no error and budget to spare**, after announcing the step it was about to
take. That is a property of the host — the platform's agent loop and the model's stopping behaviour — not of the brief, the guard or
the budget. Nothing in this repository can change it, and no eighth dispatch will test it: the last three rounds were dispatched with
the two hypotheses already disproved and with the brief's instruction moved to the first paragraph, and the outcome was unchanged.

## What can be acted on, and what has been

1. **The second channel exists and works.** `kata-cli adversarial salvage` reads a transcript, matches the brief identity, validates
   with the platform's own reader, and correctly reported `none` for the three rounds that genuinely wrote nothing. It recovered
   `kata-gate-surface` round 8's complete record — including two defects in the salvage code itself, found only by running it on a
   real transcript.
2. **The brief instructs an early record, and it is not enough** — a sentence is not a mechanism, and this document says so rather
   than repeating it in the next dispatch.
3. **A run that produces no record is still visible**: `kata-cli rounds` reports `unrecorded: true` (and the brief renders it) by comparing issued briefs against recorded
   rounds, so a change cannot silently appear to have had fewer rounds than it did.

## The one that was mine

`R11`'s cause is recorded here separately because it is a different fact: I inferred that the job had ended from a missing output file
and deleted its worktree while it was still working, after 35 minutes. Its changes were recovered from the git worktree, and the
lesson — *a job that has not reported is a job in an unknown state, and unknown is not finished* — is the same one the falsification
mechanism enforces one layer down.

## One change produced no record in **every** round, and that is its subject

`review-record-integrity` has had **four** dispatched rounds and **none** produced a record. Its brief is not different: it carries
the same early-record instruction (measured — the sentence is in the packet), the same three declaration requirements, and a *smaller*
packet than the changes whose rounds succeeded (32 KB / 388 lines against 46 KB / 434). Its review mode is `strict`, which requires
more, not less.

What is different is the subject. **This change is about what a record must contain** — the change record, the delta derived from git,
the record-integrity rules. A pass whose subject is the record is a pass that, before writing its own, goes to verify the record's
claims once more; four rounds ended on that sentence, the last one after ten minutes and forty-eight tool calls with most of its budget
untouched.

That is a hypothesis with one measurement behind it and it is **not** offered as a mechanism: the honest statement is that the change
whose subject is the record has produced a record in zero of four attempts, and that every one of them stopped immediately after
announcing a verification step — the same ending the four other record-less rounds have.
