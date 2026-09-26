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
| **3** | **`kata-cli lane`**: run the ten-step cycle and refuse edits between the seal and the archive; plus `status` naming which sibling edits would supersede this change | executed by hand, archived a change in one pass; and 11 minutes cost a sibling its certification | medium — **landed as the decision, not the cycle**: `lane` reports and `--require-current` refuses (with a non-zero exit status, which the first version lacked — a guard whose exit code is 0 refuses nothing, measured by `aad-r7-f2`); running the ten-step cycle is still an operator's job, deliberately, because a command that runs a cycle cannot prevent the edit that breaks it |
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

## 9. `major-finding-closure` archived — and the round audited the criteria I had migrated an hour earlier

Eight archived. The migration of §8 completed: seal `revision-8068d6e6b564642c` → verify PASS → one round → record accepted → review approved → **judge PASS on all four criteria** → archive.

**And the round did exactly what it was dispatched for: it checked whether my four criteria are tested by their selectors, and found three of them wider than their checks** — including, in its own words, a defect in *the invariant I landed the same hour*:

| finding | what it measured |
|---|---|
| **major** | the invariant's `PASS_FACING` list is **hand-written and enumerates 6 of the union's 15 members**, while its docstring claims the carve-out is "a decision rather than an omission" — and two of the unlisted members (`receipt_unbound`, `capability_missing`) judge the record. A hand-written enumeration guarding against unstated conditions is the same defect one level up. |
| **major** | AC-1's "come from one rule rather than two" is **false as written**: six gate sites derive a mode-dependent severity pair inline while the obligation producer asks `isTerminalSeverity`, so the two sets differ on a `std` task. |
| **major** | AC-2's selector cannot establish either half — the approval assertion is green under the defect it names (the gate refuses first, for a different reason), and the ladder assertion is outranked by the unresolved-obligations branch. |
| minor ×3 | AC-3's selector exercises only one branch; AC-4's behaviour has two sources; `reportRounds` reports a number for a round count the design document says is not derivable. |

**One lever made the honest repair cheap, and it is worth naming: `matrix set --statement` corrects a criterion without moving the revision.** `revisionStatus` stayed `current` across all four corrections, so narrowing a criterion to what its check establishes costs nothing and does not void the round that found the overreach. Two criteria were narrowed that way; the four remaining findings are carried with measured reasons, `mfc-r7-f2` first.

**What this hour shows about the loop, stated plainly:** I migrated four criteria, and within the hour a round found three of them defective and one more defective still in the fix I wrote to prevent that class. That is not a workflow failure — it is the mechanism working exactly as designed, on the author who wrote it. What made it survivable is that the correction was a *declaration* correction rather than a source change, so the round it responded to was not destroyed by the response.

## 10. Fix-plan status, and what each item learned on landing

| # | item | state | what landing it taught |
|---|---|---|---|
| **1** | every condition a gate judges by is stated in the brief | **landed**, then **audited by a round and repaired** | the invariant's own `PASS_FACING` list was hand-written and covered **6 of the union's 15** members while its docstring claimed the carve-out was a decision — the defect it exists to remove, one level up. It now enumerates the union and classifies every member, and states what it *cannot* prove: that a carve-out is correct, only that somebody made it. |
| **2** | require writing rather than a tool-call count | **landed**, shape changed by measurement | rounds told "emit by call 45" emitted at 68/75/89/96 and still produced records, so the deadline is not a scheduler. What discriminates is whether a pass **writes at all**: every recorded round wrote 17,636–67,358 characters, the two silent ones wrote 599 and 0 while their *thinking* ran to 583,914 and 536,527 characters no instrument here can read. |
| **5** | `falsify` refuses a subject that does not exist; `usage` is the host's | **landed** | four absences had been recorded under short ids the preflight never asks for; and the brief's own template **modelled** `usage` as zeros, which two records then reported verbatim against a harness-measured 134,282 / 449,147 tokens. A template that shows the wrong value teaches the wrong answer. |
| **3** | `kata-cli lane` — run the cycle and refuse edits between seal and archive | **not landed** | executed by hand, it archived two changes in one pass each; a sibling edit eleven minutes after a seal cost `kata-gate-surface` its certification, so the cost of the missing command is measured. |
| **4** | `roundMayClose` becomes the round's conclusion criterion | **not landed** | the mechanism exists and is falsifiable; what is missing is that the gate's own condition is still "all findings disposed". |
| **6** | a pass's certification binds the content it reviewed | **not landed** | dispositions already do this; the fix removes spurious staleness, not a genuine collision, which is why 3 is the load-bearing item. |
| **7** | `salvage` assembling a best-effort record | **partially landed** | `salvage` already recovered four complete records from transcripts, and three malformed ones were repaired by hand (`extract-record.py`), which shows the channel leaks in three ways: never emitted, truncated, or valid JSON with a schema-required field missing. |

