# The review loop carries its defect classes

**Change:** `the-review-loop-carries-its-defect-classes`
**Date:** 2026-10-10
**Status:** design (this document is the deliverable of the discussion that preceded it)
**Tier:** `strict` — it changes what a review round records and what the ledger calls a deficit, never what a gate accepts.

---

## 1. The measured problem

Four numbers, all taken from this repository on 2026-10-10, are the whole argument.

| Observation | Measurement |
|---|---|
| The loop, and where it concentrates | **49 changes, 102 review rounds.** 19 changes hold 98 of them (11/11/10/9/7/6/5/5/5/5/4/4…): the cost is not spread, it is concentrated |
| Cost per round | **17–28 min of review** (22 avg) **+ ≈28 min of repair/seal/verify/ledger/record** ⇒ ≈50 min per round; ≈82 h for those 98 rounds |
| No decay | `the-identity-is-computed-where-the-change-is`: blocking findings per round **3→1→1→1→1→0→3**. A converging process decays; a flat series is the signature of *sampling* |
| The history is not retained | **102 rounds survive as 56 findings.** A round record is `{at, revisionId, manifestHash, blockingIds, blockingCount}` — ids and a count, no bodies, and `review.json` is overwritten each round. Today the repository cannot answer "which defect classes recur" |

And a fifth, about *where* a round's tokens go: across rounds 3/5/6/7 the reviewer made **62–107 tool calls touching only 13–26 distinct files — 22–67 of those touches were repeats of the same handful** (`src/workflow/orchestrator.ts` 5–17×, `src/workflow/revision.ts` 5–12×, the two selectors 4–10×). Output tokens tracked calls (240k / 235k / 676k / 499k). **Rounds are expensive largely because they re-derive what the previous round already knew.**

## 2. Root cause, in engineering terms

Every finding this loop produced in the change above belongs to a class whose oracle is **mechanizable**: "one fact derived twice" (the seal hashed the sandbox's content while `verify` hashed the author's; the revision manifest and the evidence scope hash were two streams; the declared set and the repository walk were two answers to "what is content"), "a refusal whose named remedy cannot be executed", "a corrupt read that reads as absent", "a comparison that does not name what it compared".

Those classes are treated, in the literature and in practice, by **mechanized oracles** — equivalence partitioning and boundary value analysis (Myers 1979; ISO/IEC/IEEE 29119-4), metamorphic relations where the oracle cannot be computed cheaply (Chen/Cheung/Yiu 1998), differential testing where two implementations must agree (McKeeman 1998), property-based generation (Claessen & Hughes 2000), and mutation adequacy to check that an assertion actually asserts (DeMillo/Lipton 1978; Jia & Harman 2011). **Independent inspection is the right instrument for the classes those tools cannot reach** — requirements ambiguity, intent, omissions, interface semantics (Fagan 1976) — and it is paid for by the round.

What this repository has been doing is spending the *expensive, sample-based* instrument on the *mechanizable* classes. That is the reason the series does not decay: **each round samples one shape of an input space nobody has enumerated**, and each repair *adds* surface for the next round to sample (20 falsifiers, 4 selector files, 1 395 lines of guard code across seven rounds of one change).

Three contributing gaps, each with its own precedent:

