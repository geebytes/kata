# Route the Wiki record store through its owner

**Change:** `route-the-wiki-store-through-its-owner`
**Status:** implemented (the derivation and its three selectors landed; see Verification plan)
**Profile:** `current_worktree / tdd / strict`

## Problem

`wikiDir(root)` is `join(root, '.kata', 'wiki')` (`src/core/layout.ts:430,1107`). It is the **last record surface still
derived per-caller**: `recordsRoot` (`src/core/layout.ts:610`) and `evidenceDir` (`src/core/layout.ts:766`) both resolve
the checkout that owns the task's records through `recordOwner`, and the Wiki store does not.

Measured on `harden-ledger-discovery-contract-v2`, the first task sealed under `isolated_worktree`:

| command | root it resolved | store it used |
| --- | --- | --- |
| `kata-cli wiki register` (not a workflow command) | workspace root = the primary checkout | wrote `<primary>/.kata/wiki/…` |
| `kata-cli verify --change …` (task-addressed) | code root = the linked worktree | read `<worktree>/.kata/wiki/` — which does not exist |

So the closure gate answered `candidate_missing` for a candidate that exists, and its own remedy — "register the page
first" — reproduces the state. The two answers, taken from the same task on the same machine:

```
kata-cli wiki candidate   (inside the worktree) -> 0 candidates
kata-cli wiki candidate   (primary checkout)    -> 26 candidates
```

The consequence is not a missing warning: under `isolated_worktree` the **Wiki closure is unsatisfiable**, so `verify`
can never reach `governanceReady` and review/archive stay closed.

The obvious workaround is the fault the project already documents (`concepts/isolation-covers-code-not-records.md`): copy
the store into the worktree so the worktree's commands can read it. That is a second answer to the same question, and it
lives under a directory `archive` deletes — the copy would disappear with its caller, taking the only records with it.

## The fix

`wikiDir` mirrors `evidenceDir`'s derivation, and `recordOwner` gains the one branch it was missing:

```ts
export function wikiDir(root: string): string {
    const start = resolve(root);
    const owner = recordOwner({ root: start, taskId: worktreeTaskId(start) }).ownerRoot;
    return join(kataDir(owner ?? start), 'wiki');
}

// in recordOwner
const ownerRoot = taskId !== undefined
    ? findOwningCheckout(searchFrom, taskId)
    : worktreeRoot === undefined
        ? undefined
        : owningCheckoutOf(worktreeRoot);
```

### Why `wikiDir` alone was not enough — measured

The first version of this change only rewrote `wikiDir`, and the selectors passed. The real workflow still answered `0`:
`kata-cli wiki candidate` run from inside the linked worktree reported **0** candidates (the primary reported 26), because
`recordOwner` needs a task id to walk, and `worktreeTaskId` reads it from `<worktree>/.kata/tasks/` — a directory a
worktree a task is *working in* does not have. It returns `undefined`, `recordOwner` returns `ownerRoot: undefined`, and
`wikiDir`'s `?? start` fallback then answers **"here"**, i.e. the store inside the worktree. The fallback that is correct
for a single-checkout repository is exactly wrong for a worktree.

Three facts pinned the root cause:

- `owningCheckoutOf` — the path-shape derivation of "the checkout that holds `.kata/worktrees/<dir>`", documented as
  *"Nothing is read from disk, because ownership must not depend on a file being present"* — **had no caller at all**. It
  was written for this answer and never wired.
- `worktreeTaskId`'s own catch block says *"A worktree that holds no record directory yet still needs an answer, and any
  task id serves: the owner walk only has to reach the checkout that owns `.kata/worktrees/`"* — and then returns
  `undefined`, which is the one answer that does not reach it.
- every fixture in the three affected suites **created `.kata/tasks/<id>/` inside the worktree**, which is how the record
  walk learned a task id — so the tests exercised a shape no real worktree has. This is the same defect shape as the
  comment-versus-code cases this project keeps meeting: the assertion was about a state the fixture invented.

After wiring it, the real workflow answers **26** candidates from inside the worktree, and the same branch fixes
`evidenceDir`, which had been writing a second evidence copy under the worktree for the same reason.

### The consequence for the evidence surface

