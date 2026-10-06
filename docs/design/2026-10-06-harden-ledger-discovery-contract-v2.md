# Harden Ledger Discovery Contract v2

**Change:** `harden-ledger-discovery-contract-v2`
**Status:** implemented (boundary, binding and projection landed; see §6 for the evidence)
**Profile:** `isolated_worktree / tdd / security`

## 1. Problem

The prior discovery-floor repair deliberately stopped treating a passing independent check as a defect. That removed the false-negative incentive to manufacture a current failure, but it left three linked gaps:

1. A schema-less ledger artefact is only partially normalized. An array element may be filtered or coerced, but a valid JSON document with the wrong container shape can still reach a consumer as an asserted array/object and throw. A corrupt record can therefore become a process crash, an invented empty value, or a write that rewrites bytes the reader could not use.
2. A terminal challenge currently contributes to discovery after any non-blank observation, and a probe answer contributes after any non-blank command and observation. Neither result is mechanically tied to the frozen fact it purports to check. Thus a free `exit 0` challenge or a response for a different probe can satisfy discovery without a discriminating check of the current subject.
3. Candidate discovery attempts and verified readings use independent count derivations. Duplicate commands across claims and stale answers can therefore create incompatible counts, while old revision evidence can pass for current content.

The common root is that records crossing the file boundary have no single validated representation that both readers and writers must honor, and no one current-bound projection that every discovery consumer shares.

### 1.1 Verified feedback: `2026-10-06-probe-answers-outlive-their-revision`

> Verified against `master` at `15a44d7` using `tmp/repro-probe-feedback.test.ts` (4/4 passing). This is source evidence for this design, not a substitute for the acceptance tests below.

> **Impact correction.** The report correctly shows that a subject move makes a stored probe/answer stale. Its statement that the current automated strict gate necessarily rejects that stale answer is not true in the current source. `verifyAgainstRequest()` only compares `probeId` membership (`src/store/review-request.ts:173-174,218-222`), while the ledger counts a non-blank answer without a subject binding. The failure is therefore an assurance **false positive** (old evidence can pass for new content), not an automated availability block. A downstream reviewer may correctly refuse it by protocol, but the code does not enforce that refusal.

> **F1 confirmed:** `probesFor()` emits positional ids that omit subject identity (`src/kernel/discovery.ts:120`); `appendProbe()` retains the first same-id record (`src/store/ledger.ts:102-112`); `answerProbe()` permits only one answer per id (`:255-271`); and `ledger ask` reports every generated id as asked even when no write occurred (`src/cli/ledger.ts:541-554`). The repro freezes A, answers it, moves to B, and proves B receives the same id, the persisted probe remains A, and the B answer is refused.

> **F2 confirmed:** `verifiedChallengeCount()` explicitly accepts any non-empty command/observation and does not compare the observation to the stored probe fact (`src/store/verdict.ts:29-36,67-73`). The repro counts `exit 0` plus a sentence merely repeating the expected prefix as one verified reading.

> **F3 confirmed:** per-claim `probesFor()` has a local de-duplication set (`src/kernel/discovery.ts:103-112`), so identical questions are generated for separate claims. `ledgerVerdict()` uses raw `readProbeAnswers().length` for candidate attempts but command-deduplicates only the verified count (`src/store/verdict.ts:312-321`; `verifiedChallengeCount()` at `:54-75`). The repro observes cross-claim duplicate commands and the resulting 2 raw versus 1 verified reading.

> These findings map directly to AC-3, AC-4, and the dedicated AC-5 one-derivation contract in v2.

## 2. Goals and non-goals

### Goals

1. Every schema-less ledger artefact is decoded through an explicit `absent | usable | unreadable` state before a consumer sees typed data.
2. A malformed container, malformed element, invalid JSONL line, or invalid required field is `unreadable`, never silently omitted, coerced, or treated as absent.
3. Current discovery challenges are references to declared `executable_falsifier` evidence and are credited only after the existing three-step verifier ran for the frozen subject.
4. Current probe answers carry an immutable copy of the generated probe fact and a command result produced from that exact fact; an answer for another revision/path/digest cannot count.
5. Candidate and verified discovery counts are two views of one current-bound, fact-bound, command-deduplicated projection.
6. Legacy records remain inspectable without being upgraded into current discovery evidence.

