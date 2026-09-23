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

## `kgs-f9`: the fix is right, the falsifier does not exist — and the reason is not established

The finding, with a live reproduction on this very round: the record was refused with `undeclared_test_path` naming
`tests/unit/change-record.test.ts` — a pre-existing test the pass only **read**. The permitted set was fed
`sealedRecord.changedPaths` (what this revision **changed**), while the rule it feeds permits any test "the current sealed
change record proves Build wrote before this pass". A test that existed at seal time and was not modified is exactly that.

The fix is one expression: the permitted set is the sealed revision's own content —
`Object.keys(revision?.pathDigests ?? {})` — rather than only the paths that moved.

**The falsifier was attempted and deleted.** The case built a test sealed into an *earlier* revision (measured: putting it in
the same revision as the delta made it a changed path, so the first fixture proved nothing), recorded a pass citing it, and
asserted the refusal reason is not `undeclared_test_path`. It passed — and restoring the old behaviour left it green, so it
pinned nothing.

**The reason is not established.** What is known: `undeclaredTestPaths(record, permittedTests)` did not refuse the record
even when the cited path was outside the permitted set, so the fixture did not produce the shape that triggers the check —
most likely the cited path has to appear where that function scans, and a `permitted-test` observation's `ref` is not it.
Settling that is the next attempt's first step, not a guess.

This is the fifth falsifier attempt in this change that ended in a deletion rather than a green test, and the pattern is now
the change's own subject: **the assertion has to be on the producer the finding is about, in the shape that producer reads.**

## `kgs-f9`'s falsifier, third attempt: deleted, and the reason is now known

The second attempt fixed the shape problem the first one had — `undeclaredTestPaths` walks `record.attempts[].evidence`, and
the earlier version put the path in a hypothesis observation's `ref`, which that function never reads. The record was built
through the schema-valid helper with the citation in an attempt's `evidence` string, and the test asserted the refusal reason
is not `undeclared_test_path`.

It passed. The mutation restored the defect and **it stayed green**.

**The reason is the same one the second `kgs-f3` attempt hit, and it is now certain rather than suspected: the assertion
never reaches the check under test.** `adversarialGateFor` returns on the first failing conjunct, and a fixture whose record
does not satisfy the earlier ones (a judgement basis, coverage of the remit, grounded observations) never gets as far as
`undeclared_test_path` — in either version. An assertion of the form "the reason is not X" is therefore satisfied by the
gate stopping somewhere else entirely, which is precisely the "passes for the wrong reason" shape this change exists to
remove.

So the honest state stands: **`kgs-f9`'s code fix is correct and unpinned, and pinning it needs a fixture that reaches that
check — which means the record must satisfy every conjunct before it.** That is a fixture-building task with a known
prerequisite, not a guess, and it is the third falsifier in this change deleted rather than kept green.

## minor ②'s falsifier: attempted, deleted, and the reason is a wrong split

The last finding. The case wrote a schema-valid evidence envelope finished in 2020 into the evidence directory, built a delta
brief, and asserted the sealed-evidence section either offers it or **says it was withheld**. It failed with the captured
section reading `The gate already ran these agains…` — a different section, so the split on the heading text is wrong.

**What is established**: the base revision really does carry `createdAt` (checked in a real revision record), so
`sinceAt` is populated and the withholding path is reachable; and `readRecordedEvidence` reads every envelope in the evidence
directory, so a stale one is easy to have and easy to offer — which is what makes the case worth having.

**What is not**: whether the withholding works, because the assertion never looked at the right text. The next step is to
print the brief's actual section around that heading rather than guess its shape — the same lesson as the five attempts
before it, and the reason this one was deleted too rather than kept.

So `kata-gate-surface` closes its repair batch with **eight of nine findings dispositioned and verified, one (minor ②)
unfixed and its falsifier's obstacle named**.

## After the repair seal: the obligations closed, the findings did not

Sealed the repair batch. `revision-9e48ed2e77e6512a`, obligations **7 → 0**, eight evidence items, none failing, phase back to
`hardVerify` and `next: /kata-verify`.

But the findings did not follow:

```
findings list --change kata-gate-surface   ->  9 findings, 9 open, 0 fixed
adversarial-review.json                    ->  {"fixed": 1, "open": 8}
```

So **the obligations closed on evidence while the findings stayed open** — two records stating different things about the same
finding, which is the shape this whole change exists to remove, appearing in its own repair loop.

**Cause not established.** Two candidates, and they are distinguishable rather than equivalent:

1. **By design, staged**: `resolveObligationsForRevision` closes an obligation when its evidence answers it, and the finding
   is marked `fixed` at *batch closure* — so the two steps are meant to happen at different times and the batch has not closed
   yet. If so, this is correct and the next step closes it.
