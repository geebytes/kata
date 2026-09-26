# The fifth class: a required output with one unguaranteed channel

## The answer to the question the last round was dispatched to ask

I dispatched a review round asking *"is there a fifth class, or are the four closed?"* — and then answered it myself in one command:
all 22 findings on this change carry a `classInstances`, and every one names one of the four. **That was a question I could answer,
which is the first thing wrong with the dispatch** (`docs/design/2026-09-24-record-less-rounds.md`).

But the round's own failure supplied the answer it was looking for. **Three of six dispatched rounds produced no record at all**,
each ending with the same sentence (*"I already know the answer; let me confirm it"*), and one of those rounds had found a route the
design never enumerated — it survived only because I read four megabytes of transcript by hand.

**That sentence is not any of the four classes.** It is not one concept derived in two places, not a declaration read as reality, not
a check that cannot fail, and not a decision with two entrances. It is:

> **A required output whose only channel is the process reaching its natural end, so a process that ends early produces nothing.**

And the fix has the same shape as every other class's — **give the output a second channel**, exactly as the others were fixed by
giving a producer a consumer.

## What the four classes had in common, and where this one differs

| class | the defect | the fix's shape |
|---|---|---|
| one concept several derivations | one source of truth, several copies | one definition, consumers ask it |
| declaration claiming reality | a check reads a declaration, its message claims reality | read what you claim to have read, or say what you read |
| a check that cannot fail | an assertion green under both implementations | make it redden under the mutation |
| one decision several entrances | two entrances, one records | record it at every entrance, or make one entrance |
| **a required output, one channel** | **the output exists only if the process completes** | **a second channel, and a reader for it** |

Four of the five are about **how a mechanism is built**. The fifth is about **how a process is scheduled** — and that is why it was
not found by reading code, and why it took three failed rounds to become visible. It is a class of workflow defect rather than a class
of code defect, and the class table now holds it beside the others because the failure mode is the same: **a declaration (that the
record will arrive) whose reality is not guaranteed.**

## The fix, in two halves

**The second channel** is the transcript itself. A record emitted at any point in a round is still a record, so the brief now tells a
pass to **emit as soon as it has concluded its first hypothesis and keep working, refining later** — and `salvageRecord` reads the
**last** record back out of the transcript, not the final message. `kata-cli adversarial salvage --from <transcript>` turns "a human
read four megabytes by hand" into one command, and it was verified against the round that just failed: **no record in the
transcript**, which is a finding about the round rather than about the change, reported as such.

**And the reader is mechanical**, which is what makes it a fix rather than a hope: `salvageRecord` finds the last brace-balanced JSON
object carrying `hypotheses` and `findings`, handling strings that contain braces, and returns `null` rather than inventing a record
from prose. Two mutations redden it: returning the *first* record instead of the last (`expected … to contain 'SECOND'`), and
dropping the record-shape check (`expected { …(2) } to be null`).

## What this says about the loop, and about when it ends

The termination condition is *"every class an open terminal finding names is covered by a check"* — and its answer to "is the set
closed" was **no**, which is precisely why the question was worth asking even though I could answer the classification myself. A
closed-set claim is only as good as the attempt to falsify it, and the attempt found a fifth.

**So the honest state**, as of that round: five classes, five covering checks, one termination condition reading them — seven, as of the
addendum below. This change's own verdict is
`roundClosure` absent — it may close — but the round that produced the fifth class has no record, so **the round it belongs to is not
the round whose record the gate will accept.** That distinction is the whole reason the salvage channel exists.

---

## Addendum: the set grew to seven, and both additions came from the same source

That closing line — "five classes, five covering checks" — was written when it was true and is now a stale count, which makes it an instance
of the class this document is about: a number written in prose that nothing derives. The set is seven, and the two that followed the fifth were
not found by reading code either; they were **produced by a change**, which is a different route again from the one the fifth took.

- **The sixth, `a-definition-with-no-consumer`**: a declaration is written and nothing reads it. Five of the eleven findings of the first
  independent pass on the decoupled round protocol are that sentence — a schema bundled by nothing and registered with nothing, a field computed
  and never consulted, a refusal outside the vocabulary that renders it — and in each case the guard beside the declaration passed, because it
  asked whether the declaration was well formed rather than whether anything read it.
- **The seventh, `a-part-checked-as-the-whole`**: a guard inspects one field, member or direction of a concept and is read as a verdict on the
  concept. Its live instance was inside the fix for the sixth: the admission rule compared the artefact kata wrote, and the command never
  registered that artefact, so the comparison existed and could not be reached.

The route matters. The fifth came out of **a failed round** (three record-less rounds whose last sentence was always the same); the sixth came
out of **a pass's findings**; the seventh came out of **a finding about my repair of the sixth**. Three ways to find a class, and only the
second was a reviewer doing what a reviewer is dispatched to do — which is the honest reason `roundClosure` asks whether a class is covered
rather than whether a round found anything.