### Non-goals

- Infer whether a reviewer intellectually chose a good adversarial hypothesis.
- Change evidence strength, claim support, risk coverage, reviewer quorum, Review, Judge, or archive policy.
- Rewrite corrupt or legacy records automatically.
- Add a second mutation runner, host adapter, provider integration, or platform-specific execution mechanism.

## 3. Reader and writer contract

### 3.1 One explicit state for every schema-less artefact

`src/store/ledger.ts` will introduce one internal read result:

```ts
type ArtefactRead<T> =
  | { kind: 'absent' }
  | { kind: 'usable'; value: T }
  | { kind: 'unreadable'; file: string; detail: string };
```

The decoder reads bytes once. Only `ENOENT` produces `absent`. Parse failure, a wrong top-level container, invalid JSONL line, invalid array element, or an element that lacks a required/well-typed field produces `unreadable` for the entire artefact. A usable decoder may preserve unknown fields, but it never coerces a non-string into `''` and never drops a bad record to make the remainder appear healthy.

This applies to every entry currently listed as `ARTEFACTS_WITHOUT_A_SCHEMA`:

| Artefact | Usable shape | Unreadable examples |
| --- | --- | --- |
| `challenges.json` | a sequence of discriminated legacy/current challenge records | non-array document, anonymous record, invalid current binding |
| `probes.json` | a sequence of canonical, frozen probe facts | duplicate identity, command/fact mismatch, missing subject binding |
| `probe-answers.json` | a sequence of bound probe executions | free-text fact, wrong result shape, duplicate answer for one fact/revision |
| `runs.json` | a sequence of run records | primitive/null/array element or absent required run fields |
| `usage.json` | one budget/assurance record | malformed object or unsupported assurance/usage field |
| `plan.json` | planner object with typed `readingSets` and `requiredEvidence` arrays | non-object document or malformed nested record |
| `verdict-history.jsonl` | valid line-delimited history records | one malformed/non-record non-blank line |

`readLedger()` aggregates these state results into its existing readability diagnostics. Direct readers such as `readProbes`, `readProbeAnswers`, and `readPlan` expose the state to their callers instead of converting `unreadable` to `[]` or `null`. `ledgerReadability()` remains the only decision-level derivation: it refuses every ledger with an unreadable recorded artefact and names the file/reason.

### 3.2 Read-modify-write is fail-closed

Every writer enters the task lock, decodes the target artefact through the same state, and follows this rule:

- `absent`: create a valid current document;
- `usable`: apply the targeted mutation without normalizing unrelated bytes/legacy fields;
- `unreadable`: refuse before writing, retaining byte identity.

Therefore an append/answer/check command can never turn a corrupt record into an invented clean record as a side effect. The refusal reports the artefact and tells the operator to repair or replace it explicitly.

### 3.3 Legacy boundary

The decoder recognizes records in the documented legacy grammar as `usable` audit data. Current writers emit only the new bound grammar. A legacy challenge/probe/answer is readable in reports and history but is **ineligible** for current discovery credit because it lacks the required frozen binding. No background migration mutates it.

## 4. Bound discovery measurements

### 4.1 Challenges reuse the existing falsifier verifier

A current `Challenge` contains `falsifierEvidenceId`, not a free shell command. `ledger challenge add` validates all of the following before persisting it:

1. the claim exists;
2. the referenced evidence belongs to that claim;
3. the evidence is `executable_falsifier`; and
4. the ledger has a frozen subject.

`ledger challenge check` resolves that evidence and invokes the existing `verifyAll()` / `executable_falsifier` path with the normal `buildContext()` and adapter. It does **not** implement a second mutation runner. The verifier already performs the required baseline → injected defect → restored baseline sequence.

A successful verifier run records both its `EvidenceVerdict` and a challenge resolution that binds:

- the falsifier evidence id;
- the current frozen subject revision;
- the producer run/actor;
- the verifier outcome and observed three-step result.

Only a `supported` current run withdraws the challenge and can contribute one discovery reading. A refuted or inconclusive run remains non-terminal/open and cannot satisfy the floor. The legacy `command` / `failsOn` form remains readable but never gains current discovery credit.

This keeps the intended semantic distinction: a passing falsifier means no counterexample was observed *through a check known to redden under its declared mutation*; it does not make the claim automatically supported.