2. **A gap**: the batch-closure path never runs for this change, so the finding keeps a disposition the obligation no longer
   agrees with, and the next review round will re-raise findings that are already repaired.

Telling them apart is cheap — read `closeBatch`'s caller and the batch record's state — and it is the next step rather than a
guess. What is certain is the measurement: after a repair seal, `obligations 0` and `findings 9 open` are both true at once.

## Round 2's cost, measured

```
turns 86 | total input 9,852,106 | output 25,192 | cacheRead 0 | cacheWrite 0
final context 204,949 | replay factor 48.1x | average input per turn 114,559
context at 25/50/75/90% of turns: 64,571 / 115,905 / 161,910 / 191,382
```

**99.7% of the tokens are input; 0.26% is output.** The round is not expensive to *think* with — it is expensive to
*re-send*. `cacheRead: 0` throughout, so nothing was discounted, and every one of the 86 turns paid the accumulated context
in full: **each context token was sent about 48 times.**

The growth curve is the cause and it is nearly linear — 64K by a quarter of the way through, 192K by nine tenths — so the
context kept accumulating for the whole round rather than settling. Two things made this round heavier than the previous one
(9.88M against 2.82M for a comparable number of tool calls):

- **I asked for a broader sweep**: "examine all ten selectors, and for each ask what would make it fail". That means reading
  large sources early — `adversarial.ts` alone is 2,400+ lines — and carrying them for eighty turns.
- **The brief now carries the previous round's nine findings with their dispositions** (29,789 chars against 19,640).

The brief's own size is 6% of one turn, which is the same negligible fraction measured before; it is not the driver. The
driver is turns × accumulated context, with no prefix caching and no externalised state — the retrieval-layer lever this
change has never implemented.

## What the findings say about how this can be closed

Four of the seven are about **my own repairs** — including the blocking one. That is the answer to the question the round was
asked, and it is worth stating plainly: **this class cannot be closed by writing more tests, because the author writing them
is the one who cannot see the blind spot.** Round 1's repairs produced round 2's material.

The class is "the assertion does not test what it claims", and there is exactly one way to make that a measurement rather
than a judgement: **an acceptance criterion's selector must be shown to redden under the defect it names.** That harness
already exists — it is `wiring-coverage-check`'s lever 1, and it costs **zero tokens** because it runs locally.

So the same move is both the quality fix and the cost lever: **stop paying 3–10M tokens a round for an independent pass to
find this class, and make the mechanical harness refuse an unpinned selector before the round is ever dispatched.** The
independent pass should be left with what only it can do — the semantic findings, like the blocking one this round.

## `kgs3-f3`: the block added for `kgs-f6` was decorative, and it is deleted

The finding is right and the reason is precise: the block recorded a pass targeting `['AC-1','src/one.ts']` and asserted the
refusal detail names the declared path. **Both the correct remit and the one the fix replaced produce that same refusal** —
any remit containing `src/two.ts` leaves it uncovered when the pass covers only `src/one.ts`, so the assertion holds either
way and the block could not fail.

What actually distinguishes the remits is already asserted, by the case above it: **a pass covering exactly the declared delta
is admitted**. With the remit taken from the brief that is true; with the remit taken from the whole revision it is false,
because `src/one.ts` would then be uncovered. So the new block added no discriminating power over the case that already
existed, and it is **deleted rather than kept** — a test that cannot fail reads as coverage, which is the class this change
exists to remove.

The remaining two from this round are recorded with what they need:

- **`kgs3-f4`** — AC-2's repaired selector asserts the change record with hand-written content digests under an `mkdtemp` root
  where `runGit` fails, so `changedGitPaths` is `[]` and the git term of the derivation is bypassed. Pinning it needs a
  fixture that is a **git repository**, which is a fixture-building task rather than a line change.
- **`kgs3-f7`** — `undeclaredTestPaths` scans only `attempts[].evidence` and `looksLikeTestPath` treats any test-shaped token
  as a citation, so **this very round's record was refused** because one attempt mentioned a fixture's test path. The guard
  cannot tell "ran this test" from "mentioned this test" in free text, which is a design question about where the citation
  should be recorded rather than a predicate tweak.

## `kgs3-f7`: the fix is designed, the attempt failed, and the tree was restored

The finding, with a live reproduction: `undeclaredTestPaths` scans `attempts[].evidence` and `looksLikeTestPath` treats any
test-shaped token as a citation, so **the independent round's own record was refused** for mentioning a fixture's test path in
prose. The guard cannot tell "ran this test" from "mentioned this test" in free text.

