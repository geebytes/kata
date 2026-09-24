# The guard that cannot see drift

## What happened

`kata-gate-surface` has five open obligations and I recorded five dispositions for them — two `falsify` runs (both measured
`{before: 0, mutated: 1, after: 0}`, so the checks really redden) and three absences. The verdict did not move: `answeredBy: None` for
all five, and the seal would refuse.

Measured cause, and it is a sum of three separate defects:

```
revision-5ba4f845 (sealed 2026-09-23T06:29)  19 path digests, 11 of them drifted from the working tree
the ledger's record  (written 2026-09-24T18:10)  path digests = the working tree at that moment
                                                          e.g. src/quality/finding-disposition.ts
                                                               ledger 291e4daa5c1a  ← current content
                                                               revision a176c56ce1aa ← sealed content
```

So the disposition is bound to content the revision does not describe, and the criterion correctly refuses it.

## The three defects

**1. I recorded dispositions onto a revision sealed a day earlier.** The ordering constraint this line already recorded is *freeze
content → record dispositions → seal immediately*, and I broke it: `falsify` took the current sealed revision as its binding while the
files had moved on. That part is my operational error.

**2. The guard that exists to catch exactly this cannot see it.** `falsify` is supposed to refuse when the working tree is not what the
current revision describes — that was the fix for an earlier round's deadlock, and its message names the paths that differ. It did not
fire, because `falsifierProofSurface` computes the drift by comparing the *sealed* digests against the workspace over **the task's
current `ownedPaths` declaration**, and `closure-gate`'s sibling measured the same thing from the other side (`rba7-f5`, `rba7-f6`: the
two doors read two declarations of one quantity). Measured here: `revision.pathDigests` has 19 entries and 11 differ from the
workspace; the guard reported no drift. **The drift it can see is "a declared path the revision carried", and 11 of the 19 are exactly
that — so the comparison itself is not being made on the path set it names.**

**3. And the class this change exists to remove is present in the fix meant to remove it.** Two doors read "the surface a proof is
about": the reddening door and the absence door. They now share `falsifierProofSurface` — which is what `rba7-f5/f6` asked for — but
that function reads the *task's* declaration while the criterion compares against the *revision's* `pathDigests`, so a shared helper
hands both doors a surface the verdict does not measure against.

## What is not in doubt

The two `falsify` runs did what they claim: each ran the check green, reintroduced the defect, saw it redden, restored, and saw it green
again — `{before: 0, mutated: 1, after: 0}` recorded for both, and the restore left the tree clean. The three absences carry reasons
that state which kind of state they describe (a fact supplied to a predicate with nothing pinning it; a fix that does not exist in the
tree; a check whose fixture cannot reach the term it names). So the *work* is done and the *binding* is wrong, which is a different
sentence from the findings' own.

## The fix's shape, not yet applied

The disposition should bind the content it proved **by comparing the revision's own `pathDigests` to the workspace** — that is the
question "does the revision I am bound to still describe what I proved?", and it needs no declaration. Where a revision carries no
digests, the comparison cannot be made and the answer must be *not proven* rather than *bound*, which is the same fail-closed shape as
everything else on this line. And the guard's refusal must be reachable: a drift it cannot see is a drift it cannot refuse, and it
refused nothing while 11 of 19 paths had changed.
