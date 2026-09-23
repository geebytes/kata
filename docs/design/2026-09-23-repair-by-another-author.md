# A repair is made by someone other than the author it corrects

## Why this change exists, stated as the measurement that produced it

`closure-gate` was reviewed five times. Its own record of what happened:

| round | findings | admitted by the gate | about the previous round's repairs |
|---|---|---|---|
| 1 | 7 (1 blocking) | no | — |
| 2 | none (658K tokens, empty final message) | no | — |
| 3 | 5 | no | 3 |
| 4 | 5 | no | **5** |
| 5 | 2 | no | 2 |

Nineteen findings, zero admitted records, and every round's findings about the previous round's repairs. Alongside them, the
mechanism built in that change caught **seven decorative checks written by its author** — four when `kata-cli falsify` refused a
repair whose check did not redden, three by mutation and the independent rounds.

So the conclusion is not "the change had bugs". It is:

> **A change whose subject is "a mechanism that does not do what it says" cannot be finished by the author who produces that
> class at roughly one per repair.** The author cannot see their own blind spot, and each repair adds surface for the next round
> to find the same class in.

This change acts on that instead of being a sixth round.

## The three acceptance criteria, and what each one can honestly deliver

### AC-1 — the repair records whose work it is, and the criterion refuses a self-repair

**What is checkable on one machine, and what is not.** Independence cannot be *proven* here: two agent sessions on one
workstation are not separated by anything cryptographic, and this line has already recorded that ceiling for the execution
receipt ("host-authored, measured and bound; a receipt forgeable on a single-user machine is out of scope"). So AC-1 asks for
the two things that *are* checkable:

1. **The repair carries provenance** — which session ran it, recorded by the tool that ran it rather than typed in, exactly as
   telemetry is measured rather than filled in.
2. **The closure criterion refuses when that provenance is the same as the change author's.** A repair cannot close an
   obligation while the record says the person who owed the repair also made it.

The second is the part that bites, and it is falsifiable: seed a repair with the author's provenance and the obligation must
stay open.

### AC-2 — a repair's disposition follows the rule the falsifier mechanism already established

A repair is finished when its check has been **shown reddening**, or when a **recorded absence with a reason** says why no check
can be. This is `closure-gate`'s rule and this change must not restate it in its own words — **it must consume the same
function**, or there are two derivations of "the repair is done" and this line has spent a whole change on that class.

### AC-3 — the loop's cost is reported, because it is currently invisible

**This is the criterion the five-round table above would have been produced by.** Today the only way to know how many review
rounds a change has had is to list `.kata/tasks/<id>/adversarial-briefs/` by hand, and nothing relates a round's findings to the
previous round's repairs. So:

- a change reports its **round count** per node;
- it reports, for the latest round, **how many findings are about artifacts the previous round changed**;
- and it reports the ratio, because that number is what says whether a change is converging.

**It is mechanical** — the briefs, the findings and the change records all exist — and it is the only one of the three that
cannot be argued with, because it counts rather than judges.

## What this change must not become

- **Not a sixth review round for `closure-gate`.** The findings routed here are the class, not the instances; repairing the
  three majors individually is what the five rounds already showed does not converge.
- **Not a claim of proven independence.** If the design says "the repair was independent" it has reproduced the defect: the
  record can say *which session* and *that it differs*, and the ceiling is stated rather than hidden.
- **Not a restatement of the falsifier rule.** AC-2 consumes it. A second copy of "what counts as done" is the class.

## Open question for the design phase

**Who is "the author" for AC-1's comparison?** The candidates are the handoff record's `platform`/`role` (already persisted, and
already how the review gate names who is running), or a new field on the revision. The first reuses an existing mechanism, which
this line prefers; the second invents a store, which is another place declaration and reality can diverge. I lean to the first
and will check what the handoff actually records before deciding.

## The open question, answered by reading the record: `platform` cannot distinguish two sessions

Checked rather than assumed. A handoff and its receipt carry exactly:

```
protocolVersion, taskId, handoffId, platform, role, packetSha256, acknowledgedAt, repository, contextMemo
```

