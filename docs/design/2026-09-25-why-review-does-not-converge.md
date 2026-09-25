# Why the review loop does not converge, and what to change

Written after a day spent driving nine governed changes through this workflow, of which seven reached `archive`. Every number below is
measured; where a claim is an argument rather than a measurement it says so.

## The question

The loop is `verify → review → repair → verify → review …` and it does not stop on its own. Seven changes archived, but only because the
order happened to work; four did not, and two of those were blocked by things no repair could reach. This document separates what is
structural, what is a defect, and what was my own misuse.

---

## 1. Six layers, each measured

### 1.1 A round cannot be the last one — structural, and necessary

A repair changes content. A revision is derived from content. A recorded pass binds the revision it reviewed. So a repair makes the pass
`stale_revision`, and the gate requires a pass **about the current revision**. One pass can certify at most one revision, and any step toward
certifying it moves that revision.

Measured, three times in one day, the cleanest to the minute:

```
kata-gate-surface sealed revision-a118c21c7b83ebbf at 14:24:15 UTC
  → verify PASS · its round returned an accepted record (satisfied: true, defects_found) · review approved
  → judge failed EVERY criterion with stale_evidence
because src/quality/adversarial.ts — a path this change declares — moved at 14:35:14 UTC,
eleven minutes later, when a sibling change's blocking finding was repaired
```

This is the price of independence — a review of content that no longer exists proves nothing — and it is **necessary**. What is not
necessary is that nothing in the workflow expresses it.

### 1.2 Every round finds something — structural

A round's input is the previous round's repairs. Mechanised as AC-3 and measured:

| change | rounds | `targetsAboutThePreviousRound` | share |
|---|---:|---:|---:|
| `closure-gate` | 10 | 10 | 0.53 |
| `repair-by-another-author` | 8 | 8 | 0.73 |
| `kata-gate-surface` | 10 | 8 | 0.57 |

Every finding in every round targets a path the previous round changed. That is the design working: the author cannot see their own blind
spot, which is why the round exists.

### 1.3 The count rises rather than falls — no fixed point

```
closure-gate:  [7, 5, 5, 2, 5, 9, 10, 12, 14, 14]
kata-gate:     [1, 8, 6, 6, 6, 7,  7, 10, 12, 13]
rba:           [7, 6, 5, 5, 6, 8, 10, 10]
```

For a change whose product **is** a mechanism, every repair is new surface. *"Findings reach zero"* is unreachable in this shape, and the
review's termination condition was literally *"dispose of all of them"* — an open set.

### 1.4 Repairing everything — mine, and the largest avoidable cost

The severity bar has always existed: `std` blocks on `blocking` only, `strict` on `blocking` + `major`. I repaired every finding I was
given, including 23 minor/nit findings across five changes — and **each repair mints a revision, which voids the round just paid for**.
Accepting everything below the bar in one pass was the single largest saving of the day.

### 1.5 Shared `ownedPaths` — measured to the minute, three times

```
38 paths are owned by more than one change:
   5× src/cli/ops.ts · 5× src/quality/adversarial.ts · 5× src/workflow/orchestrator.ts
   5× src/quality/repair-obligations.ts · 4× src/cli/matrix.ts · 4× src/quality/evidence.ts
```

Nine changes share six central files, so every repair supersedes its siblings' revisions and **readiness has a shelf life measured in
minutes**. This is the already-recorded constraint #689; what was missing is that nothing in the workflow **says** it. The lever that works is
ordering, not a cleverer binding: run one change's whole cycle and let no other change's edit land in between.

### 1.6 The record is a required output with one unguaranteed channel — was the largest loss

Across every dispatched round with tool calls: **34 produced a record, 28 did not** — and the 28 wrote almost nothing (141 characters across
165 tool calls, in one case). Nothing was lost; nothing was produced. The treatment was one sentence in the dispatch prompt — *"emit a record
by your Nth tool call; the deadline is when the record must first exist, not when the reading stops"* — after which **12 of 13 rounds produced
records**, and the cost per round fell from 8–50 minutes to 3.4–7.7.

The record can also be **malformed**: one pass ran 90 minutes and produced a record missing its closing bracket and its `createdAt`. Both were
repaired, disclosed, and accepted only because the whole record then parsed.

---

## 2. Three structural problems

### 2.1 The certification step is destroyed by the repair it demands

The gate wants a pass about the current revision; the repair it asks for changes the revision. For any change needing more than zero repairs
after its last round, the terminal state is unreachable **by a change whose last step changes nothing**. Independence is necessary; what kata
never did is bound it, price it, or name the shape.

