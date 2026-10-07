# The reviewer definition follows the request

**Date:** 2026-10-08
**Kind:** ungoverned repair of living documentation (agent definition + two Skills), with backups kept.
**Trigger:** a reviewer in another checkout produced a blocking finding whose subject was its own brief.

## What happened

A strict review round in another project reported a blocking finding that a change had not answered probes stored against
an older revision. The change's `ReviewRequest` said the opposite:

```json
"probes": [],
"withheldProbes": ["P1-CL-1", "P2-CL-1", "P3-CL-3"]
```

The round reached that conclusion by reading `probes.json` directly, after the request had deliberately withheld those
questions. Under the current protocol the finding is invalid: `probes` is the whole obligation, `withheldProbes` is history
that cannot be answered truthfully about the content under review, and an answer satisfies no gate.

## Why it was the documentation's fault, not the reviewer's

The reviewer followed its definition. `.pi/agents/kata-reviewer.md` said the request carries "the **probes** you must
answer" and instructed, as step 2, "**Answer the probes.** `kata-cli ledger ask --change <id>` lists them". Both halves had
drifted from the CLI:

- the request no longer hands over every stored question — it hands over the ones bound to the revision it names, and names
  the rest in `withheldProbes`;
- `ledger ask` no longer offers a question whose content has moved, and an answer is advisory history.

Nothing in the definition mentioned `withheldProbes` at all, so "answer the probes" plus a stored question list read as an
unmet obligation. A definition that predates a protocol change is a trap for the next reviewer, not a mistake by this one.

## What was changed

| File | Change |
| --- | --- |
| `.pi/agents/kata-reviewer.md` | "What you are given" now states that the request carries `probes` **and, when non-empty, `withheldProbes`**, with the rule spelled out: `probes` is the whole obligation, `withheldProbes` is history, its absence from `probes` is not a gap, its presence in the file is not a finding, and a request with `probes: []` plus a populated `withheldProbes` is complete. Step 2 became "Answer the questions the request hands you", reading `probes` rather than the file, with an explicit "do not read `probes.json`/`probe-answers.json` to find questions the request did not hand you". The refusal paragraph now distinguishes a **declared path** that moved (a real refusal) from a **stored question** bound to an older revision (history that withholds itself). |
| `.agents/skills/kata-review/SKILL.md` | The request is described as carrying "the probes to answer and the probes withheld as history"; step 4 became "Answer the questions the request handed you, and only those", and the `ledger ask` line no longer reads as a source of obligations. |
| `.agents/skills/kata-verify/SKILL.md` | Same wording, since this Skill documents the request it hands to the review node. |
| `docs/operations.md` | The known-issue note "A probe set is asked once and cannot be refreshed" described behaviour that no longer exists (it told a reader to answer stale questions). Replaced with the repaired contract and a pointer to the measurements and the repair. |

Backups of the three edited files sit beside them as `<file>-before-withheld-probes-20261007-221100`.

## Why this is not a governed change

The edit is prose in a living document — the class `AGENTS.md` says to fix as you work ("skills are living docs — fix
errors, add gotchas, trim dead rules") — and it repairs a definition whose subject is a protocol that already shipped. The
alternative, a full design→build→review→judge cycle, would have left the other checkout blocked on a stale instruction for
the length of that cycle while changing nothing about the code under review.

## What a reviewer should do instead

1. Read the request. `probes` is the list to answer; `withheldProbes` is a statement about the ledger's history.
2. If a request hands over no questions, that is a complete request: say so and audit the claims against their reading sets.
3. Never open `probes.json` or `probe-answers.json` to discover obligations. A question the request withheld cannot be
   answered truthfully about the revision under review, and reporting it as unmet is a finding about the brief.