**One lever is not on the list and should be, because it made the honest repair free**: **`matrix set --statement` corrects an acceptance criterion without moving the revision.** `revisionStatus` stayed `current` across four corrections in one case, so narrowing a criterion to what its check establishes does not destroy the round that found the overreach. Without it, repairing three over-wide criteria would have minted a revision and voided the round that found them — the loop multiplying itself, for a declaration fix.

## 11. Fix item 4, split: the bound is now *used*, and the half that would weaken the gate is not

**Landed — the ladder names the closure bound.** `roundClosure` ("every class an open terminal finding names is covered by a check that reddens when the class returns") was computed and reported on `status`, and **nothing acted on it**: the operator read it while the ladder went on sending the change back to repair an instance of an already-covered class, one round at a time. `suggestCandidateAction` now returns `cover_uncovered_classes` — *cover the class rather than repair one more instance* — and it deliberately does **not** overrule a real gate: an open blocking finding, an unresolved obligation or a failed verify still routes to repair first. Four cases pin that ordering, and deleting the branch reddens one with `expected 'judge_reviewed_change' to be 'cover_uncovered_classes'`.

Measured on the live repository: three changes carry a closure verdict today (`adversarial-admissibility`, `review-record-integrity`, `kata-gate-surface` — the last now archived, whose verdict named *findings that name no class*), so the verdict is not theoretical.

**Not landed, because it needs a decision I should not make alone.** The other half of item 4 is the change that would make the bound *bind the gate*: a blocking finding whose class is covered by a check would no longer hold review approval, on the argument that the class cannot recur silently and the instance is recorded and carried to a ticket. Both halves have real weight:

* **For**: the loop's measured shape is that findings per round rise rather than fall, because every repair is new code; "dispose of everything" is an open set, and a bound that is only *reported* changes nothing about when the loop ends.
* **Against**: a blocking defect would remain in the code, certified, and the mechanism would be a guard whose default lets an unfixed defect through — the shape this line has now found eleven times. The gate's strength is one of two invariants this work has refused to trade (with revision identity), and weakening it is not a repair I should land on my own authority.

So the honest state is: **the bound is visible, nameable and actionable; whether it also excuses an unfixed blocking finding is the user's call**, and the arguments are written down rather than decided.

## 12. Fix item 6 was already implemented — and the plan item was written from a diagnosis I later retracted

**Measured before doing the work: the certification binding is already content-based, in four rules, and I nearly rebuilt it.** `src/quality/adversarial.ts` around line 1625:

```ts
const sameRevision = record.revisionId === input.revisionId;
const sameContent  = Boolean(record.manifestHash) && record.manifestHash === input.manifestHash;
const sameFreeze   = … record.candidateFreezeSha256 === input.candidateFreezeSha256;   // §7.4
const surfaceUnchanged = !sameRevision && !sameContent && … record.codeManifestHash === input.codeManifestHash;
```

so a record is refused as `stale_revision` only when **all four** fail — which means:

* **an identical re-seal does not expire a pass** (`sameContent` over the owned manifest), which is the case the plan item was about;
* **a change committed outside the declaration does not expire it** either, because §7.4's freeze identity covers more than `ownedPaths` — and the sibling defect I recorded earlier (`adversarial.ts` is not an owned path while `contentDigests` has 718 entries) is exactly why that rule exists;
* **a governance-text or instrument edit does not expire a code pass**, as long as something cheap re-read the sentences (`claimsVerified`);
* and only a change to **the code surface the revision declares** does — which is the correct answer, because the revision is the unit of certification.

**All four fields are populated on every real record** — `manifestHash`, `codeManifestHash`, `candidateFreezeSha256` and `revisionId` are present on the four archived changes' records I checked — and the behaviour is pinned by `tests/unit/adversarial-brief-binding.test.ts` (*"a recorded pass survives the state behind its brief moving afterwards"*) and `tests/unit/revision-delta.test.ts:98` (*"says unchanged when the content is identical, even if the revision id moved"*).

