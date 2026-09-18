# What an adversarial pass costs, and how to brief one

> Status: **M1, M3, M4 delivered; M2 delivered; K1–K4 delivered** (2026-09-18, kata `ca2b212`, `f624bae`, `c57e943`). The two-round measurement they enable exists as a test (`e616f85`) — see §14. Scope: the *pass itself* — how `kata-cli adversarial brief` scopes one, and what the
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

**Update (2026-09-19, after the fix was implemented):** the paragraph below describes the workaround, not a resolution. The
real mechanism has **four** volatility sources, not one — the framing rotation reads the previous pass, the reading set is
derived from the working tree, the review phase resets `review.json`, and the gate rendered the brief *without* `--since`, so
a delta round could never be satisfied at all. The fix binds a record to the **brief as issued** (`adversarial-briefs/<node>-<revision>.json`),
with the gate matching against that pool and rejecting anything never issued (`brief_not_issued`) — see the kata changelog
`2026-09-19-adversarial-brief-bound-as-issued.md`. D1's other half is fixed too: a `deferred` decision now survives a pass
that simply stops mentioning it, while blocking/major are deliberately not carried (they cannot be dispositioned).

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

The exact shapes, the batching rule that keeps K1 from *costing* turns, and the acceptance tests are in §13; §12 prices
every mechanism in this document before anyone implements one.

Until K1/K2 exist, the honest description of the current state is: **a pass that dies takes its evidence with it, and the
only mitigation is a human telling the reviewer to save early** — which is exactly the kind of instruction that should
belong to the platform.

## 12. What each mechanism costs (measure this before adopting)

Every proposal here trades something. The numbers are from the seven passes in §1 (median ≈940s, 38–132 turns per pass,
≈17s per turn including the command wait), so they describe the *shape* of the trade rather than a benchmark:

| Mechanism | Wall clock | Tokens | Condition that flips it |
|---|---|---|---|
| **M4** reading set in the brief | **saves** | **saves most** | Orientation is 10–20 reads per pass (a 500-line file is ≈5–15k tokens each) ⇒ roughly **−75–200k tokens per pass**; the brief itself grows by a few KB |
| **M3** batched execution + cost signal | **saves** | **saves** | The turn term is the dominant cost (5–12 min); one extra invocation is one extra turn. The signal itself is a few hundred bytes |
| **M1** read sealed evidence, do not re-run | **saves ~3–4 min** | roughly neutral | Measured on the round that spent ~205s of 935s on two full suites; reading the same log costs one turn and the log it would have read anyway |
| **M2** `verify`/`cold` rotation | **costs on `cold` rounds** | **costs on `cold` rounds** | A `cold` brief removes the author's claims, so the reviewer orients itself: estimate **+20–40%** against a comparable `verify` round. This is the price of independence, paid deliberately |
| **D1** dispositions survive a new pass | saves | saves | A resurrected nit invites another round, and its id can no longer even be deferred (reproduced in §10) |
| **D2** bind the brief as issued | saves | saves | Today it costs a rejected record plus a re-derivation |
| **K3** resumable pass | saves only when a pass dies | same | On the happy path: zero. After a crash: an entire re-run (15–25 min, millions of tokens) |
| **K2** incremental findings | +1–3 turns | slightly up | Buys "a crash costs the unfinished tail, not the finished part" |
| **K1** heartbeat | **can cost 5–15 turns** | **can cost** | **The trap.** One append per hypothesis = one extra invocation per hypothesis. It must be written **in the same invocation as the check it accompanies**, one line per batch (§13). Implemented naively it eats most of what M3/M4 save |
| **K4** brief says "write incrementally" | 0 | 0 | One line |

**Summary:** on the ordinary path the mechanisms should take a pass from ≈16 min to ≈8–10 min and cut tokens by 20–40%,
because what they remove is waste (re-running what is already sealed, re-orienting from scratch) rather than depth.
`cold` rounds get *more* expensive on purpose. Everything above is arithmetic on turn counts — kata records only
`elapsedMs` today, which is why **M3's `toolUses` should land first and alone**: two rounds of real data decide the rest
far better than this table does.

**The one cost that is not in the table:** cutting turns also cuts the room to *stumble* onto an unclaimed defect (the
largest catch in §9 was found in a file nobody had named). That is why M1/M3/M4 only remove waste, and why M2 keeps the
`cold` round long and broad instead of making every round cheaper.

## 13. K1–K4 as an implementable spec

**Shared rule (the trap from §12):** every incremental write MUST ride along with a command the pass is already running —
one append per batch, never one per hypothesis. If a reviewer must make a separate invocation to record what it just
learned, the mechanism costs more than it saves.

### K1 — heartbeat