### 4.2 Probe answers bind the frozen fact, not reviewer prose

A generated `Probe` becomes a canonical frozen fact: its subject revision, kind, path, and expected digest prefix/literal/existence condition determine the only permitted command. The renderer for that command has one derivation in `src/kernel/discovery.ts`.

`ledger answer --probe <id>` resolves the stored probe and records the answer **from that question**: the canonical command, the subject revision, the path and the expected fact are copied from the probe, and the observation comes from the reviewer. A caller-supplied `--command` is accepted only when it equals the probe's own command; a blank observation is refused.

> **Why kata does not run the probe itself.** The sentence this replaces said the verb "executes that canonical command". Executing it in kata would destroy the credential: the probe exists so that a reviewer has to look at one path of this revision, and if the harness runs the check the reviewer need not read anything. The binding is what AC-4 requires, and it is enforced on both sides — the answer copies the fact, and the projection re-checks it against the question.

`ledger ask` refreshes a stored probe when the derived current-subject fact changes and reports what was actually written. A question already asked is not asked again — but **only a probe frozen to the current revision counts as already asked**, because a stale record is not the question this revision poses. Answers remain write-once for one exact `(probe id, subject revision, command)` identity; a moved subject may receive a new answer.

> **Found by the mutation proof, not by review.** The first version seeded the "already asked" set from every stored probe's command, so a question whose command is identical after the subject moves (`test -f <path>`) was skipped and never refreshed. Its recorded revision stayed the old one, which made it ineligible on both sides: the moved content was left with no askable question, and an answer recorded against the stale record could count for neither revision. The witness only caught it once the probe-level revision check was mutated away — the round before that, the projection's probe check had been doing the work the refresh was supposed to do.

### 4.3 One discovery derivation

`src/store/verdict.ts` will derive candidate and verified discovery readings from the same ledger snapshot:

- a bound challenge is verified only when its resolution exactly matches its declared falsifier, current subject, producer, and a supported recorded verifier verdict;
- a probe is verified only when its answer exactly matches the stored frozen fact/current subject and the canonical command succeeded;
- legacy/unbound, stale, open, refuted, inconclusive, missing, or unreadable records never count.

Both values supplied to `decide()` come from that one projection: candidate attempts support actionable `discovery_unverified` versus an absence of attempts (`discovery_floor`), while verified readings clear the floor. `challenge_open` remains authoritative for open counterexamples. This replaces the current split where one count uses terminal records and another independently deduplicates free-form answers.

## 5. Consumer routing

- CLI commands that directly consume a schema-less artefact return a structured refusal for `unreadable`; no command dereferences a rejected document.
- `buildReviewRequest()` refuses a malformed `plan.json` or probe document rather than rendering a partial request.
- Navigation, approval, archive, and repair entry continue to consume the shared `ledgerReadability()` / `readBlockingProblems()` decision. They receive the same unreadable reason as direct CLI calls.
- Writers never repair unreadable bytes implicitly. A human may intentionally repair the source document, then rerun the command.

## 6. Verification plan

**Measured, after the implementation was committed** (each mutation applied, the selector run, the file restored byte-identical):

| AC | Mutation applied | Result |
| --- | --- | --- |
| AC-1 | `records()` returns `[]` for a wrong container instead of throwing | selector RED |
| AC-2 | `readRecordsForWrite` returns `[]` instead of refusing | selector RED |
| AC-3 | a terminal free-form challenge counts again | selector RED |
| AC-4 | the answer/question revision equality is dropped | selector RED |
| AC-5 | a probe reading is identified by its record id rather than its command | selector RED |
| AC-6 | an unbound record is treated as a current reading | selector RED |

The AC-4 row is the second attempt: the first mutation (dropping the answer-side equality) left the witness green, because at that point the probe was never refreshed and the projection's probe-side check was what excluded the stale answer. That green mutation was the signal — it is what exposed the refresh hole recorded in §4.2.

