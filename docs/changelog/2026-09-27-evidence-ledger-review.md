# Review decided by evidence: the round-shaped route is gone

**2026-09-27 · changes `round-protocol`, `adversarial-admissibility`, `review-record-integrity` + the settlement that followed**

## What changed for an operator

**Eight commands are gone.** Each now exits 1 with `unknown command`:

```
kata-cli adversarial  brief | record | note | finding | finding add | status | waive | execute | salvage | version | path
kata-cli findings     list | defer | accept | carry
kata-cli matrix       …            kata-cli falsify    …
kata-cli lane         …            kata-cli rounds     …
kata-cli repair-author | repair-briefing | repair-scope
```

They drove the round-shaped route: one review *round* produced one document (`adversarial-review.json`), kata judged it
with a citation guard and an admissibility conjunction, and a repair batch carried the findings. What replaces them is the
evidence ledger:

```bash
kata-cli ledger freeze   --change <id> --path src/a.ts --path docs/spec.md
kata-cli ledger claim    add --change <id> --id C1 --statement "..." --severity major --risk-class consistency --depends-on path:src/a.ts
kata-cli ledger evidence add --change <id> --id E1 --type executable_falsifier --claim C1 \
    --command "grep -q holds src/a.ts" --mutation-file src/a.ts --find holds --replace broken
kata-cli ledger evidence verify --change <id>        # runs it: before / mutated / after
kata-cli ledger decide   --change <id>               # pass | fail | insufficient, with reasons
kata-cli ledger status   --change <id> --cost
```

The full surface is `freeze · claim · evidence · plan · focus · ask · answer · challenge · decide · status · run ·
request-check · policy · usage · corpus · verifier · detectability · baseline`.

## Why, in one paragraph

A round's product was a *document about a review*, and most of the machinery existed to police that document: a citation
guard, a record-integrity protocol, a disposition alphabet, repair batching, replacement chains, salvage, and a
fresh-context attestation nobody could check. Measured costs of that shape on this line: 28 of 62 dispatched rounds
produced no record at all; a certification bound to a revision was destroyed by the repair that was the reason for
reviewing (15 of 23 findings in four rounds were about the previous hour's fixes); and two changes sat a full day behind a
host-capability receipt that the party being judged had to write about itself. A ledger of claims, evidence **that a
verifier re-executed**, and a decision derived from them by a pure function has no room for a document about a review.

## What is kept, and why

| kept | reason |
|---|---|
| `pathDigests` content addressing and the `lane` drift computation | a verdict must not outlive its content; measured to the minute |
| the falsifier shape `{before, mutated, after}` | a check that cannot be reddened is not evidence — caught 11 always-green checks in one day at zero token cost |
| the "every check can fail" discipline, per check | it caught its own instances, including one inside the change that landed it |
| the severity threshold deciding evidence strength | accepting 23 minor/nit findings in one batch rather than repairing each saved 23 revisions |
| the numeric deadline carried in the request | with one: 6/6 rounds produced records in 3.4–7.7 min; without: 28 of 62 produced none |
| the seven defect classes as vocabulary | 5 of 7 have a live check; the table says which |

## What is retired rather than deleted

The six schemas the old records were written against (`adversarial-review`, `repair-obligations`, `repair-batch`,
`repair-authors`, `falsifier-reddenings`, `round-events`) are removed from the registry and no longer installed. The
records themselves — eleven archived changes' `adversarial-review.json`, `repair-*.json`, briefs, and 42 MB of history in
`.kata/evidence/superseded/` — are **read-only history**: git reads them, `ledger baseline` reads their cost, and no kata
command reads them for a decision.

## Breaking, and what that means for versions

- The command surface loses eight verbs and gains one family. **Any script or skill that called them will fail.**
- `review --approve` now requires a ledger. A change with no ledger is refused with the commands that record one, and it
  does **not** fall back to an independent-pass record.
- `kata-cli judge` requires an explicit `root` — it writes `judge.json`, and the optional default wrote into whatever
  directory the caller happened to be in.
- Two generated skills are removed (`kata-review-round`, `kata-host-adapter`); their directories are deleted on the next
  `kata-cli update`.
- Under the strict tier the assurance floor is `observed`: evidence nothing re-executed cannot carry it.

`package.json` still reads `0.1.0`, so this needs a decision rather than a programmer's guess — pre-1.0 semver allows a
breaking change in the minor slot, which would make this `0.2.0`.

## The specification moved with the code

The live specs still described the route: `Adversarial pass reporting surface` named `kata-cli adversarial finding add`
as its only scenario. Two requirements were `REMOVED` and four `ADDED` under the OpenSpec lifecycle
(`retire-the-round-shaped-route`), `review-record-integrity`'s five still-true requirements were merged, two of its six
were dropped with a written reason because their subject no longer exists, and every capability's placeholder `TBD`
Purpose was replaced. `openspec validate --specs` reports 5 passed, 0 failed, no placeholder warnings.

## What was looked for that was not in the plan

Two sweeps ran the rule "one fact, one derivation — and the derivation is from the thing that decides":

| found | how | fixed |
|---|---|---|
| 78 command mentions in generated skills, three per platform | deriving the vocabulary from `src/cli.ts`'s own arms instead of a hand-written list | rewritten in ledger vocabulary; the check is now general |
| two generated skill files for commands no longer declared | asserting the reverse direction (an artefact no declaration owns) | deleted |
| a 300-line host adapter whose only invoker was deleted | asking what calls it | deleted; the addendum records what capability went with it |
| three linked worktrees, 38 MB, left by archived changes | `git worktree list` | archive now removes its own worktree (never with `--force`); a dirty one is reported |
| a test reading its fixture from that leftover junk | cleaning the junk | reads this workspace, and fails loudly if the fixture moves |
| `judge()` writing into `process.cwd()` | cleaning a stray task directory it had created | `root` is required, so a call site cannot forget it |
| an operator manual documenting eight deleted commands | grepping instruction text | `docs/operations.md` and `.pi/agents/*` rewritten |

## Verification at the time of writing

```
npx tsc --noEmit            exit 0
npx vitest run              148 files / 981 cases / 0 failures
npm run check:wiring        clean: 137 declared path(s), nothing unreferenced and nothing unconsumed
openspec validate --specs   5 passed, 0 failed
kata-cli eval dogfood       all 5 scored release gates pass; 2 skipped as unmeasured rather than passed on a zero
npm pack                    5 files, 723 kB; the six review schemas are in the bundle, the six retired ones are not
git worktree list           this checkout only
```

These numbers drift — the suite grows, the wiring count has been 47 → 0 → 5 → 0 while this was being written. Treat them
as evidence that the commands ran, never as the current number: run them.

## What is not done, and why

- **Two of the seven defect classes have no live check** (a declaration read as reality; one decision with two entrances
  where only one records it). Both need a hand-maintained map of what each function reads, so they are recorded as bounded
  work rather than claimed.
- **The shadow pilot** needs real samples over time. The three changes that walked the ledger route are its first data
  points (claim-level re-openings: 0, against 100% on the retired route), and calling that a pilot result would be
  inventing a number.
- **Two acceptance items have no obtainable denominator** (`CriticalRecall` and `FalsePass` against the retired route's
  baseline): the mechanism to measure was deleted with the route. They should be rewritten rather than carried.