### 2.2 Nothing expresses the order of work

See 1.5. The fix is a measurement (`status` naming which sibling edits would supersede this change) plus a command (`kata-cli lane`) that runs
the cycle and **refuses any edit between the seal and the archive**. Executed by hand once today, that protocol archived a change in a single
pass.

### 2.3 Review's termination condition is an open set

`roundMayClose` (class coverage) exists and is mechanical, but it is an accessory criterion while the gate's own condition is *"all findings
disposed"*. The bound that works is **"no new class"**, not **"no new finding"**.

---

## 3. Nine defects, one shape

Every "the mechanism says A and does B" instance found today belongs to one class: **the vocabulary a mechanism writes is not the vocabulary its
reader uses, or a gate judges by a condition its brief never states.**

| # | defect | evidence |
|---|---|---|
| 1 | `resolves()` requires `observation.ref` to be **exactly** a path, while the brief says *"name something openable at this revision"* | six refs named something openable with line numbers and were refused |
| 2 | `falsify` accepts a `findingId` that matches no finding | four absences were recorded under short ids the preflight never asks for |
| 3 | `abandoned` refuses the round while the brief instructs the pass to record it | a pass that followed the instruction lost its round and two findings, having used 50 of 215 tool calls |
| 4 | `usage` is a self-reported field whose producer has no instrument | one record reported 0 tokens / 0 ms against a measured 134,282 / 3.4 min |
| 5 | `archive` moves its own precondition | two changes sat four days at `judge` because the archive step had moved three of their own declared files |
| 6 | `repair_unresolved_obligations` points at `/kata-build`, which refuses from judge | a ladder exit that cannot be reached |
| 7 | the archive filter read `finding.disposition` while the evidence lives in the falsifier ledger | the refusal named an exit no command could reach (fixed) |
| 8 | a statement containing backticks cannot pass safely through the shell | three names were silently eaten out of an acceptance statement (fixed: `--statement-file`) |
| 9 | the writer recorded the replacement relation but not **which event** produced the write | the consumer inferred the shape from timestamps and `replacedCopyFilter` was wrong in six consecutive versions |

**Measured on the gate's own vocabulary: of 19 refusal reasons, 9 judge the pass, and 6 of those 9 are not stated anywhere in the brief.**

---

## 4. What is not a problem

- **`verify` converges.** It is deterministic over finite artefacts and terminated every time it was run.
- **The gate's conditions are failable and mechanical**: coverage of every criterion the revision changed, every hypothesis converged, every
  observation resolving at the revision, the severity bar, a satisfied pass bound to the current revision. **They were satisfied — seven times
  today.**
- **The falsifier mechanism is the best tool on this line**, at zero token cost: it caught seven decorative checks, three mis-derived
  identities, and one test asserting the implementation against itself.
- **`roundMayClose` gave review the bound it never had**, and `findings` carrying `falsifier` / `impact` / `classInstances` is what made rounds
  falsifiable rather than advisory.

---

## 5. The fix plan, in the order the measurements support

| # | change | evidence | size |
|---|---|---|---|
| **1** | **Invariant: every condition a gate judges by must be stated in the brief it hands out.** A test enumerating the pass-facing refusal reasons and asserting each has a corresponding requirement in the rendered brief — the twin of the existing "every field the brief prescribes is accepted by the writer". | 6 of 9 pass-facing conditions absent; it produced seven refused records today | ~30 lines + one test |
| **2** | **The deadline into the brief's envelope** (`emitByToolCall`), and **the repair layer defaulting to accept anything below the bar** | record rate 34/62 → 12/13; 23 revisions saved | one line each |
| **3** | **`kata-cli lane`**: run the ten-step cycle and refuse edits between the seal and the archive; plus `status` naming which sibling edits would supersede this change | executed by hand, archived a change in one pass; and 11 minutes cost a sibling its certification | medium |
| **4** | **`roundMayClose` becomes the round's conclusion criterion** rather than an accessory to "all findings disposed" | findings per round rise rather than fall | small (mechanism exists) |
| **5** | **`falsify` refuses a `findingId` the task's records do not contain; `usage` is filled by the host, not the pass** | four absences recorded against nothing; a record reporting 0 tokens | small |
| **6** | **A pass's certification binds the content it reviewed**, as dispositions already do (`pathDigests`) | it removes spurious staleness; it does not remove a genuine collision, which needs 3 | medium |
| **7** | **`salvage` assembling a best-effort record** from partial material, reported `inconclusive` | 28 rounds produced nothing, and the malformed-record repairs show the channel leaks in three ways | small |

