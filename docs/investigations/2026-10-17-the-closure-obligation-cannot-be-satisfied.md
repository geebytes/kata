# The closure obligation can be neither satisfied nor lifted — the seal's own remedy cannot be walked

Measured 2026-10-17 while repairing `the-gates-can-be-repaired` at `revision-2ab47a7a2b63b784`, against the mechanism
merged as `90bffc8` (`src/quality/obligation-check.ts` + the seal call site). This is that mechanism's first measurement,
and it blocks its first user.

## What happened

Round 9 (`revision-f4a487f5f1b64b5a`, `tmp/g-review-result9.json`) concluded `repair` for the class
`refusal-cannot-be-executed` and recorded a `closureObligation`. The repair was implemented, the full suite passes
(366 files / 2232 tests), `tsc --noEmit` is clean, all 31 declared falsifiers re-ran `supported` (`ledger evidence
verify`), and `ledger decide` is `pass` with no deficit.

The seal refuses:

```
Seal blocked: the repair does not satisfy the closure contract a root-cause round contracted it to.
  refusal-cannot-be-executed: inventory names sites that do not exist: <all 10 entries>
  refusal-cannot-be-executed: no passing check in this seal matches the declared effectivenessTest (<prose>)
The obligation is recorded in the review record of the round that asked for this repair; satisfy it, or record a new
conclusion for the class (a new round through `kata-cli ledger run` and a recorded result) before sealing.
```

Both halves of that refusal are unsatisfiable as recorded, and the remedy it prints is unreachable from the phase the
refusal is printed in.

## Defect 1 — the two enforced prose fields cannot be satisfied by the shape the reviewer protocol produces

`src/quality/obligation-check.ts`

- `inventory` (lines 102–104): `obligation.inventory.filter((entry) => !existsSync(join(root, entryPathOf(entry))))`.
  `entryPathOf` (line ~155) is `entry.trim().split(':')[0]`, so an entry is only ever a path (optionally `path:line`, or a
  path followed by anything after a colon). Every entry round 9 wrote is `<path> <symbol> (<annotation>)` — e.g.
  ``src/workflow/user-choice-gate.ts speaksForCurrentContent (the gate's own answer)`` — which resolves to a filename that
  contains spaces and parentheses. **No such entry can exist**, so this check can never pass for an inventory written in
  that shape, however correct the repair is.
- `effectivenessTest` (lines ~120 and ~140, `envelopeNamesCheck`): the declared text must be a substring of, or contain,
  an envelope's `checkId`/`name`/`command`/`scope.paths`. The field is prose by construction ("A selector that reddens
  while any site still violates the invariant: (a) … (b) … (c) …"), and no check id, name, command or path in the seal's
  envelope set occurs inside it. **A prose test description can never match.**

`inventory` and `effectivenessTest` are two of the four enforced fields; the other two (`repairSurface`, `ifRecursAgain`)
pass. The module's own doc-comment says the prose fields it does *not* enforce (`states`, `sourceOfTruth`, `invariant`) are
"recorded … and not claimed here" — but `inventory` and `effectivenessTest` are prose in the reviewer's output too, and
they *are* claimed.

## Defect 2 — the remedy the refusal prints cannot be executed from the phase that prints it

The remedy is "a new round through `kata-cli ledger run` and a recorded result". Measured on this change (phase
`implement`):

- `kata-cli review --change the-gates-can-be-repaired` → `Review requires explicit user confirmation at the review trust
  boundary.` (`{"requiresUserConfirmation": true, "trustBoundary": "review_gate"}`)
- `kata-cli gate reset --boundary review_gate --reason …` then `kata-cli gate approve --boundary review_gate --choice
  continue_current` both succeed, and the same refusal is returned afterwards — the gate is not what is missing.

The chain, with both ends in source:

1. `src/cli/workflow.ts:131` — `boundaryForCommand(command, inputPhase, …)`.
2. `src/cli/workflow.ts:432` — `if (command === 'review' && (phase === 'hardVerify' || phase === 'review')) return
   'review_gate';` — in phase `implement` this returns `null`.
3. `src/cli/workflow.ts:200` — `confirmHostModel: boundary !== null` — so the CLI passes `false`.
4. `src/workflow/orchestrator.ts:2581` — `if (!options.confirmHostModel) { … 'Review requires explicit user
   confirmation at the review trust boundary.' }` — refuses before anything else.
5. **No CLI argument supplies it, and the mechanism's own instruction names one that does not exist.** `confirmHostModel`
   is assigned in exactly one place — `src/cli/workflow.ts:200`, `confirmHostModel: boundary !== null` — and nothing reads an
   argv flag for it, in `src/` **or** in the shipped `dist/cli.js` (`grep -o "hasFlag([a-zA-Z]*, \"--confirm-host-model\""` /
   `includes("--confirm-host-model")` → no match in either). What the string *does* appear in is the pause instruction the
   mechanism prints to the operator: `src/workflow/prompt-catalogue.ts:148-153` tells them "only then may
   `--confirm-host-model` record the audit entry and enter Review" (and the same for Judge), and that text is in the shipped
   bundle too. So the four links are: the entry refuses for want of a confirmation, the confirmation is derived from a phase
   table that says "no boundary" in `implement`, **and** the only road the refusal's own instruction prints is a flag the CLI
   never parses. (Corrected 2026-10-17: an earlier version of this line said the string appeared nowhere at all, which the
   grep above contradicts — it appears in prompt text and comments, never as an argument.)

So the only road out of the blocked seal is a command that cannot be entered from the phase the seal leaves the task in,
and a phase transition out of `implement` is exactly what the blocked seal owes. The `implement → seal → hardVerify →
verify → review` link is the only route to `review`, and `verify` is gated the same way.

**The class is the defect.** The obligation belongs to `refusal-cannot-be-executed` — the class whose repair this seal is
certifying — and the mechanism that enforces it now refuses with a road that cannot be walked, in exactly the state the
class describes. The repair is therefore not class-level yet: the class has a third site, in the gate that certifies it.

## What the road actually needs — and why the first answer was wrong

The first answer here was "map `review` to `review_gate` in `boundaryForCommand` for phase `implement` as well", on the
evidence that the entry refused at the trust boundary. **That was measured to be insufficient and reverted**: the road is
closed by three links, and the first one is not the binding constraint.

1. **The boundary table** (`src/cli/workflow.ts:432`) — `review` maps to `review_gate` only in `hardVerify`/`review`. With
   `implement` added, in a fixture, the entry does get past the confirmation — the refusal changes to the next one below —
   so this link is real but makes no road run.
2. **The phase machine is linear** (`src/core/state.ts:72-74`: `orderedPhases.indexOf(to) === orderedPhases.indexOf(from)
   + 1`), so `implement → review` is refused: `Review could not be entered: Illegal transition from implement to review.`
3. **A round's result can only be recorded in the review phase** (the `--result-file` prologue in
   `src/workflow/orchestrator.ts`): `Review result recording requires review phase; current phase is implement.`