**So the plan item is withdrawn rather than landed**, and the reason matters: it was written when I believed a disposition's expiry proved the revision id was unstable for identical content. That diagnosis was **retracted the same day** — the two ids differed because the content really differed — so item 6 was answering a problem that the four rules above had already solved. What remains is the case I named in the same paragraph at the time: a **declared path the pass never examined** expiring the pass. That is not spurious staleness — the revision is what the pass certified — and the lever for it is ordering, which is item 3 and is landed.

**This is the third time on this line that a plan item's premise did not survive measurement** (the `createdAt` instability, the record count `rounds == records`, and now this). The pattern is worth naming: a plan written from a diagnosis is only as good as the diagnosis, and re-reading the mechanism before implementing is cheaper than implementing a mechanism that exists.

## 13. Fix item 7 is refused by a deliberate rule — and the lever is item 2, not a better salvage

**The proposal was: `salvage` assembles a best-effort record from partial material, reported `inconclusive`, so a round's work is at least visible.** Two measurements refuse it.

**First, the material is not there.** The 28 rounds that produced no record wrote 141–2,648 characters of text, and the decisive case — round 10 of `closure-gate`, dispatched with the gate's exact refusal and the two missing criteria named — wrote **599 characters across 9 assistant messages, every one of them a "let me …", with no hypothesis objects and no findings at all**. A best-effort record assembled from 599 characters of intent is a record that says nothing, and it would be *worse* than none: the gate would have something to refuse while the round's real contribution stayed unknown. `salvage` already recovers every round that had something to recover — four complete records so far — and `extract-record.py` repairs the three malformations (truncated foot, missing `createdAt`, a stray comma) measured so far.

**Second, the gate would refuse the record it produced, by design.** A record carrying a hypothesis with `outcome: 'inconclusive'` is refused **whole** — and so is one carrying `abandoned` — because *"a limit must not be laundered into a pass"*, asserted by two tests named `derives budget_exhausted when a hypothesis was abandoned to a limit`. So a best-effort record would either be refused (useless) or would have to drop the un-converged hypotheses (a record that reports finishing what it did not finish, which is the state the budget exists to make impossible).

**So item 7 is withdrawn, and the lever for the same problem is item 2, which is landed**: the failure was never that salvage is weak, it was that a pass could read 69 times and write nothing. Requiring text rather than watching a tool-call count addresses the cause; better salvage would have addressed a symptom that the measurement does not show.

---

## The fix plan, closed

| # | item | outcome |
|---|---|---|
| **1** | every condition a gate judges by is stated in the brief | **landed**, then **audited by a round** and repaired (its own list covered 6 of 15 union members) |
| **2** | require writing, not a tool-call count | **landed**, shape corrected by tabulating fourteen rounds |
| **3** | `kata-cli lane` — the order of work, made checkable | **landed**; all four archived changes report `superseded` today, so the drift is the normal state rather than an edge case |
| **4** | `roundMayClose` as the round's conclusion criterion | **half landed**: the ladder now names the bound (`cover_uncovered_classes`) and does not overrule a real gate. The half that would excuse an unfixed blocking finding is **written down with both arguments and left to the user**, because it would weaken a gate this work has refused to trade |
| **5** | `falsify` refuses a subject that does not exist; `usage` is the host's | **landed** |
| **6** | bind certification to the content a pass reviewed | **withdrawn — already implemented** in four rules, from a diagnosis I retracted the same day |
| **7** | `salvage` assembles a best-effort record | **withdrawn — refused by a deliberate rule**, and the material measured too thin to assemble from |

