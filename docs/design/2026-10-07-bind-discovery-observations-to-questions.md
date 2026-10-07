# Bind discovery observations to questions

**Change:** `bind-discovery-observations-to-questions`
**Status:** approved design
**Scope:** finish the open F2 finding in `docs/superpowers/reports/2026-10-06-probe-answers-outlive-their-revision.md` without introducing a host-specific receipt protocol.

## 1. Problem and decision

The report's F1 (revision-bound probe questions) and F3 (one discovery projection) are already implemented on `master`. F2 remains: `ledger answer --observed` accepts a free-text value, while the old discovery projection could count a non-blank answer as an independently verified reading. Repeating a probe's expected prefix is therefore indistinguishable from observing it.

A host-backed per-tool receipt would require the host to attest command, stdout, exit code, and identity. `ReviewExecutionReceipt` currently contains only run binding, capabilities, and telemetry; adding a Kata-local receipt field would still be self-authored. That is a separate host-protocol project, not a fast or honest repair here.

**Decision:** fail closed. A `ProbeAnswer` remains append-only audit history and may explain what a reviewer reported, but it has no decision power. The non-standard discovery floor accepts only a challenge that is bound to a declared `executable_falsifier`, measured at the current subject revision, and corroborated by a supported recorded verifier run.

This is stronger than matching free text against the expected string: no spelling or formatting of `observed` can satisfy a gate.

## 2. Boundary

Included:

- `src/store/verdict.ts`: make the single discovery projection derive both counts solely from admissible bound challenges.
- `src/store/review-request.ts`: stop treating absent, stale, mismatched, or legacy probe answers as request/approval gaps.
- `src/kernel/discovery.ts`, `src/kernel/decide.ts`, `src/store/ledger.ts`, and `src/cli/ledger.ts`: accurately describe advisory answer history and the challenge-only floor.
- The zenmpai report: preserve the original reproduction, add a resolved status and the implemented rule/evidence for F1--F3.

Excluded:

- Host receipt/extension work, platform configuration, or a per-tool execution attestation protocol.
- Deleting or rewriting historical `probe-answers.json` records.
- The separate caller-side `catch(() => null)` class.


## 2.1 Skill-first and platform boundary

Kata does not modify, configure, import, or route host extensions, providers, sessions, or models. It emits deterministic
requests and validates repository records only. Independent review remains a host-owned `/kata-review` Skill operation: the
host receives the request, runs the isolated read-only reviewer, and returns only the governed artefacts Kata accepts.

If a future design needs attested per-command output, it must be introduced as a platform-neutral, host-owned Skill receipt
contract and passed into Kata as data. It must not be implemented by adding a Pi extension dependency, a Kata platform
adapter, or a Kata-initiated host session. This change needs none of that capability because it removes the untrusted answer
from every gate input.
## 3. Behaviour

### 3.1 Discovery floor

`discoveryProjection` keeps one derivation for `independentChallenges` and `verifiedChallenges`, but it no longer receives or reads probe answers for either count.

A challenge counts as an **attempt** (`independentChallenges`) once predicate 1 holds — it names a declared `executable_falsifier`; that is the same split the projection always had, and it is what lets `discovery_unverified` say "something was declared and no run supports it" instead of "nothing was challenged". It counts as a **verified reading** (`verifiedChallenges`) only when all three hold:

1. it names a declared `executable_falsifier`;
2. its resolution binds the same falsifier and the current subject revision;
3. the ledger has a supported recorded verifier verdict for that falsifier and revision.

Consequences:

- a matching, mismatching, blank, stale, or legacy probe answer contributes zero;
- no challenge means `discovery_floor`, even if every issued probe has an answer;
- a challenge that was declared but lacks its supported verifier run remains `discovery_unverified`.

### 3.2 Review request completion

A ReviewRequest still carries its generated probes so a reviewer can inspect and answer them. Answers remain useful audit context, but `verifyAgainstRequest` no longer emits a gap for an unanswered probe. It continues to enforce the plan's reading set, required evidence type/strength, subject freshness, and readable artefacts.

Therefore a free-text answer cannot indirectly decide review approval through request completion either.

### 3.3 Documentation and migration

Historical answers remain readable and append-only. Their former gate effect is removed rather than retroactively fabricated as validated evidence. Comments, CLI wording, and the report must say this directly.

The report resolution must identify:

- F1: probes and answers are revision-bound/current-question scoped;
- F2: answers are advisory and cannot satisfy the floor or request approval;
- F3: both discovery counts derive from the same challenge-only projection.

### 3.4 The negatives have to be falsifiable, which took four review rounds to get right

Removing an input from a decision removes it from every test that fed that input too, and a test that asserts a negative about an
input the code under test never receives is a tautology. **Four** review rounds found **four** instances of this in this change's
own suite — the last one after this section first claimed the class was closed, which is why the section says four:

