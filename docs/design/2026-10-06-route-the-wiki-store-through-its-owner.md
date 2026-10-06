# Route the Wiki record store through its owner

**Change:** `route-the-wiki-store-through-its-owner`
**Status:** implemented and repaired twice (two independent strict rounds falsified C1; the second round found three regressions the first repair introduced — see both Repair sections)
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

## Repair: the two shapes the first fix did not cover

An independent strict round (`kata-reviewer`, 397 s, 45 tool calls) falsified C1 twice, and both reproductions were
re-run by hand before being accepted. Both are the same class: **the owner of a worktree caller was derived from a task id,
and from a path shape only one kind of worktree has.**

| finding | shape | what happened | falsifier |
| --- | --- | --- | --- |
| F1 (major) | a `--path` / hand-made `git worktree add` checkout, outside `.kata/worktrees/` | `worktreeContaining` was a pure path test while its docstring promised two shapes, so the worktree was not recognised, `ownerRoot` came back `undefined`, and both stores fell back inside it | challenge X1: `wiki candidate --root <primary>` vs `--root <primary>-linked` — differed, exit 1 |
| F2 (major) | a `.kata/worktrees/<id>` worktree holding a record directory for a task no checkout owns | `wikiDir`/`evidenceDir` asked a **task-addressed** question (`taskId: worktreeTaskId(start)`) to answer a **task-less** one, so the walk found no owner and the stores fell back inside the worktree while `recordsRoot` for the task being worked on still answered the owner | challenge X2: same comparison with the stranded directory present — differed, exit 1 |
| F3 (note) | either of the above, through the closure gate | the candidate set comes from `wikiDir` while the closure comes from `recordsRoot`, so the gate answered `candidate_missing` for a registered candidate | selector case, added |

**The fix, by class rather than by instance:**

1. `worktreeContaining` recognises the second shape its docstring has always documented, gated on a cheap fact first: a
   linked worktree's `.git` is a *file* while the main checkout's is a directory, so an ordinary command in an ordinary
   repository spawns nothing and only a possible linked checkout pays for a listing.
2. `recordOwner` answers a worktree caller from the worktree's own identity — `owningCheckoutOf` for the shape this
   repository creates (no disk), git's `main` entry for a `--path` checkout — and never from a task id. The task-addressed
   walk applies only to a caller that is *not* in a worktree.
3. `wikiDir` and `evidenceDir` stop supplying a task id, because their question does not carry one.

**Measured after the repair:** the round's own two challenge commands exit **0** (they exited 1 against the frozen
revision); `worktreeTaskId` — whose catch block claimed "any task id serves" — is gone, having no caller left; and the
false sentence in `worktreeContaining`'s docstring is now true rather than deleted.

> **A claim from an earlier change, checked.** Commit `45a6535` ("the detector sees worktrees outside `.kata/worktrees`
> too") states that a `--path` checkout "reported `[]` **while `recordOwner` recognised it**". `recordOwner` did not
> recognise it then, and does not until this repair — the commit's own message asserted the very disagreement it was
> fixing, one function over. The detector was fixed; the ownership function it was compared against was not.

## Second repair: the rule, and the three ways the first repair broke it

A second independent strict round (887 s, 62 tool calls) falsified C1 again — three findings, all reproduced by hand before
being accepted, and **all three regressions introduced by the first repair**, because that repair replaced a task-addressed
answer with a path answer and dropped two things the file itself states:

| finding | severity | shape | reproduced |
| --- | --- | --- | --- |
| F1 | **blocking** | a worktree created **inside** a worktree — which `kata-cli worktree create` produces, because `runWorktreeCommand` resolves `resolveWorkspaceRoot()` (the worktree the command stands in) and `createWorktree` targets `join(worktreesDir(root), taskId)`. `owningCheckoutOf` answered the *outer linked worktree*, and was tried before git, so every record path and both stores resolved there | challenge X3: `wiki candidate` listed the candidate from the primary and answered `[]` from the nested checkout, while `git worktree list` inside it named the primary as `main` |
| F2 | major | a task whose records exist only under a worktree (the stranded shape three mechanisms exist for). `worktreeOwnerOf` answered a defined checkout that holds no such task, so `recordsRoot`'s documented fallback — "an unreachable record is worse than a remote one" — became dead code for worktree callers | challenge X4: `status --change <id>` from the worktree holding the task's only records read the primary's path and failed with ENOENT |
| F3 | minor | a checkout whose `.git` marker names a worktree whose admin directory is gone: the gate passed, git returned `[]`, and the stores read the resulting `undefined` as "here", keeping a per-root copy — the fail-open direction this change removes | challenge X5: the primary listed the candidate and the worktree answered `[]` |

**The rule, stated once** (and now asserted rather than described):

1. **A named owner holds the task.** `ownerRoot !== undefined` implies `readdirSync(join(ownerRoot, '.kata', 'tasks', taskId))` succeeds — a wrong owner is worse than `undefined`, because `recordsRoot` has a documented answer for `undefined` and none for a wrong checkout.
2. **An owner is not a linked worktree.** The path answer walks up past any candidate that is itself a worktree, so a nested worktree resolves to the checkout that owns them both.
3. **A worktree whose owner cannot be named is refused, not read as "here".** The stores throw a named error; the alternative is a second store under a directory `archive` deletes.

The four changes that implement it: `owningCheckoutOf` walks past linked checkouts (`checkoutAboveWorktrees` keeps the path test, the loop adds rule 2); `recordOwner` asks the task-addressed question whenever a task id is known and falls back to the worktree that holds the task (rule 1); `gitListedWorktreeContaining` falls back to the `.git` marker's own text when git cannot answer (`linkedWorktreeCheckout`, gated on `/.git/worktrees/` so a submodule's marker is not mistaken for one); and both stores refuse on `worktreeRoot !== undefined && ownerRoot === undefined` (rule 3).

