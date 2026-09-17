# `layout.ts` owns the on-disk layout

The architecture review's L4-03 finding: `layout.ts` resolved *which* workspace root to use but not *what* lives in it.
`.kata/...` paths were built inline in nineteen modules — 35 occurrences in the orchestrator alone, and 138 literal
`'.kata` constructions across the source tree — so the on-disk protocol was implicit string concatenation, the same
artefact was spelled differently at different call sites, and moving or renaming a file was a grep exercise with no
compiler help.

## What changed

`core/layout.ts` now owns the layout. Every artefact has a named path function — tasks (`taskPath`, `currentStatePath`,
`stateEventsPath`, `transitionLockPath`, `reviewPath`, `judgePath`, `verifyPath`, `repairPath`,
`repairObligationsPath`, `wikiClosurePath`, `userChoiceGatePath`, `waiversPath`), revisions (`revisionsDir`,
`revisionPath`, `currentRevisionPath`), evidence (`evidenceDir`, `evidenceArchiveDir`, `evidenceFilePath`), relations,
the wiki store, runtime pointers, handoffs, adapters and config — following one convention (`xDir` for a directory,
`xPath` for a file). The names on disk are unchanged.

Path construction moved out of every consumer: state, task, recovery, config, relations, workflow-profile, evidence,
judge, reviewer, acceptance-matrix, repair-obligations, the wiki store/llmwiki/lifecycle/closure/provenance modules, the
workflow orchestrator, navigation, revision, handoff, context-fabric, distill-gates, repair-entry, user-choice-gate,
the CLI, the adapters, the eval runner and the Comet compatibility override.

**Literals went from 138 to 10, and the ten that remain are not path construction:**

- three inside `adapters/ownership.ts`'s embedded hook-guard program — the emitted script is a standalone program and
  cannot import from the module that generates it;
- four in `policy/hook-policy.ts` — the write policy's path prefixes, which describe *policy* (what a role may write)
  rather than a build path, and which are embedded into that same guard;
- one in `core/git-flow.ts` (the `.kata/` prefix that decides "unmanaged changes"), one in
  `core/repository-identity.ts` (the ignore list), one in `adapters/platforms.ts` (a platform definition's skill
  directory).

One latent bug fell out of the sweep: `wiki/conflict.ts`'s `collectFiles(root, subDir, …)` joined a root onto whatever
it was given, so passing an absolute directory would have duplicated the root. It now takes an absolute directory, and
its call sites say where they point.

## Verification

- Full suite: 517 tests in 59 files, all passing — the paths are what every test asserts about the artefacts it reads
  and writes, so the sweep is covered by construction; `tsc --noEmit` clean; `dist/cli.js` rebuilt.
- `grep -rn "'\\.kata" src` outside `layout.ts` returns only the ten policy/embedded literals listed above.