| Where | Why it was vacuous | What it is now |
| --- | --- | --- |
| `tests/unit/review-request-is-handed-over.test.ts` | the case asserted "an unanswered probe is not a gap" while the fixture asked no probe, so a restored probe-gap loop was a no-op | the fixture writes a probe; the case asserts the request carries it and that the gap list does not name it |
| `tests/unit/discovery-count-projection.test.ts` | the `project()` helper kept `probes?`/`answers?` in its type but stopped forwarding them, so every answer case was an assertion about `undefined` | the helper forwards both, so the projection really is handed an answer it must ignore |
| `tests/unit/discovery-floor-fail-closed.test.ts` (answers) | the case wrote `probe-answers.json` without the `probes.json` that always accompanies it, so an implementation matching an answer to its question read nothing | both records are written, stamped with the revision the fixture froze |
| `tests/unit/discovery-floor-fail-closed.test.ts` (satisfied state) | the case was titled "clears discovery for a terminal record that recorded an observation" but asserted only the absence of two *other* refusal codes — under the retired semantics it was true, under the new projection a record naming no declared falsifier cannot clear anything, so it stayed green while guarding nothing | split into the state it names: a positive case that a challenge bound to a **declared falsifier** clears the floor (fixture declares `E2`, resolution stamped `current`, asserted to redden when the recorded-verdict conjunct is broken), and a regression that a free-form record does **not** clear it however non-blank its observation |

**The falsifier is the historical implementation, not a synthetic one.** `E1` restores the answer-counting block that this change
deleted, in place, and reddens the projection selector (2 failures); replaying the whole historical defect — the block plus the
caller that passed `probes`/`answers` into it — reddens both selectors. A mutation that forces `return { independentChallenges: 1 }`
proves only that the test reads the return value, which is why it was replaced.

**What each selector guards, stated so a later reader does not over-claim:**

- `discovery-count-projection.test.ts` — the projection ignores answers *even when handed them* (`E1`);
- `discovery-floor-fail-closed.test.ts` — the floor refuses (`E3`), an answered probe does not clear it (reddens only under the
  full historical replay, because the production caller no longer supplies answers at all), and the satisfied state — a challenge
  bound to a declared falsifier — *does* clear it (reddens when the recorded-verdict conjunct in `discoveryProjection` is broken);
- `review-request-is-handed-over.test.ts` — an unanswered probe is not an approval gap (`E2`);
- `probe-answer-binding.test.ts` — the CLI refuses an answer whose command does not match its question (`E4`).

`C3`'s refusal text was corrected in the same pass: `discovery_unverified` named the bare `challenge check`, which refuses in the
state that reaches it (a terminal challenge whose resolution is bound to a superseded revision), and claimed the record had no
terminal observation when it does. It now names `challenge check --id <challenge-id>` and says the measurement is stale.

## 4. Tests and falsifiers

| AC | Selector | Reversible falsifier |
| --- | --- | --- |
| AC-1 | `tests/unit/discovery-count-projection.test.ts` | restore the answer loop in `discoveryProjection`; a matching free-text answer must again make the count nonzero and the test must fail |
| AC-2 | `tests/unit/review-request-is-handed-over.test.ts` | restore the unanswered-probe gap; an otherwise complete request with no answer must fail |
| AC-3 | `tests/unit/discovery-floor-fail-closed.test.ts` | make a free-text answer reach `ledgerVerdict`; a strict ledger with no bound verifier challenge must incorrectly pass and the test must fail |

The final verification additionally runs the full test suite and typecheck. The independent strict reviewer receives the frozen **19-path** surface (`17` of which this change edited; `tests/e2e/workflow-resume.test.ts` and `tests/unit/installer.test.ts` are declared because the shared fixture they use changed) and must try to make an answer, rather than a bound challenge, pass the floor or approval.


## 5. Rejected alternative

A receipt-bound `observed` field was rejected for this change because no current host contract attests individual command output. A record authored through the Kata CLI would be indistinguishable from the original self-report. Fail-closed removal of decision power is the only complete repair that stays inside the existing trust boundary.
## 6. The boundary of the hygiene class, stated so it is not over-claimed

Four review rounds kept finding one more instance of the same class — declared plumbing nothing supplies — in this change's own
declared surface. Two of them were introduced by the repairs themselves (a `rm` left on a line the repair edited, an `answers`
fixture option with no caller). The class is real, and it is larger than this change:

`npx tsc --noEmit --noUnusedLocals --noUnusedParameters 2>&1 | grep -cE 'error TS(6133|6192)'` reports **284** such findings on the
tree this change seals (`258` `TS6133` + `26` `TS6192`), of which **34** are in `src/workflow/orchestrator.ts` and **7** in
`src/store/ledger.ts`. The number is a property of the tree, not a fixed fact — re-run the command rather than quoting it. The
project's `typecheck` script does not enable the flag, so CI has never held this line.

This change therefore does the bounded thing rather than adopting the flag: it removes the instances **on lines it touched or
that a review named** (the four test files and the `readPlan` import in `src/store/review-request.ts`), and it records the rest as
a repository-wide concern outside this change's AC. Adopting `noUnusedLocals` for the whole repository is a separate change; doing
it here would churn files this change has no behavioural reason to touch.
