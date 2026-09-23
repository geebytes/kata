# Four questions about the review rounds, answered with the numbers

Asked after `closure-gate`'s five rounds and `repair-by-another-author`'s first. Each answer is a measurement rather than an
impression, and two of the four are no.

## 1. Did the review scope converge? **No — it grew.**

The briefs, by round, in characters:

| round | brief | mode | carried |
|---|---|---|---|
| 1 | 19,729 | cold | nothing |
| 2 | 23,426 | verify | round 1's findings |
| 3 | 29,789 | verify | rounds 1–2 |
| 4 | 28,634 | cold | — |
| 5 | 37,018 | verify | rounds 1–4 |

**Nearly double, and for one reason: each brief carries its predecessors' findings and dispositions.** That is what the
`Findings by class` section is for — the brief must not re-report a finding the next round should not re-derive — and it means
the reviewed *artifact* shrinks while the reviewed *brief* grows.

**And the mechanism that was supposed to narrow it never engaged.** A delta round reviews only what a closed repair batch
changed; every round of `closure-gate` reported `no repair batch has closed, so there is nothing to narrow against`. So the
answer is not "the scope converged slowly" — it is **"the scope grew, and the narrowing mechanism was never reached"**.

## 2. Did a later round re-review the previous round's content? **Yes — 85%, and of the repairs rather than the original.**

`kata-cli rounds --change closure-gate` reports:

```
rounds: 4 | findings per round: 7, 5, 5, 2 | targets about the previous round: 28 | share: 0.85
```

and by hand: **round 4's five findings were all about round 3's repairs**; round 3's three majors were about round 2's.

**So the rounds do not duplicate each other on the original content — they chase the repairs.** That is worse than duplication
in one way and better in another: the original code is reviewed once and then never again, while each round's repair becomes the
next round's material. **A change is reviewed for what it just broke, not for what it originally did.**

## 3. Does each finding come with a solution and constraints? **A constraint, and deliberately not a solution.**

The brief's `## Required result` now requires each finding to carry a **falsifier** — the check that must redden under the
defect it names. That is a constraint: it tells the fixer how the repair will be judged.

**It does not carry a solution, and that was a decision rather than an omission**: the pass's value comes from having a different
objective function than the author, and asking it to design the fix would make it a second author — the very blind spot the round
exists to escape. A recipe is also unfalsifiable, while a falsifier is red or not.

**The cost of that decision is now measurable, and it is the turns.** Every round re-derives the mechanism the previous round
already understood, because the understanding died with the pass that had it. `closure-gate`'s rounds cost 347K–658K tokens, and
the brief is 3–6% of one turn — **the money is in re-reading, not in reading the brief.**

## 4. Does the solution consider its impact radius, and is it optimal? **No — and nothing asks.**

Two separate gaps, and the second is the sharper one:

- **A finding carries no impact radius.** It names a defect and a falsifier; it does not say what else the fix will touch. The
  cost is on record: repairing `cg-f1` (the preflight not reading the ledger) broke eleven fixtures across six files, and I
  discovered that only by running the suite.
- **Nothing asks whether a repair is the best available one.** The rule is "make it redden, then green", which accepts the first
  change that satisfies it. A cheaper or narrower fix, or one that removes the class rather than the instance, is neither
  requested nor rewarded.

**And the honest note on the first gap**: an impact radius is an **observation**, not a design. A pass that has just read the
call sites *knows* what the fix will touch, and recording that does not make it the fix's author — which is the objection that
keeps a solution out of the finding. **So the impact radius belongs in the finding and the solution does not**, and that
distinction is the answer to this question rather than a compromise on it.

## What the four answers add up to

**A finding is a report, not a change proposal** — defect, falsifier, and (missing) impact radius, with the solution left to the
fixer. That is coherent, and it prices the loop in exactly the place the loop is expensive: **the fixer re-derives what the
reporter knew, and the next round finds whatever the re-derivation got wrong.**

Three things follow, in order of what they cost to do:

1. **Add the impact radius to the finding** — it is an observation the pass already has, it is falsifiable (the suite either
   breaks where it said or it does not), and it addresses the measured cause of the fixtures that broke.
2. **Make the delta path reachable** — the scope grew because the narrowing never engaged, and `closure-gate`'s rounds each
   re-read a surface a closed batch would have narrowed.
3. **Ask for optimality explicitly, and accept "this is the first thing that works" as an answer** — a rule that never asks
   cannot be said to have considered it, but demanding a proof of optimality would produce prose nobody can check.

## The delta path's verification moves to a clean instance, and why

Chosen: **not** to rebuild `closure-gate`'s batch chain. Its gap was created before the fix and has propagated two
generations (`batch-10` carried out of `batch-9` with no base, `batch-11` inheriting it), so verifying the delta there would mean
either editing history or re-anchoring a chain that exists only as a record of what happened.

**The clean instance is `repair-by-another-author`, and it already has what is needed:**

```
batch-1 | OPEN | base revision-daf33fefeb9f0bff | findings rba-f1, rba-f2, rba-f3, rba-f4
```

**A first batch, created by its seal, with the base.** The chain is unbroken because it has no carries yet.

### And the precondition the attempt made explicit

A delta exists when the batch a later round reads as the last *closed* one has a base that differs from the current revision —
and a batch only closes at a seal, and a seal only proceeds when the obligations are answered. So:

> **The delta path is reachable only after a change's findings are repaired and its batch closes. It is a reward for
> convergence, not a shortcut around it.**

That is the right design and it is worth stating, because it means the 2.5–2.7× cannot be collected on a change that has not
done its repairs — which is exactly what the five rounds of `closure-gate` were: a change whose findings were never closed.

**So the next step for the lever is not a measurement but a repair**: `repair-by-another-author`'s four major findings, then its
seal, then the brief that should come back a delta. And the measurement to take is the brief's `mode` and the round's token cost
against the three cold rounds on this line (351K, 382K, 468K).
