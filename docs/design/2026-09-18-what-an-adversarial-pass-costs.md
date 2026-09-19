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
   — **Answered (2026-09-19): explicit, and the window is a seal.** A batch is opened by a write
   (`adversarial record`, a node's refusal, or a Judge FAIL) and closed by a successful seal, which is the batch's own
   contract: one seal and one delta round per node per batch. No `repair batch` subcommand is needed, and asking the user to
   run one would make the saving depend on them remembering to.
4. For C5, which hosts can report tokens at all — or is `toolUses` the only portable signal?

## 17. Methodology: why these changes, and when the loop is allowed to stop

§14 says what to change and §16 says who does it. This section says why the changes are the *right* ones in the language of established practice, and it defines the exit condition the workflow currently lacks — because the measurements in §1 describe a loop that ran six times in a day without a definition of done.

### 17.1 Each symptom is a violated principle

| Observed | Principle violated | Practice | Change |
|---|---|---|---|
| A twenty-word text edit cost the same as a refactor (both node passes + a seal) | Verification effort should track **risk and change surface** (risk-based testing, change-impact analysis) | tiered verification: delta by default, claims-only for text, global invariants always | C2, C4 |
| One finding per cycle; three cycles spent only because findings arrived in batches | **Batch size** (lean, theory of constraints: throughput is set by the stage with fixed setup cost) | batch the repairs; one seal and one delta round per node per batch | C1 |
| A false sentence passed the seal *and* verify, and needed a twenty-minute pass to falsify | **Specification should be executable** (BDD, doc-tests, property tests) | every checkable clause becomes a command that runs in the gate | C3, and the project-side checker already installed |
| Fixing a sentence produced the next round's finding | **Narration is not an artifact** — verification holds for what can be tested | a statement about the repository must be produced or checked by a command, or it does not belong in the record | C3, P1 |
| `hardVerify → hardVerify` was an illegal transition; the brief invalidated itself | **Gates are pure functions** (build-system thinking: verdict = f(artifact, policy), cacheable, replayable) | idempotent transitions, content-addressed verdicts, resume = replay | C6 (below) |
| The review gate gained a requirement mid-task; brief modes appeared while passes were running | **A controlled process needs a versioned engine** (release engineering: pin the toolchain) | record the engine version on the task; land engine changes between tasks | C7 (below) |
| The same invariant was punctured in four shapes in one day | **Root cause, not instance** (5 Whys, class fixing) | enumerate the shapes of a category, guard the category, and mutation-test the guard | project-side P3 |
| No `toolUses`, no heartbeat, a lost pass, errors without remedies | **Observability and actionable failure** (SRE) | cost on the record, heartbeats, errors that name the next command | C5 |
| Only two or three rounds found nothing, and the next commit reopened the question | **Definition of done** | see 17.3 | DoD below |

### 17.2 The redefined flow

```
① intake      requirement → acceptance statement + claims[] (a clause and its command) + risk tier
② implement   TDD; class-level guards; every guard demonstrated able to fail
③ batch       one idempotent, replayable seal + one delta round per node (scope = change surface)
④ judge       0 blocking/major ∧ all claims pass ∧ the code pass bound to the code sub-manifest
⑤ archive     deferred findings land in the *next* batch; engine changes only between batches
```

Three differences from today's flow: the verification unit is a **batch plus its delta**, not the whole revision (while the frozen tier still runs in full); **text and code are accounted separately**; and the exit test is **stability**, not one more round.

### 17.3 Definition of done (formalised)

A task may proceed past a gate when all three hold:

1. **Claims**: every `claims[]` entry's command exits successfully, and the claim check itself is demonstrated able to fail (a seeded false claim must red).
2. **Code**: the checks derived from the code sub-manifest pass; frozen-tier checks always included.
3. **Findings**: zero `blocking`/`major`. `minor`/`nit` are recorded with a disposition; they do not gate, and they are not silently dropped — they are carried into the next batch.

And the loop terminates on **stability**: the manifest has not changed since the last verdict. "One more round found nothing" is a stopping *heuristic*; "the artifact is the one that was judged" is a stopping *condition*, and the platform already has the hash to express it.

### 17.4 Two changes this section adds

- **C6 — idempotent seal.** Entering `hardVerify` from `hardVerify` must be a no-op that re-evaluates, not an error: phase transitions are idempotent operations over content-addressed artifacts, and re-running a gate on unchanged content must be free. Found the hard way (an interrupted seal left the phase set; the re-run failed with `Illegal transition from hardVerify to hardVerify` while all six checks passed).
- **C7 — versioned engine.** The task record carries the engine version, and a gate whose behaviour changed mid-task reports that fact instead of silently applying new rules. Today the review gate gained a node requirement and the brief gained a framing mode while passes were in flight; both were improvements, and both cost a diagnostic cycle because the flow could not tell "the rules changed" from "I did something wrong".

### 17.5 What methodology says must not be optimised away

Independent verification, evidence bound to the artifact, and fail-closed severity gating are not overhead — they are the reason a verdict means anything, and today they were the only reason several silent failures were caught at all (§15 lists them). Every optimisation here changes **when** a check runs, **who** runs it, or **how much** of it runs; none changes **whether** a claim gets falsified.

### 17.6 Names for the anti-patterns, so they are recognisable next time

- **Narration as artifact** — prose about the work verified as if it were the work.
- **Gate ceremony** — a full independent audit for a typo, because the unit of verification is the artifact rather than the change.
- **Verification amplification** — each fix enlarging the surface the next verification must cover.
- **Instance fixing** — repairing the discovered shape and leaving the category open.
- **Moving platform** — the process engine changing while the process runs.
- **Unbounded review loop** — iterating until a round happens to find nothing, instead of until the artifact is stable.

## 18. Token economics of an adversarial pass, and the levers that actually move it

§12 priced a pass in wall-clock and §14–§17 say what to change. This section prices it in **tokens**, because that is the number an implementer will be judged on, and because the mechanism is not obvious: a pass does not cost "how much it thought", it costs **how many round-trips it made while carrying an already-large context**.

### 18.1 Measured

| Round | Tokens | Tool uses | Duration | Node |
|---|---|---|---|---|
| r22 | 27.5M | 242 | 5550s | verify (delta) |
| r22 | 23.5M | 221 | 6584s | review (delta) |
| r23 | 20.1M | 214 | 3756s | verify (delta) |
| r23 | 20.6M | 162 | 3239s | review (delta) |
| earlier | 11.2M / 11.8M / 10.3M / 5.7M / 5.7M / 4.0M / 2.7M | 49–132 | 619–1724s | mixed |

⇒ **≈110–130k tokens per tool call** across the recent rounds. That ratio is the whole story.

### 18.2 The mechanism: cost ≈ turns × context, i.e. ~quadratic in turns

Every turn re-sends the current context. With ~200 turns and a context that grows to roughly 100k, cumulative input ≈ Σ(context) ≈ turns × average-context ≈ **20M tokens** — arithmetic, not judgement. Two multipliers:

- **Turns**: each read, each command, each probe run, each output inspection is a turn.
- **Context size**: what the turn has to carry — the audited artifact, the brief, the task record, the sealed evidence, the probe outputs.

Both were large in the rounds above: the artifact under audit was a ~1200-line script (≈15k tokens **per read**, read 4–5 times per hypothesis set), the acceptance statement is ~12KB, the brief ~12KB, and the sealed full-suite logs are tens of thousands of characters. Probe rework (a probe that fails, is fixed, re-run) costs 3–5 turns each time; it happened several times in one round, to the author as well as the reviewer.

### 18.3 What the tokens bought, and what they wasted

**Bought (do not trade away).** Independent derivation of the same facts by two nodes; a counterexample for every conclusion; mutation evidence that each guard can fail; 32 receiver shapes checked for counting equivalence; the clean-checkout proof that the test module actually runs in CI. Every real defect in §15 was found this way, and the *duplication is the independence* — a reviewer that reuses the author's conclusions is not a reviewer.

**Wasted.** Turns that could have been one turn (probes written and run one at a time instead of batched); re-reading a large artifact per hypothesis instead of quoting the region; re-verifying the previous round's fixes in full because the artifact changed; probe rework caused by under-specified probes; and an audited artifact whose size reflects a wrong design choice rather than necessary complexity.

### 18.4 Levers, ranked by measured or structural impact

| Lever | Why it works | Expected effect | Verification |
|---|---|---|---|
| **Batch commands into one invocation** | cost is ≈ turns × context, so cutting turns cuts both factors | total tokens **3–5×** | two consecutive rounds report tool uses; must be lower |
| **Hand a starting reading set with line regions** | removes 10–20 orientation turns | 1–2M tokens/round | the brief carries the set; `cold` rounds must not |
| **Cap attempts (e.g. ≤6 unless a reproduction exists), delta-scope by default** | round length is set by hypothesis count, not delta size | ~2× | attempt counts in the record |
| **Hand over sealed evidence instead of re-running/re-reading** (M1) | the full suite is already sealed and hash-bound | −3–4 minutes, tokens neutral | reviewer cites sealed evidence ids |
| **Keep the audited artifact small** | a 1200-line helper is read many times | context an order of magnitude smaller | artifact size on the path under review |
| **Cheap model for mechanical stages, strong model for judgement** | orientation and probing are pattern work | large, model-dependent | per-agent model on the record |
| **Fewer rounds** (C1 batching, C2 text-only revisions) | 6 cycles × 2 nodes × ~20M ≫ any single-round saving | **halves the total** | seals between two judgements ≤2 |

The last row dominates: the largest term is the **number of rounds**, and rounds are produced by the structure ("every fix re-verifies everything"), not by any single pass being slow.

### 18.5 Contract for a brief (concrete, so it can be implemented)

A brief must carry: the delta surface with file paths; the **starting reading set** with line regions; the instruction to **batch commands into one invocation** — concretely, to **merge several queries
against the same file into one** and to prefer **one test invocation over several**; an attempt cap with the escape hatch ("exceed it only with a reproduction"); the **sealed evidence ids** for anything already verified; and the statement of what this round does *not* cover. It must not carry: the author's conclusions, or mutable state that the act of recording rewrites (§10).

### 18.6 What may not be traded for tokens

Independence, per-conclusion counterexamples, mutation evidence for guards, and the fail-closed gates. §15 lists what each of them caught; a cheaper pass that reuses the author's reasoning, or that concludes from reading rather than running, is not a cheaper pass — it is a different, weaker instrument wearing the same name.

### 18.7 Open questions for the implementer

1. Can `toolUses` (C5) be recorded per **attempt** rather than per pass, so a costly hypothesis is visible while it runs?
2. Is the reading set derivable from the delta + the frozen tier, or must the author curate it?
3. For the attempt cap, is the reproduction escape hatch checkable (the round must show the reproduction), or advisory?
4. Do hosts report tokens at all, or is per-turn tool use the only portable signal?

### 18.8 Measured: why one focused invocation costs more than its tests

| command | wall |
|---|---|
| `pytest <one file> --collect-only` (warm) | 2.6s |
| `pytest tests/test_canonical.py` (13 tests) | 2.7s |
| `pytest tests/test_candidate_key_production_identity.py` (14 tests) | 9.0s |
| `pytest tests/test_assert_acceptance_claims.py` (**38 tests**) | **57.5s** |
| first invocation of a session (cold `uv`/import cache) | 22.5s |

Inside those 38, the five slowest are **13.83 / 8.63 / 8.25 / 8.00 / 0.14 s** — four tests account for
39 of the 40 seconds, and what separates them from the 0.14 s one is that they **spawn a Python
subprocess** (one of them also extracts a `git archive` and copies files). The number of tests is
irrelevant; the number of process launches and tree extractions is the cost.

Two fixes, both cheap, neither weakening what is verified:

- **F1 — amortise the launch inside the suite.** A module-scoped fixture performs the expensive setup
  once: one extracted tree, and one subprocess driven through several observations instead of several
  subprocesses. **Acceptance**: the file runs in ≤15 s **and the mutations it exists to catch still
  fail** (revert the exit-code guard ⇒ red; change a count ⇒ red). The subprocess must remain — it is
  what makes the check exercise the real entry point, which is the property being bought.
- **F2 — batch at the brief level.** "Batch the commands" is too coarse to act on; say *merge several
  queries against the same file into one invocation* and *prefer one test invocation over several*.
  **Acceptance**: consecutive rounds report lower tool uses (C5) at the same attempt counts.

The asymmetry matters: F1 lives in the repository and makes **every** future round cheaper; F2 only
helps while it is obeyed. Both remove waiting, not verification.

## 19. A probe is not a test case, and the difference explains most of a round's motion

A round writes probes, runs them, and rewrites them. That motion looks like thrash; it is partly
necessary and partly avoidable, and the rule that separates the two is worth stating because it is
also what makes later rounds cheaper.

### 19.1 The two instruments answer different questions

| | test case | probe |
|---|---|---|
| what it asserts | the intended behaviour | **sensitivity** — if this condition breaks, does anything object? |
| where the expectation comes from | the specification, fixed in advance | the reviewer's **prediction**, formed at that moment, allowed to be wrong |
| what a failure means | the code violates the spec | one of two things: the code is wrong, **or the experiment is** (wrong seam, wrong interface, injection missed) |
| lifetime | permanent; runs in CI | discarded once it has answered |
| typical action | invoke normally, assert the result | **destructive**: inject the old implementation, change a number, delete a marker, corrupt a file |

Because a probe's expectation is a prediction rather than a requirement, an error is ambiguous until
the reviewer separates "the code is wrong" from "my experiment is wrong". That separation is most of
the motion in a round, and it is not visible in a plan — only in the transcript.

### 19.2 Why a probe changes, ranked by whether the change was avoidable

1. **Learning the interface — legitimate, and avoidable by a reading set.** The first probe encodes a
   guess about how to drive the system; an error means the guess was wrong, not that the code is.
   Measured example: reaching a candidate row requires `register_source → ingest_text →
   SegmentAdapter → CompilePipeline` before anything can be asserted.
2. **The property is fixed, the sensitivity deepens — legitimate.** "Is the count independent of how
   the receiver is spelled?" needed thirty-two receiver shapes only after the first probe revealed
   that counting keyed on a name pattern. The question never changed; the experiment did.
3. **Wrong seam — legitimate and necessary.** Calling the entry point in-process and running the real
   CLI subprocess can disagree, and for an exit-code contract only the second answers the question.
4. **Destructive scaffolding — necessary and error-prone.** Temporary copies, restores, and an
   assertion that the injection actually landed. Measured failure: an injection whose target string
   no longer existed ran **zero** times and exited 0 — read naively it says "the guard does not fire"
   when it says "the probe never fired it". The fix is to assert the hit count.
5. **Environment friction — pure waste.** Working directory, `PATH` for `uv`/`node`, an ignored
   `.kata` directory that makes a test unrunnable, a shared database schema colliding under
   concurrency.

### 19.3 The rule that makes later rounds cheaper: promote

A probe that reveals a **permanent** property should become a test case. Then the next round writes no
experiment at all — it mutates the code under the existing test and observes. Order:

1. **Ask whether an existing test already encodes the property.** If it does, mutate the code and
   watch it fail: two commands, no new code.
2. Otherwise write a probe — but **state the prediction before running**, so a wrong prediction is
   diagnostic instead of ambiguous.
3. **Assert the injection hit.** A no-op mutation must be impossible to mistake for an insensitive
   guard.
4. **Promote** anything permanent into the suite and name it; discard the rest.

The consequence belongs in a cost document: motion and tokens per round should **decline** as
properties accumulate as tests. Today they did not — three consecutive rounds rewrote experiments for
the same class of property (the checker's own guards), because the properties were re-probed instead of
promoted. A promoted property also changes the *kind* of work left: only 19.2 case 2 remains, and that
is the only one worth paying for.

### 19.4 What the brief must therefore require

- Is there an existing test for this property? If yes, **mutate rather than write**.
- State the prediction before running the probe.
- Assert the injection landed; a zero-hit mutation is a probe failure, not a finding.
- Promote permanent properties and say which; the round's cost should fall next time.
- Batch commands, and cap attempts.

## 21. What a real loop looked like, and the three things it says the platform is missing

One task ran into a loop that every round refreshed. The rounds are the evidence, grouped by **which
layer** their findings were about:

| rounds | layer the findings were about |
|---|---|
| r17–r18 | the **product** (candidate identity through ordering; cluster identity as a positional index) and one governance statement |
| r19–r20 | a governance statement (the same one, twice) and a test guard that claimed an ordered comparison while comparing a dict |
| r21 | a document claiming an instrument existed |
| r22–r24 | **only** the instrument: `scripts/assert_acceptance_claims.py`, its carrier, its mirror, its tests |

Product-layer findings **stopped after r18**; everything after was the tooling introduced to satisfy a
process rule mid-task. That is a platform-shaped failure, not a discipline failure, and it has three
causes worth fixing in kata.

### 21.1 Owned paths need a third class: the instrument

C2 split code from governance text. A task also carries **instruments** — verification tooling written
during the task to check the deliverables (a claim checker, a probe harness, a shadow runner). Treated
as a deliverable, an instrument is audited to the same standard, which is how five consecutive rounds
became an arms race against a guard's coverage boundary: an adversarial search on a guard always finds
the unguarded dimension, so it terminates only when the guard is deleted or its boundary is *declared*.

**Change.** Declare instruments in the task record (`ownedPaths` tiers, or an `instruments: []` list),
and let the adversarial gate treat their findings as advisory unless the finding contradicts a
**declaration** (see 21.2). Deliverable-grade rules continue to apply to the deliverable.

### 21.2 A declared coverage boundary makes boundary-attacks closeable

Today a finding is either repaired or — for blocking/major — not deferrable at all. But "your guard
does not cover dimension X" is often a *design boundary*, not a defect: the guard was never meant to
cover X, and saying so is the resolution.

**Change.** Let a task carry a **boundary declaration** for an instrument (what it covers, what it does
not, and where the single canonical statement of that lives), and classify findings as
`within-declared-coverage` or `beyond-declared-coverage`. The first must be repaired; the second is
closeable with the declaration as the reason, and the closing reason is displayed at review/judge/archive
so it cannot be used to bury anything silently. Without this, an adversarial search against any guard
has no terminating condition.

### 21.3 Scope growth must re-enter design, not drift

This task's audited surface grew silently: a script, then a carrier, then a mirror, then tests for all
three — each addition expanding what the gate considered in scope, with no decision point where the
cost was visible. Every addition also invalidated the evidence, restarting the search.

**Change.** Adding a path (or an instrument) mid-task requires a recorded scope change with its reason,
and it resets the delta base. The cost is then a decision the task makes on purpose rather than a drift
the rounds absorb. This is the missing half of C1: batching controls how often a round happens, and this
controls what a round is *about*.

### 21.4 Convergence must be a query, not a reconstruction

Assembling the table at the top of this section required reading ~10 round records by hand. C5 puts cost
on the record; the same treatment belongs to findings: **layer** (deliverable / governance / instrument)
and **severity** per revision, so "are we converging, and on what" is answerable in one command — and so
a loop of the kind described here is visible while it is happening rather than in hindsight.

### 21.5 When the platform ships what a task hand-rolled, say so

C3 (machine-checkable acceptance claims, executed by the seal) landed *after* this task wrote its own
checker — the same capability, built twice, and the second build is what the rounds then attacked. A task
holding a hand-rolled equivalent of a shipped capability should be told (a migration note on the task),
because the alternative is exactly what happened here: an instrument maintained under adversarial fire
until someone decides to freeze it.

### 21.6 What this does not excuse

The loop had two other ingredients that no platform change fixes: repairs that reintroduced the class of
defect they were fixing (four of six), and single-finding rounds instead of batches (three cycles of
six). 21.1–21.5 remove the structural amplifier; C1 and the definition of done in 17.3 address the rest.

## 22. When the two nodes run: the trigger is too coarse, not too frequent

The gate asks for a fresh independent pass on both the verify and the review node **whenever the
revision changes**, and a pass costs 15–110 minutes and 5–27M tokens (§1, §18). The mismatch is in
granularity: the trigger is the whole revision, while the cost is priced as an audit of a `surface`.

### 22.1 The evidence, from one day

| Observation | Measured |
|---|---|
| The trigger is "the revision changed" | Any commit — including a documentation edit, a test-only fix, or an edit to an **instrument** — invalidates both nodes' records at once |
| The two nodes audit **the same thing** | r24 verify and r24 review independently found the same two defects (a false claim in a generated block's header; a mirror path reported as missing); r24b reproduced both again. One audit, paid twice |
| The trigger is over-sensitive to instruments | Four consecutive rounds (r21–r24) audited only `scripts/assert_acceptance_claims.py`, its carrier, its mirror and their tests |
| The marginal value was front-loaded | **Zero product-layer findings after r18**; every later finding was about an instrument or governance text |
| Volume | ~10 rounds (15–110 min each) and 7 seals in the day; at least **4 rounds were repeats of an audit already performed** on the same surface |

### 22.2 What the trigger should bind to

**A — a per-node surface digest.** Each node declares the surface it audits (verify: the acceptance
clauses, evidence freshness, and the implementation paths that serve them; review: the contract and the
diff's code). The record carries that surface's digest. **An unchanged digest keeps the record valid.**
A documentation edit, an instrument edit, or a change to paths the node never examined stops
invalidating a pass it never made.
*Acceptance*: editing only docs or an instrument ⇒ no invalidation of the code-surface record, and
`status` says which surface the record covers. *Invariant*: a change **inside** the surface always
invalidates, and an underivable surface falls back to invalidating everything and says so.

**B — the two nodes must differ, or be one.** Today's briefs were near-isomorphic and the nodes
converged on identical findings — two audits bought one fact. Either merge them into a single
independent audit (cheap, honest) or give them **disjoint** scopes: verify = *does the implementation
satisfy the acceptance, with fresh evidence*; review = *is the contract sound, and is the diff
well-built*. Disjoint scopes also make the surface digests (A) genuinely different, which is what makes
per-surface validity meaningful.
*Acceptance*: a task shows a finding attributed to exactly one node, or explains why both reported it.

**C — the frozen tier runs at every judgement point.** Unchanged from C4: whatever the surface is, the
global invariants run before anything is accepted.

**D — the seal binds to the same surface digest.** Today's sequence was self-defeating: seal → verify →
review, where the seal itself changed the tree and invalidated the records it had just been used to
produce. A seal that binds its own surface digest removes the "audit, then invalidate, then audit again"
cycle.
*Acceptance*: a seal followed by a judgement shows no revision-invalidated record in between.

### 22.3 What may not change, and why the binding exists at all

Evidence must not outlive the artifact it describes. That rule earned its place twice today: it caught a
pass whose record predated the tree it claimed to describe, and it caught my own audit of a tree that had
since been reverted. So the binding stays — **what changes is the object it binds to**: from "the whole
revision" to "the semantic surface the node actually audited". Nothing here allows a verdict about code
to survive a change to that code.

### 22.4 Open questions

1. Is a surface digest derivable from the owned-path tiers (deliverable / governance / instrument, §21.1),
   or must the node declare its surface in the brief?
2. Does merging the two nodes lose anything that disjoint scopes would keep — and which is cheaper in
   practice given that today's value was front-loaded?
3. Should a node's record be invalidated by *any* change to its surface, or only by a change to the
   **claims and evidence** it verified (i.e. a digest over assertions rather than files)?

## 23. Handoff index (for whoever picks this up)

Read in this order; each section stands alone but the numbering is the argument.

| § | Content | Use |
|---|---|---|
| 1–12 | Measurements: what a pass costs in wall-clock; where the minutes go; the mechanisms priced one by one | the evidence base |
| 13 | Per-round audits of what each expensive round bought | calibrate scepticism against data, not vibes |
| **14** | **The five changes (C1–C5), each with evidence, acceptance test, invariant** | the work list |
| **15** | **What must not change, with the defects each thing caught** | the guard rails |
| **16** | **Handoff: owners (K/P), order, dependencies, interfaces, traps, open questions** | the施工 order |
| **17** | **Methodology: symptom → violated principle → practice; redefined flow; Definition of Done; C6/C7; anti-pattern names** | why, and when the loop may stop |
| **18** | **Token economics: turns × context; what was bought vs wasted; ranked levers; brief contract; §18.8 the measured cost of one focused invocation and its two fixes** | the efficiency work |
| **19** | **Probes vs test cases: why an experiment changes while a property must not; the promotion rule; what a brief must require** | the verification work |
| **21** | **The loop: findings by layer per round; the three missing platform pieces — instrument class, declared boundaries, scope-change re-entry; convergence telemetry** | the platform gaps this task found |
| **22** | **When the two nodes run: per-node surface digests, why the two nodes duplicate, seal binding, and the invariant that survives** | the trigger design |
| 23 | This index | orientation |

Current status of the C-list (as of 2026-09-19). **All of C1–C7 are implemented**; the commit column is the evidence, and
the row's *what it actually does* is what a reader should check rather than the commit message.

| # | Change | Commit | What it actually does |
|---|---|---|---|
| **C1** | Repair batching | `a013925`, **wired `409b8db`** | `repair-batch.json`; opening a batch **extends** the open one (one seal per batch, not per finding); closing is **refused** while a terminal finding it opened for is unaccounted — repaired, deferred **with a reason**, or no longer reported; `batchSaving` counts the seals avoided from the record. **Correction (2026-09-19, reported from outside and reproduced): the first version had no producer** — `openRepairBatch`/`closeRepairBatch` were called from tests only, so C4's delta default could never fire. Producers now sit at the write (`adversarial record`), at the node refusals, and at a Judge FAIL; the closer runs after a successful seal; and the base revision is **stamped when the batch opens**, under the name `baseRevisionId` (not `closedByRevisionId`, which read as "the revision it closed on" and would have made every delta empty) |
| **C2** | Text-only revisions spare the code pass | `0684cf5` + `0d77a90` | `codeManifestHash` stamped beside `manifestHash` on every binding artefact; `bindsToRevision` gains an **opt-in** `code` scope and its default stays `full`; the adversarial gate spares a pass only when both sides name the same code surface **and** `claimsVerified` — read from evidence, defaulting to `false` |
| **C3** | Machine-checkable acceptance statements | `7eee82e` + `76649a0` | `acceptance[].claims[]`; the seal **runs** them as ordinary checks; an unfalsifiable claim is a preflight blocker; failures are reported **by claim id** in both the passing and failing paths |
| **C4** | Delta by default after a batch | `6661f3c` | `defaultBriefScope`: a batch closed on a revision ⇒ delta from it; no closed batch, or one that named no revision ⇒ full **with its reason**; an explicit `--since` still wins; the reason travels as `scopeReason` |
| **C5** | Cost telemetry and a pass heartbeat | `ca2b212` + `f624bae` | `toolUses` beside `elapsedMs`; `adversarial-progress.jsonl`, one line per **batch** (the §12 trap); `adversarial status` reports both; a partial pass is a draft with **no verdict**, so it can never read as passed |
| **C6** | Idempotent phase entry | `cf3e19d` | re-entering the phase a task is in returns the state unchanged, writes no event, and is a **separate question** from `isLegalPhaseTransition` (which recovery replays against) |
| **C7** | Versioned engine | `dd3eb38` | the task record carries the kata version, restamped inside the state transition; `status` reports a mismatch and says it is an engine change — **reported, never enforced** |

Also implemented, from §18's levers rather than the C-list: the brief's **starting reading set** with a bounded size (M4),
its instruction to **read sealed evidence instead of re-running it** (M1), and the **`verify`/`cold` framing rotation**
(M2), which refuses to rotate while a `blocking`/`major` finding is unrepaired.

Four platform defects fixed the same day, kept here as reference implementations of the shape these changes keep taking —
*a mechanism that exists but is not wired*: `cfe616a` and `be7b196` (review→build and judge→build repair re-entry from a
superseded revision), `aed3006` (an evidence name its own schema rejected), `49d1aae` (a recorded pass invalidated by the
act of recording it — four independent drift sources), `dd3eb38` (C7).

Still open, and deliberately not done here: §18.7's four questions (per-attempt `toolUses`; whether the reading set is
derivable or curated; whether the attempt cap's reproduction escape hatch is checkable; whether any host reports tokens at
all — today `toolUses` is the only portable signal).

Two project-side notes, for context rather than as kata requirements: a project may install an interim checker of its own (k2skills did, for one acceptance statement) — it is explicitly a stopgap with a stated retirement condition once C3's claims cover the same clauses; and a handoff of this document does not authorise changes to any project's repository, only to this one.
