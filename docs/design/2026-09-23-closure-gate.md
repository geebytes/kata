# A repair closes only when its falsifier has been shown reddening

Change: `closure-gate`. Profile: `current_worktree` / `tdd` / `std`.

## The measured problem

`kata-gate-surface`'s second independent round reported `kgs3-f6`: **three clauses of the criteria that change is certified
against have no test anywhere, and the repair batch closed with them in that state.** The seal reported `obligations 0` while
three clauses were unverified.

That is not a bookkeeping slip. The closure criterion is:

```ts
const answered = obligation.acceptanceId
    ? resolvedAcceptanceIds.includes(obligation.acceptanceId) && (!matrix || evidenceIds.length > 0)
    : evidenceIds.length > 0;
```

**A finding-shaped obligation is answered by *any* passing evidence for the criterion** — the finding's own check is never
consulted. So a repair that adds an assertion which cannot fail closes its obligation exactly like one that adds an assertion
which can, and the difference is invisible everywhere.

The consequence is the loop this line has measured across three rounds: **the repair is written by the agent whose blind spot
the review exists to find, so an unpinned repair reproduces the class, and nothing mechanical stops it.** Round 1 found nine
findings; the repairs for them produced four of round 2's seven.

## What is being added

The falsifier already exists as a *request*: the brief asks every finding to carry one, and the schema accepts it. What is
missing is that nothing ever **shows it reddening**, and nothing consumes it. Three parts, in dependency order:

1. **A recorded fact**: this finding's falsifier was run, on this revision, and it reddened. Recorded by the tool that ran it —
   the command and the revision are measured, never typed in, for the same reason telemetry is measured: a caller-supplied
   value is an assertion about the thing the record exists to verify.
2. **A producer**: the repair path records it at the moment of repair. Build owns repair and test authorship, so Build is where
   the fact is born — and it must be born from an actual run, not from a claim about one.
3. **A consumer**: `obligationIsAnswered` requires it for a finding-shaped obligation. Naming a check and running it are
   different facts; only the second closes.

## Why this is the lever and not another mechanism

Two of this line's findings are the same sentence: **"a tool that exists is not a tool that was applied"**, and **"mechanism
exists, never wired"**. This change is deliberately the third thing — a mechanism whose consumer is the closure rule itself, so
that a repair which does not redden anything cannot be certified as done. It is the only mechanical way to stop the class from
reproducing, and it costs **zero model tokens** because it runs locally.

It is also the honest answer to "why did the cost not come down": the loop's rounds are paid for by the independent pass finding
the same class again. Removing the class from the repair side removes those rounds.

## Risks, stated rather than discovered later

- **A closure rule is the riskiest code here.** A wrong one refuses honest work — the same failure the review budget's
  `budget_exhausted` had. The gate must refuse **only** on a missing reddening, never on the shape of the check or the wording
  of the record.
- **The producer can be faked.** On a single machine, Build can record a reddening it did not observe. The ceiling is the same
  as the execution receipt's: host-authored, measured and bound — not cryptographic — and it must be stated that way rather
  than claimed stronger.
- **AC-5 exists because of a measured failure.** `wcc2-f1` and `kgs3-f3` were both "the fix was applied to one derivation of a
  concept that has several". So the criterion's own falsifier must enumerate **every** producer of "answered" rather than
  asserting one pair.

## What this change deliberately does not do

- It does not change what evidence a seal collects, or how a revision is minted.
- It does not touch the review loop's round bound — that is a separate decision, and this change makes the loop converge by
  removing the class rather than by capping the count.
- It does not retro-fit existing closed batches. A batch that closed on evidence alone stays closed; the record says so, and
  `status` reports the difference (AC-3).

## How a falsifier gets shown reddening — the procedure, worked out

The non-obvious part, and it decides the shape of the producer. A falsifier is *the check that must redden under the defect it
names*. The defect is **fixed** by the time the repair is done, so the check **passes** — and a passing check proves nothing
about its sensitivity. To show the check reddens, the defect has to be **back**:

