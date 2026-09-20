# A major finding gates the node and then cannot be closed

Found by the second adversarial round of `check-log-artifact-missing`: three findings were repaired, the repair re-sealed
to a new revision, and the repair batch still reported `closed: false, answered: 0`. The batch could not close, and the
reason had nothing to do with the repair.

## What is broken

A `major` finding stops a node and then has no way to be accounted for.

**The gate counts it.** `blockingAdversarialFindings` (`src/quality/adversarial.ts`) refuses review approval on
`blocking` **or** `major`, the review node opens a repair batch for them, and `isTerminalSeverity`
(`src/quality/finding-lifecycle.ts`) defines exactly those two severities as the terminal class. The rule is stated in
three places and it is consistent.

**Closure reads obligations, and only `blocking` makes one.** `closeBatchAfterSeal`
(`src/quality/repair-batch.ts`) computes `answered` from obligations that carry a `resolvedAt`, and the only producer of
those obligations, `persistBlockingFindings` (`src/quality/repair-obligations.ts`), skips anything whose severity is not
the literal string `'blocking'`:

```ts
for (const finding of findings) {
  if (finding.severity !== 'blocking') continue;   // ← a `major` finding never becomes an obligation
```

Measured: recording one review finding at each of `blocking`/`major`/`minor` produced **one** obligation.

So a `major` finding is terminal by every rule the platform states, and permanently unaccountable. Two consequences, both
observed:

1. **The batch never closes.** After all three findings were repaired and the content was re-sealed (a new revision was
   minted from the changed manifest), `repair-batch.json` still showed `batch-1 | closed: false | answered: 0`.
2. **The workflow reports the repair as unmade.** `kata-cli adversarial brief` framed the next round as
   *"an open major finding (artifact-appends-across-seals) is unrepaired, so this round checks the repair rather than
   opening a new search"* — after the repair had landed and been verified. The framing is derived from the batch, so it
   will say this forever.

There is a second, narrower cause on the same path: `resolveObligationsForRevision` runs only `if (revision &&
task.acceptanceMatrix)` (`src/workflow/orchestrator.ts`), and a task opened without a matrix — which is the default for
`/kata-open` — has none. So even a `blocking` finding's obligation would not resolve on such a task.

## A second, independent defect on the same surface

`kata-cli adversarial finding add --change <task-id>` — the command the generated review/verify Skills, the adversarial
brief and `docs/operations.md` (three places) all instruct a reviewer to use for reporting a finding *while the round
runs* — cannot work:

```text
parseChangeArg(['add', '--change', 'check-log-artifact-missing', '--node', 'review', '--from-file', 'x']) === 'add'
```

`runAdversarialCommand` computes the task id with `parseChangeArg(rest)`, and `rest` still begins with the `add` action
word; `parseChangeArg` returns the first non-flag token, which is that word. The command then fails with
`ENOENT: .kata/tasks/add/adversarial-review.json`. `adversarial note` works only because its `rest` has no leading action
word — the two commands are documented side by side and one of them is dead.

The cost is exactly what the batching rule in the brief exists to avoid: a finding can only be reported at the end, in
the single `record`, so a round that dies mid-flight loses every finding it confirmed. `kata-cli worktree create` is
unaffected (its `rest` is `['--change', …]`), which is why the bug is not visible from the sibling commands.

## Non-goals

- **Not a severity re-design.** `blocking` and `major` both gating is not in question here; what is broken is that one of
  them cannot be accounted for.
- **Not a change to what a batch is for.** One seal and one delta round per node per batch stays.
- **Not a new CLI verb.** `finding add` is the documented interface; it should work rather than be replaced.

## Decisions

### D1 — Let the rule decide which severities create an obligation

`persistBlockingFindings` hardcodes `'blocking'` where `isTerminalSeverity` already exists and already includes `major`.
The fix is to use the rule rather than to widen a literal: the three places that must agree (the navigation ladder, the
adversarial gate, the batch closure) then agree through one definition, and a future severity joins all three at once.

### D2 — Resolve obligations from the evidence, not from the matrix

