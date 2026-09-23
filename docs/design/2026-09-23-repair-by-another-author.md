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
