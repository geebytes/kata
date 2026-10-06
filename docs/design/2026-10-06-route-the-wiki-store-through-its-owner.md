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

One derivation, in the module that owns the question, mirroring `evidenceDir`:

```ts
export function wikiDir(root: string): string {
    const start = resolve(root);
    const owner = recordOwner({ root: start, taskId: worktreeTaskId(start) }).ownerRoot;
    return join(kataDir(owner ?? start), 'wiki');
}
```

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
  Wiki store, and asserts that no `.kata/wiki` exists under the worktree after a write through the worktree root. The case
  asserts the *answers*, not the call sites, so a rewrite that routes the question elsewhere but keeps the answers passes.
- **AC-2** builds a repository, a task and a linked worktree, writes one candidate record through the **worktree** root and
  reads it back through the primary — then asks `evaluateWikiClosure(worktree, taskId)`: `valid` for the registered id,
  `candidate_missing` for an id that was never registered. The second half is what keeps the fix from being "accept any id".
- **AC-3** asserts `wikiDir(root)` and `wikiRecordPath(root, id)` for a repository with no worktree at all: the location is
  `<root>/.kata/wiki`, i.e. today's path, and the record resolves inside it.
- **Reversible mutations**, applied after the commit so a restore cannot discard uncommitted work:
  1. restore `join(kataDir(root), 'wiki')` → AC-1 and AC-2 selectors must redden;
  2. drop the `?? start` fallback → AC-3 must redden.
