# A revision covers its declared paths, and the refusal that says otherwise

## The measurement

I changed four files this round (`src/cli/matrix.ts`, two new test files, and one schema test) and tried to seal. The seal was
refused:

    Build cannot run from hardVerify without a repairable verify FAIL result,
    and the sealed revision still matches the workspace.

The first half is true — `verify` reports PASS. **The second half is false**, and the code that prints it only knows the first half:

| | |
|---|---|
| current revision | `revision-e64139639a2833ef`, `ownedPaths` **11 paths** |
| `src/cli/matrix.ts` | **not among them** |
| `tests/unit/every-bundled-schema-has-an-id.test.ts` | **not among them** |
| `tests/unit/owned-paths-have-a-correction.test.ts` | **not among them** |

and `task.ownedPaths` is now **21 paths** — I corrected it with the command this change just added. So the workspace has changed and
the declaration has changed, while `revisionStatus` reports `current`:

    export async function revisionStatus(root, revision) {
      // Freshness remains scoped to the declared manifest. …
      const manifestHash = await computeManifestHash(root, revision.ownedPaths);
      return manifestHash === revision.manifestHash ? { status: 'current' } : { status: 'superseded', … };
    }

`repair-entry.ts` then reads that `current` and prints "the sealed revision still matches the workspace" — **a claim about the
workspace derived from a check of the declaration.**

## And it is the sixth instance of one class

| instance | what the check reads | what it claims |
|---|---|---|
| `cg4-f2` | the revision's owned-path map | the working tree |
| `rba5-f1` | no binding at all | the falsification rule |
| `rba5-f2` | the planned digests, no revision | the resolver's question |
| `rba5-f3` | the revision, not the content | the closure rule |
| **this one** | **the revision's `ownedPaths`** | **the workspace** |

**The pattern is not "a bug in freshness".** It is that `ownedPaths` is a **declaration** and the workspace is **reality**, and the
check reads the declaration while its message claims to have read reality. That is the class this change has now repaired six
times, and the sixth one appeared **inside the mechanism written to make the declaration correctable** — the `ownedPaths`
correction I added an hour ago changed the declaration, and the freshness rule cannot see that the thing it compares has moved.

## Why I am not working around it

Three routes exist and all three are wrong for the same reason:

- **seal anyway** — impossible; the refusal is what blocks it, because a revision is minted by a seal;
- **manufacture a repairable FAIL** (`verify --` on a drifted artefact, or a stash) — that makes the gate pass by making something
  else false, which is the behaviour this whole line has refused under other names;
- **patch `revisionStatus` to also compare `contentDigests`** — that is a seventh instance-level repair, and the comment above the
  function already argues the opposite position deliberately ("using the whole snapshot here would make a later unrelated file
  invalidate valid evidence").

**So the defect is reported rather than routed around.** It is a finding against this change's own mechanism, and it belongs in the
next independent round where it can be argued rather than assumed — with the note that the two positions in play are genuinely in
tension: freshness scoped to the declaration keeps unrelated edits from invalidating evidence, and a refusal that names the
workspace must not decide from the declaration.

## The consequence, stated

`repair-by-another-author` cannot be re-sealed while this stands, so its `revision-e64139639a2833ef` does not describe its current
workspace: it carries eleven paths while the change now edits twenty-one, and the `ownedPaths` correction, the schema invariant and
the `owned-paths-have-a-correction` case are all outside it. The change's own review surface has the same gap.
