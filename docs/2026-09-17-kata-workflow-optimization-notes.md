# Kata workflow: measured cost in one task, and what to change

Measurements from a single day on one task (`skill-identity-idempotency-versioning`, 2026-09-17), recorded because the
cost is structural rather than operational: three bindings are too coarse, and every mechanical round-trip in the table
below traces back to one of them.

| Item | Count | Cost |
|---|---|---|
| Handoff packets / acknowledged receipts | 40 packets / 18 receipts (908 KB) | the implementer role was rebuilt 13 times; a receipt dies on **every** commit |
| Seal rounds | 4 (1 passed, 2 self-inflicted through a shared database, 1 refused by phase) | ~15 min each ⇒ ~1 h |
| Revisions | 5 | each one supersedes the previous round's adversarial review record |
| Independent adversarial reviews | 2 (8 findings from one peer, 4 from mine; 19 min per subagent run) | one round had to be re-run because the seal produced a new revision |
| Wiki closure blockers | 2 (missing `--candidate` with no remedy printed; a legacy field blocking every workflow mutation) | ~20 min |
| Polling misjudgement (mine) | `pgrep -f 'kata-cli build'` matched my own shell | ~20 min idle, which kata cannot disprove: there is no heartbeat file |

## P0 — three small changes that stop the bleeding

### 1. Receipts and adversarial records must bind to content, not to HEAD

`verifyContextPacket` requires `packet.repository.head === current.head`, so **any** commit invalidates a receipt —
including commits that touch nothing in the task's owned paths and therefore cannot change what is being reviewed. That
mechanism produced 40 packets and 13 implementer rebuilds.

What to change:

- accept a receipt when the **owned-path manifest / diffHash is unchanged**, or when HEAD moved but only through paths
  outside the owned set;
- the same rule for the adversarial record: today a re-seal turns a recorded pass into `stale_revision` and the whole
  review (19 min) has to be re-run even though the artefact under review is byte-identical.

The content binding is right — it is what caught F-10 (stale evidence) honestly — the problem is that *re*-binding is
priced like a first binding.

### 2. A superseded revision must be re-sealable from `hardVerify`

```
Build cannot run from hardVerify without a repairable verify FAIL result
```

Re-sealing after a commit requires running `verify` first, purely so the phase flips back to `implement`. This is the
same family as the two deadlocks already fixed (`cfe616a` review→build, `be7b196` judge→build): an authorized transition
that nothing recognises. `build --seal` should accept `reason: revision_superseded` straight from `hardVerify`.

### 3. Every gate refusal must print its remedy

Three instances today, each of which sent an agent into `dist/cli.js` to work out the fix:

| Error | What it does not say |
|---|---|
| `evaluation: candidate_required` | the exact command, with the registered id: `kata-cli wiki closure --task <id> --decision captured --candidate <id> …` |
| `Wiki record … is invalid: $.revalidatedBy is not allowed` | the allowed field set, and that `wiki repair` exists — this one blocked **every** workflow mutation, because closure validates the whole wiki |
| `revision_superseded` | the single command that should be run next |

## P1 — cost structure

4. **A fast seal.** A round today is lint + typecheck + the full suite (10 min) + 12 evidence commands, all serial. Let
   `build --seal` run the fast set (lint/typecheck/AC evidence) and require the full suite at `judge`/`archive`, where the
   artefact is actually frozen — or let the seal reuse an already-passing full-suite result for the same owned-path
   manifest (the content binding of #1 again).
5. **De-duplicate evidence against the full suite.** Several of the 12 AC evidence commands re-run files the suite
   already covers — two passes over the same tests, about a third of the 5 minutes. Either record a pointer ("covered by
   suite @ revision X") or run them concurrently once checks have their own isolation.
6. **Give the seal a heartbeat.** Append each check's state and elapsed time to
   `.kata/tasks/<id>/seal-progress.jsonl`. What a monitoring agent needs is not "can I `pgrep` the process" but a
   readable status; `pgrep` produced two false positives today.
7. **Wiki staleness is a terminal state.** `register` skips ids that exist, `promote` requires `candidate`, `rebuild`
   clears the whole library — so a page whose record was minted before an edit can never be re-minted, and closure can be
   wrong indefinitely. It needs `wiki refresh --record <id>`.
8. **`kata open` mints ids the schema rejects.** It produces `AC-n` while `task.schema.json` wants `^REQ-[0-9]+$`, so a
   task that is otherwise entirely conformant cannot seal until the ids are renamed by hand (done by hand today).

## P2 — structural

9. **Serial checks are a symptom.** `331618c` made seal checks serial because they share one Postgres schema. The real
   fix is per-worker/per-check isolation (a database or schema each), which is also the precondition for the project's own
   suite to run in parallel and come down from ten minutes to about one.
10. **The trust boundary stops are right** — choosing a platform or a model stays a human decision — but every phase
    transition asks again. Persist the choice per task; today it was reused manually from an earlier
    `continue_current`.

## What should stay

- **Evidence and diffHash bound to a revision** honestly caught F-10 (stale evidence). The mechanism is right; only the
  price of re-binding is wrong (#1).
- **The independent adversarial review gate is the day's highest-value addition**: two rounds found 12 real defects
  (including one blocking: the replay gate could not be reached in production at all). It paid for itself.
- The two deadlock fixes (`cfe616a`, `be7b196`) and `66fd88a` (report every preflight blocker at once) all point the
  right way.

## Order of work

P0 (1, 2, 3) plus the heartbeat (#6): all small, unit-testable, and they remove most of the daily mechanical
round-trips — #1 and #2 alone account for the 40 packets and the re-run review.