| AC | Focused proof | Reversible mutation |
| --- | --- | --- |
| AC-1 | `ledger-record-read-state.test.ts` creates every schema-less artefact in absent, usable, non-array, malformed-element, and malformed-JSONL states; all decision/direct-reader surfaces classify the same state. | Downgrade `unreadable` to `absent`; wrong-container cases must stop refusing. |
| AC-2 | `discovery-floor-fail-closed.test.ts` corrupts an artefact, invokes a writer, and byte-compares it before/after; `ledgerVerdict` must name unreadability rather than throw. | Let a writer replace an unreadable document with `[]`; byte-preservation assertion must fail. |
| AC-3 | `discovery-challenge-binding.test.ts` builds a real frozen ledger, declares a discriminating falsifier, binds a challenge, and checks it through the CLI/verifier path. A free `exit 0`, a mismatched evidence id, or a non-reddening falsifier cannot count. | Restore free-command terminal counting; the `exit 0` case must incorrectly pass and the suite must redden. |
| AC-4 | `probe-answer-binding.test.ts` freezes A, answers A, moves/re-freezes B, refreshes the question, and proves the A answer or a fact-mismatched answer cannot count for B. | Remove revision/fact equality from the projection; stale/mismatched answer must incorrectly count and the suite must redden. |
| AC-5 | `discovery-count-projection.test.ts` generates duplicate cross-claim commands, stale answers, and fact-mismatched answers; candidate and verified sides must derive from one current-bound, deduplicated projection and both remain unable to clear the floor. | Restore raw answer-length counting on either side; the projection-equality assertion must redden. |
| AC-6 | `ledger-cli-end-to-end.test.ts` loads legacy-readable records, proves reporting remains readable, and proves they cannot qualify as current discovery evidence. | Treat legacy unbound records as current bound readings; the eligibility assertion must redden. |

The generator and the projection are two suites on purpose: `tests/unit/probe-set-asks-distinct-questions.test.ts` owns what the generator asks, and `tests/unit/discovery-count-projection.test.ts` owns what the counts make of the records. Focused suites run before typecheck; the full test suite and the declared reversible mutations run only after the implementation is committed, so a mutation restore cannot discard uncommitted work.

**Measured consequence, recorded rather than discovered later.** Refusing to count a free-form challenge changes what a *fixture* must declare, so nine suites outside the original surface had to declare a real `executable_falsifier`: the shared `tests/helpers/ledger.ts` seed (which satisfied the floor with a bare probe), plus `ledger-gates-the-ladder`, `ledger-can-approve-a-review`, `retired-assurance-cannot-authorize`, `ledger-repair-denial`, `archive-asks-the-ledger-for-known-problems`, `installer`, `workflow-resume` and `wiki-distillation`. `src/cli/invocation.ts` gained `--falsifier` in the value-flag vocabulary. Each of those is a place where the old contract was *encoded in a fixture*, which is why the change to it had to be visible rather than silent.

## 7. Scope and integration

The change owns the reader/decision/CLI/type surfaces, the flag vocabulary, and six distinct focused suites (plus the nine fixture surfaces the contract change forced). Nine overlaps are deliberately recorded with active tasks:

- `gate-input-integrity`: `src/kernel/decide.ts`, `src/store/verdict.ts`;
- `verdict-readings-per-run`: `src/cli/ledger.ts`, `src/kernel/types.ts`, `src/store/ledger.ts`, `src/store/verdict.ts`;
- `review-loop-verdict-unification`: `src/store/review-request.ts`;
- `record-ownership-single-derivation`, `unique-copies-is-one-model`: `src/cli/invocation.ts`.

`harden-ledger-discovery-contract` is this task's recorded `superseded_by` predecessor. It contained the same design basis but only five frozen ACs; v2 adds the independently evidenced discovery-projection AC before any implementation starts.

Because this change is isolated, shared-path changes in other active worktrees will require an explicit integration/re-seal decision after implementation; this document does not claim their acceptance criteria.

## 8. Acceptance matrix

| AC | Contract | Evidence selector |
| --- | --- | --- |
| AC-1 | Every schema-less artefact has explicit absent/usable/unreadable decoding; malformed containers/elements are unreadable. | `tests/unit/ledger-record-read-state.test.ts` |
| AC-2 | Decision and writer paths consume that state fail-closed and preserve unreadable bytes. | `tests/unit/discovery-floor-fail-closed.test.ts` |
| AC-3 | Only a current, bound, independently executed `executable_falsifier` result can verify a challenge for discovery. | `tests/unit/discovery-challenge-binding.test.ts` |
| AC-4 | Probe answers bind and revalidate the exact current frozen fact, so stale/mismatched answers cannot count. | `tests/unit/probe-answer-binding.test.ts` |
| AC-5 | Candidate and verified readings share one current-bound, fact-bound, deduplicated projection; duplicates and stale answers cannot inflate either side. | `tests/unit/discovery-count-projection.test.ts` |
| AC-6 | Legacy records remain report-readable but cannot become current discovery evidence. | `tests/unit/ledger-cli-end-to-end.test.ts` |

