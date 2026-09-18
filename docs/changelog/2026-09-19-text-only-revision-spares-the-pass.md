# A governance-text edit spares a code-verifying pass — but only with the claims re-read (C2, wired)

Measured: **three of six cycles in one day were pure governance-text edits** — one acceptance statement, three rewrites —
each costing roughly an hour of re-verification for about twenty words. Every revision invalidated both nodes' passes,
including the pass that had verified the code and had nothing to say about the sentence.

## The ordering constraint, taken literally

§16 said C2 may only be wired **after** C3, "otherwise a text edit could leave a stale truth claim satisfied". That is the
whole design of this change: a governance-text edit changes the *sentences*, and the sentences are what claims check — so a
pass is spared **only when something cheap has re-read them**.

## What landed

- **`codeManifestHash` on the bindings.** Stamped beside `manifestHash` by kata wherever a verdict is stamped, and declared
  on all seven schemas that carry a revision binding (`verify-result`, `review`, `judge-result`, `adversarial-review`,
  `user-choice-gate`, `task-choice`).
- **`bindsToRevision(artifact, current, { scope })`.** The default is `full`, so **no existing caller is loosened** — a gate
  opts into `code` scope one call site at a time. With `scope: 'code'` a verdict survives a change whose code surface is
  identical; an underivable surface on **either** side falls through to `false`, which is the full invalidation the
  proposal requires.
- **The adversarial gate's two conditions.** A text-only revision spares a pass only when (1) both sides name the code
  surface and agree, and (2) `claimsVerified` — read from the recorded evidence, where a claim's envelope carries
  `claim:<acceptanceId>:<claimId>` and the `revisionId` it ran against. A revision whose acceptance statement declares no
  claims is trivially satisfied, which is the honest answer while the statements are still prose.
- **`claimsVerified` defaults to `false`**, so a caller that has not thought about it gets the strict behaviour it had
  before.

## Verification

`tests/unit/text-only-revision-spares-the-pass.test.ts` (5): a docs-only edit with the claims re-read **spares** the pass; a
docs-only edit with the claims **not** re-read, or with the flag unset, does not (the `stale_revision` hazard §16 named);
changed code does not; an underivable code surface on either side does not; and sparing the pass is not a way around the
brief binding, the fresh-context attestation or the attempt requirement.

Full kata suite: 766 tests in 94 files; `tsc` clean; `dist/cli.js` rebuilt.
