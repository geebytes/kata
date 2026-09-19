# The surface digests were computed over almost nothing (a defect in my own §24.4 work)

Found by running the new mechanism against the **real task record** the other session had just declared: `scope show` said
the boundary was valid, and the instrument surface came back **`null`**. Chasing that produced a much worse finding than the
one I was looking for.

## The defect

`codeManifestHash` and its siblings hashed `revision.pathDigests[ownedPath]` — a lookup by **owned path** into a table
keyed by **files**.

On the measured task those are not the same kind of string: `ownedPaths` is **13 directory-shaped paths** (`scripts`,
`tests`, `packages/k2skills-core/src/k2skills_core/skill_factory`, …) while `pathDigests` has **699 file keys**. So the
lookup found nothing for eleven of the thirteen, the digest was computed over the two documentation paths that happened to
be files, and it **looked perfectly healthy**.

The consequence is the failure mode §15 forbids, reached by a plausible implementation:

- the code surface **did not move when code moved** — measured: changing
  `packages/…/skill_factory/registry.py` left `codeManifestHash` **byte-identical**;
- so the sparing rule C2/§24.4 added could have spared a pass for a change it had never inspected.

## Fixing it fixed a second, smaller one

Classification now happens **at the digest-key level** (`classifyDigestKeys`), not at the owned-path level. That matters
because `splitOwnedPaths` classified owned *paths*, and the task declares its instrument as a **file** inside an owned
**directory** — so the instrument was never subtracted, and the instrument surface was `null` even after §24.4 was
"implemented". Measured on the real record, before and after:

| probe | before | after |
|---|---|---|
| code change moves the code surface | **false** | true |
| instrument change moves the code surface | true (wrong) | **false** |
| instrument change moves its own surface | false | **true** |
| docs change moves the code surface | false | false |

Real key counts on that record: **2 instrument / 677 code / 20 governance**.

## Why the earlier tests missed it

Every fixture in `instrument-boundary.test.ts` used **file-shaped** owned paths (`['src/a.ts', 'docs/b.md',
'scripts/checker.py']`), where lookup-by-path works. The realistic shape — a directory owned, a file inside it declared —
was never represented. `surface-digest-expansion.test.ts` is written with directory-shaped owned paths for that reason, and
its first case asserts the exact property that was silently false.

## Verification

`tests/unit/surface-digest-expansion.test.ts` (6): classification by digest key rather than owned path; the code surface
moving when code moves (the defect, asserted directly); an instrument edit staying out of the code surface while moving its
own; a governance edit staying out of the code surface; `null` meaning "cannot be spoken for" rather than "unchanged" for an
undeclared or legacy revision; and file-shaped / trailing-slash owned paths matching themselves. Full kata suite: **810
tests in 100 files**; `tsc` clean; `dist/cli.js` rebuilt.

The earlier file's path-level test is annotated with what it does **not** cover, since the gap between the two levels is
what hid this.
