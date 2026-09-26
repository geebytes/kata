# An owned path the identity policy cannot see is a declaration that cannot be kept

Found while sealing this change, on the second attempt, and measured rather than inferred.

## What happened

`round-protocol` declared two paths under `.llmwiki/`. The seal accepted them, minted a revision, and then **every** check of that revision
reported drift:

```
kata-cli lane --change round-protocol
  revisionStatus: superseded
  driftedPaths: ['.llmwiki/concepts/the-round-protocol.md', '.llmwiki/index.md']
```

No edit had touched either file — `git status` was clean, and so was a second measurement of the same two files. Re-sealing did not help:
the next revision reported the same drift. The only way out was to **stop declaring them**.

## The measurement that explained it

The two paths shared one digest in the revision, and two different files cannot have one content digest:

```
.llmwiki/concepts/the-round-protocol.md  recorded: 8ba1b5d99a4b2c214afaf6fd2dc427f10e1f307fe048a02a1e4860a5dfb90c04
.llmwiki/index.md                        recorded: 8ba1b5d99a4b2c214afaf6fd2dc427f10e1f307fe048a02a1e4860a5dfb90c04
sha256(b'[missing]')                                 = 8ba1b5d99a4b2c214afaf6fd2dc427f10e1f307fe048a02a1e4860a5dfb90c04
```

That is the sentinel `feedOwnedTree` writes when it cannot `stat` an owned path (`src/workflow/revision.ts`, the `else` branch). The reason it
could not is that the digest is taken **against the frozen content snapshot**, and `.llmwiki` is in `ignoredDirectoryNames`
(`src/core/repository-identity.ts:16-19`) — so the snapshot never carries it. The path is not missing; it is invisible to the walk that
decides what a revision is.

## Why it is not merely a nuisance

* **It is silent.** No warning, no refusal, no note in the seal output. The declaration is accepted and the digest is fabricated.
* **It is permanent.** `[missing]` never equals the file's real digest, so the revision reports `superseded` for as long as the declaration
  stands — and the drift names files nobody edited, which points the operator at the wrong cause.
* **It is indistinguishable from a real removal**, for which the sentinel is correct and deliberate ("a removal must not read as never
  existed"). One value answers two questions, so the reader cannot tell which was asked.
* **It is unrepairable in place.** Everything the operator would try — re-seal, verify, a fresh round — lands on the same comparison.

## The rule

**A declaration must be limited to what the identity policy can see.** `ownedPaths` is the surface a revision hashes; a path the walk is
built to exclude cannot be part of it, and accepting one is a promise the seal cannot keep. The two honest fixes, in order:

1. **Refuse it at declaration time.** `open` already normalizes owned paths (`normalizeOwnedPaths`); the same gate should name every declared
   path the walk excludes, and refuse — "this path is outside the repository's identity policy, so a revision cannot be about it" — rather
   than accepting it and recording a sentinel later.
2. **Or distinguish the two cases in the digest**, so "the policy cannot see this path" is not spelled the same as "this path was removed",
   and the drift report can say which.

Until one of them lands: do not put `.kata/`, `.llmwiki/` or any other excluded tree in `ownedPaths`; a change whose knowledge belongs in the
wiki carries it in the closure, not in the declaration. This change does exactly that — the page is named by the closure and the declaration
stays inside what the walk can read.
