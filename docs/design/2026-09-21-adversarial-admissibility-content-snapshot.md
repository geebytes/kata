# Adversarial admissibility: pre-check content snapshot and isolated seal execution

**Status:** implemented in the `adversarial-admissibility` worktree; pending governed seal/verification.

## Decision

A sealed revision's content identity is captured **before** any quality check runs. Checks execute only against a disposable materialization of that snapshot, never against the author's worktree.

This replaces the rejected “post-check full-tree snapshot” approach. The rejected approach treated a check's own output (for example, `check-ran.txt`) as an author edit, so a second seal minted a new revision even when the author had changed nothing.

## Why the other sources are insufficient

- `git status` only sees uncommitted work and reports an empty surface after a pre-seal commit.
- `ownedPaths` is a declaration and cannot be the authority for an AC that must report changes outside that declaration.
- A post-check whole-tree walk observes check side effects, not just authored content.

## Contract

1. Before the revision is minted and before a check starts, Kata creates a private execution copy and computes `contentDigests` from that copy.
2. The revision ID, change record, delta surface, and evidence `diffHash` use that frozen content snapshot. The content-digest delta is declaration-independent.
3. A Git repository uses a detached temporary worktree, then overlays current uncommitted/untracked repository content. A non-Git fixture receives the same private copied materialization; a Git-dependent check then fails as evidence rather than gaining write access to the author directory.
4. Every check keeps its original command, cwd, environment, and fingerprint in evidence. Only an internal execution override maps repository-local references into the private copy. Check reuse therefore remains keyed to the declared check rather than a random temporary path.
5. A check whose cwd escapes the repository is refused for isolated execution. Kata does not silently run it in the author worktree.
6. Runtime dependencies are copied rather than linked. Relative runtime symlinks are retained only when their resolved target remains under the private `node_modules`; escaping links are refused. Check writes, test output, and build artifacts are discarded with the private copy.
7. If a Git repository cannot create its detached execution worktree, the seal fails closed. It does not degrade to author-worktree execution.

## Freshness boundary

`contentDigests` define **what the sealed revision contained** and its delta against a base revision. They do not replace manifest-scoped evidence freshness: an unrelated later workspace edit must not invalidate valid evidence for an unchanged owned manifest. The next seal incorporates that later edit into its own immutable content snapshot.

## Proofs

- The seal-cost/revision-identity e2e check writes `check-ran.txt` through a relative cwd. The first seal succeeds, the author root does not contain that file, and a second seal reuses the identical revision/evidence.
- Mutation proof: temporarily disabling the sandbox cwd mapping makes the e2e test fail because `check-ran.txt` appears in the author root. The source was restored immediately after the proof.
- An e2e ancestor-workspace fixture proves an incomplete linked-worktree `node_modules` is supplemented from Node's resolution candidates as private, dereferenced copies.
- The full regression result is captured by the seal evidence. Its only local failure was the unrelated `comet-init-platforms` real-Comet fixture, which is outside this change's paths.
