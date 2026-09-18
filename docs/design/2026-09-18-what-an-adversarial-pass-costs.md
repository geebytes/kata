# What an adversarial pass costs, and how to brief one

> Status: **proposal** (2026-09-18). Scope: the *pass itself* — how `kata-cli adversarial brief` scopes one, and what the
> brief tells its reviewer. It builds on the delivered finding-lifecycle design
> (`2026-09-18-finding-lifecycle-and-proportional-reverification.md`, state in `…-state-of-play.md`): F2 already gives a
> delta brief, `--since` and `--elapsed-ms`, and F3 already prices a repair. Nothing here re-proposes those.
>
> Every number below is measured, and where a mechanism is missing it is named with `file:line`. §6 lists what an
> implementer must deliver; §7 lists what must **not** change.

## 1. The measurement this comes from

Seven independent adversarial passes on one task (`skill-identity-idempotency-versioning`), same machine (48 cores),
same workflow, scheduled by the same person with the same intent:

| Round | Wall | Tool calls | Tokens | Outcome |
|---|---|---|---|---|
| 9 | 773s | 102 | 5.7M | 2 minor + 1 nit |
| 10 | 1331s | 49 | 2.2M | 1 minor + 1 nit |
| 11 | 1236s | 56 | 1.3M | **none** |
| 12 | 634s | 75 | 5.3M | 5 nit |
| 13 | 935s | 83 | 4.8M | **1 major** + 4 nit |
| 14 | (running) | 38 | 1.8M | — |
| review round | 985s | 132 | 21.4M | 3 major + 4 minor + 1 nit |

Median ≈ **940s (16 min)**. The machine was **idle** for most of it (`load average 5` of 48 cores during a pass): the
time is **not CPU**, it is the reviewer's own turn loop — thinking at a large growing context, then waiting for a
command, then reading its output and deciding again. Two terms:

| Term | Observed | What it is |
|---|---|---|
| **Test execution** | ~3–8 min | the reviewer runs its own evidence: focused subsets (20–40s each), probes (3–30s), and — in the wider rounds — **two full suites ≈ 100s each** |
| **Reviewer turns** | ~5–12 min | 38–132 turns; each turn = one model call at 0.4–1 MB of accumulated context, then a command wait |