The fix is precision rather than a loosening, and the reason is worth keeping: the guard exists to catch a test the pass
**wrote**, and a written test **exists on disk**, while a path merely mentioned may not. So the predicate should flag a cited
path only if it exists — which cannot let an authored test through, because that one exists by definition.

The shape: the predicate is pure and has no `root`, so the fact is **supplied by the gate**, the way
`sealedRevisionTestSelectors` already is — `existingTestPaths: (await listRepositoryFiles(root)).filter(looksLikeTestPath)` —
and the predicate filters by membership, **failing closed** when the list is absent (keeping today's behaviour rather than
opening a hole).

**The attempt failed and was reverted.** `listRepositoryFiles` is imported inside another function in the same module, so the
gate could not see it; the patch left the module unimportable and **53 tests failed**. Reverted immediately rather than left
broken: `tsc` clean, 160 files / 1151 tests / 0 failed, tree clean.

The remaining step is one import — `listRepositoryFiles` into `adversarialGateFor`, or threading the `files` the gate already
computes — plus the input field and the predicate filter. Everything else in the design above is settled.

## Does the architecture admit an unbounded review → repair → review loop?

**Yes — and there is no structural bound on it.** Measured: `rg "maxRounds|roundLimit|roundCount|repairRounds" src/` returns **nothing**, and the
number of rounds a change has had is visible only by listing `.kata/tasks/<id>/adversarial-briefs/` (two files for this
change, one per revision). Nothing counts them and nothing stops them.

### Two loops, and only one of them is unbounded

- **`verify → repair → verify` terminates.** Verify is deterministic: it asks whether the evidence is current, complete and
  attributable to the criteria. Measured on this change: it failed twice — once because a commit after the seal superseded the
  revision, once for a missing Wiki closure — and both ended with a deterministic action (re-seal; record the closure), not
  with a review round. A deterministic check over a finite artefact converges.
- **`review → repair → review` does not.** Review is an open-ended search, and every repair mints a revision, which makes the
  review record `stale_revision` and forces a fresh pass. So a repair **cannot** be the last step: it guarantees another round.

### Why it does not converge, structurally

The artefact each round reviews **contains the previous round's repair** — and the repair is written by the agent whose blind
spot the review exists to find. So:

```
R(n+1) = repair(R(n), findings(n))
findings(n+1) = review(R(n+1))
```

If repair and review were both sound this would reach a fixed point. It does not, because `repair` reproduces the class
`review` finds. **Measured: four of round 2's seven findings are about round 1's repairs**, including the blocking one — a
defect in the repair whose purpose was to stop a finding from being erased.

### What bounds it today, and why that is not a bound

**The human at the gates.** `review_gate`, `judge_gate` and `archive_gate` each require explicit confirmation, so the loop
cannot run away on its own. It is therefore a **cost** loop rather than a runaway one — and the cost is measured: round 1 was
2.82M tokens, round 2 9.88M, and the per-round figure is dominated by turns × accumulated context with no prefix caching.

**The termination condition that exists is statistical**: the loop ends when a round happens to produce no blocking or major
finding, because only those open obligations. Nothing guarantees it, and the class reproduction is precisely what prevents it.

**And there is a second, quieter non-termination**: obligations close on **evidence**, not on "the finding was fixed" —
`kgs3-f6` measured three untested criterion clauses while the batch closed with `obligations 0`. So the *apparent* end of the
loop can be false, and the same finding returns in the next round.

### The three things that would make it converge

1. **Mechanical repair acceptance** — a finding's falsifier must be shown reddening before its obligation closes. This stops
   the class from reproducing: a repair that ships an un-pinned assertion would be refused rather than certified. *Designed in
   this change; not built.*
2. **A round bound with a stated outcome** — after N rounds a finding may be closed only by a falsifier or by routing, so the
   loop must either converge or be **recorded as not converged**. Silence is what makes it unbounded.
3. **Measure the loop** — record the trajectory (findings per round, the share of them about the previous repair, tokens per
   round) so "this is round five" is a number rather than a discovery. Today it is a directory listing.

## Why our review rounds cost more instead of less, and the two levers that reverse it

In ordinary practice a review round gets **cheaper** as the change matures, and the reasons are specific rather than
cultural:

| ordinary practice | why it gets cheaper |
|---|---|
| round 2 reviews **the diff** | the artefact under review **shrinks** to what round 1's repairs touched |
| the reviewer **keeps its knowledge** of the module | the cost of understanding is paid **once** |
| findings attach to **lines** in a tracker | the author works from the comment, not from a re-derivation |

**Our flow inverts both halves of that, by design and by instruction:**