**Measured after the repair:** the round's three challenge commands exit **0** — the same commands that exited 1 against the frozen revision — and the ledger's `decide` returns to `pass`.

> **One challenge had to be re-aimed, and the reason is recorded.** X5's original form compared the two answers; the repair changed the worktree's behaviour from *silently answering `[]`* to *refusing by name*, which also makes the comparison fail. The defect is the silent per-root store, so the amended command exits 0 only on the named refusal (`no owner to read`) and 1 on any answer read from inside the worktree. `ledger challenge amend` records the replaced command as an amendment rather than rewriting history.

## Third repair: Git identity outranks a nested path, task ownership remains content-bound

A third strict round found that the second repair still chose the wrong source of truth for one reachable topology: an
**outside-path** linked worktree can itself create the product's nested `.kata/worktrees/<id>` directory. The inner path
therefore has a valid local path shape, but its apparent parent is the *outside linked checkout*, not the primary. The
inner `.git` marker and `git worktree list` name the primary as `main`; `owningCheckoutOf` was selected first, so Git was
never consulted.

The two blocking findings are one root cause expressed at two surfaces:

| finding | failing answer | required answer |
| --- | --- | --- |
| F1 / AC-1 | `wikiDir(inner)` chose `<outside-outer>/.kata/wiki` | a real linked worktree asks Git first, so it chooses `<primary>/.kata/wiki` |
| F2 / AC-2 | `recordsRoot(inner, task)` could not reach the primary and wrote the captured closure under the outer copy; candidate lookup then returned `candidate_missing` | Git's primary is considered for a task **only when it actually holds that task**; then the closure and candidate read one primary store |

### Refined ownership contract

There are deliberately two questions, with different permitted fallbacks:

1. **Task-less store** (`wikiDir`, `evidenceDir`): for a real linked checkout, Git's `main` entry is authoritative; the
   `.kata/worktrees` path derivation is only a no-Git fixture/fallback. If neither source can name a non-worktree owner,
   the store refuses rather than reading inside a worktree.
2. **Task-addressed record** (`recordsRoot(root, taskId)`): first find a non-worktree ancestor holding `taskId`; if none,
   ask the current worktree's Git/path owner and accept it **only if it holds `taskId`**; only then fall back to the
   current worktree when that worktree holds the task's sole copy. Thus `ownerRoot` is never a non-holding checkout, while
   a stranded task remains reachable.
3. A checkout is known to be linked by either the product path shape or a `.git` marker explicitly pointing under
   `/.git/worktrees/`; a submodule marker (`/.git/modules/`) is not a worktree marker. This lets `owningCheckoutOf` skip
   an outside linked outer checkout even if Git itself is unavailable, preserving the fail-closed result.

### RED and verification

- AC-1's new actual-Git fixture creates `<primary>-outer` with `git worktree add --detach`, then asks that outer to create
  `<outer>/.kata/worktrees/inner`. Before the repair `recordOwner(inner).ownerRoot` is the outer checkout; it must be the
  primary, and both flat stores must agree.
- AC-2 constructs the same topology, registers the candidate in the primary and writes a captured closure from the inner
  worktree. Before the repair the closure lands below the outer and evaluates `candidate_missing`; after it, it lands and
  evaluates under the primary.
- The existing stranded-task test remains the guard against turning Git's primary into an unverified owner: a primary that
  does not hold the queried task must not win over the worktree holding the only copy.
- AC-1 additionally corrupts the inner Git marker while retaining an outside linked outer marker. The selector must refuse instead of placing either flat store under that outer checkout; temporarily removing the marker recognition makes this case RED.


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
| AC-1 | The Wiki store is derived from the record owner: the primary checkout and a linked worktree answer the same directory — for both worktree shapes (under `.kata/worktrees/` and git-listed elsewhere) and whatever task directory the worktree happens to hold — and no second copy appears under the worktree. | `tests/unit/record-ownership-answers-every-surface.test.ts` |
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
     case and AC-2 must redden (this is the mutation that would have caught the first, insufficient version);
  4. drop the git shape from `worktreeContaining` → AC-1's `--path` case must redden (this is the mutation that would have
     caught F1);
  5. stop `owningCheckoutOf` walking past a linked worktree → AC-1's nested case must redden (this is F1's falsifier);
  6. answer the task-id question from the worktree without asking who holds the task → AC-1's stranded case must redden
     (F2's falsifier);
  7. drop the stores' refusal → AC-1's unnameable case must redden (F3's falsifier).

Measured, all four applied against the committed repair and restored byte-identical:

| mutation | result |
| --- | --- |
| `wikiDir` derives per-caller again | selector RED |
| `recordOwner` ignores the worktree branch (the first, insufficient version) | selector RED — this is F2's falsifier |
| `worktreeContaining` drops the git shape | selector RED — this is F1's falsifier |
| `wikiDir` supplies `taskId: worktreeTaskId(start)` again | **GREEN — and that is the finding** |

The fourth mutation does not redden, and the honest reading is that **removing the task-id argument is a simplification,
not a separately load-bearing fix**: once `recordOwner` answers a worktree caller from the worktree's identity, the answer
no longer depends on the id, so supplying one changes nothing. The dependency was removed because a task-less question
carrying a task id is what made the defect expressible in the first place — not because the argument is now a witness. F2's
own falsifier is the second row.
