# Repair Discovery Floor Semantics

**Change:** `repair-discovery-floor-semantics-v2` (successor of the un-bootstrapped `repair-discovery-floor-semantics`)
**Status:** implemented
**Profile:** `current_worktree / tdd / strict`

## 1. Problem

The strict discovery floor currently treats `Challenge.reproduced === true` as the sole proof that an independent challenge was actually performed. `kata-cli ledger challenge check` sets that field only when a command exits non-zero. Consequently, a challenge that was independently run against the current revision and **passes** records an observation and moves to `withdrawn`, yet contributes zero `verifiedChallenges`. The decision then refuses with `discovery_unverified`.

That is the wrong equivalence:

> "an executed challenge has no current counterexample" is not the same as "no challenge was executed".

It creates a perverse review incentive: an independent reviewer must find or manufacture a still-failing counterexample to satisfy the floor, even when the reviewed revision correctly withstands the challenge.

The live blocker is `decision-snapshot-commit`: its independently run challenge completed with an `exit 0` observation and was withdrawn, but its ledger remains `insufficient / discovery_unverified` solely because it never reproduced on the repaired revision.

## 2. Decision

### 2.1 What the discovery floor proves

For the discovery floor only, a **verified challenge** is a distinct challenge that:

1. is no longer `open` (`withdrawn` or legacy-readable `resolved`);
2. has a recorded, non-blank `resolution.observed`; and
3. therefore has a persisted result from an actual check.

A non-zero result remains an open counterexample and is separately rejected by the existing `challenge_open` rule. A later successful re-check withdraws it and records the observation. A first-check success is equally an observed result and may satisfy the discovery floor.

`Challenge.reproduced` remains an immutable historical fact: it says a counterexample was once observed. It no longer decides whether a challenge was executed. This preserves finding history while separating it from execution evidence.

### 2.2 What the discovery floor does *not* prove

A completed challenge does **not** prove a claim correct, prove the command is meaningful, or substitute for evidence, risk-class coverage, quorum, review, or Judge. Those gates remain unchanged.

Kata cannot infer semantic adversarial quality from a shell command or exit code. Independence remains a host/reviewer responsibility; Kata mechanically verifies only the recorded execution state and observation. Treating `exit 0` as a current defect simply because it passes is not a sound substitute for that responsibility.

### 2.3 Fail-closed states retained

| State | Discovery count | Gate result |
| --- | --- | --- |
| No non-open challenge/probe | 0 independent | `discovery_floor` |
| Challenge is `open`, including non-zero or timeout result | not verified | `challenge_open` |
| Non-open challenge without a non-blank observation — blank **or absent**, since the artefact has no schema | not verified | `discovery_unverified` |
| Non-open challenge with a recorded observation, whether or not `reproduced` | verified | may clear discovery only; all other gates still apply |
| Recorded probe answer without command or observation | not verified | `discovery_unverified` |

Legacy `resolved` challenges remain readable under the same non-blank-observation rule.

### 2.4 The false positive this trades for, stated plainly

The floor is now satisfiable by a command that measures nothing: `challenge add --command 'exit 0'` plus one `challenge check` leaves a terminal record with a non-blank observation, and it counts. That is the deliberate price of removing the false negative — under the old rule an honest passing check was ineligible, which is what drove reviewers to manufacture a current failure — and `reproduced` could not separate the two cases anyway: it records that a command once failed, not that the command was worth running.

The honest reading of "execution evidence" is therefore **a command ran and its output was recorded**, not "the measurement was meaningful". The probe half has the same shape plus one more gap: `verifiedChallengeCount` does not compare a probe answer's observation against the fact the probe asked for, because an answer carries neither the probe's kind nor its path. Both are behaviour changes with their own review; a mechanical bar (for example, requiring a challenge to reference a declared path, and a probe answer to carry the asked digest or path) is a candidate successor, not something this change pretends to have done.

## 3. Implementation boundary

The implementation changes the one derivation, `verifiedChallengeCount()` in `src/store/verdict.ts`. It will count terminal challenges by terminal state plus recorded observation, not by `reproduced`.

The existing writer already provides the required record:

- `src/cli/ledger.ts` executes the command and persists `resolution.observed` on every `challenge check`.
- `src/store/ledger.ts` preserves `reproduced` when a prior counterexample existed; comments will state that the field is historical counterexample evidence, not discovery execution evidence.
- `src/kernel/decide.ts` keeps the existing two checks and their reason codes: no independent record remains `discovery_floor`; a terminal record with no usable observation remains `discovery_unverified`.
- `src/kernel/types.ts` and the `discovery` field's doc in `src/kernel/decide.ts` state the rule that now holds, and name the limit beside it (a recorded measurement is not a meaningful one). An earlier draft of this section claimed the "nearby comments" were covered while `decide.ts` still described the removed rule — found by an independent round, which is why the claim is now specific about where.

No schema migration, provider integration, platform adapter, receipt protocol, or change to the acceptance/approval/Judge gates is introduced.

## 4. Test plan and falsifiers

### Unit derivation