**Not on the list: a round cap.** It bounds the tail without removing a cause, and it trades quality for cost.

---

## 6. The honest separation

Five of the seven changes archived today did so because the order happened to work. The four that did not were blocked by 2.2 (twice), by
2.1 (once), and by a vacuous acceptance criterion (once — `major-finding-closure`'s `AC-1` is `"Implement the change successfully."` with
`acceptanceMatrix: null`, so the gate prints `check row (none)` while `judge.json` records `AC-1: PASS` with `npm test` as its evidence).

And three of the largest costs were mine rather than kata's: repairing below the severity bar, not serialising changes that share paths, and a
deadline instruction written as "stop" rather than "emit first, keep reading".

**The workflow's problem is not that its gates are wrong. It is that a process whose certification is destroyed by its own repairs, whose
correctness depends on a global ordering, and whose loop has no fixed point for mechanism-building work is presented as a ladder each change
climbs alone.**

## 7. Measured after this document was written: `adversarial-admissibility` stopped at the host wall, and its round found four instances of item 1

The change whose subject is the admission rule itself (`src/quality/review-state.ts`) re-sealed, passed `verify`, and its closing round returned an accepted record — and then the gate refused with **`executor_unavailable`**.

Its four findings are all instances of item 1 in the fix plan, found by a pass reading the module I asked it to read:

| severity | finding |
|---|---|
| **blocking** | the **discharge** conjunct refuses an entire record when any single hypothesis is `inconclusive`, and the brief never says so — while the brief *does* grant that running out of envelope is "a result, not a failure" |
| major | the **grounding** conjunct refuses a `source` ref of the form `path:907-929`, while the brief says only that an observation must *name something openable at this revision* |
| major | the **grounding** conjunct for the `analysis` kind resolves only against instruments the task declared, a registry the brief never mentions |
| major | a **strict** node demands an execution receipt this host cannot produce — architecture #722 working as designed |

**So two of the twelve changes are unarchivable on this host by construction**: this one and `review-record-integrity`, both `strict`, both refused by the same fail-closed capability check rather than by any evidence. That is not a defect; it is the contract doing exactly what it says. What it means practically is that a strict change needs a *different host*, and nothing in the change's own state can say which wall it is behind until it stops hitting the first one — `adversarial-admissibility` spent four days at `hardVerify` believing it needed a round.

The three rule findings are carried with their reasons and are answered by a single change: **state the condition in the brief**.

## 8. The 2.1 case, repaired: `major-finding-closure`'s vacuous criterion

The ladder had already named the step — `next: /kata-design`, reason **`migrate_legacy_acceptance_matrix`** — and the change's `task.acceptance` was a single placeholder:

```json
{ "id": "AC-1", "statement": "Implement the change successfully." }
"acceptanceMatrix": null
```

so the gate's own contract printed `AC-1 — (none) — asserts: (no check answers this criterion)` while `judge.json` recorded `AC-1: PASS` with `npm test` as its evidence. **Two derivations of whether the criterion holds, and the certifying one asserted nothing** — which is why the change looked stuck at `judge` for four days when it was never stuck on freshness.

The migration, in the order the tooling requires:

1. **`task.acceptance`** — four criteria, each a sentence from the change's own spec, replacing the placeholder. (There is no governed command for adding a criterion; the design step's guard permits task-owned `.kata` paths, and `matrix declare` validates rows against `acceptance`, so the acceptance list has to exist first. That is the unverifiable `task.json` write the platform otherwise removes, and it is worth a correction path of its own.)
2. **`matrix declare`** — four rows, each declaring implementation paths, a selector and an evidence row. It refused the first attempt correctly: *"Matrix row references unknown acceptance criterion: AC-2"*.
3. **`claims` attempted and removed.** A claim is a checkable sentence with its own command, and it makes the contract informative — but the claim runner spawns the command directly, and `npx vitest run …` returned **exit 127** for all four, so every claim failed. Rather than shape a command to please the runner, the claims were dropped and the criteria rest on the matrix selectors every other change uses; the contract renders them with the renderer's own honest text, *"(no assertion text declared for this row — check whether the selector tests the criterion)"*.
4. **Seal** → `revision-8068d6e6b564642c`, obligations `2 → 0`, and `verify` PASS with `failedAcceptance 0`.

**The one thing that is not yet answered:** whether the four criteria are *true*, which is the round now running. A criterion written by the author of the code is exactly the claim a review exists to falsify, and I have just written four.
