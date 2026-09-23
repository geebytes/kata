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

## AC-4's second half: what "closes the obligation it produced" runs into

Read, not guessed. Obligations close on **evidence**, not on a disposition:

```ts
// repair-batch.ts, at closure
const resolved = new Set(obligations.filter((o) => o.resolvedAt).map((o) => o.findingId))
const answered = batch.findings.filter((finding) => resolved.has(finding.id)).map((finding) => finding.id)
if (answered.length > 0) { /* marks each answered finding `fixed` */ }
```

So a finding is "answered" when the **obligation** carries a `resolvedAt`, and `resolvedAt` is set by a seal that produces
fresh passing evidence — not by any disposition. Two consequences for the routed disposition:

1. **Marking a routed finding `answered` would write `fixed`**, which is false: it was not repaired, it was handed to
   another change. The closure path assumes answered ⇔ repaired, and that assumption is exactly what a routed disposition
   exists to break.
2. So the second half is not a one-line addition — it is a **second closure rule**: an obligation may close because the
   finding was routed, and the closure must record *which* change carries it rather than recording a repair.

That is a design decision of the same shape as the ones already made in this change, and it belongs with them rather than
being slipped into the closure code at the end of a session. Named here with its evidence so it is not re-derived.

What already holds, and is what makes the second half tractable: the routed finding is **dispositioned, not deleted**
(`a07158d`), and AC-6's pass history means no later record write can erase it (`6ba10c4`). The routing survives; what is
missing is the closure rule that reads it.

## The declaration-correction capability: what it is, and the constraint found before writing it

Two changes cannot be archived and two acceptance criteria are false as written, and both come back to one missing
capability: **a governed path for correcting a task's declaration.** `matrix set` covers a row's `testSelector` and
explicitly disclaims the rest — its own docstring says "**not** a way to change the acceptance criteria. The statements and
their ids are untouched." So the exclusion was designed, not forgotten, and lifting it is a decision rather than a repair.

Two halves, and they unblock different things:

| half | unblocks | size |
|---|---|---|
| `matrix set --statement "<corrected>" --reason "<why>"` | the two acceptance criteria `wiring-coverage-check` cannot satisfy as written | small |
| declaring a **matrix** for a task that has none | archiving `major-finding-closure` and `repair-obligation-deadlock` (`missingAcceptanceMatrix: true`, and the archive refuses them while `status` reads green) | larger: rows are declarable only at `open --bootstrap-file` |

**The constraint, checked before writing any code rather than after:**

```
acceptance item additionalProperties: false
acceptance item props: id, statement, claims
```

So a correction history **cannot** live on the acceptance item — `statementHistory` there would make the task
schema-invalid, which is a corruption rather than a feature. The previous statement has to be recorded **beside** the task,
the way `scope change` records a grown surface and the change record carries `surfaceBasis`. That is the design; writing it
on the acceptance item is what a blind implementation would have done, and it is precisely the class of damage this session
has spent its time repairing elsewhere.

The write path is already located and is the locked one every task mutation uses:

```ts
await mutateTaskArtefact(root, change, taskPath(root, change), async (raw) => {
    const current = JSON.parse(raw) as Record<string, unknown>;
    return `${JSON.stringify({ ...current, acceptanceMatrix: next }, null, 2)}\n`;
});
```

Nothing was written: the code above is a plan, and the task files are untouched.

## The archive block is not a missing matrix — it is a vacuous criterion

Checked before using the capability that was just built, and it changes the answer.

```
major-finding-closure        criteria 1 | statements 34 chars | matrix false
repair-obligation-deadlock   criteria 1 | statements 34 chars | matrix false
review-record-integrity      criteria 5 | statements 146–201 chars | matrix true
adversarial-admissibility    criteria 6 | statements 156–234 chars | matrix true
```

Both unarchivable changes carry **one 34-character criterion**: `AC-1 :: Implement the change successfully.` That is a
placeholder from a shape that predates the strict bootstrap, and it asserts nothing.

So `missingAcceptanceMatrix` is a **symptom**. Declaring a matrix for either task would satisfy the archive gate while
certifying nothing — a matrix row saying "AC-1, evidenced by the test and typecheck the seal already collected" attached to a
criterion that claims nothing. That is the same move this session has refused repeatedly under other names: making a gate
pass rather than making the thing true.

The honest options, and neither is "declare a matrix":

1. **leave them unarchived.** Their `judge PASS` and `verify PASS` stand in the flow; they are historical records whose
   subject is done. Archiving is bookkeeping, and the bookkeeping is what is broken;
