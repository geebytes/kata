# Record integrity: what a twelve-round loop measured, and the handover

**Audience:** whoever owns the record/attestation side of kata. **Scope:** this document is self-contained; it may be
handed over on its own. It does not authorise changes to any project repository — only to this one.

**Subject:** the part of an adversarial loop that the C-list (§14 of
`2026-09-18-what-an-adversarial-pass-costs.md`) did not address. C1–C7 fixed *when* a pass runs and *what* it binds
to. This document is about the **record the author writes**, which is where a second, independent loop on one project
change (`b1-identity-gap-closure`, 2026-09-20/21) put three quarters of its findings.

Measurements live in §27 of the design document; this document carries the reasoning a fixer needs, the reproduction
commands, the acceptance each change must meet, and the traps that were measured the hard way.

---

## 1. What the loop measured

19 recorded passes (10 `verify`, 9 `review`), **50 findings** by id, 487 tool uses in the records.

| Class | Findings | `major` | `blocking` |
|---|---|---|---|
| **Record / prose** — ledger rows, notes, counts, citations, coverage statements, "what I did" summaries | **37** | **12** | 0 |
| Code — identity preimages, wiring, assembly, guards | 10 | 5 | 2 |
| Other | 3 | 0 | 0 |

The two `blocking` findings are code, and both were real delivery defects (evidence citations were not content-anchored,
so identical content could yield different `version_id`s; a manifest digest still carried a runtime segment id). So were
two of the code `major`s. **Seven of the eleven rounds were about the documents describing the work** — pointer targets
that had been deleted, a ledger row whose premise the row's own disposition had falsified, counts that drifted, a
section that said it did not restate what it restated, and a coverage statement that misdescribed what the gates do.

Reproduce the ledger from the record itself, not from this table:

```bash
python3 - <<'PY'
import json, glob
for f in sorted(glob.glob(".kata/tasks/<task>/passes/*.json")):
    d = json.load(open(f))
    print(f.split("/")[-1], d.get("node"), d.get("verdict"),
          [(x.get("severity"), x.get("id")) for x in d.get("findings", [])])
PY
```

**Provenance.** Pass counts, severities and `toolUses` come from `passes/*.json` and the seal output. Token and
wall-clock figures come from the harness's per-agent reports, so those are estimates and are marked as such in §27.

---

## 2. The diagnosis, in one finding

In round 42 I changed tactics: instead of fixing stale citations one at a time, I wrote a **mechanical sweep** — resolve
every `path:line` citation against `git ls-files`, check the line exists — and its commit message reported "30 citations
resolve and hold, 4 bare ones hand-checked, one stale".

Both passes of the next round measured it: **38 unique citations**, and **five** resolve to content that is not what the
sentence claims (`media_compile_service.py`'s version record sits on the neighbouring lines; `versioned_publishing.py`'s
comment now says the opposite, because the write side was wired in a later batch). The sweep checked that a line
**exists**, not that it is the **right** line, and then summarized itself in a sentence that was false.

The next round then did the same thing one level up: review 44 measured that commit's own "mechanically checkable"
invariant and found it false as written (19 other documents match the grep; only the three changed ones are clean).

