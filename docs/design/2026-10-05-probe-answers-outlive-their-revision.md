# Probe Answers Outlive the Revision They Were Asked About

**Change:** `photo-observation-provider-layer` (dogfooded in `zenmpai`; found by an independent round, located and reproduced by the implementer)
**Status:** observed and reproduced; not repaired
**Profile:** `git_flow / tdd / strict`

## 1. Problem

A strict change's probe set is asked **once**, against the first frozen subject. Every later revision that moves a
reading-set file leaves those probes asking about a digest the revision no longer has — and neither the question nor
its answer can be replaced. The four rules that produce this are each sound alone:

| Rule | Home |
| --- | --- |
| A probe's id is positional: `P${probes.length + 1}-${claim.id}` | `src/kernel/discovery.ts:114` |
| The command's expected prefix is taken from the **current** subject: `input.subject.pathDigests[path].slice(0, 8)` | `src/kernel/discovery.ts:107` |
| `appendProbe` never replaces an existing id: `if (!items.some((entry) => entry.id === probe.id)) items.push(probe)` | `src/store/ledger.ts:105` |
| `answerProbe` refuses a second answer for the same id | `src/store/ledger.ts:133` |

`ledger ask` derives the question correctly and then reports `asked: [...]` **unconditionally**, whatever the write did
(`src/cli/ledger.ts:528-554`). So the command that exists to ask a fresh question reports that it asked, while
`probes.json` still holds the old one. The failure is silent on both sides: the derivation is right, the write is
discarded, and the caller is told it succeeded.

Observed on a real change. After five review/repair rounds, three questions could not be answered at the frozen subject:

| probe | path | asks | subject records | exit |
| --- | --- | --- | --- | --- |
| `P1-CL-1` | `tests/architecture/test_photo_observation_boundaries.py` | `6ea3a611` | `98389ebc` | 1 |
| `P1-CL-2` | `tests/photo_observation/test_rawpy_sensor.py` | `26d19055` | `8f986e31` | 1 |
| `P1-CL-3` | `tests/photo_observation/test_rawpy_sensor_integration.py` | `4888fa51` | `55297add` | 1 |

The recorded answer to the first one is itself the demonstration:

```json
"observed": "sha256(...test_photo_observation_boundaries.py)[:8]=6ea3a611 (probe asked for prefix 6ea3a611)"
```

The parenthetical restates the expectation. It cannot distinguish "read the file" from "read the question".

## 2. Reproduction

```bash
# 1) the real digest and the probe's expectation disagree
node -e "process.stdout.write(require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync('tests/architecture/test_photo_observation_boundaries.py')).digest('hex').slice(0,8))"
# → 98389ebc   (probe asserts 6ea3a611)

# 2) the real observation cannot be recorded
kata-cli ledger answer --change <id> --probe P1-CL-1 --command '<the command>' --observed '98389ebc'
# → {"ok":false,"error":"P1-CL-1 has already been answered; a probe is answered once, ..."}

# 3) `ask` reports a question it did not ask
kata-cli ledger ask --change <id>
# → {"asked":["P1-CL-1","P2-CL-1",...],"seed":"rev:<current>"}
#    probes.json: P1-CL-1 prefix is still 6ea3a611, askedAt is still the first round's
```

## 3. Why a repair loop guarantees it

Three rules meet, and none of them is wrong on its own:

1. `docs/operations.md:307` and `.agents/skills/kata-review/SKILL.md:157` require it: *"a verdict outlives its content, so
   a declared path that moved after the decision refuses the approval and names the path."*
2. Above `standard`, both severities refuse approval: `mergeBlockingSeverities` returns
   `['blocking', 'major']` (`src/quality/review-ladder.ts:72`), consumed as `blocking_findings`
   (`src/workflow/distill-gates.ts:108`).
3. A review round's findings are *about the guards*, and the guards live in the reading-set files — so repairing them
   moves those files. That is what the reading set is for.

Therefore: **any strict change that completes one repair round after its first `ledger ask` reaches a state where its
probe set asks about content that no longer exists, cannot be corrected, and is cited by the protocol as a reason to
refuse.** The mechanism is unusable precisely in the loop it was built to serve.

## 4. What is *not* broken — measured

Stating this precisely matters, because the intuitive reading ("the stale probes fail a gate") is wrong, and acting on it
would fix the wrong thing.