| | ours | consequence |
|---|---|---|
| what round 2 reviewed | **the whole change surface**, and my prompt told it to examine all ten selectors | it read the large files early (`adversarial.ts` is 2,400+ lines) and carried them for eighty turns |
| the reviewer's knowledge | **destroyed by design** — a fresh context per round is what independence *means* | every round re-acquires understanding from scratch |
| the findings | **prose** (29.5% of the brief) | the repairer re-reads code to re-derive the mechanism |
| the transcript | **accumulates for 86 turns**, `cacheRead 0` | 48× replay: 9.85M input against a 205K final context |

So the measured 2.82M → 9.88M is not a platform anomaly and not a model property. **It is what happens when the artefact
under review grows while the reviewer's knowledge is discarded.**

### The two levers, both already named in the design and neither built

1. **Review the delta, not the surface.** The delta machinery exists — `since`, `changeSurfaceAgainstWorkspace`, the delta
   brief — and round 2 did **not** use it: the brief reported `no repair batch has closed, so there is nothing to narrow
   against`. But a repair batch **had** closed: the round reviewed a revision containing round 1's repairs, which is exactly a
   delta. **This is the single largest lever**, because it bounds the artefact instead of letting it grow with each round.
2. **Externalise the facts, not the conclusions.** The retrieval layer of §3.3 — content-addressed slices, the evidence graph,
   per-hypothesis hydration — was classified host-side and never built. It is what stops the transcript growing: a file read in
   round 1 is not re-read in round 2, because its hash is known.

Plus the one change already landed: **findings carry a falsifier rather than prose**, so a repair goes straight to making a
check red instead of re-deriving why the defect exists. That cuts turns, which is the term that dominates.

### The measurable target

Round 2: 86 turns at 114,559 average input. If the round read the delta (a handful of files rather than twenty) and the facts
were externalised so the context plateaued around 35K instead of climbing to 205K, the same round would cost roughly
86 × 35K ≈ **3M rather than 9.9M** — back to round 1's level, and **decreasing** from there as the delta stays small. That is
the shape ordinary practice has, and it is reachable with machinery this design already describes.

## Lever 1's root cause, measured: the batch closure is refused and its refusal is discarded

Lever 1 was "review the delta, not the surface" — and round 2 did not get a delta, reporting `no repair batch has closed, so
there is nothing to narrow against`. The cause is a chain of four measured facts, and the last one is why nobody saw it.

1. **`repair-batch.json` holds one batch, `batch-1`, with a base revision and `closedAt: undefined`** — it never closed.
2. **It was refused, correctly.** `closeBatchAfterSeal` refuses with `open_terminal_findings` when a `blocking`/`major`
   finding is neither answered (a resolved obligation), deferred, nor reported-as-no-longer-open. Measured on this change:
   **12 terminal findings in the batch, 7 answered by resolved obligations, 5 unaccounted** — and the five are exactly round
   2's findings, raised *after* the seal that resolved round 1's.
3. **The refusal is discarded.** `orchestrator.ts:803` calls `await closeBatchAfterSeal(root, taskId).catch(() => null);` —
   the returned refusal object is dropped, and the seal reports success regardless.
4. **The consequence surfaces only as cost.** An unclosed batch means the next round gets no delta, so it reviews the whole
   change surface instead of the repair — which is the difference between round 1's 2.82M tokens and round 2's 9.88M.

**So the cost driver the review loop pays for is a refusal nobody read.** The mechanism is not missing and not misordered —
it runs, decides correctly, and its answer is thrown away. That is the "mechanism exists, never wired" class one level down:
the wiring is there, the *reader* is not.

**What the fix needs**, and it is a design choice rather than a line change:

- **surface the refusal** so a seal that leaves a batch open says so, and `status` reports why the next round has no delta;
- **decide what a later round's findings do to an earlier batch.** A batch is "one seal and one delta round per node"; round
  2's findings arrived after that seal, so they belong to the *next* batch — which means the closure should be computed
  against the findings that existed when the batch's seal ran, not against every finding the record now holds. Today the
  batch accumulates findings from later rounds and can therefore never close.

## ②'s producer: attempted, failed on a mis-anchored edit, reverted

The producer is the pass delivering the facts it read, so the record path can write them into the ledger. Three parts, all
small: the schema accepts `deliveredFacts` (array of `{path, note}`), the brief's `## Required result` asks for it, and
`writeAdversarialRecord` calls `persistDeliveredFacts` — in the single write path rather than beside each caller, because a
producer that lives next to its callers is one of them will forget. The hash stays the platform's to measure, never the pass's
to assert.