## 9. Review-driven repair: the boundary was declared but not consumed

The first independent security-tier round failed this change with one blocking and three lesser findings, all of one class:
the three-state read was **built** and then consumed by only part of the ledger. The round's own counterexamples were recorded
as challenges and replayed by kata — `X20`, `X21` and `X22` each exited 1 — and all three now exit 0, which is what
withdrew them.

| finding | what was actually wrong | repair |
| --- | --- | --- |
| F1 (blocking, AC-2) | `restateClaim`, `appendClaim`, `appendEvidence`, `replaceEvidence`, `recordVerdicts` and `appendRun` still read with `readJson`, which answers `null` for absent *and* unreadable, so an unrelated append replaced a corrupt file and reported success | a second write-side boundary, `readDocumentForWrite`, validates schema-carrying artefacts (parse + `validateArtefact`) before any write; the schema-less run log goes through `readRecordsForWrite` |
| F2 (major, AC-1) | `readVerdictHistory` had a catch-all that reported *any* read failure as `{ entries: [], malformed: 0 }`, so an existing but unreadable history read as "no verdict was ever reversed" | only ENOENT is absent; other failures return an `unreadable` detail, and `claim show` publishes `historyUnreadable` instead of an empty `readings` list |
| F3 (major, AC-3) | the projection credits a challenge from its own resolution, so a falsifier demoted by `evidence replace` left its challenge carrying credit for a declaration that no longer existed | the write that invalidates the binding drops it: `replaceEvidence` removes `falsifierEvidenceId` (and the resolution's binding) from any challenge whose falsifier is no longer an `executable_falsifier` |
| F4 (minor, AC-2) | `ledger ask` read through the convenience reader, answered `[]` for an unreadable file, and only then hit the writer's refusal — so the refusal escaped as an exception | the command reads the explicit state and refuses in the same shape as every other refusal |

The stale comment F3's neighbourhood exposed — an orphaned doc block describing a removed `verifiedChallengeCount` and explaining a limit with a reason (`an answer carries neither the kind nor the path`) that the change's own `ProbeAnswer` had already made false — was deleted rather than reworded.

**Measured after commit `5c9a5f6`** (each mutation applied to committed source, its selector run, then restored and
SHA-256-checked byte-identical):

| mutation | selector | result |
| --- | --- | --- |
| `readDocumentForWrite` returns `undefined` instead of refusing a parse failure | `tests/unit/discovery-floor-fail-closed.test.ts` | exit 1 (red) |
| `readVerdictHistory` returns the empty history for every read failure again | `tests/unit/ledger-record-read-state.test.ts` | exit 1 (red) |
| every evidence item counts as a declared falsifier | `tests/unit/discovery-challenge-binding.test.ts` | exit 1 (red) |
| `ledger ask` reads through the convenience reader again | `tests/unit/discovery-floor-fail-closed.test.ts` | exit 1 (red) |

Nine new cases carry the repairs in the declared surface (six writers, one `claim show` publication, one history boundary, one
demoted-falsifier binding). Full suite after the repair: 264 files / 1560 tests.

**A limit this repair does not remove, recorded rather than implied:** the binding is maintained by the only writer that can
invalidate it (`evidence replace` — evidence is otherwise write-once). A hand-edited `evidence.json` that demotes a falsifier
while leaving a challenge's resolution intact is schema-valid and would still be credited. Closing that would mean the
projection re-deriving `declared` from an evidence list it is not given, which is a second derivation of the same question
and a behaviour change with its own review.

### 9.1 The second round: the boundary was consumed, but not atomically

The second independent round could not falsify any of the four repairs — its own challenge was withdrawn — and reported
three neighbouring defects, the same class one step out:

| finding | what was wrong | repair |
| --- | --- | --- |
| R2-A (major, AC-2) | `replaceEvidence` is one decision over four artefacts, but it wrote `evidence.json` *before* reading `verdicts.json`, so an unreadable verdict file was refused **after** the replacement had landed, under a message that said nothing had been written | every read of the decision happens before the first write — the verdict list, the run log and the challenge list are all read up front |
| R2-B (minor, AC-3) | unbinding a demoted falsifier replaced the whole `resolution`, erasing the recorded verdict, subject and producer — more than the binding the comment claimed to remove | only `falsifierEvidenceId` (top-level, and inside the resolution) is removed; the measurement stays and the reason is appended to the observation |
| R2-C (minor, AC-2) | `ledger answer` still read through the convenience reader, so an unreadable `probes.json` was reported as "no probe has been asked" | the sibling verb of `ask` reads the explicit state and refuses in the same shape |

**Measured after commit `a1a5742`** (same method: committed source, one mutation, its selector, restored and SHA-checked):

| mutation | selector | result |
| --- | --- | --- |
| write `evidence.json` before reading the rest of the decision | `tests/unit/discovery-floor-fail-closed.test.ts` | exit 1 (red) |
| unbinding replaces the whole resolution again | `tests/unit/discovery-challenge-binding.test.ts` | exit 1 (red) |
| `ledger answer` reads through the convenience reader again | `tests/unit/discovery-floor-fail-closed.test.ts` | exit 1 (red) |

Two cases and two assertions carry this round in the declared surface. Full suite after it: 264 files / 1562 tests.

**Still not closed, and recorded rather than implied:** the round also observed that the twelve recorded probes carry digest
prefixes from the content that existed *before* this repair (8 of the 12 commands now fail). That is the same dogfooding
artifact as F5 — the probes were issued by the installed bundle built from master, and this change's own refresh rule (a
probe whose command or subject moved is re-asked) is exactly what would have re-issued them. It is invisible once the
change is merged and the bundle rebuilt, and it is why the probe half of this ledger is not offered as evidence of the
repair.

