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