**Conclusion, and the reason this is a platform item rather than an author-discipline item:** *an author's account of its
own work has no verifier, and any process that requires one will keep producing falsifiable text.* This is §19 ("a probe
is not a test case") one level up — a **summary is not a measurement** — and it survives the author trying to be careful.
Careful prose is still prose.

---

## 3. Three multipliers, with reproduction

### M1 — the DoD mandates hand-written records and gives them no verifier

The batch-level DoD requires the delivery note, the ledger row and the report line to be updated **in the same batch** as
the code. Code carries tests, mutation evidence and `claims[]`; the record carries nothing. An adversarial pass whose
instruction is "falsify" will always find the unverified surface cheapest. This is the fuel for 37 of the 50 findings.

The part that makes it a loop rather than a tail: **every repair's new prose became the next round's target.** Rounds
r36–r44 all sit in one section family of one document — each time I fixed a sentence, the sentence I wrote about the fix
was the next round's cheapest target.

### M2 — scope changes are recorded but never applied

```bash
kata-cli scope change --change <task> --add <path>        # writes scope-changes.json
python3 - <<'PY'   # every revision snapshot carries the same digest
import json, glob, hashlib
for f in sorted(glob.glob(".kata/tasks/<task>/revisions/*.json")):
    d = json.load(open(f)); op = d.get("ownedPaths") or []
    print(f.split("/")[-1], hashlib.sha256(json.dumps(op).encode()).hexdigest()[:10], len(op))
PY
```

Six scope records in the loop's change — including two that *added* a design contract — and **every** revision snapshot
carries the same `ownedPaths` digest (`4522af1eaa…`, 9 entries): still containing a path whose removal was recorded,
still excluding the design contract. Two consequences, both costing rounds:

- the delta **understates** a repair whose delivery note is out of surface (`scope-additions-never-applied`, plus two
  `owned-path-*` majors);
- and the DoD's "update the design contract in the same batch" *pushes* edits into a file the gate cannot see. The
  relocation that followed left a stale cross-reference behind, which was round 42's `major`.

§21/§26 records the **recording** half as delivered. The **applying** half is what is missing.

### M3 — the brief carries attempts, not class history

The brief lists the previous round's attempts. It does not say "this class has been found six times; here is how each was
dispositioned; here is the invariant that now covers it". Each round therefore re-derives a class the record already
holds — r36–r43, one class, independent derivations at ~1–1.8M tokens each. The cheapest lever in this loop is not a
smaller context; it is not re-deriving a classification the platform already knows.

---

## 4. Work list

Order by leverage. Every item must be **shown to fail** before it is called delivered (§6).

### A — the change record is generated, not written

**What exists:** the seal already holds the git diff, the evidence set, the check results, the claims and the findings.

**What is missing:** any artefact assembled from them. The author writes paths, counts and dispositions by hand.

**Change:** emit a machine-written record from those inputs (paths, checks, claims, findings, surface digests) and let
the author write only **judgements and trade-offs** — which cannot be derived, and are therefore the only prose worth
reviewing. A worked example of the *shape* exists in a project repo (the k2skills interim claims checker wrote a
generated block and compared it byte-wise) — and so does its limit: it protected the block and left the prose outside it,
and the next two rounds were findings in that prose.

**Acceptance:** (a) a record whose prose states a derivable fact is refused, and the message names the field; (b) planting
such a fact and re-running the seal shows the refusal, with the planted fact quoted back.

**Invariant:** **the record may never be the only place a fact is true** — anything that matters must exist in code,
evidence or a check.

### B — `claims[]` reach the record's own rows

**What exists:** C3 (`7eee82e`, `76649a0`) runs acceptance statements as checks, reports failures by claim id, and
refuses a claim that cannot fail.

**What is missing:** the same treatment for the ledger/report rows — the surface the last seven rounds falsified.

**Change:** a row may carry `{id, statement, check}`; the seal runs it and names the row on failure.

**Acceptance:** a planted false ledger row fails the seal and names the row; a true one passes.

**Invariant:** a claim's check must be able to fail (`expect.exitCode` required — see §5), and a row without a check is
marked *unverified* rather than silently counted as covered.

**Dependency:** none beyond C3.

### C — apply the recorded scope changes

**What exists:** `scope-changes.json`, written by `scope change` (the recording half).

**What is missing:** anything that reads it. The seal stamps `ownedPaths` as declared.

**Change:** the effective surface becomes `ownedPaths ∪ recorded scope changes`, computed at seal and stamped into the
revision, with the reason for each exclusion recorded.

**Acceptance:** after `scope change --add <design doc>`, the next revision's digest changes and the delta covers that
file; an **unrecorded** out-of-surface edit is still refused.

**Invariant:** never silently widen. If the union cannot be computed, fail closed and name the record that could not be
applied.

**Dependency:** none; it is the smallest of the four.

### D — the brief carries the class history

**What exists:** the brief carries the previous round's attempts, the starting reading set, and the instruction to read
sealed evidence rather than re-run it.

**What is missing:** the classification. For each class present in the record: how many times, the last disposition, and
the invariant that now covers it.

**Acceptance:** a brief for a revision whose prior rounds found the same class names that class and its disposition; a
brief for a first round does not invent one.

**Invariant:** this is **context, not a verdict**. It must not tell the pass what to conclude (I1), and it must not
shorten the falsification instructions.

**Dependency:** after A or B, since both produce the classification it summarises.

---

## 5. Traps measured the hard way

- `check = {command: <executable>, args: [...], expect: {exitCode: n}}` — `command` must be an **executable**. A whole
  command line placed there is treated as a missing program: 10 of 10 claims red with exit 127.
- `expect.exitCode` is **required**. Without it `resolveClaimChecks` throws
  `Cannot read properties of undefined (reading 'exitCode')` and the diagnostics are mislabelled `matrixError` — which
  makes the platform's own `validateClaims` (rejecting a claim with no expected result) **unreachable** on that input.
- `adversarial record`'s schema is `additionalProperties: false` and the error does not list the allowed keys; a
  top-level `taskId` is required on findings and rejected at the top level. Project the payload, or keep the raw file.
- The generated `.kata/schemas/task.schema.json` copy inside a project lags the engine's schema (no `claims`,
  `coveredBy`, `boundaries`, `instruments`, `engine`): a project reading the copy concludes that a legal declaration is
  illegal. Refresh the generator, or stamp the copy with the engine version it came from.