### 9.2 The third round: a report is not a decision, and a binding is not a declaration

The third independent round found the same class at two further layers — the surfaces that *report* on a ledger, and the
decision layer's trust in a record's self-description:

| finding | what was wrong | repair |
| --- | --- | --- |
| the reporting surfaces (`status --cost`, `focus`, `challenge list`/`check`, the review request) | each read through a convenience reader that answers `[]`/`null` for a file that exists and cannot be decoded, so a corrupt `probes.json` published `probesAsked: 0`, a corrupt `plan.json` was reported as "no plan has been stored" (with a remedy that overwrites the bytes), and a corrupt `challenges.json` as "no open challenge to check" — while `decide` refused the same files | the cost report publishes `null` counts plus `unreadableArtefacts`; `focus` and the request builder distinguish `unreadable` from `absent`; the `challenge` verb refuses once, naming the files |
| `challenge add` | two writers in sequence, so an unreadable `claims.json` refused **after** the challenge had been recorded, under a message saying nothing had been written | `recordChallenge` reads both artefacts before writing either, and requires the claim it links to |
| **a fabricated binding** — the security-relevant one | `discoveryProjection` credited a challenge from its own resolution, so a record naming a falsifier the ledger never declared (schema-less file, hand-repairable, reachable without tooling) satisfied the strict-tier discovery floor | the projection takes the declared falsifier set as an input and credits a binding only when the ledger declares that id; an absent set credits nothing, because a binding that cannot be checked against a declaration is not evidence |
| `readLedger`'s own view | validated while the scan ran, then rebuilt by an independent `readJson` that coerced whatever it found: a `claims.json` holding an object made `ledger.claims` an object, so `ledger.claims.some(...)` threw inside a command instead of the ledger reporting that the file cannot be read | a document the scan called malformed contributes nothing to the view: the bytes stay, `malformedFiles` names it, and consumers see the absence rather than a shape the file never had |

**Measured after commit `036644f`** (same method):

| mutation | selector | result |
| --- | --- | --- |
| the declaration no longer gates the binding | `tests/unit/discovery-count-projection.test.ts` | exit 1 (red) |
| the cost report counts a convenience-read probe list again | `tests/unit/discovery-floor-fail-closed.test.ts` | exit 1 (red) |
| `focus` stops distinguishing an unreadable plan | `tests/unit/discovery-floor-fail-closed.test.ts` | exit 1 (red) |
| the challenge is written before the claim list is read | `tests/unit/discovery-floor-fail-closed.test.ts` | exit 1 (red) |

