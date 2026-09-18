# Re-verification becomes proportional to the change (F2 of the finding-lifecycle design)

The design's largest cost item: records bind to a whole owned manifest (`revision.ts`'s rolling `manifestHash`), so a
two-line repair paid for a full independent pass — measured at 619s/773s/1035s/1240s/1331s per round, with five of eleven
rounds spent on defects the previous round's repair had introduced or left uncovered. The reason is structural, not
procedural: a rolling digest cannot answer **which files changed**, so a reviewer had no smaller question available.

## What changed

**F2.1 — per-path digests, beside the manifest hash.** `computePathDigests(root, ownedPaths)` records
`pathDigests: Record<path, sha256>` on the revision (a directory owned path is expanded to its files, so "something in
here changed" is answerable precisely). **`manifestHash`'s derivation is untouched** — the identity is
`sha256(taskId, manifestHash, checkIds)` exactly as before, and `tests/unit/revision-delta.test.ts` locks that the two
agree byte-for-byte whether or not the field is present (I4). `kata-cli revision digests --change <task> [--since …]`
prints the table, or the change surface against a base.

**F2.2 — delta briefs.** `kata-cli adversarial brief --change <task> --node <n> [--since <revision-id|manifestHash>]`
renders the full brief plus the delta section: the added/modified/removed paths, what to re-derive (claims that touch
those paths; re-check earlier conclusions whose supporting path changed; do not re-prove a refutation on unchanged
paths), the earlier attempts for reference, and the earlier findings with their dispositions. `--since` that cannot be
measured yields `delta_unavailable` in the result — the caller is told, never handed a full brief labelled as a delta.

**F2.3 — the gate checks the scope mechanically.** A recorded pass may carry `scope: { kind: 'full' }` or
`{ kind: 'delta', from, changedPaths }` (schema + `baseManifestHash`). `evaluateDeltaScope` recomputes the change surface
from the recorded digests and requires the declared paths to cover **every** difference: a miss is `delta_stale`, a base
without digests is `delta_unavailable`, and both refuse the node. The reviewer declares *that* it is a delta pass; kata
declares *over what* (`currentDeltaScope` measures it at record time), because the gate cannot take the reviewer's word for
its own scope any more than for its verdict.

## Verification

- `tests/unit/revision-delta.test.ts` — the manifest-hash regression lock, per-path recording with directory expansion,
  added/modified/removed, `unchanged` for identical content under a new revision id, `delta_unavailable` for a legacy
  revision, workspace comparison, `deltaCoversChange` for a partial and a complete declaration, and the gate's
  acceptance/refusal/`delta_unavailable` paths against real revisions.
- Full kata suite: 640 tests in 79 files; `tsc` clean; `dist/cli.js` rebuilt.

## Still open from the design

F3 (pricing a repair: `reverificationCost` + `findingOrigins`) and F4 (platform-derived relevant checks, with fallback to
full as a hard requirement) and F5 (`reviewedPaths`, explicitly lowest confidence and last). **The design's own largest
unverified assumption remains unverified: the actual saving of F2 has not been measured on a real task** — the mechanism
now exists, but "10–22 minutes becomes 2–3" is still a projection, and it should be measured before F4 is built on it.
