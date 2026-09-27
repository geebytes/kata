# The wiki enrichment packet is not a task

## Why

`.kata/tasks/` is the governed task store: every directory in it is supposed to be a task that `kata-cli status` can
resolve. One directory breaks that. The install path and the wiki rebuild both write a wiki *enrichment packet* to
`.kata/tasks/wiki-enrich/task-packet.json` — a directory named like a task, holding no `task.json`:

- `kata-cli status --change wiki-enrich` answers `No Kata workspace owns task wiki-enrich` while the directory sits in the
  store, so every tool that enumerates `.kata/tasks/*` as tasks has to special-case it (measured: this session's own
  sweep of the twelve store entries reported one `PARSE_FAIL` for exactly this directory);
- the packet has **two writers** — `install` (`src/adapters/ownership.ts`) and `wiki rebuild`
  (`src/wiki/llmwiki.ts`) — so the two can produce different packets for the same wiki, which is the
  "one decision, two entrances" shape this repository removes most often;
- nothing reads the packet back, so neither write is validated: it is a document written into the state store with no
  schema behind it.

The requirement this needs does not exist in the live spec: the store's own integrity (every entry is a task, every
artefact has one writer) is asserted nowhere, which is why a directory that is not a task could live there unnoticed.

## What changes

- `ADDED` — *The task store holds only tasks* (`workflow-runtime`): a directory under `.kata/tasks/` SHALL be a task the
  CLI can resolve, or SHALL NOT be created there.
- The enrichment packet moves out of the governed store to a path that names what it is, and gets **one writer**, with a
  schema behind it, so the two callers cannot drift.
- An invariant check that reddens when a task-owned artefact is written without the locking writer — the invariant this
  repository has hit twice (a scope apply that trusted its input; a declaration written by a second path that left no
  record).

## Impact

- Specs: `workflow-runtime` (one requirement added).
- Code: `src/wiki/llmwiki.ts`, `src/adapters/ownership.ts`, and whichever module the packet's single writer lands in.
- Existing records: the packet is a handoff artefact and nothing reads it back, so no stored record changes meaning.