- A pass that dies without writing its result file leaves the revision with **no** record for that node, and
  `adversarial status` does not distinguish "never ran" from "ran and crashed".
- Two nodes can reach the same finding independently (twice in the last three rounds). Good for confidence, wasteful for
  cost; per-node surface digests (§22) are the mechanism, and using them is a project-side choice.

---

## 6. Self-evidence required

A gate that cannot be shown to fail is a guard that reads as protection without being one (§15). Before any of A–D is
called delivered:

- plant a false derivable fact → the seal refuses it and names the field (A) or the row (B);
- add a scope record → the next revision's digest changes and the delta covers the file (C);
- produce a brief whose class history is wrong → a pass refuses it (D).

---

## 7. What must not change

§15's four invariants stand: an independent adversarial node (I1); evidence bound to the revision it was produced on
(I2); repairs authorised by severity and nothing else (I3); `fail-closed` over a silent pass (I4). Nothing in §4 touches
them — A removes prose, B adds a check, C corrects which surface is bound, D adds context. In particular, **do not**
shorten the falsification instructions to save tokens: the measured waste is in re-deriving a class, not in falsifying
it.

---

## 8. Author-side rules the platform cannot enforce

Each was forced by a finding, and each became durable only when written as a mechanically checkable invariant — an
intention would not have survived the next round.

| Rule | Forced by | Invariant as it now reads |
|---|---|---|
| Point at the artefact; do not enumerate it | "only two rules are not derivable from the diff" was false | the note says how to derive the diff (`git show <a>^:<path>` vs `git show <a>:<path>`); nothing counts the hunks |
| Cite symbols, not line numbers | five citations resolved to wrong content | zero line-number citations **in the documents the change touches** — per document, because 19 other documents under `docs/` still cite line numbers, and stating it repo-wide was itself a false claim |
| No absolute quantifier without its range, and mark the branch you did not measure | "prose is not machine-checked" (two guards check it); "不会被任何门禁检查覆盖" (a guard covers it) | the coverage section names the guards and their ranges, and labels the unmeasured branch *not measured* |
| A delivery makes present-tense text false; mark it | the audit report was still named as outside the surface after being merged in; three `现状` lines survived their own delivery | pre-delivery statements read "（交付前；现已不成立，本条按历史读）" |

---

## 9. Where the measurements live

| What | Where |
|---|---|
| The full ledger and the round-by-round framing of this loop | §27 of `2026-09-18-what-an-adversarial-pass-costs.md` |
| Token economics, the brief contract, the cost of one focused invocation | §18 of the same document |
| C1–C7, the §21 platform gaps, and their delivered status | §§14, 21, 26 of the same document |
| Instruments, declared boundaries, scope-change records, layer × severity | §§24, 25 of the same document |
| The project-side record of these findings (the plan document and the claim carriers) | that project's repository, not this one |
