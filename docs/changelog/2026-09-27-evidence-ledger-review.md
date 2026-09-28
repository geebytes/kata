# Review decided by evidence: the round-shaped route is gone

> **Version 0.2.0.** Read the addendum and the 0.2.0 section at the end for what changed after the first draft.

**2026-09-27 · changes `round-protocol`, `adversarial-admissibility`, `review-record-integrity` + the settlement that followed**

## What changed for an operator

**Eight commands are gone** (see the addendum at the end for what followed). Each now exits 1 with `unknown command`:

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

---

# Addendum — the re-audit, and what it changed for an operator

**2026-09-27 (later) · the settlement re-checked against the plan's own acceptance basis**

After the deletion list was worked through, the landing was re-audited by taking each checkable assertion in
`docs/design/2026-09-27-clean-refactor-plan.md` and checking it against code (the plan's own A–E vocabulary; full record in
`docs/architecture-reviews/2026-09-27-current-workflow-code-review.md` §13 and the plan's §26). Five items were wrong. Four
of them change what an operator sees, so they belong here rather than only in a design doc.

**One command is new: `ledger replay`.** It re-runs every recorded evidence item through the verifier that decided it and
reports how many verdicts still reproduce. It writes nothing — verdicts are returned, not recorded — so a replay never
disturbs the ledger it measures. Measured on this repository's three archived ledgers: 17 recorded verdicts, **6
reproduced · 0 contradicted · 11 could no longer be evaluated** (the cited test files were deleted with the retired route,
so the checks exit non-zero before any mutation). Exit code is 1 when anything was contradicted or could not be evaluated.

**A new required release gate: `evidence-replayable`.** It reads what `ledger replay` measured during the run — not a
number written into a manifest — and fails on **any** contradicted verdict, while applying the ≥95% floor only to ledgers
whose content still exists (a ledger frozen over moved content cannot be replayed at all, so its rate would measure the
code's life rather than the record's truth; those ledgers are excluded by name). Because it is required, a release that
never replayed anything is **not release-ready** — the gate reports `skipped` and `releaseReady: false` rather than
passing on an assumption.

**`ledger status --cost` renamed one field and added two.** `claims.reopenings` is gone:

| was | is | what it counts |
|---|---|---|
| `reopenings` | `attributableReopens` | claims a person re-opened with `ledger claim reopen` |
| — | `automaticReopens` | claims the delta says must be re-verified (`ClaimState.stale`) — computed per decision, never persisted |
| — | `reReviewClaims` | their sum, which is what the acceptance item means by "re-review" |

One word had covered two facts, and the acceptance item read the operator's counter while the mechanism's own reopen went
uncounted. Anything parsing this JSON must be updated.

**An approval can no longer outlive its evidence.** `review.json` records `reviewRoute`, and for a ledger-route approval
the archive gate now refuses when the ledger is **gone** and not only when it cannot be read. Previously the gate refused a
ledger it could not read and said nothing about one that was not there, so deleting `.kata/tasks/<id>/review/` cleared the
review half while the approval named that ledger as its basis. The refusal says which situation it is.

**`ledger plan` now reports the tier the decision will use.** It reported the *classification* tier (`standard`) while
`ledger decide` reported the policy ceiling (`strict`), so a plan's required evidence and risk classes were computed for a
weaker tier than its own gate. An explicit `--tier` still wins, including below the ceiling.

**Two manifests, one left.** `evals/dogfood-app.yaml` was a second copy of `evals/dogfood-app.json` in a format this loader
never parsed; running it produced a token error rather than a rule. The file is gone and a non-JSON manifest is now refused
by name, pointing at the JSON form.

**Not fixed, and how the two criteria stand.** `gate mutation kill = 100%` is measured — **18/18**, every decision rule's
producing statement can be removed and a watcher turns red — but the instrument is `scripts/mutation-kill.mjs`, run on
demand (~8 minutes), not part of the suite; the ✅ in the plan is a measurement, not a continuously verified property.
`shadow pilot` remains undone: it needs samples over time, and one sample is not a pilot.

---

# 0.2.0 — the local release

**2026-09-27 · version bump, and the last three findings from installing the artifact**

**The version is 0.2.0.** It was still 0.1.0 while this release deletes eight commands, renames a cost-report field and
adds a required release gate; pre-1.0 semver allows all three in the minor slot.

**A required gate that cannot be measured is a wall, not a standard.** Installing the packaged artifact into a scratch
workspace and running the manifest there reported `releaseReady: false` — "evidence-replayable produced no
measurement". With no ledger in the workspace the gate can never be scored, so a fresh project could never certify a
release. The criterion is about *recorded verdicts*, and a project that has none has nothing for a replay to contradict.
The gate now tells three cases apart:

| the workspace | what the gate reports |
|---|---|
| no ledger at all | `skipped`, **not a gap**, and its details say so |
| ledgers exist, nothing scored | still required and still unmeasured ⇒ **not release-ready** |
| the sweep itself failed | stays required — a repository that could not be walked is not an empty one |

Measured both ways: this repository (three ledgers, replay runs) reports `releaseReady: true` with 7 scored gates and 2
informational skips; a fresh install reports `releaseReady: true` with 6 scored and 3 skips, the third reading "This
workspace has no evidence ledger, so there is nothing to replay. Not a gap".

**A packed tarball was committed, and is not any more.** `npm pack` ran during the release check and a following
`git add -A` swept `kata-dev-kata-0.1.0.tgz` into the commit — a stale snapshot of `dist/` that ships to nobody and drifts
from the source. `dist/` was already ignored; `*.tgz` is ignored now, and the file is untracked. Found by the post-merge
`git status`, which is the check that exists for exactly this.

**One more refusal by name.** `evals/dogfood-app.yaml` was a second copy of a JSON manifest in a format the loader never
parsed, and running it produced `Unexpected token '#'` — a complaint about a token rather than about the rule. The file is
gone and a non-JSON manifest is refused by name, pointing at the JSON form.
