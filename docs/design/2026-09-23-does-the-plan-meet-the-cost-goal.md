# Does this meet "cost down without review quality down"? Three of six, and not the dominant term

The goal, from `docs/verfify.md`: **minimise(tokens, latency) subject to criticalRecall ≥ baseline and falsePassRate ≤
baseline.** So a proposal counts only if it lowers cost *and* leaves the finding-rate intact — and the honest way to check is
against the cost equation rather than against a list of ideas.

## The equation, as measured

```
total ≈ Σ_turns input(turn) ≈ turns² × per-turn growth
```

86 turns, 9.85M input tokens, 205K final context, **replay factor 48×**, `cacheRead: 0` on every turn. **The brief is 3–6% of one
turn** — so anything that makes the brief shorter or better saves ~1%, and anything that reduces turns saves quadratically.

## The six proposals, scored against both halves

| proposal | cost | quality | verdict |
|---|---|---|---|
| **Mechanical gates before the first round** | **0 tokens** | removes the mechanical class from the paid pass, freeing it for the semantic class | **✅ both** |
| **Impact radius in the finding** | ~0.1% of a turn | the fixer does not re-derive what the fix will touch — 11 fixtures broke on one repair, found only by running the suite | **✅ both** |
| **Delta path reachable** | **measured 2.5–2.7× cheaper per round** (657,892 vs ~1,762,000 tokens) | equal-or-better: a closed batch's repair is exactly what needs reviewing, and the original is already reviewed once | **✅ both** |
| **Round budget** | caps the tail | **a round that would have found a blocking finding is skipped** | **⚠ trade, not a free win** |
| **Ask for optimality** | brief growth | **unverifiable prose** — the fourth question's own answer | **❌ neither** |
| **Repair by another author** | **+1 dispatch per repair** (the failed attempt cost 725K tokens for nothing) | **untested** — the one attempt produced no repair | **❓ unknown** |

## What that adds up to, in numbers rather than adjectives

**Three of six satisfy both halves, and only one has a measured effect: the delta path at 2.5–2.7×.** The mechanical gates are
free and their effect is real but different in kind — they do not make a round cheaper, they make the round spend its budget on
the class that needs judgement. **The impact radius is honest and cheap and moves the number by ~0.1%.**

**And none of the six touches the dominant term.** The cost is turns × accumulated context, and the two levers that attack it are:

- **fewer turns per hypothesis** — the measured 2.5–2.7×, which is the delta/hypothesis-scoped effect and the only big number on
  this line that is not an estimate;
- **less accumulated context per turn** — the externalised fact ledger, built and **unmeasured**.

**Prefix caching — the third lever, and the one that would remove the 48× replay — is measured impossible at this endpoint**:
two byte-identical requests with an 18,445-token prefix both returned `cacheRead: 0`. That is a supplier fact, not a code change.

## So: does the preceding discussion meet the requirement?

**Partially, and the honest version is narrower than the discussion sounded.**

- **Met by three proposals**, with **one measured at 2.5–2.7×** and two that improve quality per token without moving the total
  much.
- **Not met by the round budget**, which buys cost with a real quality risk and should be described that way rather than as a
  fix.
- **Not met by asking for optimality**, which the fourth question itself showed produces prose nobody can check.
- **Untested for the repair author**, whose first use produced no repair because I emptied its worktree while it ran.

**And the ceiling to state plainly**: a realistic target from what is actually measured is **2–3× cheaper per round with quality
equal or better** — not the 20× once estimated from the turns² term alone, which assumed turns per hypothesis would fall, and
they did not (10 per hypothesis, before and after).

**The requirement is therefore satisfiable, but not by this list.** It is satisfied by the two levers that attack the dominant
term, and of those only one is measured — which is the same conclusion this line reached before: **measure the lever, then build
it, not the other way round.**
