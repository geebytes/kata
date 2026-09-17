# One repository identity

The architecture review's L3-03 finding: "what is this repository?" had three answers. `shouldIgnore`/`shouldIgnorePath`
existed almost verbatim in `quality/evidence.ts` and `workflow/revision.ts`, and a third, differently scoped table
(`isIgnoredWorkspacePath`) governed drift and ownership inference without the cache entries the hash tables had. So the
freshness hash, the revision manifest and the drift view could disagree about a path — a `.pytest_cache` write was
invisible to the hash and reported as drift, and a walk that excluded a directory by name in one place read it in
another.

## What is one definition now

**`core/repository-identity.ts`** owns the policy and the walk:

- `ignoredDirectoryNames` — toolches, caches and kata's own state (`.git`, `.kata`, `.llmwiki`, `.pytest_cache`,
  `.mypy_cache`, `.ruff_cache`, `.coverage`, `__pycache__`, `node_modules`, `dist`, `.codex`, `.claude`, `.opencode`).
- `ignoredPathPrefixes` — the generation-managed trees (`.github/hooks`, `.github/skills`, `.github/instructions`).
- `ignoredHeavyPaths` / `ignoredFileSuffixes` — model weights and dataset dumps (`.models`, `*.gguf`, `*.safetensors`,
  `*.onnx`, `*.ckpt`). These used to be excluded only because they happened to exceed the per-file size cap; naming
  them states the intent and stops the walk from reading a multi-gigabyte file to find out it did not want it.
- `isIgnoredRepositoryName`, `isIgnoredRepositoryPath` — one predicate, segment-aware, used by the hash, the manifest
  and drift alike.
- `walkRepositoryFiles(root, { under?, maxFileBytes? })`, `repositoryTreeHash(root)`.

`computeDiffHash` is `repositoryTreeHash`, `computeScopeHash` and `computeManifestHash` walk through the same reader,
and `isIgnoredWorkspacePath` is now `isIgnoredRepositoryPath`. Drift and ownership inference therefore see exactly what
the hashes exclude — including the cache directories they previously reported.

## The one deliberate difference, stated at the call site

The size budget belongs to the caller, not to identity: the **tree hash** caps at 2 MB because it is a cheap
fingerprint over everything, while **owned-path hashing has no cap** because the manifest's job is to notice that any
owned file changed — a 29 MB PDF in an owned test directory must still be able to supersede a revision. `WalkOptions`
states this at each call site instead of leaving it implicit in one table's silent skip.

Two properties worth recording:

- Where the old tables already agreed, the tree hash is **bit-identical** to the old `computeDiffHash`, so existing
  sealed revisions in a repository without heavy paths stay current rather than flipping to superseded.
- No cache is added. "Hash the tree four times per seal" is real cost, but a walk cache keyed on mtime/size can miss a
  write that lands in the same second with the same length — and a stale hash reads as *fresh evidence*, which is the
  failure the whole evidence system exists to prevent. The cost stays visible, and Phase 3 owns making it cheaper.

## Verification

- `tests/unit/repository-identity.test.ts` — the policy by name and by path (including nested caches and a `.md` file
  whose name merely contains a cache name); drift and the tree hash agreeing on a cache-only change versus a real one;
  subtree walks returning repository-relative paths; and the size-budget difference between the tree hash and owned-path
  hashing.
- Full suite: 497 tests in 54 files, all passing (including the revision-supersede and seal tests that would fail if the
  tree hash had changed value), `tsc --noEmit` clean, `dist/cli.js` rebuilt.
