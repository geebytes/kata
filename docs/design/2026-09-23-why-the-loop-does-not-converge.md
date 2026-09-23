# Why verify → repair → verify repeats, and which part of it is the methodology's fault

Written after `closure-gate` (five rounds, 19 findings, zero admitted records), `wiring-coverage-check` (three rounds, 27
findings), `kata-gate-surface` (two rounds, 16), `adversarial-admissibility` (two passes, 13), and the round now running on
`repair-by-another-author`. The question is whether the repetition is the methodology failing or the work being shaped the way it
is. **It is both, in different places, and the distinction matters because only one of them is fixable by more discipline.**

## Four causes, separated by what would remove them

### 1. The loop is structural, and it is a trade the methodology never wrote down

A repair changes content. The revision id is content-derived, so the change moves to a new revision. A review record is bound to
a revision, so the record becomes `stale_revision` and **the next round is mandatory** — that is what independence costs, and it
is correct: a review of content that no longer exists concludes nothing.

So the shape is `R(n+1) = repair(R(n), findings(n))`, with no fixed point by construction. **And nothing bounds it**: `rg
"maxRounds|roundLimit|roundCount" src/` returns nothing, and the only record of how many rounds a change has had is a directory
listing — until `kata-cli rounds` was built today.

**Compare verify.** Verify is a deterministic check over finite artifacts, and it converges: each of the two verify failures on
`closure-gate` ended with exactly one deterministic action, not with another round. **So the honest statement is not "kata loops"
— it is "kata puts independence ahead of termination, and never said so or bounded it".** That is a methodology gap.

### 2. This particular class regenerates, and that is the work, not the method

The class is *a mechanism that does not do what it says*. Every change on this line **builds mechanisms**, so every change
produces the class it exists to remove: round 3's findings were about round 2's repairs, round 4's about round 3's, and the
mechanism itself caught **seven decorative checks** written by their author.

That is not a kata defect. **It is what verifying verification looks like**, and the evidence that the machinery works is that it
found them: 19 + 27 + 16 + 13 findings, most of them this class, none of them invented.

### 3. The author cannot see their own blind spot — and the methodology was built assuming they can

Every repair on this line was made by the author of the artifact, and the independent round exists precisely because that author
cannot see it. So the loop's *input* — the repair — is produced by the process's weakest link, and the next round spends a
million tokens rediscovering it. **`repair-by-another-author` is the fix for this and it is the only one of the four that
changes the loop's shape rather than its cost.**

### 4. There is no terminal state other than "erase"

Measured: `findings defer` and `findings accept` refuse `blocking` and `major` ("they must be repaired"), and `adversarial waive`
**overwrites the node record as `findings: []`** — so the exits were *repair* and *erase*, and erasing is not resolving.
`findings rout` was built today to add the missing third exit. **This is a methodology gap, and it was the direct cause of
`closure-gate`'s inability to close: its findings could be neither repaired (outside its ownership) nor erased (that would
destroy the evidence) nor routed (no such command).**

## What the methodology does not have, stated as four missing bounds

| missing | consequence measured |
|---|---|
| a round budget with an explicit outcome | five rounds on one change, no termination condition |
| a routed terminal disposition | repair or erase, nothing between (half-built today) |
| a round-cost report | the loop's cost was invisible (built today: `kata-cli rounds`) |
| mechanical gates before the expensive pass | four of six findings in one round were catchable by mutation at **zero tokens** |

## And one thing that is not the methodology's fault at all

**The earlier optimization line failed for a reason that is mine, not kata's**: cost was never a metric that could fail. The
change had six acceptance criteria and **none mentioned cost**, so it could not fail for failing to reduce cost — only for the
mechanism not being wired, which is what it kept fixing. A goal with no criterion that can fail does not move, and that is a
planning error I made, not a property of the framework.

## The verdict

**The methodology is not broken; it is unbounded in three places and blind in one.** Independence is bought with rounds and kata
never prices them; a repair can only be repaired or erased; the loop's cost is not reported; and the repair is written by the
author the round exists to check. Three of those four are now built or half-built, and the fourth —
`repair-by-another-author` — is the one that changes what a round is for.

**What to stop doing**: running the expensive instrument five times on one change. The mechanical gates are free, they catch the
same class, and they should run **before** the first round rather than after the fifth.