**Three of the seven plan items did not survive contact with the mechanism** (4's second half weakens a gate, 6 already existed, 7 is refused by design), and that ratio is the honest result of writing a plan from a day's diagnosis: the diagnoses were worth making, and each one had to be re-measured before it was acted on. The four that landed are mechanical, small, and each was verified by a mutation that reddens.

## 14. The first round this repository executed found six defects — five of them in the day's own work

`adversarial-admissibility` re-sealed (`revision-5db843a10894a7aa`), its packet was issued, and `kata-cli adversarial execute --executor "node host/run-round.ts"` ran a real round: **65 minutes, a receipt bound to the issued request, and a record the gate accepted** (`satisfied: true`) — the first strict change certified on this host. The `executor_unavailable` wall is gone, replaced by an ordinary record check.

**And the round immediately audited the day.** All six findings are about work landed in the previous hours, two of them blocking, and every one held:

| finding | severity | what it found |
|---|---|---|
| `aad-r7-f4` | **blocking** | **the adapter wrote a receipt for a round that did not run** — `PiSession.capabilities` is a constant fixed before the child exists, `finish()` ends the stream on `error` as well as `close`, so a spawn that never started drained the loop, tripped no stop condition and returned `completed` with four-zero telemetry. *"A receipt for a round that did not run is the defect this boundary exists to prevent"* — my own file's sentence, and the code did it. Fixed in the reference: **a session that produced no result produces no receipt** |
| `aad-r7-f3` | major | **the host emitted telemetry it never measured** — `truncations` was never set, so every receipt claimed `0`, i.e. *measured, and it was zero*, which made `unmeasuredTelemetry` report that nothing was unmeasured. Also the token figure summed each turn's cumulative context (11.75 M for one round) instead of what each call billed |
| `aad-r7-f6` | major | **the invariant landed for fix item 1 could not fail for the case it names**: it compared three hand-written literals against each other, so a sixteenth reason added to the gate's union left it green. It now reads the union from the source |
| `aad-r7-f1` | major | **the closure verdict had two producers that could disagree** — and the second was dead code: `adversarial status` built its own verdict over *every* tracked finding and then dropped it. It now reads the ladder's value and projects it; measured, all four changes agree |
| `aad-r7-f2` | major | **the two guards added today could not refuse anything** — `lane --require-current` and `falsify` returned `{success:false}` and the process exited **0**, so a CI step or lane step checking the status proceeded. Both now exit 1; measured 1 / 1 / 0 for the guard, the report form and the accepted case |
| `aad-r7-f5` | **blocking** | **AC-6's second clause was false as written** — it called a guard that refuses an honest inconclusive verdict a defect, while the discharge conjunct refuses such a record by design and AC-6's own selector asserts that refusal is correct, so the criterion was certified by a check testing the inverse of one of its clauses. The clause is replaced by what holds, via `matrix set --statement` — which does not move the revision, so the round that found it was not voided by the correction |

**The pattern is the one this whole document describes, one turn further out**: the author writes a mechanism, a reviewer finds what the author could not see, and every finding is in the *previous* work. What is new is who paid for it — the round ran under kata's own `execute` contract, wrote a receipt bound to the request it answered, and cost nothing but the tokens, because the host capability that had blocked two changes was a missing adapter rather than a missing rule.

## 15. The record-less round, measured a second time — and the lever turns out to be a number

§1.6 named the largest loss on this line: a required output whose only channel is the round reaching its natural end. The decoupled
protocol was built partly to answer it — the host streams, kata decides, and `salvage` reads a transcript — and then the same failure was
measured again, on the new route, on one revision:

| attempt | executed by | tool calls | transcript | record |
|---|---|---|---|---|
| 1 | `execute` → `pi` | 92 | 869 KB of events | **none** |
| 2 | `execute` → `pi` | 108 | — | one, and the gate refused it for citing tests it had not declared |
| 3 | `execute` → `pi` | — | **139 MB** | **none** |
| 4 | `execute` → `pi` | — | 21.7 MB | **none** |

**Four dispatches, zero accepted records** — and one measurement that names the mechanism precisely: the transcript of attempt 4 holds
**zero characters of assistant text**. Not a truncated record, not a malformed one: a session that reasoned for twenty-five minutes and wrote
nothing at all. `salvage` reported the same thing it reports for round 2 of this line's earlier failures — *"the transcript holds no complete
record, so the round produced none"* — which is correct and useless, because there was nothing to salvage.

**The lever is the line's own experiment, and it is one sentence.** `docs/design/2026-09-25-record-production-experiment.md` measured it:
rounds told to emit "as soon as you have findings", with no number, produced **0 records in 4 attempts**; rounds given the same instruction
**with a number** produced one in **6 of 6**, at 3.4–7.7 minutes and 134–216K tokens against 8–50 minutes and 400K–1.2M for the same change
without it. The brief already carried the guidance. What it did not carry was the number — and a session has no instrument for "soon" and
does have one for a count it can see.

So the brief now states it, **derived rather than written down**: `ceil(MEASURED_REVIEW_PASS_COST.mostToolCalls × REVIEW_HEADROOM)`,
divided by three, floored at ten — *"write your first complete record by tool call 71 of this round's 215"* — from the same constants the
envelope is built from, so a promise in the brief cannot drift from the limit the round is held to. That is this change's own class table
applied to its brief: one fact, one derivation.

The next dispatch produced a record the gate **accepted** (`toolCalls 168`, 1.19 MB, `tokens: null` — unmeasured rather than a fabricated
zero), and the change went to judge and archive. **One attempt with a number, one record; four without, none.**

**Two honest limits.** Five data points are not a law, and the numbers come from two routes: the six-of-six figure was measured on subagent
rounds whose prompt *I* wrote, while the four failures were process rounds whose prompt is kata's brief — so what is demonstrated is that the
instruction matters and that a numbered one survived the route change, not that some particular number is optimal. And the transcript did not
make `salvage` work here: a session that writes no text leaves nothing to salvage, which is why the recording channel was never the fix and the
*stopping* behaviour is.

## 16. Two more classes, both produced by this change rather than found in it

The class table had five entries. The first independent pass on the decoupled protocol produced eleven findings — and five of them were one
sentence nobody had written down:

> **6. A declaration with no consumer** — a declaration is written and nothing reads it.

The protocol's schema was bundled by nothing and registered with nothing, so the "bundled schema" a criterion promised did not ship;
`elapsedMs` was computed, passed into the runner and consulted nowhere, so the wall clock stayed the host's word while the branch claimed kata
measured it; `receipt_unwatched` was a refusal outside the union the brief renders from, so no brief could state the condition a pass was
refused by. **In every case the guard beside the declaration passed**, because it asked whether the declaration was well formed rather than
whether anything read it. The covering check asks the whole repository: every schema file ships and is reachable by name, and every field the
round runner declares is read by the round runner.

The second pass produced a sharper one, and it is the same sentence one level up:

> **7. A part checked as the whole** — a guard inspects one field, member or direction of a concept and is read as a verdict on the concept.

Its live instance was inside the fix for the sixth class: `runIsCertified` compared the artefact kata wrote, and **`adversarial execute` never
registered that artefact** — so every production run was admitted on an identity while the code that compares content existed and could not be
reached. Mutation-verified: with the receipt omitted, the tamper case and the source clause both redden. The other instances are the same shape
— a criterion broader than its selector, one binding checked while the siblings beside it are trusted, a packet's brief hash verified while its
budget and capability set are taken as given, and the bundled-schema guards walking registered-to-file and never file-to-registered.

**Both classes are now checks, and both checks redden under a mutation that reintroduces them** — which is the only difference this line has
found that matters: an instance repaired is a round bought, a class covered is a round saved.

## 17. `round-protocol` archived: the loop closed on the decoupled protocol

This change — the one that moved receipt authorship from the host to kata — went through its own gate and archived
(`revision-9505acc36fbe0568`, judge PASS on AC-1…AC-6, evidence 8, obligations 0, failing evidence 0, 193 files / 1327 tests).

What that demonstrates, stated no more strongly than the evidence supports:

- **The host contract can be smaller than it was.** The adapter launches and maps a stream; kata counts, refutes capability claims, derives the
  status, writes the receipt and registers the run. The host that once wrote its own certificate — and, in `aad-r7-f4`, wrote one for a round
  that never started — now writes none.
- **The wall that stopped two strict changes was a missing adapter, not a missing rule.** `adversarial-admissibility` was the first round this
  repository executed through `execute`; `round-protocol` is the first change whose whole cycle ran on the protocol it defines.
- **The two classes above were found by the mechanism being certified**, which is the property the whole line exists for: the reviewer is not
  the author, and five of eleven findings were about work landed hours earlier.

**What remains blocked, and it is not this:** `adversarial-admissibility` and `review-record-integrity` still hold obligations that need a
capability receipt their host cannot issue, and the two-ledger fact recorded in §3 is unchanged — a finding can live in `review.json` or in the
adversarial record, and a reader that consults one answers for half of them. Neither is a defect this change could have fixed from inside, and
both are cheaper to state than to hide.
