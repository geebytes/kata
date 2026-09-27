# Tasks — enrich-packet-outside-the-task-store

## 1. Design

- [x] 1.1 Acceptance criteria, matrix rows and upstream coverage declared at `open`
- [x] 1.2 The delta spec names the two requirements this change proposes (`The task store holds only tasks`, `One writer
      per task-owned artefact`), because neither exists in the live spec and AC-1 has no other justification

## 2. Where the packet lives

- [x] 2.1 Give the enrichment packet a single writer outside the governed store — `src/wiki/enrich-packet.ts`, writing to
      `<.kata/runtime>/wiki-enrich-task-packet.json` through `layout.wikiEnrichPacketPath`. `runtimeDir` already holds the
      regenerable non-governed artefacts (the active-task pointer), and it is outside `.kata/tasks/`
- [x] 2.2 Point `install` (`src/adapters/ownership.ts`) at that writer instead of building its own path
- [x] 2.3 Point `wiki rebuild` (`src/wiki/llmwiki.ts`) at the same writer
- [ ] 2.4 **Not done, and deliberately out of scope.** Validating the packet against a schema was in the proposal's bullet
      list, not in either proposed requirement, and no acceptance criterion covers it. It is a separate defect class (a
      document nothing reads back) and adding it here would be a second change wearing this one's criteria. Recorded rather
      than dropped silently.
- [x] 2.5 Remove the phantom entry the old code left in the store (`.kata/tasks/wiki-enrich/`), since AC-1 is a statement
      about the store as it is, not only about what new code writes

## 3. The invariant

- [x] 3.1 A check that reddens when a module writes inside the governed store without the locking writer
- [x] 3.2 Report the module and the line, not a count, so the refusal names what to fix. The two remaining sites are
      recorded with the reason each is not locked — and a recorded site that no longer exists fails the case, because a
      stale exception is how an allowlist stops describing the code

## 4. Tests

- [x] 4.1 `tests/unit/task-store-holds-only-tasks.test.ts` — AC-1
- [x] 4.2 `tests/unit/enrich-packet-has-one-writer.test.ts` — AC-2
- [x] 4.3 `tests/unit/task-artefacts-are-written-under-lock.test.ts` — AC-3

## 5. Acceptance

- [x] 5.1 `kata-cli design` passes (no orphan acceptance criterion) — it refused once for exactly that reason, which is the
      gate working: AC-1 had no upstream requirement, and the answer was to propose one rather than to widen a mapping
- [ ] 5.2 `kata-cli build --seal` mints a revision whose evidence covers all three criteria
- [ ] 5.3 `kata-cli ledger` decides `pass` at the declared tier
