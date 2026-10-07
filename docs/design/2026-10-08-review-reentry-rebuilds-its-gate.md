# Review re-entry rebuilds its gate

**Change:** `review-reentry-rebuilds-its-gate`
**Status:** approved design
**Reported by:** a governed change in another checkout (`zenmpai`, branch `feature/photo-observation-provider-layer`) that could not re-enter review.

## 1. The measured deadlock

The report, reproduced here in this repository on a change that holds the same state:

```
change: record-ownership-single-derivation
current-state.json            phase = review
user-choice-review_gate.json  choice=continue_current  consumedAt=2026-10-02T04:56:30Z

$ kata-cli gate approve --task … --boundary review_gate --choice continue_current
User choice gate review_gate has already been consumed.        ← no next step named
$ kata-cli review --change … --confirm-host-model
… phase=hardVerify                                             ← the store says review
```

Three defects compose into it, and each is a surface reporting or keying on a phase it assumed rather than the one it read.

### 1.1 The review refusal invents a phase

`src/workflow/orchestrator.ts:1889` returns the confirmation refusal with a hard-coded `phase: 'hardVerify'`, and `:1962` does
the same in the failure path. Every other place in that file reports what it read — `cmdVerify` at `:1367` returns
`phase: current.phase`, and `:1430` reads the store for the same purpose. So an operator who runs `review` from a task sitting in
`review` is told the task is in `hardVerify`, and the next thing they try (the remedy for a *stale* gate) is the wrong one.

### 1.2 The consumed refusal names no remedy

`src/workflow/user-choice-gate.ts:145` throws `User choice gate <boundary> has already been consumed.` — and stops there. Its
neighbour at `:219` was fixed to carry `gateRebuildInstruction`, with the comment "the remedy is not guessable: the gate has to be
*recreated*, by the command whose success creates this boundary's gate". The rule landed on one of the two branches that need it.

### 1.3 The remedy does not work from `review` — the deadlock itself

`GATE_CREATED_BY` (`user-choice-gate.ts:18-27`) records `review_gate: { command: 'verify', phase: 'hardVerify' }`, and
`boundaryCreatedBy(phase, command)` matches on the phase a command **reports**. `cmdVerify` reports the phase it **entered**
with (`:1367`), so a verify run from a task already in `review` reports `review`, the table finds no entry, and
`createUserChoiceGate` is never called — the consumed gate is never replaced. The remedy the sibling message prescribes is
therefore inert in exactly the state that needs it, and the only way out is `kata-cli build --seal`, which mints a revision for
content that did not change.

## 2. Decisions

1. **The creating condition is the command's success, not the phase it reports.** `GATE_CREATED_BY` keeps a phase only where the
   phase genuinely distinguishes the boundary (it does not for `review_gate`: a successful `verify` is what creates it, from any
   entry phase). `boundaryCreatedBy` therefore answers `review_gate` for a successful `verify`, and the instruction every
   refusal prints becomes true.
2. **A refusal reports what it read.** The two hard-coded `phase: 'hardVerify'` returns read the store, so the refusal and
   `current-state.json` cannot disagree.
3. **Every unusable-gate refusal carries the next step.** The consumed branch appends `gateRebuildInstruction(boundary)`, the
   same string the stale branch already appends. One remedy sentence, two branches.

## 3. Behaviour

```ts
// src/workflow/user-choice-gate.ts — the entry that was keyed on the wrong phase
export const GATE_CREATED_BY: Record<UserChoiceBoundary, { command: string; phase?: string }> = {
    implementation_gate: { command: 'design', phase: 'plan' },
    // No phase: a successful verify is what creates this boundary, whichever phase it entered from. Keying it on
    // `hardVerify` made the remedy inert for a task already in `review` — measured, and the reason this change exists.
    review_gate: { command: 'verify' },
    judge_gate: { command: 'review', phase: 'review' },
    archive_gate: { command: 'judge', phase: 'judge' },
};
```

```ts
// the consumed branch, which now says what to do
if (gate.consumedAt) {
    throw new Error(`User choice gate ${input.boundary} has already been consumed. ${gateRebuildInstruction(input.boundary)}`);
}
```

## 4. Tests and falsifiers

| AC | Selector | Reversible falsifier |
| --- | --- | --- |
| AC-1 | `tests/unit/gate-reentry-rebuilds-its-gate.test.ts` | restore the `phase: 'hardVerify'` entry for `review_gate` in `GATE_CREATED_BY`: the case that drives a successful `verify` from a task in `review` and requires a fresh, unconsumed gate must redden |
| AC-2 | same | restore `phase: 'hardVerify'` in the review refusal: the case asserting the refusal's phase equals the store's phase must redden |
| AC-3 | same | remove `gateRebuildInstruction` from the consumed branch: the case asserting the message names the creating command must redden |

