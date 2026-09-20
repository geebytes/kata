# An unresolved obligation blocked the run whose evidence would resolve it

The seal refused on an unresolved repair obligation **before** the checks; the only path that ever resolves one ran
**after** them. So an unresolved obligation stopped the run that would have produced the evidence answering it, and
neither `build --seal` nor `verify` could get past it — `verify` failing the criterion with `unresolved_repair_obligation`.

It went unnoticed because the preflight's obligation check returned early for a task with no `acceptanceMatrix`. Removing
that early return (necessary in `major-finding-closure`, because closure resolves from the task's acceptance ids and the
revision's evidence rather than needing a matrix) made the deadlock reachable on the default task shape that `/kata-open`
produces. No test had ever sealed a task carrying an unresolved obligation; both existing obligation tests call the
resolver directly.

The fix keeps resolution where it belongs — after the checks, reading the evidence the repair produced — and lets the
preflight deny only what the run *cannot* answer. Both sides consult **one** function, `obligationIsAnswered`, so they
cannot drift into a seal that passes while leaving an obligation open.

## What the implementation and the review pass turned up

Four more members of the same family, each repaired with a test of the shape that exposed it. Two were the very failure
mode the change exists to prevent:

| what | how it showed | state |
|---|---|---|
| closure ran **before** resolution | every batch's first successful seal refused on `answered: []` — one run late, swallowed by `.catch(() => null)` | repaired |
| closure did not mark its answered findings `fixed` | a closed batch still read as unrepaired to the round framing, which went on saying "an open major finding is unrepaired" | repaired |
| `TrackedFinding.source` was ambiguous | the bare node name made an adversarial `review` finding and a `review.json` finding indistinguishable, so a write hit the wrong record and failed on a file the task does not have | repaired |
| the dry run counted a **deferred** check | a frozen-tier check is planned but produces no evidence, so the preflight called an obligation answerable and the seal passed while it stayed open — measured: planned verdict `true` against the same rule over what that plan produces, `false` | repaired |
| `adversarial record` opened a batch but created no obligation | a finding arriving in the verdict had nothing that could ever answer it | repaired |

The fourth is the one worth dwelling on: the review pass attacked the change's own claim ("the two cannot drift") rather
than reading its diff, and found the claim false through the mechanism built to make it true. It is also the only finding
of the round, and it was repaired in the round that found it.

Verified end to end on the case that surfaced the deadlock: `check-log-artifact-missing`'s held-open batch closed, with
both findings named as answered once their obligations resolved.

Suite: 909 passed, 0 failed.
