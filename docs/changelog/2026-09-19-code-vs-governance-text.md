# A governance-text edit need not invalidate a code-verifying pass (C2)

Measured: **three of six cycles in one day were pure text edits** — one acceptance statement, three rewrites — and each
cost roughly an hour of re-verification for about twenty words. Every revision invalidated both nodes' passes, including
the pass that had verified the code and had nothing to say about the sentence.

## What landed

`src/quality/code-surface.ts`:

- **`isNonCodePath`** — a path is non-code only when it is documentation or governance *by extension* (`.md`, `.mdx`,
  `.txt`, `.rst`, `.adoc`) or *by directory* (`docs/`, `wiki/`, `.llmwiki/`). Everything else, **including anything
  unrecognised**, is code.
- **`codeManifestHash`** — the content identity of a revision's code paths, derived from the per-path digests F2 records.
- **`touchMovedCode` / `textOnlyChange`** — did a change touch code.

## The rule that matters more than the classification

The two possible errors are **not symmetric**: over-classifying prose as code costs one unnecessary round, while
under-classifying code as prose would let a code change leave a code verdict standing. So the answer is `true` ("code
moved") whenever classification is impossible — a revision sealed before per-path digests existed, or an owned set with no
code paths at all — and every consumer must then fall back to **full invalidation and say so**. A `.json` config is
deliberately *not* treated as prose: it can change a gate's behaviour, and this classification exists to preserve
verdicts, not to save time at the risk of one.

The proposal's C2 invariant also holds: a text edit may never leave a **stale truth claim** satisfied — which is what the
claims pass exists for (C3), and why a text-only change still invalidates the *claims* pass. This module only says which
pass a text edit may spare, never that a text edit needs no verification at all.

## Verification

`tests/unit/code-surface.test.ts` (5): the classification of documentation vs code (including `.kata-config.json` and an
unrecognised path being code); a split that loses no path; a code sub-manifest that ignores a docs edit and changes when
code changes; text-only versus code-moved; and both fallbacks (legacy revision without digests, owned set with no code).

Full kata suite: 751 tests in 91 files; `tsc` clean; `dist/cli.js` rebuilt.