Each mutation is applied to a committed tree, restored byte-for-byte with the SHA checked; final verification runs the full suite
and `tsc --noEmit`.

## 5. Ownership

| Path | Also owned by |
| --- | --- |
| `src/workflow/user-choice-gate.ts` | free |
| `src/workflow/orchestrator.ts` | `change-lifecycle-reconciliation` (hardVerify) — declared with `--allow-ownership-conflicts`, recorded as an audit fact |
| `tests/unit/gate-reentry-rebuilds-its-gate.test.ts`, this design | free |

## 5b. The fourth link, found by running the recovery on the reported project

The three defects above were fixed, the bundle was rebuilt, and the recovery was run in the reported checkout. The gate was
rebuilt by `verify` and accepted by `gate approve` — and `review --confirm-host-model` **still refused**, with the correct
phase this time ("Review requires explicit user confirmation"), while holding a fresh, approved gate.

The link is `boundaryForCommand` (`src/cli/workflow.ts:301-307`), the second table keyed on a phase:

```ts
if (command === 'review' && phase === 'hardVerify') return 'review_gate';
```

`runWorkflowCommand` derives the confirmation from that boundary being non-null
(`confirmHostModel: boundary !== null`, `:132`), so a task already in `review` had no boundary to confirm and could never
re-enter the phase it was sitting in. The rule the table was missing is the one the fix states: **a command asks for its
boundary when it is about to cross it and when it is already there** — `review` from `hardVerify` or `review`, `judge` from
`review` or `judge`, `archive` from `judge`, `distill` or `archive`. `build` keeps its single phase: the implementation choice
belongs to `plan`, and a task in `implement` has already made it.

This is the same class as the other three — a surface keyed on a phase it assumed — and it is why the change's AC-1 says
"can re-enter review without minting a revision": the property is only true once both tables agree with it. Found by running
the reported path end to end rather than by reading it, which is the reason the recovery was executed against the real project
instead of being declared fixed.

**Also measured while recovering:** the ledger's `evidence replace` refused nothing and the verification PASSed on the
reported project's own content, so the state it reached was `review` with a fresh gate — the state this change exists to make
reachable.

## 5c. The fifth link: the invocation that *closes* the phase is not crossing the boundary

Fixing §5b made re-entry work, and immediately exposed the other half of the same table. Measured on the reported project:
`verify → gate approve → review --confirm-host-model` succeeded, and then the round's outcome could not be recorded at all —

```
kata-cli review --result-file tmp/review-result-r11.json
→ review_gate requires an explicit user choice before continuing
```

Two invocations of one command in one phase, and the table could not tell them apart. `boundaryForCommand(command, phase)`
answers "which boundary does this command ask for **in this phase**", and the entry invocation consumed the gate, so the
invocation that *submits the result* was treated as crossing a boundary that had already been crossed.

The discriminator is what the invocation **does**, not the phase it runs in: the invocation that opens the phase crosses the
boundary, the one that closes it records the outcome of a session that already crossed. So `boundaryForCommand` takes a
`recording` option, `runWorkflowCommand` passes `resultFileRequested(argv)`, and a recording invocation asks for no boundary —
for `review`, `judge` and `archive` alike, since they all have the same two halves.

The regression is pinned as a **chain**, because the defect lived in the join between two invocations and no single-invocation
test could see it: the entry asks for the boundary, the recording invocation does not, and the recording invocation is driven
through `runWorkflowCommand` with `--result-file` so the refusal would surface where the operator met it. Falsifier: removing
the `recording` short-circuit reproduces the reported message verbatim in both cases.

## 6. Rejected alternatives

- **Change `cmdVerify` to report `hardVerify`.** It would make the table match, by making a command report a phase it did not
  find — the same defect as §1.1, moved. The table is what was wrong.
- **Tell the operator to run `build --seal` first.** That is the current workaround, and it mints a revision for unchanged
  content: a real cost (every consumer of the revision sees a new one) paid to avoid a one-line correction.
- **Reset the gate in place when the phase re-enters review.** A gate's `consumedAt` is the audit trail of the choice having
  been used; rewriting it in place erases when the choice was consumed. Recreating the file, which is what a successful
  creating command does, keeps both facts.
- **Drop the `review_gate` boundary entirely.** Re-entry is a real decision point (the host model is chosen there), and removing
  the gate to fix the rebuild path would trade a deadlock for a missing trust boundary.

## 7. What this change does not do

It does not change what a gate *means* — the same choices, the same consumption, the same binding to revision or content. It does
not add a `--force` or an override: the fix is that the documented remedy works. And it does not touch the four changes in this
repository that sit in the same state (they are other changes' records; their recovery is an operational step, not a code change).