**The attempt failed and was reverted.** The anchor for the producer call — `const validated = validate<AdversarialRecord>(…)`
— matched a different occurrence than the one inside `writeAdversarialRecord`, so the inserted `await` landed where it did not
belong and `tsc` reported a syntax error at line 774. Reverted rather than left broken: `tsc` clean, 161 files / 1156 tests /
0 failed, tree clean.

That is the same class as the `insert`-tool defect recorded earlier in this line (an edit resolving somewhere other than
intended, reporting success). The rule it teaches: **anchor an edit by reading the function body it belongs in, not by a string
that also occurs elsewhere.**

**State of ②**: the ledger (`4cbcf08`) and its consumer in the brief (`e8d3f3e`) are committed and mutation-verified. The
producer is the one part left, and it is specified above.

## `kgs3-f5`: the correction command existed and the correction was half applied

The finding: "the nonexistent implementation path was given a correction command and left uncorrected." Measured — it was worse and
simpler than that. I had corrected **AC-1's** row and stopped, so **AC-2 still declared `src/quality/change-surface.ts`**, a file
this change never created. Every declared implementation path now exists (checked across all six rows), and the brief no longer
names the phantom.

The finding is right, and its sharpest part is about me rather than the tool: **I built the correction command and then used it
once, on the row I happened to be looking at.** A tool that exists is not a tool that was applied — which is the same distinction
as the mechanism-with-no-consumer class, one step earlier in the chain.

### Correction to the line above: the brief still names the phantom, and correctly so

I claimed the brief no longer names the phantom path. **Measured, it does** (41,117-character brief, `change-surface.ts`
present). The claim came from a check against an empty string — `--json` does not carry the brief text, so `includes` was false
for a reason that had nothing to do with the matrix.

What is true and verified: **no row of the acceptance matrix declares it any more** (all six rows declare paths that exist), and
the brief names it because the **findings history** quotes it — `kgs3-f5`'s own message names the path. That is the history
doing its job, not a declaration surviving.

The lesson is the one this line keeps re-learning: a claim built on a check that could not have failed either way is not a
measurement. The check that would have caught it is the one used for the matrix — compare against the thing that is supposed to
be empty, and read the output rather than its absence.

## AC-5's second half: three fixture fixes, no assertion, and the surviving hypothesis

The clause: the sealed evidence a brief offers must not predate the delta it is offered for. It is untested, and the
implementation exists (`99e6223`). I tried three times to pin it and deleted the case each time:

1. **The section split was wrong** — I cut the brief on heading text that did not match, so the assertion read a different
   section. Fixed by printing the real section first.
2. **The evidence filenames were wrong** — `readRecordedEvidence` filters on `${taskId}-`, so `before-the-delta.json` is a file
   the reader never looks at. Measured from the source, fixed.
3. **`diffHash` must be 64 hex** — the schema pins it to `^[a-fA-F0-9]{64}$`, and a readable placeholder makes the whole read
   throw, which the brief swallows as an empty list. Measured from the schema, fixed.

After all three the offered list was **still empty**, so the surviving hypothesis is that the brief filters evidence by
**freshness** — `checkFreshness` compares the envelope's `diffHash` (or `scope.hash`) against the working tree, and an envelope
dated 2020 or 2099 matches neither. If so the fixture must make the envelope's `diffHash` the current one and vary only
`finishedAt`, which is what the clause is about.

**Stated as a hypothesis rather than a conclusion, because the next attempt should test it first rather than fix a fourth
fixture detail.** What is certain: the assertion never reached the offered list, so nothing about the clause was measured.

### The hypothesis was falsified, and the evidence points somewhere sharper

Tested rather than assumed: `buildAdversarialBrief` reads evidence with a plain `readRecordedEvidence(root, taskId)` — **no
freshness filter anywhere**, so `checkFreshness` is not what emptied the list. Hypothesis falsified.

What the measurement points at instead: the message the assertion read is `- (nothing is sealed yet, so there is …)`, which is
the **no-delta** branch of that section. It renders when `sinceAt` is undefined, and `sinceAt` comes from `input.delta?.sinceAt`
— so the brief the fixture built was **not a delta brief**, and the withholding branch never ran. The `since` argument is
therefore not enough on its own: the fixture's base revision has to be one the delta derivation accepts, and the builder
already refuses to guess (`delta_unavailable` when a revision predates per-path digests).

So the next attempt starts by asserting the precondition rather than the behaviour — `brief.delta` (or the reported scope) must
say delta — and only then asserts which envelopes are offered. That is the same rule this clause has now taught three times in a
row: **an assertion that fails for a reason you did not anticipate reports your instrument, not your subject.**
