# Four rounds that wrote nothing, and three different causes

The record-less class was named from three instances and fixed by giving the output a second channel (the transcript) plus a reader
for it (`salvageRecord`, `kata-cli adversarial salvage`). A fourth instance arrived immediately, and its cause is not the one the
first three shared — which is worth writing down, because the fix addresses the shape and only one of the causes.

| round | cost | last message | record | cause |
|---|---|---|---|---|
| — | 658,523 tokens | *"Let me settle three decisive facts in one batch"* | none | ran out of budget mid-confirmation |
| — | 874,572 tokens / 34 min | *"Now the decisive final checks…"* | none | ran out of budget mid-confirmation |
| R8 | 509,018 tokens / 119 min | **a complete record** | **salvaged** | none — the record was in the transcript and the reader could not parse JSONL |
| R9 | 691,564 tokens / 50 min | *"I need to resolve a critical ambiguity…"* | none | **the author's own stale scratch file** |

## R9's cause: `tmp/_brief.txt`

Its final sentence names it: *"the packet's brief (line 25) begins `Task: repair-by-another-author`, but `tmp/_brief.txt` is for a
different task."* That file was a brief I had written to `/tmp` on 23 September at 14:32 for an earlier round, and it was still in the
workspace. `tmp/` is gitignored, so it never appeared in a revision, a change surface, or a delta — and the reviewer, whose tools are
`read/grep/find/ls`, found it by looking at the disk and spent its last turns on an ambiguity I created.

**So this instance of the class has a different fix.** The first three were a required output with one unguaranteed channel; this one
is **a workspace that carries material from another round, indistinguishable to a reader from material of this one**. The brief cannot
fix it — it cannot enumerate what is on disk — and the reviewer cannot either, because it has no way to tell a scratch file from an
intended artefact. What fixes it is the author not leaving it there: 183 files, up to 107 KB each, accumulated across a day of rounds
in the one directory the project designates for scratch.

Cleaned: everything under `tmp/` except the packet for the round in flight and the current repair batch, which the round is
explicitly given a path to.

## What this says about the class, and about the fix already made

The fifth class's fix — a second channel for a required output — **works**: R8's record was recovered from its transcript by
`kata-cli adversarial salvage`, after two defects in the recovery itself were found by using it on a real transcript (a JSONL record's
escaped quotes defeated the brace scan, and the brief's own history contains complete records of earlier rounds, so "the longest
record-shaped object" was the wrong one).

But a class is a sentence about a failure, and two different failures can share the sentence *"the round produced no record"* while
sharing nothing else. **R9 shows the class needs splitting**: *the output had no second channel* (fixed) versus *the input was
contaminated by material the author left behind* (a hygiene rule, not a mechanism). The termination condition counts classes, and a
class that names two causes will keep a round open for the wrong one.
