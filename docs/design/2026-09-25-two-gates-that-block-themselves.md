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
