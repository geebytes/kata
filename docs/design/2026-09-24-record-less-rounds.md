# Rounds that investigate to the end and write nothing

## The pattern, with three instances

Six review rounds have been dispatched on this line with a written brief. **Three produced no record at all**, and their final assistant message is the same sentence shape each time:

| round | cost | final message | record |
|---|---|---|---|
| — (`065d429a`) | 658,523 tokens | *"Let me settle three decisive facts in one batch: …"* | none |
| — (`487565dd` → the 874K round) | 874,572 tokens / 34 min | *"Now the decisive final checks — the record-write guards, the write path …"* | none |
| R8 (`3ec1bab2`) | 1.9M bytes of output so far | *"I've found the likely core defect. Let me confirm it precisely with a batch of reads."* | none so far |

**The shape is: "I already know the answer; let me confirm it."** In round 5 the confirmation was the last thing it did, and the answer — which turned out to be a *fourth route* the design had not enumerated — survived only because I read 4 MB of output by hand rather than trusting the absence of a record.

## Why this is a design defect rather than reviewer sloppiness

The brief asks for three things a thorough reviewer naturally satisfies last:

1. **every path under review claimed by a hypothesis's `targets`** — the coverage requirement;
2. **`falsifier`, `impact` and `classInstances` on every finding** — the field requirements;
3. **a complete JSON record as the final message** — and the reviewer has **no shell**, so nothing can be persisted on its behalf.

A pass that investigates until its budget ends satisfies 1 and 2 and loses 3, and **losing 3 loses 1 and 2 with it**: the coverage, the fields and the findings all die with the message. So the design rewards the wrong order, and it rewards it three times out of six.

The mitigation in the current brief is a sentence — *"a record that lands is worth more than an investigation that does not"* — and three rounds show that a sentence is not a mechanism.

## What the mechanism would be, and what it costs

**A `kata-reviewer` with `write` for one path — its own record.** It cannot author the artefact under review (that is the review contract and it holds), and the record slot is not the artefact: it is the pass's own statement. `adversarial note` already exists for exactly this and is unreachable for the same reason (it needs a command).

The cheaper half, available today: **the orchestrator appends whatever the last assistant message contained when a round ends with no record.** Half a record — the findings it managed to write — is worth more than the whole investigation, because the investigation cannot be read by anything but me.

## And what I should have asked

The question R8 carried — *"is there a fifth class?"* — **I answered myself in one command**: all 22 findings on this change carry a `classInstances`, and every one names one of the four. A dispatch is worth its cost when its question is not mechanically answerable by the dispatcher; this one was. Round 5's question (adjudicating a genuine tension between two defensible positions) was not, and it earned its 874K by finding a route I had missed.
