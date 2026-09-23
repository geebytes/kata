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