1. run the check → it must **pass** (the repair is in place; if it fails, the repair is not done and this is a different error)
2. re-introduce the defect, run the check again → it must **fail** (that is the reddening)
3. restore

That is exactly the mutation verification this line has been doing by hand all session — revert the fix, watch the suite
redden, restore — and it is the only procedure that measures what the criterion claims. The tool cannot invent step 2: knowing
how to re-introduce a defect is knowledge only the repairer has, so **the mutation is declared** by Build alongside the
falsifier, and the tool's job is to run the three steps and record what it observed rather than accept a claim about them.

So the producer is a command with a shape like:

```
kata-cli falsify --change <id> --finding <finding-id> --check <selector> --mutation <command>
```

which records a fact — the finding, the check, the revision, and that the check reddened — and refuses if step 1 fails, step 2
does not redden, or the restore does not return the tree to where it started. The record is what AC-1's criterion consumes; the
refusals are what stop the producer from becoming another field a caller can type.

### Slice order

1. **The store and the criterion** (AC-1, AC-4): a reddening record and `obligationIsAnswered` requiring one for a
   finding-shaped obligation, with the two directions tested — present closes, absent stays open — and "names a check that was
   never run" staying open.
2. **The producer** (AC-2): the three-step run, with the refusals above, and the hash/revision measured rather than supplied.
3. **Visibility** (AC-3): `adversarial status` distinguishes answered-by-evidence from answered-and-falsified.
4. **The class falsifier** (AC-5): enumerate every producer of the closure decision rather than asserting one pair — the
   mistake `wcc2-f1` and `kgs3-f3` both punished.

### What this change must not become

A closure rule that refuses honest work. The refusal must fire on **one** thing — a missing reddening — and never on the shape
of the check, the wording of the record, or whether the mutation looked convincing. If a criterion here can be satisfied by
prose, the change has reproduced the class it exists to remove.

## Slice 1 measured: the criterion works, and it breaks eleven fixtures across six files

The criterion change was written and its own three cases went **GREEN** — an obligation with no reddening stays open, one with a
reddening closes, a reddening for a different finding does not close it. **The RED before it was exactly the change's reason**:
two of the three failed with `expected true to be false`, i.e. today the obligation closes on passing evidence alone.

Then the full suite: **eleven failures across six files** (`quality-gates`, `batch-closure-marks-findings`,
`major-finding-routing`, `obligation-answerability`, `obligation-resolution`, `preflight-planned-evidence`). The fixtures are
wrong rather than the rule — they close finding-shaped obligations with no reddening — and the shared producer is
`persistBlockingFindings`.

**So the criterion was reverted and this slice keeps only the store**, which is additive and green. Committing a red suite is
not an option, and neither is loosening the rule to make fixtures pass: the rule is the change.

**The next slice is therefore fixture work plus the criterion**: give each of the six fixtures a reddening for the finding its
obligation carries, then re-apply the criterion. **And one consequence needs deciding rather than discovering**: changes sealed
before this rule — `wiring-coverage-check`'s six obligations among them — have findings with no reddening and could never
close. AC-3's visibility is where that shows up, and it is the reason AC-3 is not optional.

## Why AC-3's test kept reading an empty list — and it is a defect of the family this line keeps finding

Two attempts, both ending at `readObligations` returning `[]` after `persistBlockingFindings` had demonstrably run. The cause,
read from the source:

```ts
export async function readObligations(root, taskId) {
    try {
        const record = await readValidatedOptional('repair-obligations', obligationsPath(root, taskId));
        return record?.obligations ?? [];
    } catch {
        return [];      // <- a validation failure and an absent file are the same answer
    }
}
```

**A record that fails validation is indistinguishable from a task with no obligations.** The second attempt asserted the setup
before the subject and reported `expected [] to have a length of 2` — so the obligations were written and the read refused them,
silently. That is the same shape as the empty-answer-from-an-uncovered-instrument (`kgs-f9`), and it is why four attempts on
that clause and two here have failed for reasons the cases were not about.