`evidenceDir` shares the derivation, so it shares the repair: a seal run from inside a real worktree now writes evidence to
the owning checkout instead of `<worktree>/.kata/evidence`. That is the same class and the same fix, and it is asserted in
AC-1's selector (the file whose subject is "record ownership answers every surface") and in AC-3's.

- **No consumer changes.** `wikiRecordPath` derives from `wikiDir`, and every reader/writer of the store goes through one
  of the two (`src/wiki/store.ts`, `src/wiki/llmwiki.ts`, `src/wiki/drift.ts`, `src/wiki/context.ts`, `src/wiki/closure.ts`,
  `src/workflow/handoff.ts`, `src/cli/wiki.ts`). Fixing the definition fixes the sites — the alternative (each consumer
  resolving the owner itself) is the shape that produced this defect.
- **`?? start` is the answer for "no owner", and it is not the defect this class usually has.** `ownerRoot` is `undefined`
  when no checkout holds the task, and for a task whose records live in the caller's own checkout that is the correct
  answer: the store is *here*. What must not happen is a worktree reading "here" — and a worktree whose task has an owner
  never takes the fallback.
- `worktreeTaskId(start)` supplies the task id when the caller stands in a worktree, because `recordOwner` needs one to
  look up; this is the same call `evidenceDir` makes, for the same reason (`src/core/layout.ts:772-775`).

## Non-goals

- **No migration and no record moves.** For a repository whose task lives in the caller's checkout the derived directory is
  byte-identical to today's; AC-3 pins that.
- **Not the two other defects measured the same day.** The receipt anchor (`handoff create` anchors on the workspace root
  while the seal anchors on the code root, so no receipt is ever current without `--root <worktree>`) and the seal run from
  the primary checkout (evidence measured against the primary's content) are in `src/workflow/context-fabric.ts` /
  `src/cli/workflow.ts` / `src/cli.ts`, a different surface. They are recorded in
  `.llmwiki/concepts/code-root-versus-record-root.md` and remain follow-ups.
- **No change to what the closure gate requires.** This change makes an existing requirement satisfiable; it does not
  weaken it.

## Acceptance matrix

| AC | Contract | Evidence selector |
| --- | --- | --- |
| AC-1 | The Wiki store is derived from the record owner: the primary checkout and a linked worktree answer the same directory, and no second copy appears under the worktree. | `tests/unit/record-ownership-answers-every-surface.test.ts` |
| AC-2 | A closure naming a registered candidate evaluates valid when asked from inside the linked worktree, and a genuinely absent candidate still fails closed. | `tests/unit/wiki-closure-follows-its-owner.test.ts` |
| AC-3 | For a single-checkout repository the store's location is unchanged, and every consumer resolves the same file as before. | `tests/unit/owner-rule-covers-evidence-and-trace.test.ts` |

## Verification plan

- **AC-1** extends the existing "the evidence store, `recordsRoot` and the ownership answer agree on one path" case to the
  Wiki store, and adds the **bare worktree** case: a worktree with no record directory inside it, which is the shape a real
  one has and the shape every existing fixture invented its way around. The case asserts the *answers*, not the call sites,
  so a rewrite that routes the question elsewhere but keeps the answers passes.
- **AC-2** builds a repository, a task and a linked worktree **with no record directory inside it**, writes one candidate
  record through the worktree root and reads it back through the primary — then asks
  `evaluateWikiClosure(worktree, taskId)`: `valid` for the registered id, `candidate_missing` for an id that was never
  registered. The second half is what keeps the fix from being "accept any id".
- **AC-3** asserts `wikiDir(root)` and `wikiRecordPath(root, id)` for a repository with no worktree at all: the location is
  `<root>/.kata/wiki`, i.e. today's path, and the record resolves inside it.
- **Reversible mutations**, applied after the commit so a restore cannot discard uncommitted work:
  1. restore `join(kataDir(root), 'wiki')` → AC-1 and AC-2 selectors must redden;
  2. drop the `?? start` fallback → AC-3 must redden;
  3. restore `ownerRoot = taskId === undefined ? undefined : findOwningCheckout(searchFrom, taskId)` → AC-1's bare-worktree
     case and AC-2 must redden (this is the mutation that would have caught the first, insufficient version).
