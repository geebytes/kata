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