Two facts make the second term dominant and make "buy more cores" useless: turns cannot overlap (each depends on the
previous command's output), and every extra "please also check X" in the brief costs a **new turn chain**, not a new
corner of the machine.

## 2. What the brief currently asks for, and where that is expensive

`renderAdversarialBrief` (`src/quality/adversarial.ts:125`) already carries the honest parts: revision and manifest
binding, the scope (`--since` delta, `:443`), the known-and-deferred section, `reverificationCost`, and the JSON schema
the reviewer must return. What it does **not** do is bound the reviewer's *execution* cost or shape its *framing*:

1. **Nothing says "do not re-run the whole suite."** Round 13 spent ~205s of its 935s on two full-suite runs, and got
   from them the *opposite* of evidence: it concluded, correctly, that "both runs stayed green — that is
   schedule-dependent luck, not evidence that the dependency is gone". The suite result that mattered was **already
   sealed** (the project's own `test` check) and could have been *read*.
2. **Nothing carries the sealed evidence** to the reviewer. Every pass re-derives what the gate already recorded; the
   logs sit in `.kata/evidence/*.json` (`log` field) and are never pointed at.
3. **Nothing rotates the framing.** Every brief I write by hand leads with *my* claims ("the fix does X, verify it"). A
   fresh context is asked to check my framing, not to form its own — and the largest catch of the session (round 13's
   major) was in a **file I had not mentioned**, found only because that reviewer went looking on its own.
4. **No cost signal.** The brief states what to verify, never how expensive the reviewer's own runs are, nor how big the
   delta is. A reviewer cannot pace itself, and the platform cannot report the pass's cost afterwards — `elapsedMs`
   exists on the record (`schemas/adversarial-review.schema.json`) but **tool uses / tokens do not**, so the loop has no
   feedback term at all.

## 3. Formatting note

Because the first three are properties of the *brief*, and the fourth is a property of the *record*, they belong in
platform code and schema — **not** in a promise that humans will write better briefs. A hand-written brief is exactly
what produced the sixteen-minute median.

## 4. The proposal

### M1 — brief the reviewer to *read* evidence, not to re-run it

The brief gains a section listing the sealed evidence the reviewer may use as its own ground truth — `checkId`,
revision binding, and the path to the evidence envelope — and states the rule:

> Run what you need to falsify a specific claim; **do not re-run a check whose sealed evidence already covers this
> revision** (the full suite in particular). If you believe the sealed evidence is wrong, say so and show why — that is
> a finding, not a reason to re-run it.

**Exception, explicit and narrow:** when the round's own focus *is* suite-global behaviour (order dependence, worker
isolation, a claim about the suite as a whole), the brief says so and permits one full run. Round 13 needed this; most
rounds do not.

*Side effect (state it in the brief, do not hide it):* the reviewer can no longer independently falsify "the whole suite
is green". The gate still runs it, and the reviewer can inspect that evidence — but the **independence** of a global
claim drops from "re-derived" to "inspected". That is the price, and it is worth paying only because the suite already
runs at seal time on the same revision.

*Measured upside:* round 13's two full runs were ~205s (22% of that pass). Removing them from an ordinary round is
worth ~3–4 minutes, and — more importantly — removes a run whose green result the reviewer correctly refused to trust.

### M2 — rotate the framing: `verify` vs `cold`

Two brief modes, and the mode is **recorded and rotated by the platform**, not chosen by the author each time:

- **`verify`** — the author's claims are listed, each with its repro command, and the reviewer must additionally walk
  the **whole delta** ("do not answer only the listed items"). This is the cheap, targeted round.
- **`cold`** — **no author claims**: the brief gives the delta, the acceptance criteria, the sealed evidence and the
  previous pass's `attempts`, and asks the reviewer to decide what to attack. This is the independent round.

Platform behaviour: `kata-cli adversarial brief` defaults to the mode the task has **not** used most recently, states
which mode it used and why, and the skill text tells the reader to keep the rotation. A hand-written brief can still
pass claims, but the *default* stops being "the author's framing".

*Side effect:* a `cold` round is slower and less predictable — it may spend its budget on something the author already
knows is fine. That is the point: round 13's major was found precisely because nobody had framed the search.

*Why one focus per round is **not** proposed as a blanket rule:* rounds 3–5 of the same task produced two defects that
only appeared in the **interaction** between two fixes (a partition-suffix change and an alias lookup). A single-focus
brief would have walked past both. Recommended split: **`cold` rounds stay multi-dimensional** (the reviewer picks), and
single-focus briefs are reserved for re-verification of a specific repair.

### M3 — give the cost signal, both ways

- **Into the brief:** the delta's size (files, lines) and, when known, the previous pass's `elapsedMs` and tool-use
  count — so a reviewer knows whether it is being asked for a ten-minute round or a thirty-minute one.
- **Into the record:** `toolUses` (and, when the host can report it, tokens) alongside the existing `elapsedMs`
  (`src/quality/adversarial.ts:83`), so `adversarial status` can show a trend instead of a single number, and a future
  `--since` decision can be based on cost rather than on hope.
- **Into the brief text, one line:** independent commands belong in **one** invocation (run them together, read the
  outputs together). Every separate invocation is a full model turn; batching is the single largest lever on the
  turn term, and it costs nothing in evidence quality.

### M4 — hand the reviewer its reading list

The brief already knows the changed paths (`pathDigests`, F2). Listing the **files worth reading** (changed files plus
their direct collaborators from the matrix) as a starting set removes the 10–20 orientation reads every pass currently
spends before it can form its first hypothesis. It must be framed as a starting set, not a boundary — the same sentence
that says "these are where the change is" must say "reading beyond this list is expected when the change's claims reach
elsewhere".

## 5. Invariants (do not trade these for speed)

- **I1** No verdict without an executed counterexample. Every `attempts[]` entry keeps its `method` + `evidence`.
- **I2** Destructive falsification stays mandatory where it applies: break the guard, confirm it reds, restore it. A
  guard nobody has seen fail is not evidence (`round 13` did this for the drift check; `round 14` for the golden).
- **I3** The reviewer never sees the author's reasoning as *instruction*. `cold` mode exists to keep this true by
  default rather than by discipline.
- **I4** Sealed evidence may be **read**, never **assumed**: if a reviewer leans on sealed evidence it must cite the
  envelope.
- **I5** Cost measures may change *when* a check runs and *who* runs it; they may never change *whether* a claim is
  falsified.

## 6. Deliverables for the implementer

1. `renderAdversarialBrief` gains two sections: **sealed evidence** (checkId + path + revision binding) and **reading
   set** (changed paths + collaborators), plus the "do not re-run covered checks" rule with its exception (M1, M4).
2. Brief **mode** (`verify` | `cold`): accepted as a flag, defaulted by rotation against the previous pass on the same
   task, **stated in the brief text** and stored on the record (M2).
3. `toolUses` on the adversarial record + schema (M3); `adversarial status` reports it beside `elapsedMs`.
4. The batched-execution line in the brief template (M3).
5. The verify/review skill text states the rotation and the "read, don't re-run" rule (one paragraph, same place as the
   existing `recordCommand` instructions).
6. Tests: a brief in `cold` mode contains no author claims; the rotation flips between passes; the sealed-evidence
   section names the current revision's envelopes and not another revision's; a mode/`toolUses` round-trip through the
   schema.

**Acceptance:** on the next task, two consecutive passes report their mode, their `toolUses`, and their `elapsedMs`; the
`cold` pass contains no author-authored claim list; and a reviewer following the brief can falsify a seeded defect
without running the full suite (seeded by the implementer, as a test).

## 7. What must not change

- `--since` / delta scope / `delta_stale` refusal (F2) — the change surface stays measured, not asserted.
- `reverificationCost` and `findingOrigins` (F3) — a repair keeps its price tag.
- The gate's own full-suite check at seal time. M1 moves the *reviewer's* re-run out of the loop; it does not touch the
  gate.
- Anything a reviewer concludes must remain bound to `revisionId` + `manifestHash` + `briefSha256` as it is today.

## 8. Honest boundaries

- The **turn term** (~5–12 min) is estimated from turn counts and pass durations, not instrumented: no host reports
  per-turn latency to kata today. M3's `toolUses` is the first step toward seeing it; until then the split between
  "thinking" and "waiting" in §1 is an inference from two data points (48 idle cores, 38–132 turns).
- M1's saving is measured only as the removed full-suite runs (~205s of one 935s pass). The claim that the reviewer is
  *not* worse off rests on round 13's own argument that the green run was not evidence anyway — one round's reasoning,
  not a controlled comparison.
- M2's benefit is **not** measurable by construction (its whole point is that the author cannot predict what a `cold`
  pass finds). Its cost is predictable and its benefit is only visible in hindsight; the rotation is the compromise.
