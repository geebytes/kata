# A finding has a lifespan (F1 of the finding-lifecycle design)

The gates' severity semantics were already right — `blocking`/`major` stop a task, `minor`/`nit` do not — so "fix every
minor the moment it is seen" was never something the platform demanded. What was missing is that **a finding had no
lifespan**: `review.json`'s findings carried `id`, `taskId`, `acceptanceId`, `severity`, `message`, `path` and nothing
else, so "known, decided to defer, remembered" had nowhere to live. It survived in the author's notes, came back as a new
finding in the next pass, and was invisible when the task closed — a review honestly reporting three small problems was
indistinguishable from one that quietly dropped them.

## What changed

**The record carries the decision.** `schemas/review.schema.json` and `schemas/adversarial-review.schema.json` findings
gain four **optional** fields: `disposition` (`open` | `fixed` | `deferred` | `accepted`, absent = `open`),
`dispositionReason`, `dispositionBy`, `dispositionAt`. Old records read as `open` — no migration, nothing rewritten.

**`kata-cli findings`** — `list [--disposition …]`, `defer --id … --reason … [--by …]`, `accept …`, and
`carry --to <task-or-ticket>`. `src/quality/finding-disposition.ts` reads the findings from **both** records (the review's
and each adversarial pass's) so one view answers "what is open on this task".

**The invariants are enforced, not documented:**
- **I1** — `defer`/`accept` refuse `blocking`/`major` with a message that says the finding must be repaired;
- **I2** — a deferral requires `--reason`, and records who and when; the decision is printed everywhere findings are;
- **I5** — a disposition changes *when* a finding is read, never *whether*: an accepted finding stays in `unfixed()` and
  keeps being listed.

**Three places now show it:**
- the **adversarial brief** gained a *Already known, already decided — do not re-report these* section, with the
  instruction to attack the *decision* rather than re-discover the finding (a whole review round is what a re-report costs);
- **verify** reports `deferredFindings` in its diagnostics and does not fail because of them (severity still decides);
- **archive** refuses an unfixed `blocking`/`major` finding, and refuses to close with deferred findings that were not
  carried anywhere (`kata-cli findings carry --to …`, or `archive --findings-carried-to <where>`), so living with a known
  problem is a recorded decision instead of a list that stops being printed.

## Verification

- `tests/unit/finding-disposition.test.ts` — a record that never said reads as `open`; blocking/major refuse both
  dispositions; a minor needs a reason and records by/when; an accepted finding stays visible; findings are read from an
  adversarial pass as well as the review.
- Full kata suite: 632 tests in 78 files; `tsc` clean; `dist/cli.js` rebuilt.

**Not yet done (from the same design, in its own priority order):** F2 (per-path digests + `--since` delta briefs), F3
(pricing a repair), F4 (platform-derived relevant checks), F5 (review bound by `reviewedPaths`, explicitly lowest
confidence and last).
