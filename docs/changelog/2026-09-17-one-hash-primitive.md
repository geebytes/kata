# One sha256 primitive

The architecture review's L6-03 finding: the same one-line hash was written six times, under five names —
`core/layout.ts`'s `sha256`, `wiki/llmwiki.ts`'s `sha256`, `wiki/record.ts`'s exported `computeFileHash`,
`workflow/context-fabric.ts`'s one-liner `hash`, `adapters/ownership.ts`'s exported `sha256` — plus three inline
`createHash('sha256')` uses in the evidence, revision and repository-identity walks and one in the CLI. Two modules
exported their own copy of the same primitive under different names, so the hash identity that the revision, Wiki,
handoff and generated-skill layers all depend on was defined by convention rather than by a shared function.

## What changed

**`core/hash.ts`** is the one definition:

- `hashContent(value: string | Buffer): string` — the one-shot primitive, hex-encoded.
- `createContentHasher()` — an incremental hasher for the callers that hash a tree or a record part by part, so even
  those do not repeat the algorithm name.

Every site now uses one of the two. The two externally-visible names are kept as re-exports of the primitive
(`computeFileHash` in `wiki/record.ts`, `sha256` in `adapters/ownership.ts`), marked deprecated, so nothing outside
these modules breaks while callers migrate.

`grep -rn "createHash('sha256')" src` now matches exactly one file: the primitive itself.

## Verification

- The full suite (497 tests) exercises every consumer — revision manifests, Wiki records, handoff packet hashes,
  generated skill files — and passes unchanged, which is the evidence the primitive produces identical values.
- `tsc --noEmit` clean; `dist/cli.js` rebuilt.
