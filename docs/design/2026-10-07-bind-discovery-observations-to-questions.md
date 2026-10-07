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

A candidate contributes only when all existing challenge-side predicates hold:

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

## 4. Tests and falsifiers

| AC | Selector | Reversible falsifier |
| --- | --- | --- |
| AC-1 | `tests/unit/discovery-count-projection.test.ts` | restore the answer loop in `discoveryProjection`; a matching free-text answer must again make the count nonzero and the test must fail |
| AC-2 | `tests/unit/review-request-is-handed-over.test.ts` | restore the unanswered-probe gap; an otherwise complete request with no answer must fail |
| AC-3 | `tests/unit/discovery-floor-fail-closed.test.ts` | make a free-text answer reach `ledgerVerdict`; a strict ledger with no bound verifier challenge must incorrectly pass and the test must fail |

The final verification additionally runs the full test suite and typecheck. The independent strict reviewer receives the frozen 11-path surface and must try to make an answer, rather than a bound challenge, pass the floor or approval.

## 5. Rejected alternative

A receipt-bound `observed` field was rejected for this change because no current host contract attests individual command output. A record authored through the Kata CLI would be indistinguishable from the original self-report. Fail-closed removal of decision power is the only complete repair that stays inside the existing trust boundary.