`resolveObligationsForRevision` requires a matrix to map an obligation to a row, and refuses to do anything without one.
For a matrix-less task the honest mapping is by evidence: the task's acceptance ids against the passing evidence for this
revision, which is what the matrix branch computes anyway. A matrix is an *enrichment* of that mapping, not a
precondition for it.

### D3 — Read the flag, not the first bare word

The task id in the `finding` branch comes from a `rest` that carries an action word. It should be read with
`argValue(rest, '--change')` — the flag the documented command actually passes — rather than through the positional
helper, and the branch should keep working if the action word is absent.

## Acceptance criteria

- **AC-1** — A `major` review finding creates a repair obligation, and a `blocking` one still does; a `minor` one still
  does not.
- **AC-2** — A repair batch whose terminal findings were repaired and re-sealed closes, with those findings named in
  `answered`, on a task that has no acceptance matrix.
- **AC-3** — After a batch closes, `kata-cli adversarial brief` no longer frames the round as checking an unrepaired
  finding.
- **AC-4** — `kata-cli adversarial finding add --change <task-id> --node <node> --from-file <json>` records the finding
  against that task, and fails with a usage error (not an ENOENT on a task named `add`) when `--change` is missing.
- **AC-5** — The commands named in the generated Skills and `docs/operations.md` all work as written; the Skills are
  regenerated from `phase-guidance.ts` rather than edited.

## Verification notes

- AC-1 is a direct read of the obligations after recording findings at each severity — the same probe that found it.
- AC-2 needs a matrix-less task driven to a terminal finding and then re-sealed, which is what
  `check-log-artifact-missing` did by hand; it should become a fixture.
- AC-4 is asserted on the exit path as well as the success path: the bug's signature is the *reason* it fails, not that it
  fails.

## What implementation found: the defect is three layers deep

Repairing D1 was necessary and not sufficient, and each layer surfaced only because the previous one let the next seal run
far enough to fail. All three are recorded here rather than folded into the change's own history, because two of them are
pre-existing and one is a decision the platform has not made yet.

**Layer 1 — the producer.** `persistBlockingFindings` skipped everything that was not `severity === 'blocking'`, and
`recordFinding` refused to call it for anything else. Repaired by both using `isTerminalSeverity`.

**Layer 2 — nothing called it for an adversarial finding.** Its only caller was `recordFinding` in `reviewer.ts`, which
handles *review* findings. An adversarial pass's findings reach the platform through `addAdversarialFinding` and
`adversarial record`, and neither persisted an obligation. So the batch's `answered` bookkeeping — read from obligations —
could never account for the findings the batch was opened for. Repaired by persisting an obligation when an adversarial
finding with a terminal severity is added.

**Layer 3 — a deadlock, and it is pre-existing.** `collectSealPreflight` refuses a seal on unresolved obligations
(`seal-preflight.ts`, check 5), and it runs *before* the checks. `resolveObligationsForRevision` — the only path that ever
resolves one — runs *after* them. So an unresolved obligation blocks the very run whose evidence would answer it, and
there is no CLI to resolve one by hand (`reopenObligation` has no production caller).

The matrix case is closed on this path because check 5 returned early for a task with no matrix; the checks then ran, and
`resolveObligationsForRevision` resolved it afterwards. Removing that early return — which this change does, because
closure resolves from acceptance ids and evidence and does not need a matrix — makes the deadlock reachable on the
default task shape, where it had never been exercised.

**Not repaired here, and the reason is scope, not difficulty.** Closing it means deciding *when* an obligation may be
considered answered by evidence the current run is about to produce: either the preflight stops refusing on obligations the
current revision can still answer, or resolution moves ahead of the preflight with the previous revision's evidence. Both
are changes to what the seal means, and neither belongs in a change whose stated job is to make a terminal finding
closable. What this change does instead is stop the platform from *lying* about it: the seal now refuses on a task shape
where it previously passed silently and left the batch open forever.

**What this does not break, verified:** with a matrix present and the criterion unsatisfied, an obligation stays
unresolved exactly as before (`hasMappedEvidence` is untouched); with a matrix and matching evidence it resolves exactly
as before; and a `minor` finding still creates no obligation.
