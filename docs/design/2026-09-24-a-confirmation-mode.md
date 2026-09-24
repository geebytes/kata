# A confirmation mode, so a repair is confirmed rather than re-reviewed

## The measurement that asks for it

`repair-by-another-author` has run four recorded review rounds and two that produced nothing. The findings by round, and **what each
was about**:

| round | findings | what they were about |
|---|---|---|
| 1 | 7 | **three of them: my acceptance checks do not test their own criteria** |
| 2 | 6 | mostly round 1's repairs |
| 3 | 5 | f1 my sort, f2 my AC-2, f4 my doc, f5 my dead code |
| 4 | 5 | **f1/f2/f3/f4: the content binding I had shipped an hour earlier, each call site forgetting a different half** |

**Every round's findings are about the previous round's repairs, and none is about the change's original code.** And that is not a
mystery: `R(n+1) = review(repair(R(n), findings(n)))`, the repair is mine, and my blind spot is what the round exists to find — so each
repair is *new code*, handed to a round framed as *"find defects in this"*.

## Why real practice does not spiral, in four parts

- **a round reviews a frozen diff** — a bounded artefact, not a surface that grows with each repair;
- **the reviewer keeps its memory across rounds**, so a repair is recognised rather than rediscovered;
- **findings carry coordinates** — closed or not closed is mechanically checkable;
- **a round ends on "no blocking finding"**, not on "every finding disposed" — and this line's route to a repair is
  `deployment → revoked → repair`, whose own text says *"they must be repaired"*, so the terminal condition is unreachable while any
  major finding exists.

This line inverts all four, and two of the four are the reason for the spiral rather than a fact of nature.

## The mechanism that is already half-built

| piece | what it already does |
|---|---|
| `falsifier` on every finding | defines what "the repair worked" means: a check that reddens under the defect |
| `kata-cli falsify` | **runs** the three steps and records the observed exit codes — green, red, green |
| `obligationIsAnswered` | a finding-shaped obligation does **not** close on passing evidence; it needs a reddening or a recorded absence |
| `scope change` + `scope apply` | a changed declaration is a recorded decision, not a silent drift |
| `verify` | deterministic checks, and it converges — four verify runs on this line each ended in one definite action |

**Confirmation already exists and costs zero tokens** (it runs locally). What is missing is a brief that *asks for it* instead of
asking for a full re-review of the repairs.

## The design: `mode: 'confirmation'`

`resolveBriefMode` currently returns `cold` or `verify`. The `verify` case is chosen when an open blocking or major finding exists,
and its framing is *"this round checks the repair rather than opening a new search"* — **which is the right intent expressed as the
wrong instrument**: the round still receives the whole change surface and the whole repair diff, so it searches.

A third mode, selected when **the only open findings are ones this change repaired since the last recorded round**, renders:

1. **The findings, one per line, with their `falsifier` and their `impact`** — and nothing else about the change. The round's question
   is *"has each of these been shown to redden, and does the recorded reddening answer the finding it claims?"*
2. **The recorded reddenings and absences verbatim** (from the ledger), so the round can check the proof rather than reconstruct it.
3. **No reading set, no delta path list, no hypothesis requirement** — because those exist to make a *search* fair, and there is no
   search here.
4. **A required output of one of three verdicts per finding**: `confirmed` (the recorded reddening reddens under the finding's defect),
   `not-confirmed` with what it observed instead, or `cannot-tell` with what it would need. **A new finding is allowed but must be
   about the repair's claim**, not about the change at large.

And it must be **selected by the tool, not by me**, or it is a habit rather than a mechanism: the condition is
`every open blocking/major finding has a recorded reddening or absence` — which is exactly the state `obligationIsAnswered` already
computes, so the mode's trigger and the closure rule read the same fact.

## What this is not

- **Not "stop reviewing"**: a round that has never been run still opens cold and searches the whole surface.
- **Not a lighter check**: the confirmation round cannot pass anything the ledger does not already carry; it can only fail it.
- **Not free of new findings**: a falsifier that does not redden, an absence without a reason, and a reddening recorded against an
  outgrown declaration are all findings this mode is specifically aimed at — and those are *classes*, printed per finding.

## The honest cost

A confirmation round is smaller than a search round but **not zero** — it reads the ledger, re-runs checks, and reasons. The measured
search rounds on this line cost 350K–875K tokens each; the target is one order below, and **the first confirmation round's cost is
itself the measurement** that says whether the design worked. If it lands at the search rounds' cost, the mode is decorative and the
honest response is to delete it rather than keep it for the name.