- Two of the seven rounds above ran with the loop's full ceremony; the median is over a small sample on one task, one
  machine, and one author — treat the numbers as the shape of the cost, not as a benchmark.

## 9. Appendix — what each expensive round bought

| Round | What its cost bought |
|---|---|
| 11 (1236s) | Nothing — a genuine `no_defect_found`, which is the only evidence that a batch of fixes is actually clean |
| 12 (634s) | 5 nit, all in the previous round's *repairs* — the pattern that repairs need their own pass |
| 13 (935s) | **A major**: a third instance of the merged-stream defect, sitting on the path that had just become the default — the failure mode that would have made CI red at random |
| review (985s, 21.4M tokens) | 3 major, incl. the canonicalizer's fingerprint never matching a real method row (a frozen slug that could never hold) |

The last line is why M1 is written as *"stop re-running the suite"* and **not** as *"shorten the round"*: the round that
found the most ran longest because it read code deeply, not because it ran tests.

## 10. Addendum (2026-09-18, after the proposal was written) — two defects the proposal's own mechanism exposed

Reproduced while recording a pass against a task that carried **deferred** findings (F1):

| # | What happens | Why it matters |
|---|---|---|
| **D1** | Recording a new pass **replaces** the previous pass's record, and the dispositions live on that record. The five deferred findings became `open` again, and `kata-cli findings defer --id <old-id>` then fails with *"was not found in the review record or an adversarial pass"* — the ids no longer exist. | F1's promise is that a deferral stays visible **across passes**. As built, the next pass silently resurrects it and the author cannot even re-defer it by id. |
| **D2** | The brief embeds the known/deferred section, so replacing the record **changes the brief text** — and the gate validates the new record by recomputing that brief's hash. Recording a pass therefore invalidates the very brief it was created from: the record is rejected with `brief_mismatch`, and re-fetching cannot recover the old hash. | The binding is meant to be "this pass answered that brief". It cannot be satisfied when the operation being performed is the one that mutates the brief. The fix is to bind the record to the brief **as issued** (store the hash — or the text — on the record at creation and compare against that), or to keep brief inputs immutable for the duration of a pass. |

