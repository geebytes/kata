# Two declarations of one surface, and a freshness check that reads the older one

## The defect, at its most precise

`repair-by-another-author` corrected its own `ownedPaths` from 11 to 22 paths this round — first directly, then, once I found the
governed route, through `kata-cli scope change` + `kata-cli scope apply`, which recorded the decision as `scope-1`. Its sealed
revision still carries **11**. So there are now **two declarations of one surface**:

| declaration | value | what it is |
|---|---|---|
| `revision.ownedPaths` | 11 | frozen when the revision was minted |
| `task.ownedPaths` | 22 | corrected since, with a recorded reason |

and the check that decides freshness reads the **older** one:

    export async function revisionStatus(root, revision) {
      const manifestHash = await computeManifestHash(root, revision.ownedPaths);
      return manifestHash === revision.manifestHash ? { status: 'current' } : { status: 'superseded', … };
    }

`repair-entry.ts` reads that `current` and refuses a seal with *"the sealed revision still matches the workspace"*. The message is
false: **eleven of the twenty-two declared paths are not in the hash that was checked**, and the files I changed this round
(`src/cli/matrix.ts`, two test files, one schema test) are all in the eleven that were not.

## And `scope apply` says exactly the right thing while its own door is shut

The command prints:

    next: 'Re-seal so the next revision hashes the grown surface; the change resets what the next round narrows against.'

That is correct and complete: the seal is the moment a revision takes on the grown declaration. **And the seal is refused by the
check described above.** So the mechanism knows the next step and the gate for that step reads a value the mechanism just
superseded — which is why this is the seventh instance rather than a sixth:

| instance | the check reads | the message claims |
|---|---|---|
| `cg4-f2` | the revision's owned-path map | the working tree |
| `rba5-f1` | no binding at all | the falsification rule |
| `rba5-f2` | the planned digests, no revision | the resolver's question |
| `rba5-f3` | the revision, not the content | the closure rule |
| `rba5-f5` | an inherited timestamp | the latest round |
| the seal refusal | the revision's `ownedPaths` | the workspace |
| **this one** | **`revision.ownedPaths` — a declaration** | **`task.ownedPaths` — a newer declaration, and the workspace** |

**The pattern is not "a stale check".** Each message claims to have read reality, and each check read a *declaration* — and here
there are two declarations of the same thing, so it is not even a declaration-versus-reality gap but a **declaration-versus-its-own
successor**.

## What I got wrong, and what the fourth route changed

I said three routes existed and all were wrong, and concluded the defect was unrepairable in place. **The conclusion was half wrong:**
there is a fourth route, `kata-cli scope change` → `scope apply`, and it is the governed way to grow a surface. Round 6's 874K-token
pass found it in its last sentence and ran out of budget before writing its record — so the finding survived only because I read the
output anyway. **A round that finds the answer and loses the record has still found the answer, and the record's absence does not
make its last sentence worthless.**

The three routes I had enumerated were genuinely wrong (sealing is what mints a revision; manufacturing a repairable FAIL makes the
gate pass by making something else false; patching `revisionStatus` to compare content is a seventh instance-level repair whose own
comment argues the opposite position deliberately). **A fourth existing and my list being incomplete are different things**, and I
conflated them.

## And a real finding fell out of walking the route

`kata-cli matrix set --owned-paths` — the correction added an hour earlier — **does not record a scope decision**. `matrix.ts` does
not import `scope-change.js`, so the surface grew through the other entrance and `scope show` reported `changes: 0`,
`unreportedGrowth: []` until I walked the governed route. Two entrances to one decision, and only one of them leaves the point that
`scope.ts`'s own docstring says the commands exist to provide ("no point at which the cost was visible"). **That is the same class
again, inside the command written for it.**

## So what should A be

Not "make `revisionStatus` also compare `contentDigests`", which is the instance-level repair whose own comment argues against it.
The question this defect actually raises is a **data-model** one: **a revision's declaration can be superseded by the task's, and
nothing detects that** — no field records "this revision's declaration has since been corrected", and no check compares the two. So the
candidate is a revision whose freshness check distinguishes three states rather than two: the declaration changed (the revision does
not describe the change's declared surface), the content changed (it does not describe the workspace either), and neither. The
refusal message can then say which, which is what it currently pretends to.