and `platform` is `"pi"` — **the host platform, identical for every session on this machine** — while nothing in `src/` records
a session identity at all, which is deliberate: kata does not configure, route or record host models (AGENTS.md #4). So the
first candidate is out:

> **The comparison AC-1 wanted cannot be made from recorded identity.** Two sessions on one workstation are the same
> `platform`, the same `role` and the same repository, and a handoff is acknowledged by whoever runs the command rather than by
> an identity the record could compare.

**So AC-1 is reframed to make the difference structural rather than declared** — which is the same move this line made for the
review round, and for the same reason:

> **The repair is made by a session the platform constructs** — a fresh context and a declared tool set, the `kata-reviewer`
> shape one step further: an agent type that may write, but only inside a scratch copy of the change, and whose own report and
> what it was handed are both recorded.

**And the ceiling is stated rather than hidden**, exactly as it is for the execution receipt: on a single-user machine this
proves *which session did the work and what it was given*, not that two sessions are cryptographically separate. What it does
make impossible is the shape this change exists to remove — **a repair whose record cannot say who made it, closing an
obligation owed by the person who made it.**

The second candidate (a new field on the revision) is rejected for the reason this line keeps giving: **a new store is another
place declaration and reality can diverge**, and the existing mechanism plus a structural construction covers what the new field
would have claimed to.

## The real-data measurement, as evidence rather than as a test

```
$ kata-cli rounds --change closure-gate
rounds: 4 | findings per round: 7, 5, 5, 2 | targets about the previous round: 28 | share: 0.85
```

That is the number the change exists to produce: `closure-gate`'s convergence ratio, which until now could only be reached by
listing a directory and reading five records by hand.

**And it is recorded here rather than asserted in the suite, because of what the seal found**: the case that asserted it passed
in the working tree and exited 1 under the seal — the seal runs a check against the sealed content, and another change's runtime
data under `.kata/` is not part of it. **A test that only passes where its author's other changes happen to be is not a test**,
which is the same defect as a check that cannot fail, one step over: a check that can only pass. The suite keeps the fixture case
and this is the measurement.

## The review round: seven findings, and the one that matters most is about this change's own behaviour

Cost **351,864 tokens / 72 tool uses / 15.6 minutes** — the cheapest round on this line, and it returned a record. The gate
refused it as `incomplete` (a criterion not covered), the same reason all five of `closure-gate`'s records were refused.

| finding | what it says |
|---|---|
| `rba-f1` major | **`reportRounds` reports a number that is not what it claims** — the count treats targets as findings, which is the unit mistake I made and only half-fixed |
| `rba-f2` major | **`unrecorded` does not do what its docstring says** — a field claiming more than it delivers |
| `rba-f3` major | **AC-2's declared check does not test AC-2** — it reads three files as text and asserts strings |
| `rba-f4` major | **AC-1's provenance record has no producer and no consumer in the tool** — `recordRepairAuthor` and `readRepairAuthors` are called by nothing but tests |
| `rba-f5` minor | the evidence kept in place of the deleted real-data test is not the command's output |
| `rba-f6` minor | **the sealed matrix binds each criterion to the wrong module** |
| `rba-f7` minor | **the new report reads the adversarial records unvalidated, with corruption swallowed into absence** — "the defect this line fixed twice" |

**And the finding that is about this change's behaviour rather than its code:**

> **This change exists to make the repair author someone other than the author of the artifact. Its own repairs were made by its
> author.** It built the entry point (`.pi/agents/kata-implementer.md`), the ledger and the criterion, and then used none of them
> on itself — which is `rba-f4`'s class ("a mechanism with no consumer") raised to the level of the whole change.

That is the honest answer to the question this change was opened to test. **Building the mechanism for cause ③ does not remove
cause ③; using it does** — and the use is the next round, not this one.

**What it confirms about the loop**, from the retrospective written while this round ran: the class regenerated exactly as
predicted — four of seven findings are this change's own mechanisms not doing what they say — and the round cost a third of
`closure-gate`'s because its brief carried no history. **The cheap round is the first one; the expensive rounds are the ones
that carry their predecessors.**

## The first real use of this change's mechanism, and it produced nothing

Dispatched `kata-implementer` with `isolation: worktree` to repair the seven findings — the first time the repair author this
change exists for was actually used. What happened:

| | |
|---|---|
| duration | ~19 minutes |
| output | 1,435,479 bytes of investigation |
| **changes made** | **none** — its worktree was clean at the base commit |
| **output file** | **removed, with no completion notification** |
| **worktree** | **left behind**, still registered in `git worktree list` |

**The isolation half worked, and it is structural rather than instructed**: `isolation: worktree` really gave it its own git
worktree, so "write only inside a scratch copy" was true by construction. **The other half did not exist.** There was no way for
it to report, no way for a dispatch to receive a report, and nothing that noticed it had ended — which is `rba-f4` ("a mechanism
with no producer and no consumer") demonstrated on the mechanism itself, the same day the finding was filed.

**So this round does not test the change's hypothesis.** The hypothesis is that a different repair author regenerates the class
less; the first use produced no repair at all, so there is nothing to compare. What it does test is the mechanism, and the
mechanism's first step is missing: **a repair author with a scratch copy, an investigation, no output, and no consumer.**

### What that changes

`kata-cli repair-author record|list` is built from this (`rba-f4`'s repair): `record` writes what a repair author returns —
session, what it was handed, what it reported — and `list` reads it back with `allHaveAuthors`, the question a reader asks. Tested
behaviourally rather than by asserting strings, which is the shape `rba-f3` named.

**And it is not enough on its own.** The missing piece is the orchestration around the author: a dispatch that hands it the
findings and the falsifier each needs, receives the report, records it, and **knows when the job ended**. Today that last part is
absent — the job's output file disappeared and no notification arrived, and the only reason this document can describe it is that
I went looking at the filesystem.

**Stated rather than tidied**: this change built the entry point, the ledger and the criterion for a repair author, and its own
seven findings were repaired by its author, because the first attempt to use the mechanism produced nothing and nothing was there
to notice.