So AC-3's test is blocked on a **diagnostic** rather than on an assertion: the swallowed validation error has to be visible
before a fixture can be trusted. Recorded here rather than worked around, because a fixture that cannot say why its input is
missing is a fixture that will pass for the wrong reason the moment the input stops being missing.

**AC-3's status in one line**: implemented, measured on the real change (12 obligations, 7 `evidence-only`), and **not pinned** —
its row in the acceptance matrix has no test, which the seal surfaced mechanically.

## AC-3's third attempt: the producer returns nothing, and the working fixture differs by one field

With the swallowed validation failure removed, the third attempt localised it in one step: **`persistBlockingFindings` itself
returns `[]`**, so nothing was ever written and no reader could have found it. The two earlier attempts were asking the reader.

The working fixture is next door — `tests/unit/obligation-resolution.test.ts` persists `major` and `blocking` findings and then
asserts `obligation.resolvedAt` is defined, and it passes. Its setup differs from mine in exactly one visible way:

```ts
// theirs
await createTask({ root, id, title: 'Resolution', acceptance: [{ id: 'AC-1', statement: 'A repair is accounted for.' }] });
// mine
await createTask({ root, id: 'ac3', title: 'ac3', ownedPaths: ['src/x.ts'], acceptance: [{ id: 'AC-1', statement: 'x' }] } as never);
```

So the next experiment is one line: use their shape. That is recorded rather than guessed at, and the case is deleted rather
than committed red — a red test cannot be committed and a green one that cannot fail is worse than none.

**What AC-3 stands on, unchanged**: implemented, measured on the real change (12 obligations reported, 7 `evidence-only`), and
not pinned. Its matrix row has no test, and the seal says so mechanically.

## The seal found a dead end: five rows sharing a selector can never be separated

The split worked — five test files, one per criterion, 167 files / 1175 tests green. Then the matrix corrections, and they are
**impossible through the governed path**:

```
matrix set --selector tests/unit/closure-gate-criterion.test.ts
  -> "That correction would leave a selector declared by more than one criterion
      (tests/unit/closure-gate.test.ts declared by AC-2, AC-3, AC-4, AC-5)."
```

The guard is right: one evidence file per selector, so a shared selector cannot evidence two criteria. **But the correction
path edits one row at a time, and after changing any single row the other four still share** — so every first step is refused,
and there is no first step. `matrix declare` refuses a second declaration, so the whole matrix cannot be replaced either.

**This is the fifth variant of one gap**, and the sharpest: the first four were "a declaration that no longer matches reality
has no governed correction". This one is **"a declaration that no longer matches reality has a correction that cannot be
applied, because the guard refuses every intermediate state"** — a correction path whose own precondition is unreachable
one step at a time.

**Two honest ways out, both needing a decision rather than a workaround**: make the correction atomic (accept a whole corrected
matrix when the task already has one, validating only the result), or allow a batched selector correction that validates once
at the end. Until one exists, `closure-gate` cannot be sealed — and it is not the matrix that is wrong, it is the way back.

**Also measured**: `matrix set --command` and `--selector` are separate branches, so supplying both
applies only the first — **and that is still true**, as the independent round pointed out (`cg-f7`): the sentence here claimed it was fixed, and it was not. What is true is that the two corrections have to be issued one at a time, which is what this round did. **A fix to it belongs with the other corrections, not in a sentence claiming it was already done.**

## A read-only reviewer cannot persist as it goes — the two requirements are in tension

Measured on this change's own independent round: `progress lines 0` thirteen minutes in, with 2 MB of output, because the
`kata-reviewer` agent type has `tools: read, grep, find, ls` — **no bash** — and persisting a note means running
`kata-cli adversarial note`. So the instruction "persist as you go, so a round that dies mid-way keeps what it established" was
**impossible to follow** with the tool set that makes `read_only_fs` constructive.

That is not a bug in either half. **Constructive read-only means the reviewer cannot write, and incremental persistence means
something must write.** The resolution is that the two cannot both belong to the reviewer: either the **orchestrator** persists
on its behalf from what it returns, or the round accepts that a crash loses everything and the brief stops asking for
incremental notes.