Six cases carry this round in the declared surface. Full suite: 264 files / 1568 tests. The one-decision witness lives at the
store entry point rather than behind the command, because the verb-level refusal answers first and would otherwise hide
whether the write itself is one decision — the same trap as witnessing a fix without witnessing the path that reaches it.

### 9.3 The fourth round: a partial view, and a record certifying itself

The fourth independent round could not falsify eight of the eleven repairs and found the class at two more layers:

| finding | what was wrong | repair |
| --- | --- | --- |
| `usage.json` (major, AC-2) | the one schema-less artefact whose writer-path reader was its own: `readUsageRecord` parsed without a container check, so `[]` read as an empty record and `ensureAssurance`/`setUsage` overwrote the bytes that were the only evidence the file is corrupt | the reader is `readJsonObject` and requires an object; `policy.json` uses it too, which closes the literal `null` case (it parsed to `null` and was indistinguishable from an absent file) |
| **a self-asserted run** (major, AC-3) — the security-relevant one | the declaration check landed, but the *resolution* was still the only account of the run: a hand-written `challenges.json` asserting a falsifier id, a supported verdict and the current revision satisfied the floor with `verdicts.json` empty | `discoveryProjection` also requires the reading the ledger recorded — same evidence, same revision, written only by `evidence verify` — so the record cannot certify itself |
| a partial view reaching the consumers (major, AC-1) | with the scan's verdict now nulling a malformed section, the consumers read that null as *absent*: `claim list` answered `claims: []`, `status` answered `0`/`null`, `focus` answered "the subject is not frozen" — each with a remedy that overwrites the evidence | **one gate at the command boundary**: a verb that reports on, decides from or writes to a ledger with an unreadable section stops, naming the files; `status` is the exception, and now carries `unreadableArtefacts` so the exemption is honest |

**Measured after commit `4b75333`/`1e4d3a5`** (same method): the recorded-run requirement, the usage container check and the boundary gate each redden their selector; restoring the file returns the committed SHA-256 and green.

Three cases and two assertions carry this round. Full suite: 264 files / 1572 tests.

**What four rounds say about the shape.** Each round found the same class one layer further out — a reader, then a writer, then a report, then the view a report is built from — and each round's fix was one layer up from the previous one: per-reader, then per-decision, then per-verb, and now **one gate at the boundary plus one input to the decision**. The rule that emerged and is worth keeping is not "check the container" but: *an absence and an unreadable file must not be representable by the same value anywhere a decision or a report reads it.*

### 9.4 The fifth round: the container was checked, the elements were not

The fifth independent round could not falsify any of the fourteen repairs in place and found the class one layer in again —
**inside** the elements: the outer container answered its type while a nested field did not. Its four findings, and the
single mechanism that now covers them:

| finding | what was wrong | repair |
| --- | --- | --- |
| `challenges.resolution: null` (major, AC-1) | the optional nested field had no shape check, so the record passed the scan, `malformedFiles` stayed empty, the boundary gate did not fire, and `discoveryProjection` dereferenced it — a `TypeError` out of `decide`, navigation, repair-entry and distill-gates alike | the field spec carries a **shape** per field (`record`, `stringArray`, `recordArray`, `boolean`, `string`, `number`), checked by the same `records()` the scan and every writer use |
| a rejected policy (major, AC-1) | `policyRejected` was reported in its own field while the view handed consumers `defaultPolicy()`: a stored ceiling of `security` was delivered as `strict`, and `ledger plan` wrote a plan under the substituted rule | the rejected policy joins `malformedFiles` and `malformedReasons`, so the boundary gate and `status` both name it — the two answers to one question become one |
| `plan.readingSets[].paths` (minor, AC-1) | `decodePlan` checked only `claimId`, so a set without `paths` reached `focus` and threw | `paths`, `types` and `minimumStrength` are **required shapes**: the consumers dereference them, so an absent one is not a usable record |
| `usage` fields (minor, AC-1) | only the container was checked: `{"usage": 42}` was delivered as the usage record, and `{"assuranceHistory": "zzz"}` was spread by `ensureAssurance` into three fabricated history entries written back into the store of record | the usage document's fields carry shapes too |