- **Where:** `.kata/tasks/<taskId>/adversarial-progress.jsonl` (mirrors `seal-progress.jsonl`).
- **Line shape:** `{"type":"attempt","at":"<ISO>","node":"verify","hypothesis":"…","method":"…","outcome":"refuted|confirmed|inconclusive"}`,
  append-only, one line per **batch** of work (the batch that just ran), not per hypothesis.
- **How it is written:** the same invocation that runs the reviewer's checks may append the line (a small `kata-cli
  adversarial note --change <id> --from-file <line.json>` is enough); a pass that finishes normally may write it in one
  call at the end.
- **Read side:** `adversarial status` reports the heartbeat's line count and last line, so "a pass is alive and where it
  is" is answerable from outside — the same reason the seal got one.
- **Acceptance:** kill a pass after its first batch; the file holds that batch, and `adversarial status` shows it.

### K2 — incremental findings

- **Command:** `kata-cli adversarial finding add --change <taskId> --node verify --from-file <finding.json>` — same
  finding shape and validation as `record` today (severity enum, non-empty message/path).
- **Storage:** findings land in the node's record as they arrive; the record is **append-only** for findings until
  `record` seals it.
- **`record` becomes:** verdict + revision binding + `briefSha256` + `scope` + `elapsedMs`/`toolUses`; it no longer has to
  carry the findings (it validates that at least one attempt exists, exactly as today).
- **Acceptance:** add two findings, kill the pass, run `record` with a verdict ⇒ both findings survive; the gate evaluates
  them the same way it evaluates findings that arrived in one file.

### K3 — resumable pass

- **Depends on D2**: the record binds the brief **as issued** (store `briefSha256` at creation and validate against that,
  never against a freshly recomputed brief).
- **Behaviour:** if a partial record exists for the current revision and brief, a retry continues it — it may add findings
  and attempts, and `record` seals whatever is there.
- **Acceptance:** a partial record + a second pass produces one record with both passes' attempts, and the gate reports a
  single `scope` for it.

### K4 — the brief says so

- The brief's output contract gains one sentence: findings and attempts may be written **as the pass proceeds** (the
  commands above), and a pass that dies mid-way keeps whatever it wrote.
- It also states the batching rule verbatim, so the reviewer does not trade 15 turns for crash-resilience.

**Sequence:** K1 (with the batching rule) and M3's `toolUses` first — both are small, neither changes what counts as
evidence, and together they make the rest measurable. K2/K3 follow once D2 is fixed, since "resume" is meaningless while
the binding can be invalidated by the write itself.

## 14. What was delivered, and what the loop does not yet prove (2026-09-18)

| Mechanism | Where it landed | What changed in practice |
|---|---|---|
| **M1** read sealed evidence | `ca2b212` | the brief lists each envelope with its path and flags the project-declared checks; on the real task: 16 evidence lines, 4 flagged |
| **M3** cost signal | `ca2b212` | `toolUses` beside `elapsedMs` on the record (`--tool-uses`), so the two terms of §1 are separable; one "Pacing yourself" line in the brief |
| **M4** reading set | `ca2b212` | derived from the change surface and the matrix's collaborators; bounded to 40 and framed as *a starting set, not a boundary* — a clean working tree is not "nothing to read", and 702 entries is a wall, not orientation (both corrections measured, not guessed) |
| **M2** framing rotation | `c57e943` | `verify` / `cold`, rotated by default with the reason written into the brief; **refuses to rotate while a `blocking`/`major` finding is unrepaired** — a deploy-time decision recorded in the code rather than left open |
| **K1–K4** a pass survives its death | `f624bae` | `adversarial-progress.jsonl` (one line per **batch**, the trap from §12) reported by `status`; `adversarial finding add` lands findings as they are confirmed, and a record created that way is a **draft with no verdict**, so partial can never read as passed; the brief says so (K4) |
| **K3** resumable | `f624bae` | binding the brief *as issued* needed no stored copy: after the D2 fix the brief derives only from durable state, so re-deriving it is an identity function. `BRIEF_DURABLE_INPUTS` / `BRIEF_VOLATILE_INPUTS` write the input surface down |

**The loop exists** (`e616f85`): a test drives two rounds on a fixture whose checks are shell commands — evidence → per-path
digests → revision → one file changes → the delta names exactly that file → the derived set falls back to full with its
reason → both rounds land on the record with the baseline snapshotted, so the saving computes (**540 s and 29 turns** on the
fixture).

**What it still does not prove:** the §11 projection. The fixture's rounds are constructed costs, and the real saving needs
a real pass — the mechanism only makes the number *obtainable* rather than remembered. Two rounds of real data decide the
rest far better than §12's arithmetic, which is what §12 itself says.

## 14. The five changes today's measurements justify

Measured on one task in one day: **79 commits, 26 revision snapshots, 22 completed seals, 20 adversarial passes, 6 fix→seal→pass cycles**, at **1.2–2 hours per cycle** (each cycle = one repair round + one seal + one pass per node; seals are 3–6 min, passes 11–35 min). Every number below is from that run; §12 prices the mechanisms, this section is the施工 order.

### C1 — Repair in batches, not per finding

- **Evidence.** Three of the six cycles existed only because findings arriving from the two nodes were repaired in separate batches: every batch produced a new revision, which invalidated **both** node passes, so the second batch paid a full re-verification for work that was discovered during the first.
- **Change.** Give the task a repair-batch concept: findings accumulate as `open`; a batch is opened, repaired, and closed; **the seal and one delta round per node happen at batch close**, not per finding. `findings defer|carry` already exist for what the batch does not answer.
- **Acceptance.** On a task with ≥3 findings from two nodes, the number of seals between two judgements is ≤2, and the record states which findings the batch answered.
- **Invariant.** The severity gate is unchanged: blocking (and major in strict) must still be repaired before progression, and a batch may not silently drop one.

### C2 — A text-only revision must not invalidate code-verifying passes

- **Evidence.** Three cycles today were pure governance-text edits (one acceptance statement, three rewrites); each cost ≈1 hour of re-verification for ~20 words.
- **Change.** Classify owned paths (code vs docs/governance) and bind the code pass to the **code sub-manifest**. A revision whose manifest differs only in non-code paths invalidates a *claims pass*, not the code pass.
- **Acceptance.** Editing only a docs/acceptance statement ⇒ one seal + one claims pass, with the code pass still satisfied; editing code still invalidates both.
- **Invariant.** A text edit may never leave a **stale truth claim** satisfied — which is exactly why the claims pass exists (C3). If the claims pass cannot be derived, the change falls back to full invalidation and says so.

### C3 — Machine-checkable acceptance statements (`claims[]`)

- **Evidence.** A false sentence in the acceptance text passed the seal **and** verify, and was caught only by the next adversarial round — twice. Prose has no test; code does.
- **Change.** Schema: `acceptance[].claims[] = {id, statement, check: {command, expect}}`; the seal executes claim checks like any other check and records evidence; a failing claim is a blocking-class failure. The generated evidence table (statement → counts → file:line) is the check's payload, so the sentence and the command cannot drift.
- **Acceptance.** A seeded false claim (statement contradicting the code) fails the seal; a true one passes; editing the statement forces its check to re-run.
- **Invariant.** Claims are **additional** evidence: they never replace the adversarial pass, and every claim check must be demonstrated able to fail (mutation-tested).

### C4 — Delta re-verification as the default after a batch

- **Evidence.** Delta rounds today ran 11–18 min against 15–35 min for full-scope rounds, and the mechanism (`--since`, F2) already existed but was not the default.
- **Change.** After a repair batch the default brief is delta-scoped; full scope is reserved for the first round after intake, after a design-level change, and at freeze/judge. The brief states its scope and what it excluded.
- **Acceptance.** Post-batch briefs carry `scope.kind = delta` with the change surface; `adversarial status` reports the saving.
- **Invariant.** Frozen-tier checks always run; an underivable surface falls back to full **and says so** (F4 already behaves this way).

### C5 — Cost telemetry and a pass heartbeat

- **Evidence.** Records carry `elapsedMs` but no `toolUses`/tokens, so every cost claim in this document is arithmetic on turn counts; and one pass today vanished mid-run with nothing on disk, where the seal has had `seal-progress.jsonl` for exactly this reason.
- **Change.** `toolUses` (and tokens where the host reports them) on the record; an `adversarial-progress.jsonl` heartbeat written **in the same invocation as a check** — never one write per hypothesis (§12 measures why); `adversarial status` shows both.
- **Acceptance.** A killed pass leaves ≥1 heartbeat line and `status` reports it; two consecutive passes report their turn counts.
- **Invariant.** The heartbeat must not cost a turn per hypothesis — an incremental write that needs its own invocation costs more than it saves.

## 15. What must not change

Today's cheapest-looking optimizations are the ones that would hurt most. Concretely, keep:

- **The independent pass itself.** It found, on the same day: a candidate identity still carrying runtime handles through *four* further routes, a publish gate that skipped and therefore proved nothing, three false statements in the acceptance text, a guard whose claim of testing order did not hold, and three majors in a review round. Several would have shipped silently.
- **Evidence↔revision binding.** It has already caught evidence that outlived the tree it described.
- **Severity-gated repair authorization and fail-closed gates.** Both were exercised today; both are why a "green" run could not be trusted into a wrong conclusion.
- **No verdict without an executed counterexample, and destructive falsification where it applies.** Every real defect above came from someone running something, not from reading.
- **The rule that optimisation may change *when* a check runs and *who* runs it — never *whether* a claim is falsified.**

## 16. Handoff: who does what, in what order

§14 lists the five changes and §15 what may not move. This section is the handoff — it says which side owns each piece, in which order, with what interface, and how the owner proves it.

**Owners.** `K` = the kata implementer (this repository). `P` = the project side (the repository consuming kata; today k2skills). Anything a project can do without platform support is `P`, and anything that must hold for *every* project is `K` — a project-specific branch or flag is a rejected design (see §4 M4's boundary rule).

### Order, with dependencies

| Step | Owner | Deliverable | Depends on |
|---|---|---|---|
| **1** | K | **C5 cost signal**: `toolUses` on the adversarial record + schema; `adversarial-progress.jsonl` heartbeat; `adversarial status` shows both | — |
| **2** | P | **Claim checker** (`scripts/assert_acceptance_claims.py`): the checkable clauses of an acceptance statement executed as commands; wired into the project's check set | — |
| **3** | K | **C3 claim checks**: `acceptance[].claims[]` in the task schema; the seal runs them; a failing claim is a blocking-class failure; brief/verify surface it | 2 (the shape P already uses) |
| **4** | K | **C4 delta by default after a repair batch**; full scope only after intake, a design-level change, or at freeze/judge | 1 (needs the scope in the record) |
| **5** | K | **C1 repair batch**: findings accumulate; a batch is opened/repaired/closed; one seal + one delta round per node per batch | 4 |
| **6** | K | **C2 text-only revisions invalidate the claims pass, not the code pass** (code pass bound to the code sub-manifest) | 3 (the claims pass is what keeps a text edit honest) |

Steps 1 and 2 are independent and can proceed in parallel tonight; 3 lands on top of the shape 2 establishes; 6 is only safe once 3 exists — otherwise a text edit could leave a stale truth claim satisfied.

### Interfaces (exact)

- **Claims.** `acceptance[].claims[] = {id, statement, check: {command, expect?}}`. The seal executes `check.command`; a non-zero exit or an `expect` mismatch is a **blocking-class** failure bound to that acceptance. The generated evidence table (clause → measured counts → `file:line`) is the check's payload, so the sentence and the command cannot drift.
- **Claim failure surfaces.** A failing claim must be visible in the brief, in `verify`, and in the seal report **by claim id**, not only as a red run.
- **`coveredBy`.** The resolver already honours it (a covered check is not executed, its declaration is credited, and the seal lists `coveredChecks`). The **generated** copy at `<project>/.kata/schemas/task.schema.json` is stale and rejects the field (`additionalProperties: false`) while `kata/schemas/task.schema.json:333` allows it — so refreshing the generated copy is a prerequisite for projects to declare coverage without failing their own schema check.
- **Telemetry.** `toolUses` (and tokens where the host reports them) on the adversarial record; a heartbeat whose **contract is one line per batch, written in the same invocation as the check it accompanies** — a write that needs its own invocation costs a turn and eats the saving (§12).
- **Record safety.** `record` must validate before writing (it already does after today's fix): a rejected record must never destroy a valid one. Keep that property when adding claims.

### Verification each owner owes

- **Every new gate must be demonstrated able to fail** (mutation evidence: revert the fix, watch it red, restore). Two guards today were caught claiming a property they did not test — a dictionary comparison that ignores insertion order, and a shape check that could not fail. Treat "this guard tests X" as a claim requiring evidence.
- **Every claim check must be seeded false once** (a statement contradicting the code) and observed failing the seal.
- Acceptance for the batch itself: on a task with ≥3 findings from two nodes, seals between two judgements ≤2, and the record states which findings the batch answered.

### Known traps (measured today)

- `kata-cli` runs `dist/cli.js`: any `src/` edit needs `node scripts/build.mjs`.
- The generated `.kata/schemas/*` copy can lag the kata package; a project then fails its own schema validation for a field the platform supports.
- Two agents can share one working tree: stage explicit paths only, never `git add -A`.
- The brief must never embed state that the act of recording mutates (the four sources are listed in §10's update).

### Open questions for the kata owner

1. Can a claim check be **derived** from the statement mechanically for the common shapes ("no caller in category X", "no subcommand named Y", "path matches template Z"), or does every project keep its own script? (P's script is the proof of the common shapes.)
2. For C2, is the code/non-code split derived from the owned-path globs, or declared per path?
3. For C1, is a batch an explicit state transition (`repair batch start|close`) or an implicit window between two seals?
4. For C5, which hosts can report tokens at all — or is `toolUses` the only portable signal?
