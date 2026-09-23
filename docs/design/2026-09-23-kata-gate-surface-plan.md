# kata-gate-surface — the implementation the two falsifiers now require

Status: **red falsifier committed, implementation located and not yet written.** The next step is bounded and needs no
further investigation; this file exists so it is not re-derived.

## The red test, and what it says

`tests/e2e/declared-delta-is-admissible.test.ts` (AC-3) records a pass holding **exactly** the delta its brief declares and
asks the gate to admit it. It refuses:

```
detail:    "the state does not cover: src/one.ts"
satisfied: false
```

`src/one.ts` is a path the brief never named. The brief declares one surface; the gate demands another.

## Where the disagreement is

`src/quality/adversarial.ts`, the gate's remit:

```ts
const sealedSurface = sealedRecord?.revisionId === revisionId ? sealedRecord.changedPaths : null;
const changeSurface = sealedRecord?.revisionId === revisionId
    ? (sealedRecord.surfaceBasis === 'first-revision' ? [] : sealedRecord.changedPaths)
    // No record for this revision: a revision sealed before content identity existed has only the ownership table to offer.
    : (revision?.pathDigests ? Object.keys(revision.pathDigests) : []);
```

Three sources feed one concept:

| source | what it is | when it is used |
|---|---|---|
| `sealedRecord.changedPaths` | the sealed change record's surface | a record exists for this revision |
| `Object.keys(revision.pathDigests)` | the revision's whole content | no record — **this is what refuses the delta** |
| the brief's `ir.scope` | **kata's own declaration of what this round reviews** | nowhere — the gate never reads it |

The third is the one that should decide a delta round, and it is the only one the gate does not read. `wcc2-f1` named this
from the record side; `wcc3-f10` and the red test reach it from the delta side.

## The implementation

The issued brief is already persisted, with its scope, at
`.kata/tasks/<task>/adversarial-briefs/<node>-<revision>.json`, and it is **kata's** declaration rather than the
reviewer's — the property that keeps the remit falsifiable. Two readers for it already exist and one of them is in the
dead-export list, which is the same shape this whole line of work exists to remove:

- `issuedBriefPool(root, taskId, node, binding)` → `{ accepted, otherRevision }`, already used to verify a record's
  `briefSha256` against a brief kata really issued;
- `readBriefFile(path)` → the raw text, and it has **no production caller**.

So the change is: when the accepted issued brief for this node and revision carries `ir.scope.kind === 'delta'`, the remit
is that scope's `changedPaths`; otherwise the existing derivation stands. One source, and the same one the brief was
rendered from.

## What will verify it

| test | before | after |
|---|---|---|
| `tests/e2e/declared-delta-is-admissible.test.ts` | **red** — refused for a path the brief never named | green |
| `tests/unit/change-surface-derivation.test.ts` | green, mutation-verified | still green, still mutable |

The unit test is the guard rail: it enumerates the producers, so a fix that satisfies the delta path by introducing a fourth
source will fail it. And it must still go red when the record's surface is emptied — a green that cannot be made red is
what this line of work has recorded three times over.

## Not part of this step

`wcc3-f2` (a repair that edits a file hashed at both seals is invisible in the surface) and AC-4's routed terminal
disposition are separate acceptance criteria of this change and are not touched by the remit fix.
