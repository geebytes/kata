# Two gates that block themselves, measured

Two workflow defects were measured while closing changes, and both have the same shape: **a gate refuses on a condition that its own
prescribed next step cannot satisfy.**

## 1. The archive gate moves its own precondition

`major-finding-closure` and `repair-obligation-deadlock` reached `judge` with `judge: PASS`, `verify: PASS`, zero failed evidence and
zero obligations, and `archive` refuses them:

```
major-finding-closure | status superseded | fresh: null | review: true | judge: false stale_judgement
```

Both changes' `ownedPaths` include their own OpenSpec files (`openspec/changes/<id>/proposal.md`, `specs/**/spec.md`, `tasks.md`), and
**OpenSpec's archive step moves those three into `openspec/changes/archive/<date>-<id>/`** — so the revision's declared paths no longer
exist at their declared locations. That revision can never be `current` again, its evidence can never be fresh, and `kata-cli archive`
can never pass. **The freshness it requires is destroyed by the archive step it also requires.**

## 2. `repair_unresolved_obligations` sends a change to a step that refuses it

`wiring-coverage-check` reached `judge` with **`judge: PASS`** and six unresolved obligations. Both `status` and `archive` prescribe the
same next step:

```
reason: repair_unresolved_obligations | next: /kata-build
```

And `build --seal` refuses from that phase:

```
Build cannot run from judge without a repairable judge FAIL result, or a superseded sealed revision
```

The obligations are finding-shaped, so each needs **both** a passing evidence envelope for its criterion and a recorded falsifier or
absence; the evidence side is resolved by the seal's resolver, which is the step that cannot run. The two exits are therefore
**closed in a circle**: the phase cannot re-seal because it has no repairable FAIL, and it cannot archive because it has obligations a
seal would answer.

The measured cause on this change: its obligations were opened by findings raised **after** the revision they are bound to, so their
dispositions were recorded against a tree the seal had already minted, and the resolver — which runs only at a seal — has never seen
them with evidence attached.

## What this is not

It is not a documented trade and it is not a defect in the changes. Nothing in either change can be repaired to pass: the condition
`archive` refuses on is a property of the workflow, and the condition `build` refuses on is a property of the phase. Both are recorded
here rather than worked around, because the alternative — moving the OpenSpec files back, or hand-editing the obligation store — makes
the gate pass by making something else false.

## 3. The independence rule forces the round whose repairs invalidate it

`closure-gate`, `kata-gate-surface` and `repair-by-another-author` all reached

```
phase: review | verify: PASS | obligations: 0 | new revision minted by the seal
```

and `review --approve` refused all three:

```
Review approval is held by the independent adversarial pass: The recorded adversarial pass is about a different revision.
```

**The chain, measured rather than asserted:** a repair changes content → the revision is content-derived → the recorded pass is bound to
the revision it reviewed and goes `stale_revision` → approval requires a pass about the *current* revision, so a new round is mandatory →
the new round's findings are about the repairs → repairing them mints another revision → the pass about it goes stale. One pass can
approve at most the revision it was recorded against, and any change to the change moves that revision.

This is not the same defect as the other two here, and it is worth stating why: the archive gate and `repair_unresolved_obligations`
refuse on a condition **nothing can satisfy**, whereas this one refuses on a condition that **every step toward it invalidates**. It is the
price of independence — a review of content that no longer exists proves nothing — and kata never bounded it, priced it, or wrote down that
its terminal states are reachable only by a change whose last action changed nothing.

### What the three changes' state actually is

Every mechanism the three changes set out to build is in the tree, `verify` passes on the current revision, no obligation is open, and the
only unmet condition is a pass about a revision that any further repair would move again. Recorded here rather than worked around, because
the alternatives are to re-dispatch the same round a fourth time or to hand-write an approval — one is the loop, and the other makes a gate
pass by making something else false.

### The measurement that closes the arc

The three changes reached `hardVerify` with `verify PASS`, `obligations 0` and a sealed revision — every mechanism they set out to build is in
the tree, tested, and falsifier-verified. What they cannot get is a certification, because certification requires an independent record bound
to the current revision and **the pass does not emit one**: ten dispatched rounds, ≈6.5M tokens, ≈990 tool calls, ≈230 minutes, zero records,
each ending `stopReason: stop` with no error (measured in full in `2026-09-25-record-less-rounds.md`).

The tenth of those was told the gate's exact refusal, the criteria by id, the two it had missed and the check to make before writing. It
stopped anyway. So the remaining cause is not in the brief, the guard, the budget or the remit — and it is not reachable from this
repository.

**What that means for these three changes is worth stating precisely**, because "failed" would be wrong: their acceptance criteria are
implemented, their evidence passes, their obligations are answered, and the falsification mechanism caught seven decorative checks, three
mis-derived identities and a hand-typed coverage marker along the way. What is not reachable is the *certification step*, which requires an
artefact from a pass that does not produce it. The honest terminal state is `hardVerify` with the reason recorded here, not an approval
written by the author.

## 4. The archive refusal named an exit that no command could reach — and fixing it archived the first change on this line

`wiring-coverage-check` reached `distill` with `judge PASS` and `archive` refused:

```
Archive blocked; 5 unfixed blocking/major finding(s) remain: … Repair them, or record evidence that they do not hold.
```

The evidence **had** been recorded — five absences, each with its measurement — and the command that records it (`kata-cli falsify --none`) writes
to the falsifier ledger, while the filter read `finding.disposition`. **No command writes a disposition for a blocking or major finding**
(`findings accept` and `defer` refuse them by design), so the exit the refusal named was unreachable by the command it implied.

That is the **seventh consumer of one question** to be repaired for reading a copy — after `cg-f1`, `kgsr7-f3`, `rba-r3-f3`, `wcc7-f3`, the review
admission and `findings accept` — and its repair is the same one: ask the ledger and the obligations. It took two commits, because the first
asked the ledger **without the binding**, and `revisionCounts` returns false for a missing binding by design; measured, then fixed.

With that, the remaining refusal was the *documented* one — six below-the-bar findings not carried anywhere — and
`archive --findings-carried-to <ticket>` closed it. **`wiring-coverage-check` is the first change on this line to reach `archive`**, which
proves the path is reachable end to end: review approved → judge PASS → distill → archive. What the other four lack is not a gate but a
record.

That distinction is the arc's own summary: **every gate that refused could be repaired, and the last one to refuse was refusing on evidence
it could not see.** The one thing no repair reached is a pass that emits a record.