- **No institutional memory of defects.** The loop re-finds its own repairs (rounds 4, 6 and 7 each found a defect in the previous round's repair; three rounds were the *same* class). ODC (Chillarege et al., IBM 1992) exists precisely to turn defect attributes into process corrections; CMMI's Causal Analysis & Resolution is the organisational form of the same rule; and `cortexkit/magic-context`'s own `AUDITOR.md` states the operational consequence — *"this repo runs frequent, deliberately blind audits, so the same findings tend to resurface… spend your budget on new signal instead of re-deriving settled conclusions"*.
- **No instruments register.** Guard adequacy is asserted per case, so a falsifier can aim at a line that no longer exists (measured: four went `inconclusive` in one round; one was a **syntax error** that "reddened" everything; one silently failed to apply and was read as a green guard).
- **No stopping rule.** Nothing in the protocol defines "this class is closed", so the loop stops when a sampling round happens to be dry — a coin flip, not a proof. Reliability engineering treats stopping as a *statistical* decision against a failure-intensity target (Musa 1998); DO-178C's MC/DC is the precedent for letting a mechanical coverage criterion stand in for inspection breadth.

## 3. What this change does

Six acceptance criteria. **None of them changes what a gate accepts** — the two candidates that would (refusing to dispatch a round for an unmechanized class; refusing a further round when a class recurs) are explicitly deferred to the operator with their options recorded in §6.

| AC | What it establishes | Selector |
|---|---|---|
| **AC-1** | A finding carries its **class**, its **origin** (the original code or a previous repair), the **axis** of the input space it exercised, and the **instrument** that found it. An unknown class is refused by name. Records written before this change stay readable. | `tests/unit/a-finding-carries-its-class.test.ts` |
| **AC-2** | A **round record carries the round's findings**, not only their ids and a count, so the history survives the next round's `review.json`. A round whose findings are dropped is refused by name rather than recorded as an id-only line. | `tests/unit/a-round-record-carries-its-findings.test.ts` |
| **AC-3** | The ReviewRequest declares, per class the change touches, whether its oracle is **mechanizable**, and names the **generator** and **relation** for those that are. A mechanizable class with no generator is reported as a **ledger deficit** (the existing "not ready" route), not silently accepted. | `tests/unit/a-mechanizable-class-needs-a-generator.test.ts` |
| **AC-4** | Every declared falsifier's **anchor must match exactly once** in its file, and the harness asserts that a mutation **applied** before believing its reading. A stale anchor is reported by name as unverifiable, never counted as `supported`. | `tests/unit/a-stale-anchor-is-not-a-supported-falsifier.test.ts` |
| **AC-5** | A defect class that **recurs across rounds** is reported with the class (not only with the finding's text) and routed by the existing recurrence signal, so the operator sees "this class is still being sampled" rather than "another finding". | `tests/unit/a-recurring-class-is-named-as-a-class.test.ts` |
| **AC-6** | The **shadow replay** over the archived corpus is produced as evidence: misallocation rate, repair-regeneration rate, out-of-packet class share, and a fitted discovery rate with the stopping-rule parameters it implies. | `tests/unit/the-shadow-replay-reports-its-metrics.test.ts` (the report's own computation, on a fixture corpus) |

**Evidence plan.** AC-1…AC-5 are behaviour in `src/` with a single-point, reversible falsifier each (the anchors are copied from the code). AC-6 is a computed report over `.kata/tasks/**` — its instrument is a fixture corpus in `tests/`, because a report over live task records cannot be a falsifier.

## 4. What is borrowed rather than invented

The discussion that produced this document examined `cortexkit/magic-context` (MIT) — the host-side context manager this session already runs inside — and found that it is a **working reference implementation of the same mechanism**, with three artifacts worth adopting in form:

| Their artifact | What this change takes from it |
|---|---|
| `mutations.toml` + `ck-mutate check` — one row per guard, naming the test that must fail, anchors copied from the code, `check` failing when an anchor stops matching exactly once, and an admission rule that a row must guard a *silent, costly* failure | **AC-4**: anchor uniqueness is checked, not assumed; a stale anchor is a named defect of the instrument |
| `AUDITOR.md` + `docs/AUDIT-KNOWN-ISSUES.md` — a register of *decisions* with their reasoning, whose stated purpose is that a blind audit spends its budget on new signal; "a documented item is not new information", but arguing against the recorded reasoning with source evidence is the signal | **AC-1/AC-5**: classes and recurrence are recorded so a round is not spent re-deriving them; and the register's epistemics — decisions, not taboos |
| `gate-evidence/loop-r4-*.txt` — a round's compile/test/mutation evidence as files | the evidence bundle this change's own rounds produce, and the packet shape AC-3's generator references plug into |

**And what is deliberately not taken:** Magic Context renders project memories and history into every model call (`m[0]`/`m[1]`). The review node requires `fresh_context` (its capability set is `['fresh_context', 'read_only_fs']`), and independence is defined as *removing inherited context and supplying the issued brief* — so **the reviewer's context is never sourced from project memory**. Facts may be delivered to it as artifacts; the author's knowledge may not. The tool stays where it is (host side); `kata` itself keeps no host coupling and no model capability.

## 5. Risks, and the countermeasures that are part of the design

| Risk | Why it is real here | Countermeasure in this change |
|---|---|---|
| Recording classes becomes bureaucracy that a round still ignores | the register is only useful if it is read at dispatch time | AC-3's deficits are the read path: the ledger reports the unmechanized class, and `decide` refuses `pass` while it stands |
| The class vocabulary collapses everything into one bucket | a taxonomy that cannot distinguish is worse than none | the vocabulary is fixed in `src/quality/defect-classes.ts` with each class's *oracle type* (`mechanizable` / `judgment`) and a one-line definition; an unknown value is refused |
| A round records a class and then finds something else anyway | that is *desirable* — the register must not fence the search | AC-5 reports recurrence; it never instructs the reviewer to stay inside the vocabulary. A finding whose class is new is a normal outcome and is what the class list grows from |
| The replay report is computed badly and flatters the mechanism | a self-serving measurement is the failure this repository keeps catching | AC-6's report computes from round records and findings only (no free text inference), states the metric definitions, and is reproducible from the store |

## 6. The operator's decision on the two gate-semantics candidates — 甲 (recorded 2026-10-10)

Both candidates were answered **甲**: keep the mechanism, make the mechanism-preserving form carry teeth, and change no gate
requirement. The blocking forms were not adopted, and the measurement that decided it is recorded here rather than in a
conversation:

- **D1 — a mechanizable class with no generator.** The request now **names the generator it is missing**, and the deficit
  routes as before; the **archive gate re-runs `decide`** (`distill-gates.ts`'s `evaluateLedgerAtArchive`), so an unsettled
  class blocks the *archive*, not the round. The rejected form (refusing to dispatch) was measured against this change's own
  rounds: **all ten findings of rounds 7 and 8 were mechanizable classes**, and refusing those rounds would have discarded
  three blocking and two major findings, including the legacy-revision phantom (`R8-F1`) — while the first change to adopt the
  mechanism has no generators at all and could not be reviewed under it.
- **D2 — a recurring class.** Reported, never enforced, and the signal was sharpened as agreed: counted **by class**, only for
  `mechanizable` classes, and `stopLineCandidate` **requires an `origin: repair` instance**. Measured against the same rounds:
  the naive rule ("any recurring class") would have refused round 8 on `instrument-unsound` and `comparison-unnamed` — while
  round 8's blocking finding was a **new** class (`corrupt-read-as-absent`), so the naive rule would have cost the one finding
  that mattered. The sharpened rule fires on the recycling shape and not on that round.

Both refinements are properties with their own cases; the oracle half was **not** load-bearing in its first fixture and stayed
green under a mutation that ignored it, so a case carrying a `judgment` class *with* a repair origin was added — the same
"the fixture must carry the shape" rule this session has now paid for four times.

## 6b. Deferred candidates (recorded, not decided)

Two candidates would change **gate semantics** — `kata`'s own rule is that a change which loosens (or tightens) what a gate means is put to the operator first:

- **D1 — refuse to dispatch a round whose class has no generator.** Mechanism-preserving version: the deficit routes to build (AC-3, implemented). Blocking version: `ledger run` refuses the request. Cost of the blocking version: a genuinely novel class cannot be reviewed at all until a generator exists, which inverts the value of the first round.
- **D2 — refuse a further round when a class recurs.** Mechanism-preserving version: report and route (AC-5, implemented). Blocking version: `/kata-review` refuses while a class recurs, forcing process repair first (stop-the-line).

Both are recorded here with their mechanism-preserving form implemented, and neither is taken unilaterally.

## 6c. One narrowing recorded, not hidden: the class gap is a deficit, not a reason code

The first version of AC-3 added a kernel reason code (`class_without_instrument`) so the class gap would appear in the
decision's `reasons`. The eval corpus's own guard refused it — *"a refusal reason no seed exercises is a rule with no
example"* — because the rule lives in `src/store/verdict.ts` while the corpus scores the kernel (`src/kernel/**`). Two honest
answers existed: move the rule into the kernel so a corpus seed can exercise it, or drop the code and let the **deficit** carry
the gap (the deficit array is where "what is missing" belongs, and the verdict is already `insufficient`). The second was taken
for this slice; the first is recorded here as the follow-up that would give the rule a scored example.

The guard is worth keeping exactly as it is: it refused a rule nobody could see working, which is the same property this change
exists to install.

## 7. Cost

- `src/quality/defect-classes.ts` (vocabulary + oracle type), the finding schema fields, the round-record writer, the falsifier anchor check, the request's instrument declaration, the recurrence class, and the replay computation: **≈300 lines of production code, one schema extension, six selectors**.
- One design (this document), one seal, one independent round — with the difference that the round is asked to falsify *these* claims rather than to re-derive the surrounding area, which is the whole point.
- Expected effect on the loop (to be measured, not assumed): AC-1…AC-5 remove the re-derivation and the instrument failures; AC-6 gives the numbers that decide whether the *next* step (a generator per class) pays for itself. **The round count is not expected to fall from this change alone** — that comes from the mechanization the criteria make visible and mandatory-to-declare.