Recorded because the tension will be met again by anyone who reads "read-only reviewer" and "persist as you go" in the same
brief, and because the honest current state is: **a crashed `kata-reviewer` round leaves nothing, and the instruction telling it
otherwise is noise it cannot act on.**

## The independent round on closure-gate: seven findings, and the answer to the question it was asked

Cost: **406,492 tokens / 107 tool uses / 19 minutes** on the  subagent — against 1.0–4.9M for the  rounds on this line. It ran with  only, so it could not invoke the CLI and returned the record as text for the host to file.

The question was whether this change passes its own test. It does not.

- **blocking** `cg-f1` — The seal preflight's dry run omits the reddening ledger, so `obligationIsAnswered` returns answered=false for EVERY obligation carrying a `findingId` (the only shape persistBlockingFindings ever creates). collectSealPreflight therefore denies every seal while any finding-shaped obligation is open, and the resolver that would close it runs only after a successful seal — a permanent deadlock, and pr
- **major** `cg-f2` — `FalsifierReddening.revisionId` is recorded and never consumed: `obligationIsAnswered` narrows the parameter to `Array<{ findingId: string }>` and compares only `findingId`. The field's own docstring — 'Recorded so a later re-seal cannot inherit a stale proof' — is therefore false, and the freshness property the design leans on ('the revision it reddened on are measured') buys nothing: a reddening
- **major** `cg-f3` — The new ledger is the one task artefact read without a schema and with the error swallowing this change removed elsewhere: readFalsifierReddenings returns [] for both a missing file and a corrupt/invalid one. It reproduces, in the change's own new file, the defect the change documents as fixed in readObligations ('a record that fails validation read exactly like a task with no obligations ... the 
- **major** `cg-f4` — AC-4's declared check does not test AC-4. tests/unit/falsifier-refusals.test.ts asserts the producer's three refusals; AC-4 is about closure — 'a falsifier that names a check which was never run does not close the obligation'. The closure rule consults neither `check` nor any ran/unran fact, and recordFalsifierReddening is a plain write with no linkage to a run, so a record naming an unrun check c
- **major** `cg-f5` — AC-5's declared check does not test AC-5. tests/unit/closure-gate-producers.test.ts enumerates the four INPUTS of obligationIsAnswered, not the producers of the closure decision, so the thing the criterion exists to catch — 'a second derivation of answered ... caught rather than added' — is not caught. A second derivation (a copy of the rule in the preflight dry run, or repair-batch.ts:277-278's s
- **major** `cg-f6` — The revision's other changed file, src/cli/matrix.ts, ships its new atomic correction (`matrix set --from-file`) with no test — the branch the design credits with unblocking this change's own seal is untested, and its `previousSelectors` audit output is unasserted. The revision's own declarations also no longer match the tree: ownedPaths and pathDigests carry tests/unit/closure-gate.test.ts, which
- **minor** `cg-f7` — A false sentence in the change surface: docs/design/2026-09-23-closure-gate.md states the `--command`/`--selector` single-branch defect is 'also measured, and fixed in the same pass'. It is not fixed — each correction branch still ends in an early `return`, so `matrix set --command X --selector Y` still applies only the first. This is the declared-path prose-accuracy class the change's own history

**The blocking one is a permanent deadlock this change introduced**: the seal preflight dry-runs  without the reddening ledger, so it answers false for every finding-shaped obligation — the only shape  creates — and the resolver that would close one runs only after a successful seal. Two derivations of "answered", and this change updated one.

**And it found the class it was asked about, in this change**: `cg-f3` is the new ledger being read without a schema and with the error swallowed — the defect fixed in `readObligations` an hour earlier, reproduced in the module written to avoid it. `cg-f4` and `cg-f5` are "the declared check does not test the criterion", the same shape as `kgs3-f3`.

## The repair of the independent round's findings

All seven disposed. Six carry a verification that can fail; the seventh does not, and saying so is the point of this sentence rather than an omission from it:

