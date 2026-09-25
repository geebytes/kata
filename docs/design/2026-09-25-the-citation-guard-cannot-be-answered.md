# The citation guard cannot be answered by the world

## The question it asks, and the four ways I tried to answer it

`evaluateAdversarialGate` refuses a record that cites a test path which is neither declared nor permitted, on the theory that *a test
the pass wrote is the shape of authorship*. The question is therefore **"did this pass write the test it cites?"** — and I have now
answered it four times, each time wrongly in the other direction:

| # | The predicate | What it does | Measured instance |
|---|---|---|---|
| 1 | `existing.includes(path)` — admit what is on disk | **Admits everything a pass wrote**, because a written test is on disk by definition | — |
| 2 | `!existing.includes(path)` — admit what is not on disk | **Refuses everything a pass read**, because reading a file does not remove it | round 8 of `kata-gate-surface`: refused for citing a test it had read |
| 3 | `sealedRevisionTestSelectors` — admit what the seal carried | **Refuses a pass that cites another change's test**, which is ordinary and honest | round 5 of `wiring-coverage-check`: refused for citing three tests it read and wrote none of |
| 4 | `mtime <= sealedAt` — admit what existed when the revision was sealed | **Refuses the same three**, because the author had edited them since the seal | measured: `class-invariants.test.ts` mtime 01:32, `record-salvage.test.ts` 05:00, `repair-briefing.test.ts` 05:02, against a seal at 16:57 the previous day |

The fourth was my own attempt at a *direct* fact rather than a proxy, and its failure is the interesting one — though the doc's summary sentence overstates the set: form #1 did not *refuse* honest records, it admitted everything, and the summary that says all four `refused honest records in a different direction` is corrected here (`kgsr8-f6`): **the timestamps are
late because I edited those files today.** A test a pass read has a fresh mtime whenever its author has touched it since the seal, so
"when did this file appear" is not a fact about the pass either.

## Why every form fails

**Because the guard infers the honesty of a record from the state of the world, and every state it can read moves.** The file's
existence, its content, its modification time and the sealed revision's digest all change for reasons that have nothing to do with the
pass — and the honest pass and the authoring pass are indistinguishable in all of them, because the difference is *who created the
file*, which no read of the file can show.

The shape is the one this line already has a name for: **a check whose subject is an event, answered by reading a declaration.** The
declaration here is the filesystem, and it is a live one.

## The form that could work, not yet built

**A pass declares which tests it wrote, and the guard checks the declaration against the citations** — a self-consistency check rather
than an inference about the world:

```
"wroteTests": ["tests/unit/some-new.test.ts"]   // required, and may be empty
cited ⊆ declared ∪ permitted ∪ wroteTests        // otherwise refused
```

Two properties make that better than the four above. It is **decidable** — no clock, no disk, no seal, just two lists the record
already holds. And it is **honest about its ceiling**: a pass could omit a test it wrote, exactly as it could misreport
`executedInFreshContext` or forge an execution receipt, and this line has already accepted that ceiling for both of those ("host-authored,
measured and bound; a receipt forgeable on a single-user machine is out of scope"). What the check buys is that the *record*
contradicts itself when it cites a test it does not list — which is a real inconsistency, and the one a reader can see.

## What to do meanwhile

**Stop flipping the predicate.** Four attempts is enough to establish that no fifth proxy will work, and each attempt has cost a round:
rounds 8, 9 and 12 of one change and round 5 of another were each refused by a form of this guard. The current form is the fourth
(mtime), it fails closed when it cannot tell, and it refuses honest records — which is worse for the loop than admitting a written
test, because a refused record costs a whole round and an admitted one costs nothing that a reviewer would not have caught anyway.

The honest state is recorded here and in the class table rather than patched further, and the fifth form belongs to its own change.