**Measured after commit `2059798`** (same method): removing the resolution shape, the reading-set `paths` requirement, the
usage field shapes, or the policy's membership in `malformedFiles` each reddens `tests/unit/ledger-record-read-state.test.ts`
and restoring the file returns the committed SHA-256. Seven cases carry this round. Full suite: 264 files / 1579 tests.

**One deliberate limit, recorded rather than implied.** `resolution.observed` is *not* required: a terminal record whose
observation is absent is the discovery floor's own refusal ("an attempt that decided nothing"), and that contract belongs to
the change that owns it. This boundary insists only that a resolution that *is* present answers the type it declares. The
first attempt required it and broke that change's case — the honest reading of the conflict is that the finer refusal is not
this change's to take away.

### 9.5 The sixth round: the last two consumers, and the write path

The sixth independent round could not falsify the eighteen repairs in place and reported three items — the class's last
consumer layer, the write path, and a comment that described a coercion the code does not perform:

| finding | what was wrong | repair |
| --- | --- | --- |
| the two consumers of `unsupportedClaims` (major, AC-1) | `openLedgerProblems` asks the readability predicate first, but the change record's `findings` and the archive's known-problem read called the projection directly — so an unreadable ledger became `findings: []` and `0 problems` | the projection asks the one predicate itself and refuses with the files named; absence stays a fact (`[]`), not a refusal |
| `writePolicy` (minor, AC-2) | `policy.json` is validated through its reader's schema, but it was in neither table the single write entry point consulted, so the one writer that persists it could store a policy every reader then refuses | the write entry point validates reader-validated artefacts too |
| the `records` comment and `recordElements` (nit) | the comment claimed non-string fields were coerced to `''`, non-object elements dropped and non-array documents passed through; the implementation throws for all three. `recordElements` had no callers | the comment describes what the code does; the dead function is gone |

**Measured after commit `0ac0455`:** removing the projection's refusal reddens `tests/unit/ledger-record-read-state.test.ts`;
removing the write-path validation reddens `tests/unit/discovery-floor-fail-closed.test.ts`; both restore to the committed
SHA-256. Two cases carry this round. Full suite: 264 files / 1582 tests.

**A note on the round count.** Six rounds found the same class one layer out, and four of them paid for a repair that
closed a layer rather than the class — the mechanism was right and the sequencing was not. The rule this change leaves
behind, in the reviewer's own words, is the invariant, not the sites: *an absence and an unreadable file must not be
representable by the same value anywhere a decision or a report reads it* — and when a round names a class, the class is
closed in one pass before the next seal, because every partial repair costs a full independent round.

### 9.6 The seventh round: navigation must carry the refusal too

The narrow seventh review checked the only remaining report projection outside the ledger workflow and found the same
false-zero shape in `readUpstreamSummary`: it correctly exposed `ledger.state: "unreadable"`, then replaced the failed
problem read with `[]` and reported `reviewFindings: 0`, `blockingFindings: 0`, and `majorFindings: 0`. That is not an
absence of findings; it is a refusal to answer how many there are.

The repair turns the named refusal into one synthetic `ledger_unreadable` **blocking** problem at the navigation
boundary. This is deliberately a projection-only representation: it does not change the ledger's decision, fabricate a
claim finding, or cause another reader to derive readability. All existing navigation counters and priority logic now
consume the same explicit problem instead of interpreting `[]` as both empty and unreadable.

The permanent regression test is the reviewer’s minimal topology: a task with a malformed `claims.json` has an
unreadable ledger and must report one blocking review problem whose message names `claims.json`; it may never report zero.
The reversible mutation restores the old `[]` fallback and reddens that test.

### 9.7 Owner-routed Wiki store integration

Verification runs in an isolated linked worktree, while the registered Wiki closure candidate lives in the owning
checkout's record store. Keeping `wikiDir(root)` caller-derived made a valid registered candidate read as
`candidate_missing` from this worktree. Copying the candidate would create a second record of the same fact, so this
change integrates the archived `route-the-wiki-store-through-its-owner` definition-layer repair instead: the record
owner is derived by checkout/worktree shape, and `wikiDir` resolves through that owner. C8/E8 make the dependency
explicit for this revision: a closure asked from the linked worktree must resolve its registered candidate in the owner
store.