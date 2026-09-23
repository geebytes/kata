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

## Where AC-6's cause is not

`wcc3-f8` says the current change record's `openFindings` is the same ids as the base record's, so findings raised between
the two seals never appear. Checked, and the derivation is not the cause:

```ts
// change-record.ts
const openFindings = input.findings
    .filter((finding) => finding.disposition !== 'fixed')
    .map((finding) => ({ id, severity, disposition }))
```

It filters and maps the input — it does not copy a previous record. And the seal passes live state:

```ts
// orchestrator.ts, at the seal
findings: (await readTrackedFindings(root, taskId)).map((finding) => ({ id, severity, disposition }))
```

So the cause is upstream of both: **what `readTrackedFindings` can see**. Measured while closing `wiring-coverage-check`,
which is the same mechanism from the other side: round 2's findings lived only in the adversarial node record, round 3's pass
overwrote that record, and after the overwrite the earlier ids were gone from every source the seal reads. The node record
is a single slot per node, so "what is still open" is a function of which pass wrote last.

That makes AC-6's first question concrete and answerable without further search: **should the tracked-findings source be the
node record, or an append-only history of passes?** The evidence for the answer is already committed — the file this
document's sibling dumped verbatim exists precisely because the node record is a single slot.

## AC-2's first question, likewise

`wcc3-f2` measured that a repair editing `src/workflow/orchestrator.ts` and `src/adapters/phase-guidance.ts` — files hashed
at **both** seals — does not appear in the change surface. The surface is derived by `changeSurfaceAgainstWorkspace(base,
revision)` in `revision-delta.ts`; the question to answer before any code is whether the base revision's digest for those
paths was captured **before or after** the repair, because a digest captured after it makes the two equal and the edit
invisible by construction rather than by bug.

## AC-2, measured: the finding's premise is wrong, and the surface is right

The measurement this document said to take before writing any code — the base revision's digest for the files `wcc3-f2`
named, against the current revision's:

```
src/workflow/orchestrator.ts    base bf74c4e2e5   current bf74c4e2e5   SAME
src/adapters/phase-guidance.ts  base d164842a02   current d164842a02   SAME
src/quality/wiring-check.ts     base e99b367112   current eb3037d1a6   DIFFERENT
```

The two files the finding named carry the **same** digest in both revisions. So they did not change **between** the two
seals: the repair that touched them landed **before** the base revision was sealed, which is why the base already holds the
edited content and why the delta is empty for them. A surface that reported them as changed would be the defect.

That makes `wcc3-f2` a **premise error rather than a bug**: "a repair that edits a file already hashed at both seals" is
only invisible when the edit happened before the earlier seal, and in that case there is nothing for a delta to report. The
third file differs, and the surface does see it.

AC-2 therefore closes as **measured, not implemented** — and this is the second time in this change that measuring before
coding turned a finding into a correction of the finding rather than a code change (the first being AC-6's cause, which is
upstream of the derivation that was suspected).
