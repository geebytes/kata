# An amended contract voids the certification it was sealed under

**Status**: implemented directly (outside the Kata governed lifecycle, on the user's instruction), 2026-10-13.
**Origin**: measured on `the-workflow-layer-checks-what-it-claims`, whose AC-3 read *"the argument the sandbox executes is the
argument the check declared, through the same predicate `cwd` already uses"* — a sentence true of neither of the two rules
`src/workflow/execution-sandbox.ts` actually has. `ledger claim restate` corrected the reviewer-facing **claim**; the
**criterion** stayed false, and no command could correct it.

## 1. The two halves that were missing

1. **No writer.** A task's acceptance criteria are frozen at creation. `kata-cli tasks declare` writes `upstreamCoverage` and
   `acceptanceMatrix` and refuses to rewrite criteria (`src/cli/tasks.ts`), and the only remaining route was hand-editing
   `task.json` — outside the task lock, with no record of who decided it or why. Three design documents in this repository
   already record that this was the only route available.
2. **No cost.** A criterion lives in `task.json`, which is deliberately outside revision content identity. So a corrected
   sentence left `revisionStatus` reporting `current`, and the seal, the verify pass and the judge verdict all kept standing
   over a contract the change no longer makes.

## 2. What was built

### `kata-cli tasks amend-acceptance --change <id> --id <AC-id> --file <amendment.json> --reason "<why>" [--by <actor>]`

`src/quality/acceptance-amendment.ts` is the single writer. The file carries both texts — `expectedStatement` (what the
caller believes is on disk) and `statement` (the correction) — because the operation is a **compare-and-swap**, not an edit.

- **The audit is append-only and comes first.** `acceptance-amendments.jsonl` (beside the task, next to
  `declaration-changes.jsonl`) records both texts, both contract hashes, the reason, the actor, the timestamp and the
  revision the amendment voids. The record is written before the task, both inside the task lock, so a task that carries an
  amendment always has the decision that produced it.
- **Only the statement.** The criterion id, its order, the matrix, `ownedPaths` and every other declaration are out of reach.

### The contract is part of the revision identity

- `acceptanceContractHashOf(acceptance, matrix)` (`src/core/task.ts`) is the one derivation; `review-ir.ts`'s candidate
  freeze now asks it instead of restating the serialization, so "did the contract move" has one answer.
- `TaskRevision.acceptanceContractHash` records the contract a revision froze, and `revisionIdFor` takes it as a term, so a
  re-seal after an amendment mints a **new** revision rather than reusing the record that froze the old contract.
- `RevisionStatus` gained a third non-current state, `contract-moved`, carrying the two hashes. Every consumer already asks
  `revisionIsCurrent`, so the invalidation is one rule in one place.

### What the invalidation reaches

- `verify` fails readiness for a contract-moved revision (`supersededReadiness`), and the verdict now carries the comparison
  (`supersededComparison.kind === 'contract-moved'`) rather than only the word `revision_superseded` — the same reason the
  content and declaration comparisons are carried.
- `ledger run` / the ReviewRequest refuses, naming the state it measured and the two hashes.
- The repair-scope guide (rendered into the generated skills) now names the amendment as a way a revision stops describing
  the task.
- `ReviewPackage.declaration.acceptanceAmendments` hands the round the correction itself — old text, new text, reason, actor,
  voided revision — and `.pi/agents/kata-reviewer.md` (rendered from `src/adapters/manifest.ts`) tells the reviewer to judge
  the correction rather than only the corrected sentence. An unreadable log is a **named hole**, never an empty history.

## 3. Refusals, and the remedy each prints

| Refused when | Why it is refused | Remedy printed |
|---|---|---|
| no `--reason` | an unexplained contract change is indistinguishable from drift | supply one |
| empty statement | a criterion with no sentence is not a contract | supply one |
| the criterion is unknown | — | the criteria the task actually has |
| `expectedStatement` ≠ what is on disk | two authors must not amend one criterion to different things | the text on disk, to re-run deliberately |
| the contract would be byte-identical | there is nothing to record | — |
| the criterion declares claim clauses | `ClaimDeclaration` binds a sentence to the check that must make it true; rewriting the sentence alone leaves the check asserting wording the contract no longer carries | the clause ids, so the boundary is visible |
| **the current revision records no `acceptanceContractHash`** | such a revision cannot report `contract-moved`, so the amendment would look applied while the certification survived it | `kata-cli build --seal --change <id>`, then amend |
| nothing is sealed | there is no certification for the amendment to void | `kata-cli build --seal --change <id>` |
| the revision is unreadable | it cannot be shown that the amendment voids anything | inspect `current-revision.json` |
| the amendment log is unreadable | an amendment written now could not be told from one never recorded | inspect the log |

Every refusal writes nothing at all — no log line, no task write.

## 4. Boundaries, stated rather than implied

1. **The judge has no direct contract check.** It is reachable only from phase `review` with an approved review, and approval
   requires the ReviewRequest, which refuses a contract-moved revision. The hole is closed by the route, not by a check in
   `cmdJudge`. A future route to `judge` that skips the request would reopen it.
2. **A revision sealed before this field existed cannot be amended under.** Refused by name, with the re-seal remedy — the
   alternative (tolerating it) is an amendment that voids nothing.
3. **A criterion with claim clauses cannot be corrected through this command.** The clauses are checks bound to the sentence;
   correcting one without the other is the drift `ClaimDeclaration` exists to prevent. Queued (see the defect queue) as the
   remaining half.
4. **The wiring lint is a text scan.** `tests/unit/an-amended-contract-voids-the-certification.test.ts` asserts the seal's
   call site passes `acceptanceContractHash`; it can see a call site that stopped passing it, not a call site built another
   way. The load-bearing guard is the amendment writer's refusal.
5. **The first seal after this change renumbers.** The contract term is part of the id, so a task sealed before it gets a new
   id at its next seal — the same transition, and the same reasoning, as the content-snapshot term before it. Stored revision
   files are untouched and stay readable; what stops is their use as the current identity.
6. **The carriage is in the package, not on the request.** `reviewPackage.declaration` already carries the declaration the
   round judges, and the amendment is the history of that declaration; a second copy on the request would be one fact in two
   places.

## 5. Cost

≈3 h implementation and tests, 9 source files, 2 schemas, 1 render source, 15 new test cases. Full suite 361 files / 2170
tests, `tsc` clean, generated assets regenerated (`kata-cli update`, conflicts 0).