Both were worked around honestly rather than hidden: the pass was recorded against the recomputed hash with a `contextNote`
stating that the issued brief was the other one and that the only difference is the emptied dispositions section. The
workaround is not the fix — D1 is a **correctness** defect in the finding lifespan (a deferral that a later pass can
silently undo), and D2 makes the record binding unverifiable exactly when a task has deferred findings.

> **Resolution (2026-09-18).** Both are fixed in kata, each with its reproduction as a test. **D1:** `writeAdversarialRecord`
> carries a decision forward onto the finding of the same id when the new record does not state one — a decision belongs to
> the finding, not to the pass that reported it. **D2:** the brief's known-and-decided section is derived *only* from
> `review.json`, the durable record, never from the pass's own record — so the rule it teaches is **a brief may contain
> only state that recording a pass cannot change**, which is a sharper statement of what a brief is: the question the pass
> answers.

## 11. Addendum — a lost pass: whose defect is it (2026-09-18)

A review pass was dispatched and **vanished**: the job registry no longer lists it, the transcript stops mid-`read` with no
error and no completion, and `review.json` was never written. Everything the reviewer had established in its three minutes
was lost. The instruction that followed — *"write your findings early rather than last"* — is a **workaround at the
delegation layer**, and it has the shape this repository keeps flagging: a human convention standing in for a missing
platform mechanism. Splitting the blame honestly:

| Layer | Share of the defect | Why |
|---|---|---|
| the host runtime | **lost the job** | kata cannot prevent a subagent from dying; nothing in the repository can |
| **kata** | **made the loss total** | a pass has exactly one write point — the record at the end — so a crash leaves nothing recoverable. Meanwhile the **seal**, which is the other long-running operation, already writes a heartbeat (`seal-progress.jsonl`) for exactly this reason. The inconsistency is kata's, not the host's |
| the brief | **asked for everything at the end** | the pass's output contract is a single JSON: verdict, attempts, findings, all or nothing |

So: not a host bug that kata should absorb, but a **kata gap with an existing precedent in kata's own code**. The fix
mirrors the seal:

1. **K1 — heartbeat**: a pass appends one line per hypothesis to `.kata/tasks/<task>/adversarial-progress.jsonl`
   (`hypothesis / method / outcome`), so a crash leaves the reviewer's *work* recoverable even when its verdict is not.
2. **K2 — incremental findings**: findings can land one at a time (`adversarial finding add --change … --node … --json`),
   with the final `record` only sealing the verdict and the revision binding. A crash then costs the unfinished tail, not
   the finished part.
3. **K3 — resumable pass**: once D2 is fixed (the record binds the brief *as issued*), a partial record is a valid
   starting point, so a retry continues instead of re-deriving fifteen minutes of work.
4. **K4 — say it in the brief**: if a pass is expected to write incrementally, the brief must say so; today it cannot,
   because there is nothing to write to.

Until K1/K2 exist, the honest description of the current state is: **a pass that dies takes its evidence with it, and the
only mitigation is a human telling the reviewer to save early** — which is exactly the kind of instruction that should
belong to the platform.
