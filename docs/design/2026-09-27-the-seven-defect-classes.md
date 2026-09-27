# The seven defect classes, and what covers each today

**Why this file exists.** The repository carried a class table — `src/quality/class-coverage.ts` — that named the sentences
this project's review findings belong to, with a check per class that reddens when the class returns. It was deleted with
the round-shaped route, because the mechanism that consumed it (`roundMayClose` asking whether a round could close) was
replaced by the ledger: class-level closure is now the tier's `requiredRiskClasses` — a coverage contract over a declared
risk space (assumption, boundary, state transition, privilege, failure mode, …) rather than a table of historical classes.

That replacement is the right one and it is also **not the same thing**. A risk class asks "has this kind of risk been
considered"; these defect classes ask "is this how the mechanism is built wrong". They are vocabulary, and they earned
their place by measurement: one line of work produced 37 instances across ten rounds, and disposing of them one at a time
reproduced the class seven rounds running.

So the vocabulary is kept here, as prose, and the table below says for each class **whether a live check still covers it**.
That column is the point: prose with no check is a description, and a description is what a reader needs to recognise an
instance — but it is not what makes the class stop returning.

| # | class | what it is | instances on this line | the check that covered it | covered today |
|---|---|---|---|---|---|
| 1 | `one-concept-several-derivations` | a concept is re-derived at each call site, so one site is updated and the others keep the old answer | `wcc2-f1`, `kgs3-f3`, `rba5-f1/f2/f3`, `cg-f1`, `rba7-f1/f2/f4` | `tests/unit/class-invariants.test.ts` | **yes** — `tests/unit/one-derivation-of-claim-support.test.ts`, restored after the old check was deleted; five call sites were found by looking for the class, one of them a second answer instead of a copy |
| 2 | `declaration-claiming-reality` | a check reads a declaration (an owned-path set, a manifest, a task field) while its message claims to have read reality | `cg4-f2`, `rba5-f1/f2/f3`, the seal refusal, `rba7-f1/f4` | `tests/unit/class-invariants.test.ts` | **partly** — `tests/unit/revision-declaration-moved.test.ts` and the ledger's drift computation (`focus` narrows a reading set to what moved) exercise the mechanism; nothing asserts the class itself |
| 3 | `a-check-that-cannot-fail` | an assertion is green whichever implementation runs, so it demonstrates nothing | eight decorative checks, every one caught by mutation and none by reading | `tests/unit/class-invariants.test.ts` | **yes** — `tests/unit/kernel-every-check-can-fail.test.ts` (K2, per check: an evidence type without a mutation is refused by name) |
| 4 | `one-decision-several-entrances` | one decision has two entrances and only one records it, so the decision happens and the trace does not | five, the last being `matrix set --owned-paths` | `tests/unit/class-invariants.test.ts` | **partly** — `tests/unit/scope-change-safety.test.ts` covers the recorded scope-apply path; the *trace* half (an unrecorded entrance) has no live check |
| 5 | `a-part-checked-as-the-whole` | a guard inspects one field, member or direction of a concept and is read as a verdict on the concept | `cg8-f1` (identity verified, content not), and the criterion broader than its check | `tests/unit/class-invariants.test.ts` | **yes** — `tests/unit/kernel-two-adapters-reach-the-same-decision.test.ts` now states which evidence classes the differential exercises and which it cannot, and fails when an evidence type is in neither list (verified by deleting one: "is in neither list, so nobody decided whether the two adapters can be compared on it") |
| 6 | `a-definition-with-no-consumer` | a declaration is written and nothing reads it — a schema nothing bundles or registers, a field nothing consults, a refusal nothing can return | six, the sixth being the round protocol's own schema | `tests/unit/class-invariants.test.ts`, `npm run check:wiring` | **yes** — the wiring check (37 findings, all measured), `tests/unit/every-bundled-schema-has-an-id.test.ts`, and `policy`'s own integrity checks: a policy section with no consumer refuses to load |
| 7 | `output-with-one-unguaranteed-channel` | a required output has exactly one channel and that channel is not guaranteed, so a process that ends early produces nothing | three of six dispatched rounds produced no record | `tests/unit/ledger-records-each-fact-as-it-arrives.test.ts` | **yes** — the ledger writes each fact as it arrives, which is what removed the single channel; the case asserts it file by file |

## Two classes without a live check

Classes 2 and 4 are partly covered, and saying so is the honest half of this document.
They are not abandoned: each is named, each has instances recorded by id so a future instance can be recognised, and the
shape a check would need is inferable from the class itself. What neither has is the thing that made classes 1, 3, 5, 6 and 7
stop returning — an assertion that fails when the class comes back.

Landing two checks is bounded work and is not done here. Recorded rather than implied, because a table that claims
coverage for a class with no check is exactly the defect class it is describing.