2. **correct the criteria first** — which `matrix set --statement` now makes possible — and then **re-run seal, verify,
   review and judge against criteria that mean something**. Real work, and a decision: it is not obviously worth it for two
   changes whose subjects landed days ago.

Either way, **the capability just built is not what unblocks them**, and saying so before using it is the point. It does
unblock what it was aimed at: `wiring-coverage-check`'s two criteria that are false as written can now be corrected.

## A falsifier that asserted the wrong producer, deleted rather than kept

Tried to pin `kgs-f3` (the remit taking any delta in the issued-brief pool). The test built exactly the case the finding
describes — a real issued brief for this revision plus a content-matched entry for a foreign revision carrying a different
delta, ordered so a first-match-wins reader would take the foreign one — and it **passed**. Then the mutation check: removing
the revision filter again **left it green**, so it pinned nothing.

The reason is the finding's own shape, one level up: **it asserted the wrong producer.** `ir.scope` is built inside
`buildAdversarialBrief` from that function's own resolved scope; the filter I fixed lives in `adversarialGateFor`. A test
that reads the brief cannot see the gate's remit at all.

That is the third time in this change that my own test did not test what it claimed — after a case that passed while `routed`
was schema-invalid (`kgs-f2`), and a fixture that asserted the surface while the criterion was about the record (`kgs-f4`).
It is also why the test was **deleted rather than kept**: a green test that cannot fail is worse than no test, because it
reads as coverage.

To pin `kgs-f3` the assertion has to be on `adversarialGateFor`'s remit: a pass that covers this revision's delta and not
the foreign one must be admitted, and the same pass must be refused when the foreign delta is what the gate took.

## `kgs-f3`'s falsifier: second attempt, also deleted, and why

The second attempt moved the assertion to `adversarialGateFor` — the producer the finding is about — and built the case: a
real issued brief for this revision, a content-matched entry for a foreign revision carrying `src/foreign.ts`, a file
sorting first, and a pass answering exactly this revision's delta. It asserted the gate's `detail` does not name the foreign
path.

It passed. The mutation check then removed the revision filter again and **it stayed green** — so it pinned nothing either.

**The reason is not established.** What is established: the assertion never reached the coverage conjunct. The gate reports
`detail` only when a conjunct produces one, and this fixture does not satisfy the conjuncts that come first — so the remit
the filter controls was never measured, and both attempts were asking a question the fixture could not pose.

That is the honest state to leave: `kgs-f3`'s **code** is fixed and reviewed, its **falsifier does not exist**, and the next
attempt needs a fixture that reaches the coverage conjunct (a sealed record for this revision, a pass with a judgement basis,
grounded observations) before it can distinguish the two remits at all. Two failed attempts are recorded rather than one
green test, because the green one would have read as coverage.

**The pattern is the point, and it is now four instances in this change**: a case that passed while `routed` was
schema-invalid; a fixture asserting the surface while the criterion was about the record; an assertion on the brief's scope
while the defect was in the gate; and now an assertion on the gate that never reaches the conjunct under test. Every one is a
test whose subject was not the subject.

## `kgs-f3`, resolved by measurement: my "fix" is a no-op at the call site

Third attempt, and this one produced the answer rather than another green test.

The gate calls the pool with **only** `revisionIds`:

```ts
(await issuedBriefPool(root, taskId, node, { revisionIds: [revisionId] })).accepted
```

and `issuedBriefPool` classifies an entry as accepted when `revisionIds.has(entry.revisionId) || manifestHashes.has(entry.manifestHash)`.
With `manifestHashes` empty, **the content-matched branch can never be true at this call site** — so the `.filter((entry) =>
entry.revisionId === revisionId)` I added changes nothing here. Measured: removing it leaves the entire suite green, including
the e2e fixture that reaches the coverage conjunct.

**So `kgs-f3`'s premise does not hold where the fix was applied.** The finding said the remit is "derived from any delta scope
present in the issued-brief pool"; at this call site the pool only ever contains entries for this revision, so there is no
second delta to take.

Two honest dispositions, and the choice is a judgement rather than a measurement:

1. **keep the filter as a defensive guard** — it is correct and costs nothing, but it is also **unpinnable at this call site**,
   and this change's own rule is that a guard whose removal leaves the suite green is decorative. Keeping it means writing
   down that it is defensive rather than load-bearing;
2. **remove it**, and let the pool's contract (a delta is revision-relative) be stated where the pool is called, with the
   `revisionIds`-only binding as the reason.

**What is not in doubt**: three attempts produced no falsifier, and the reason is now known — the defect is unreachable there.
Recording that is worth more than a green test, which is why all three attempts were deleted rather than kept.