- **`cg-f1` blocking** — the seal preflight now reads the reddening ledger, so it dry-runs the same inputs the resolver does. Without this the preflight refused every seal while a finding-shaped obligation was open, and the resolver that could close one runs only after a successful seal: a permanent deadlock. It is the second derivation of "answered" this line keeps producing, and it is now asserted rather than remembered — `closure-gate-producers.test.ts` requires the preflight to call `obligationIsAnswered` **and** to read the ledger.
- **`cg-f2`** — the criterion narrows by revision, so the docstring's promise ("a later re-seal cannot inherit a stale proof") is now true rather than decorative. The shared fixture takes the revision it reddens for, which is why six fixtures moved.
- **`cg-f3`** — the ledger is read through a schema (`schemas/falsifier-reddenings.schema.json`, registered in `core/schema.ts`) and **no longer swallows**: a failure is not an absence. This was the defect fixed in `readObligations` an hour earlier, reproduced in the module written to avoid it, and found by the independent round.
- **`cg-f4`** — AC-4's rule implemented, not merely declared: a reddening now records **the three exit codes the producer observed** (green, red, green), and the criterion requires them. A falsifier that merely names a check, with no observed runs, no longer closes an obligation.
- **`cg-f5`** — AC-5's falsifier now enumerates the **producers of the closure decision** rather than the inputs of one function: the decider computes it and consults the ledger, the preflight calls it, and the batch closure reads the resolver's output rather than re-deciding. A naive "no other file may mention answered" assertion would have been wrong — the third shape is a consumer, and the test says why.
- **`cg-f6`** — `matrix set --from-file` has a test: it applies a whole corrected matrix, reports the previous selectors, refuses a result that does not validate, and asserts the matrix was left as it was.
- **`cg-f7`** — the false sentence is corrected in place, and says what is true: the single-branch behaviour is **still** there, and a fix belongs with the other corrections rather than in a sentence claiming it was done. **It is the one finding with no falsifier, because it is prose** — round 3 caught that this file claimed "each with a verification that can fail" while one of the seven had none (cg3-f1). A prose correction cannot be pinned by a test; it can only be stated honestly, which is what this sentence now does.

## Round 2 produced no record, and its last thought was a real defect

Cost: **658,523 tokens / 85 tool uses / 17 minutes**, and the round ended mid-analysis with no record — its final message was
empty. What it left behind is a `thinking` part whose last line names something true, verified independently:

> *the reddening ledger records 6 reddenings (cg-f1..cg-f6), all bound to revision-0aa79bf2959193f4 … but those reddenings were
> produced by `node tmp/mutate-all.mjs <id>` applied to the tree at the time. Note the mutation file lives at `tmp/` — untracked
> files under tmp/ are not part of the …*

Checked, and it holds:

```
git check-ignore -v tmp/mutate-all.mjs   ->  .gitignore:17:tmp/
paths in the revision: 27, any tmp/: 0
the ledger records: mutation "node tmp/mutate-all.mjs cg-f1"
```

**So the recorded proof references a script that does not exist in the sealed revision.** Nobody can reproduce a reddening from
the revision alone, which is the whole point of recording it: the record says "this check was shown reddening" and the way to
show it is outside the artefact. It is the same shape as the rest of this line — **the evidence does not travel with the thing
it certifies.**

Two consequences, and the second is a design one:

1. **My use of the tool is at fault here**: the mutation command should be self-contained (an inline `node -e`, or a path inside
   the revision), and the six reddenings for this change are weaker evidence than they look for that reason.
2. **The tool could require it**: a `mutation` that names a path absent from the revision is a proof nobody can re-run. That
   belongs with the other corrections rather than in a sentence claiming the record is reproducible.

**And a second thing the round did not get to say**: it produced no record at all, so its 658K tokens bought no finding and no
verdict. The `kata-reviewer` type cannot write, so its result is its final message — and an empty final message loses everything.
That is the same tension recorded above, one level up: a read-only reviewer cannot persist, so the round is only as durable as
the model's last sentence.

## The criterion assumes every repair is a source change — and two repairs are not

Three of round 3's findings are repaired, and **only one of them can be falsified**:

