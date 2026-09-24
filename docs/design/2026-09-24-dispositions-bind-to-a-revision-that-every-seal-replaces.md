# The dispositions bind to a revision that every seal replaces

## What happened, measured

`repair-by-another-author` had six findings (`rba-f1`, `f2`, `f3`, `f4`, `f9`, `f11`), and their dispositions were recorded on
`revision-daf33fefeb9f0bff`. By the time the change reached `revision-f7ff9a5b1fb85fbb`, all six were stale and the seal refused
them. The correct response is the order I had recorded from `closure-gate`: **freeze content → run the falsifiers → seal
immediately.** I did that:

- the tree was clean and the revision matched;
- `rba-f1`, `rba-f2`, `rba-f4` each reddened under their own mutation and were recorded (`observed {before:0, mutated:1, after:0}`);
- `rba-f3`, `rba-f9`, `rba-f11` recorded absences, since each repair is a declaration rather than code;
- all six sat on `revision-f7ff9a5b1fb85fbb`, the current revision, having changed nothing.

**Then the seal minted `revision-becb49c9303042ca`, and all six were stale again.**

## And this is not an operator error

Not one byte of content changed between the two seals. `git status` was clean, the `falsify` guard — which refuses to record
anything when the working tree differs from the current sealed revision — passed both before and after, and the tree was clean
throughout.

So the two revisions have **identical content and different ids**. The seal includes `createdAt` in what it mints, and a second
seal's timestamp necessarily differs. **Therefore "freeze content → prove → seal" cannot be satisfied when the proof binds to
`revisionId`**, because the seal that would close the obligations is the seal that invalidates the proofs that let it close.

**And I had this conclusion before and withdrew it.** In `closure-gate` I compared two revisions with equal path sets and clean
trees, concluded the id was unstable, and then retracted it after finding that exactly one path digest differed — `nginx`-style, one
file genuinely changed, so the ids were correct and the real cause was that `falsify` bound the proof to the *last sealed revision*
rather than to the working tree. Both observations were right and they are about different things:

| conclusion | verdict |
|---|---|
| "one path digest differed, so the ids were correct" | ✅ true for that pair |
| **"but a seal with no content change still mints a different id"** | ✅ **true here — the same content, a different id** |

## Why it matters more than one change's obligation list

The consequence is that **a repair can never be shown to have closed its own obligation**, in the only order the tooling allows —
and it is not confined to this change: `closure-gate` is stopped in exactly the same place, with two obligations open and the same
revision churn behind them.

**So the ledger's binding is wrong, not the operator's procedure.** A disposition is a claim about *content*: the defect this
finding names was re-introduced and this check reddened. Content is what the revision's `contentDigests` already describe, and a
seal that changes nothing does not change them. So the binding should be to the content digests the disposition was recorded against,
not to the revision id that a later seal will replace — and "the content did not change, so the disposition still holds" is a
falsifiable criterion rather than a convenience:

- **records in the same content → the obligation closes** (today it does not);
- **records with different content → the obligation stays open** (today it also stays open, but for the wrong reason, and it cannot
  distinguish "you changed the code" from "you sealed twice");
- **a `falsify` run against content that no revision names → refused** (already true, and it must stay true).

`contentDigests` is already in the revision and the seal already computes it, so the change is a binding rather than a new
mechanism — the same shape as this line's other fixes, and the reason it belongs as its own governed change rather than a patch to
this one.