The cycle is therefore: the round must be recorded, and recording needs the review phase; the only forward step out of
`implement` is `hardVerify`, which is exactly what the blocked seal performs; and the seal is blocked until the round is
recorded. No change to the boundary table breaks that — so "make the printed road walkable" as first described is **not a
repair but a new capability** (a class-conclusion round recorded before a seal, with no phase transition), and it belongs
in a change of its own rather than in the one whose seal is stuck.

## What was done, and what is still only measured

**Option 1 was taken** (the operator chose it). `src/quality/obligation-check.ts` now reads the two fields the way the round
that writes them writes them:

- `inventoryPathOf` resolves an entry to the first token in it that names a file on disk (backticks, quotes, a trailing
  `:line` and trailing punctuation stripped). An entry that names no file is reported **quoted**, so the round sees which
  one, instead of the whole list being reported as missing.
- `declarationNamesACheck` asks whether the declaration names any identifier the seal's own evidence carries (a check id, a
  scoped path, or a `path/to/file.ext` token in the command; at least eight characters, occurring verbatim). A declaration
  that names **no check at all** is a different state from a check that ran and did not match, and it is reported as
  itself — "the declared effectivenessTest names no check at all, so nothing this seal ran can confirm it".
- That state is decided by a decision recorded among the task's waivers under `obligation:<defectClass>` and is published
  as a **recorded gap** (with the reason and the approver) — never as a satisfied contract, and with no decision it refuses
  like any other unmet obligation. The seal's call site passes the waivers in and the passing report carries the gap.

The instrument is `tests/unit/an-obligation-is-read-as-the-round-wrote-it.test.ts` (six cases) and falsifier `E32`; the
message change moved one assertion in `tests/unit/a-seal-satisfies-the-closure-contract.test.ts`, which is declared.

**Option 2 is still only measured** — a class-conclusion round cannot be recorded before a seal. That is a capability, not
a repair: the phase machine's linearity (`src/core/state.ts:72-74`), the `--result-file` prologue's phase guard and the
boundary table are three links of one cycle, and relaxing any one of them alone changes a refusal into another refusal
(measured). It belongs to its own change, with its own acceptance criteria.

**Option 3 was not taken**: the recorded obligation in `review-history.jsonl` is a reviewer's own field formatting and was
not edited. The road out for this change is the decision route option 1 added, recorded with its reason and approver in the
task's waivers.

## Three mechanism gaps measured while doing this

1. **Adding an acceptance criterion has no governed writer.** `kata-cli tasks declare` writes `upstreamCoverage` and
   `acceptanceMatrix` and refuses acceptance explicitly ("A task's acceptance criteria are its contract and are not
   rewritten here"), and `tasks amend-acceptance` corrects an **existing** criterion only — it refuses an id that is not in
   the task (`no criterion 'AC-5' in task '…'`). So the repair that unblocked this change could not be given a criterion of
   its own through any command, and §8 was folded into AC-2 by a recorded amendment instead (widened, not narrowed). The
   measured road that would run: let `amend-acceptance` add a criterion when the id is absent, with the same reason/actor
   record it already writes for a correction.
2. **`scope change` calls do not accumulate.** Four consecutive `scope change --add` invocations each computed
   `current + added` from the last **applied** set, so three of the four additions were dropped and `scope apply` reported a
   declaration missing three paths; re-running each `change` immediately followed by `apply` added them one by one.
   Measured on this change (scope-24 … scope-28, then scope-29 … scope-32 applying four times). The road that would run:
   fold the pending additions into the base the next `change` computes from, or refuse the second `change` until `apply`.
3. **The pause instruction names a flag the CLI does not parse.** `--confirm-host-model` is what `prompt-catalogue.ts:148-153`
   tells the operator to use to record the audit entry and enter Review (and Judge); `confirmHostModel` is instead derived
   from the boundary table (`src/cli/workflow.ts:200`), so in a phase that table maps to no boundary the printed road is a
   flag that does nothing — the same class this change is repairing, printed by the mechanism that repairs it. The measured
   road that would run: accept the flag as the confirmation (it names the fact it claims), or print the flag the mechanism
   actually reads.
