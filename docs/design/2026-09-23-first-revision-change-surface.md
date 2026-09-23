# The change surface of a first revision, and why the gate cannot bound it

Status: **open — measured, not fixed.** Found by an independent adversarial pass on `wiring-coverage-check` (finding
`wcc-f8`), then reproduced live while trying to conclude that change's own review.

## What happens

A task's **first** revision has no base. Two places then treat "no base" as "the whole revision changed":

| # | Site | Code |
|---|---|---|
| 1 | `src/quality/change-record.ts:204` | `diffPathDigests(input.baseContentDigests ?? {}, contentDigests)` — diffing against `{}` is not a diff, it is the identity, so every path in `contentDigests` is reported as *added* |
| 2 | `src/quality/adversarial.ts:2427` | when the sealed surface is empty, `changeSurface` falls back to `Object.keys(revision.pathDigests)` — the whole revision again |

Measured on `wiring-coverage-check`'s sealed revision: `changedPaths` **669**, `changedOutsideOwnership` **658**, against a
brief that names **11** paths.

## Why it blocks

The gate builds its review remit from that field (`sealedSurface = sealedRecord.changedPaths`) and
`evaluateAdmissibility` refuses when any remit path is not claimed by a hypothesis's `targets`.

> A pass that reviews exactly the paths the brief named **cannot be admitted**: admission requires claiming 658 paths it
> never examined.

Observed twice: the recorded pass on this revision reports `satisfied: false, reason: incomplete`, and the message shown
was — until `9575d23` — "carries no falsification attempt", naming a cause that has nothing to do with the failing
conjunct. A record with ten attempts and seven discharged hypotheses was refused with that sentence.

## Why the obvious fix is not safe

Attempted and reverted: stop diffing when there is no base (`fromRevision = []`, surface falls back to git), with a
`surfaceBasis: 'content-diff' | 'git'` field so "no base to diff" and "nothing changed" stay distinguishable.

Unit level: green. Full suite: **9 e2e failures**, e.g. `workflow-resume.test.ts > rejects approval that would reuse review
findings from another revision`, which stopped reaching its own assertion because the adversarial gate now refused first.

The lesson is the coupling, not the failure:

> `changedPaths` → `sealedSurface` → the **coverage conjunct**. This field is not a record of a number; it is a decision
> input for the gate. Narrowing it flips the predicate and the gate then **refuses records that are legitimate**.

The comment above site 1 already warns about the opposite direction ("a record whose purpose is to stop a round's surface
being *understated* reported that nothing had changed"). The field has two failure directions, and the attempted fix traded
one for the other.

## The question that has to be answered first

**What is the change surface of a first revision?**

There is no content-based answer: a first revision's content identity *is* the tree. So the surface must come from
somewhere else, and each source has a distinct failure mode:

| Option | Surface | Failure mode |
|---|---|---|
| i | git only (`changedGitPaths`) | a round that committed before sealing reports an empty surface → the coverage conjunct becomes vacuous → **the gate gets weaker**, and silently |
| ii | the paths the brief declared | the remit becomes self-declared → not falsifiable, which is the whole point of AC-2 of `adversarial-admissibility` |
| iii | `ownedPaths ∪ brief paths`, refusing when empty | most conservative; the first revision's scope is decided by declaration rather than content identity — weaker than (ii) claims to be, stronger than (i) |

A fourth possibility is not a surface at all: **fail closed and say so** — "the change surface of a first revision cannot be
derived; declare it or seal a second revision". Honest, and it would have blocked this change's review rather than admitting
it against 658 unexamined paths.

## Regression net, ready

The 9 e2e cases that failed on the attempt are the net for this work: `tests/e2e/workflow-resume.test.ts` (5),
`tests/e2e/wiki-distillation.test.ts` (1) and the remainder in the same run. **Read what they assert before changing the
surface** — one of them was asserting a message that a different refusal had displaced, which is how the misreporting in
site 2 became visible at all.

## Both sites must move together

Changing site 1 alone is what produced the 9 failures: the fallback at site 2 immediately re-created the whole-revision
remit whenever git reported nothing. A fix that touches one and not the other either does nothing or flips the gate.

## What the regression net actually asserts (read before relying on it)

Checked after writing the section above, and it changes how the net can be used: **the 9 e2e cases assert messages and
phase transitions, not the surface.** A grep for `changedPaths`, `changedOutsideOwnership` or `surfaceBasis` in
`tests/e2e/workflow-resume.test.ts` returns nothing.

So they tell you *that* a flow changed, never *which* conjunct moved. The one that failed most legibly was
`rejects approval that would reuse review findings from another revision`: it expects `same sealed revision` and received
the adversarial gate's refusal instead, i.e. **a different check fired first** — the surface had changed the predicate's
outcome and displaced the assertion the test was written for.

That also means the failed attempt did not prove "a smaller remit makes the gate refuse legitimate records". It proved
something narrower and worth keeping: **an empty surface routes into the site-2 fallback**, so a fix at site 1 alone can
leave the effective remit unchanged *and* change the code path, which is enough to move a flow without moving the number.

Consequence for the next attempt: **f9 is what makes it diagnosable.** Before `9575d23` the refusal said "carries no
falsification attempt" regardless of the conjunct, so an attempt could not tell coverage from discharge from grounding. Now
it names the failing conjunct and carries the predicate's `detail` — so the first step of the next attempt is to re-apply
the site-1 change, run one failing fixture, and **read the reason it now prints** instead of inferring it.