| Question | Measurement | Answer |
| --- | --- | --- |
| Does `probeResponseRate` gate anything? | `probeResponseRate` is constructed in `src/store/ledger.ts` for `status --cost` and has no other reader; the floor's condition is `input.discovery.independentChallenges === 0` (`src/kernel/decide.ts:427`) | **No.** It is reported, not consumed |
| Are duplicate questions counted twice? | `distinctProbeCount` de-duplicates by `command.trim()` (`src/store/ledger.ts:931`); measured on the real change: raw files hold 9 records, `status --cost` reports `probesAsked: 6, probesAnswered: 6` | **No** — for the reported rate |
| Do stale answers still satisfy the floor? | `verifiedChallengeCount` counts an answer when `answer.command.trim()` and `answer.observed.trim()` are both non-blank (`src/store/verdict.ts:50-57`); the round-1 text above is non-blank | **Yes.** `ledger decide` returns `pass` on a probe set whose three digest questions are unsatisfiable |

So the ledger does not notice, and cannot be made to notice from inside the reviewer role. The refusal comes from the
review protocol (rule 1 above) applied by a reader — which is exactly what happened: an independent round found it,
called it blocking, and named the three paths.

**The defect is therefore an inconsistency between a rule and its mechanism**: the protocol requires the probe channel to
prove that a reading happened *at this revision*, and the mechanism guarantees the probe channel can only ever prove it
about the revision where the question was first asked.

## 5. Two adjacent defects found while locating this one

**5a — `independentChallenges` counts records where its sibling counts questions.** `src/store/verdict.ts:292-296`
adds `readProbeAnswers(...).length` — raw records — while `verifiedChallengeCount` in the same file de-duplicates by
command (`src/store/verdict.ts:57`, with a comment saying "Distinct questions, not distinct answer records"). The
generator de-duplicates **within one claim** but not **across claims** (`const asked = new Set()` is per-`probesFor`
call), so a three-claim ledger asking three questions each can legitimately record the same question twice. Only
zero-ness of `independentChallenges` gates (`src/kernel/decide.ts:427,438`), so this is reporting-only today — but the
same file now gives two answers to "what is one independent reading", and that is the class this line of work has spent
the most rounds on.

**5b — the count's docstring declares a check the code does not make.** `src/store/verdict.ts:30-34` says a probe answer
"counts only when the recorded observation carries the fact the probe asked about — the digest prefix for
`digest-prefix`, or the path for the existence questions." The implementation checks non-blank `command` and non-blank
`observed` and nothing else. An observation that restates the question therefore counts as an independent reading, which
is how the answer quoted in §1 satisfied a strict floor. The known gap this maps to is already recorded
(`docs/architecture-reviews/2026-09-27-current-workflow-code-review.md:98,105`: `ledger answer` does not validate
`observed` against the expected digest) — what is new is that the **count's own comment now claims it does**.

## 6. Proposed repairs

Each closes the loop; they are alternatives, not a sequence. None changes what a probe means.

1. **Content-addressed probe ids** — `P${index}-${claim.id}@${prefix}` (or include the subject revision). A new subject
   produces new ids, so a re-ask appends a fresh question and the old one stops being the thing that is answered.
   Requires deciding what a stale id does to the counts; the honest answer is "it is a question about a revision that is
   no longer under review", which is §5a's problem stated as a rule.
2. **Replace on identity change** — in `appendProbe`, when an id exists but `kind`/`path`/`prefix` differ, replace it and
   keep the previous record in history rather than silently retaining it.
3. **Bind answers to the subject** — an answer records the subject revision it was observed at; a re-freeze retires it
   (counted as unanswered, not as answered), which forces a re-answer instead of permitting a stale one.

Option 3 is the only one that also fixes the general case where a reading set moves *without* the question changing
(§5a's duplicates), because it makes the binding explicit rather than inferred from the question's text.

## 7. Scope and non-goals

In scope: the identity and lifetime of a probe and its answer, and the counts derived from them.

Out of scope:

- changing the strict tier, the discovery floor's semantics, or the evidence/quorum gates;
- deciding whether a given probe question is worth asking;
- validating that an answer's `observed` semantically matches the question — that is §5b, a separate decision with its
  own failure modes (it would need the probe's kind and path, which the answer type deliberately does not carry);
- hand-editing any existing task's ledger to clear the symptom.

## 8. Recorded limitation

While this is unrepaired, the only in-task mitigation is **additive**: re-run `ledger ask` with a larger `--per-claim` so
that fresh ids (`P3-*`, `P4-*`, …) are appended against the current subject, and answer those. Measured on the real
change: three fresh probes were appended, all carried the current prefix, and all three were answered from a real
execution.

That mitigation is honest but partial, and both limits should be read together with it:

- the stale answers remain in the record and still satisfy the floor (§4), so the channel's *reported* assurance is
  higher than what it proves;
- it is positional, so the next move of any reading-set file recreates the same state for the newly appended probes.