`tests/unit/probe-set-asks-distinct-questions.test.ts` will prove the one derivation distinguishes execution from reproduction:

- terminal challenge + non-empty observation + `reproduced: false` counts as one;
- terminal challenge with no observation does not count;
- an open challenge does not count even if an observation exists;
- the existing reproduced-then-withdrawn counterexample still counts.

**Mutation:** restore the `challenge.reproduced !== true` filter in `verifiedChallengeCount`; the first case must fail.

### CLI workflow

`tests/unit/ledger-cli-end-to-end.test.ts` will create a strict ledger, record claims/evidence, add a passing challenge, run `ledger challenge check`, and verify that `ledger decide` does not report `discovery_unverified`. This proves the actual command persists the observation consumed by the one derivation; a unit-only fixture is insufficient.

**Mutation:** omit or blank the observation passed by the CLI writer; the workflow must again refuse with `discovery_unverified`.

### Fail-closed state matrix

`tests/unit/discovery-floor-fail-closed.test.ts` drives a **real ledger on disk** through `freezeSubject` → `appendChallenge` → `ledgerVerdict` for the states AC-2 names, so the refusals are pinned where they decide rather than only in the count: an open counterexample, a timed-out check left unresolved, a terminal record with a blank observation (which must refuse with a deficit naming `challenge check`), a terminal record with an observation, and a legacy `resolved` record.

It is a separate suite rather than a reuse of the AC-1 selector because the two rows then resolve to **one** check: measured on the first seal of this change, `ac-1-terminal-observation` and `ac-2-fail-closed-discovery-states` produced the same resolved command line, the change record listed a single check, and AC-2 was left with no evidence of its own.

**Mutation:** remove the `resolution.observed` guard in `verifiedChallengeCount`; the blank-observation case must fail.

### Decision matrix

`tests/fixtures/review-scenarios.ts` retains an explicit `discovery_unverified` case, but describes it truthfully as a record with no usable observation rather than a command that passed. `src/kernel/decide.ts` continues to pair every reachable reason with an actionable deficit.

## 5. Scope and non-goals

Included: ledger challenge execution evidence, its pure decision derivation, reason text/comments, and the focused unit/CLI/fixture tests.

Excluded:

- changing the strict tier, review quorum, evidence adequacy, claim support, or review/Judge trust boundaries;
- deciding whether a particular shell command is intellectually adversarial or independently authored;
- changing current task ledgers by hand or fabricating a challenge result;
- the separate `install-pi-reviewer-agent` distribution work;
- any repair to `decision-snapshot-commit` other than allowing its already-recorded ledger to be re-evaluated after this governed change lands.

## 6. Acceptance matrix

| AC | Contract | Verification |
| --- | --- | --- |
| AC-1 | A terminal challenge with a non-blank persisted observation counts as executed discovery even when `reproduced` is false. | Unit derivation and `reproduced`-predicate mutation |
| AC-2 | Open, timeout/unresolved, or observation-free challenge states remain fail-closed; existing reason/deficit routing remains reachable. | Fail-closed state matrix over a real ledger (`tests/unit/discovery-floor-fail-closed.test.ts`) plus the observation-guard mutation |
| AC-3 | The real CLI check → ledger decision path consumes the recorded passing observation and does not demand a manufactured counterexample. | End-to-end ledger CLI test and observation-writer mutation |
| AC-4 | The change does not treat discovery as claim evidence or weaken evidence/quorum/review/Judge requirements. | Existing strict-ledger workflow regression and focused decision assertions |

## 7. Measured verification

Three declared mutations were applied to production source, observed to redden, and restored:

| Mutation | Restored line | Observed result |
| --- | --- | --- |
| Re-require `challenge.reproduced !== true` in `verifiedChallengeCount` | `src/store/verdict.ts` | the AC-1 derivation case failed (`expected 0 to be 1`) and the AC-3 CLI case failed (`expected 'insufficient' to be 'pass'`) |
| Blank the observation persisted by the CLI writer | `src/cli/ledger.ts` | five `ledger-cli-end-to-end` cases failed with `expected 'insufficient' to be 'pass'`, including the AC-3 case |
| Remove the `resolution.observed` guard in `verifiedChallengeCount` | `src/store/verdict.ts` | the AC-2 blank-observation case failed (`expected 1 to be +0`) beside the AC-1 unobserved case |

Restored state: focused suites 58/58 green (`probe-set-asks-distinct-questions` 5, `discovery-floor-fail-closed` 5, `ledger-cli-end-to-end` 18, `review-seed-corpus` 30), `tsc --noEmit` clean, full suite **260 files / 1505 tests** green.

## 8. Recorded limitation

The floor still cannot distinguish a meaningful adversarial command from a vacuous one — `grep -q` against a frozen source file and `exit 0` are both `exit 0`. That judgement is a reviewer/host responsibility, and this change deliberately does not pretend to mechanize it; what the floor now proves is exactly *that a recorded independent check ran and persisted its observation*. A vacuous challenge remains possible and is a review-quality question, not a discovery-floor question.