| finding | what the repair is | falsifiable? |
|---|---|---|
| `cg3-f2` | AC-4's rule moved to the file its selector names | **yes** — reverting `observedReddening` reddens it, and it is recorded |
| `cg3-f1` | **a sentence in this document** | **no** — prose has no check to redden |
| `cg3-f3` | **the enumeration in a test** | **no** — reverting the discovery to a literal list leaves every check green, because the fix *is* the test |

So the seal refuses, correctly, and the reason is not that the repairs are wrong. **It is that the criterion assumes a shape
every repair does not have**: it asks for *the check that must redden under the defect*, which presupposes the repair changed
code that some check exercises. A repair to a test, or to a document, has no such check — and the two findings in that shape are
exactly the two this round cannot close.

**This is the third time the same gap has surfaced** — `cg-f7` was a prose correction, and `cg3-f1` is the finding *about* that
being unpinned. So the honest statement of the criterion's limit is:

> **A repair whose subject is not code cannot be falsified by mutating code.** The rule needs a second disposition — "no
> falsifier exists for this repair, and here is why" — which is a recorded fact rather than an exception granted by whoever is
> doing the repair. Otherwise the rule forces either a fake mutation or an obligation that can never close, and both are worse
> than saying so.

**And the same shape is why `cg3-f5` (the sealed revision declaring a deleted path) is not fixed here**: it is a repair to a
declaration, and its falsifier would be the seal's own refusal — which is the mechanism, not a check.

## The revision id IS stable — and the proof bound a stale revision, which is a different and smaller defect

Four times in this round a proof was recorded and then invalidated by a later seal. The fourth time is the one that shows the
cause, because the tree was clean and the two revisions are the same in every way I can see:

```
revision-31fc4d5781f961ec  paths 28   (proofs recorded against this one)
revision-7cd64168e6ecbccf  paths 28   (the seal produced this one)
only in 31fc4d: (none)     only in 7cd641: (none)
ownedPaths equal: true
git status: clean
```

**Same paths, same owned paths, clean tree, different `revisionId`.** So something in the digest differs that is not a tracked
file's content — the candidates are a check's side-effect file or the seal's own artefacts — and the consequence is the one that
matters here:

> **A proof bound to a revision is invalidated by the next seal of unchanged content**, which makes the sequence
> "freeze → prove → seal" impossible: the seal that would close the obligation is the seal that invalidates the proof.

This contradicts the guarantee the revision scheme is built on — unchanged content yields a byte-identical `revisionId` — and it
is the same shape as the rest of this round: **a declaration (the revision id) that does not match the thing it names.** The
falsifier binding is the first consumer that makes it visible, because it is the first thing that requires two seals of the same
content to agree.

**Not fixed here, and named rather than worked around**: the diagnosis needs the digest recomputed twice over one content set to
see which entry moves, which is a measurement I did not have budget for. It belongs with the corrections, and it is the reason
this change cannot close its own last three obligations.


## Correction: the digest is stable, and the real cause is a stale binding

The section above concluded that the revision id is unstable. **That conclusion was wrong**, and one comparison shows it: the
two revisions differ in exactly one path's digest —

```
tests/unit/closure-gate-criterion.test.ts
  31fc4d: 1a58c8c9efe02e84d7ec50da58f91c9aa4847be88afb2ba461659df5d3f78dc5
  7cd641: c754ec1754ddee0bda0e2bfe3ff43f213f98674c1f88ddf3c6cef3135a575c3d
```

— and that file **really did change** between the two: step 1 of this round added four cases to it. So the digest was right both
times, and the defect is one level down:

> **`kata-cli falsify` binds a proof to `readCurrentTaskRevision` — the last *sealed* revision — not to the content in the
> working tree.** So after any unsealed edit, a proof is recorded against a revision the tree no longer corresponds to, and the
> next seal mints a different one and invalidates it.

That is the same class as everything else in this round, one more time: **a record that names something other than what it is
about.** And it is fixable where it lives, which the unstable-digest reading was not: the command must refuse to record a proof
about content no sealed revision describes.
