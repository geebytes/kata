# One authoritative relation store

The architecture review's L4-04 finding: `addTaskRelation` wrote one edge three times — into the global graph
(`.kata/relations.json`), into `.kata/tasks/<id>/task-relations.json`, and into `task.json` through
`mirrorRelationIntoTask`, which rewrote the record the lifecycle reads for acceptance criteria and workflow profile and
bumped its `updatedAt` as a side effect of adding a relation. No transaction, no reconciliation: a failure between the
writes left the stores disagreeing. Reads preferred the per-task file and silently fell back to `task.json` on *any*
read error, so disagreement surfaced as a plausible answer rather than as a problem.

## What is one store now

**`.kata/relations.json` is the authoritative record for task relations.**

- `addTaskRelation` performs **one write**: the graph. The per-task file and the `task.json` mirror are gone, so
  creating a relation no longer rewrites the task record — which also removes the unlocked read-modify-write on
  `task.json` that L3-09 records.
- `readTaskRelations` **derives** a task's relations from the graph, in the same shape consumers already use
  (`type`, `targetTaskId`, `reason`, `createdBy`, `createdAt`). It reads no second store.
- No silent fallback: an **absent** graph means no relations have been recorded, while a graph that **drifted** from
  `kata-relations.schema.json` fails where it is read, naming the file. That is the distinction the old fallback
  erased.
- `task.schema.json` keeps its optional `relations` property, so a repository whose task records still carry the
  legacy mirror is not rejected; nothing writes it any more. The CLI's `tasks relate` output reports
  `relationPath: .kata/relations.json`, since that is where the edge actually went.

## Verification

- `tests/unit/relation-store.test.ts` — an added edge appears once in the graph while `task-relations.json` is not
  created and `task.json` is byte-identical; a task's relations derive from the graph in the consumer shape (and only
  its own outgoing task edges); an absent graph answers with no relations; a drifted graph is reported rather than
  answered; terminal redirects follow the graph and a cycle is refused.
- The three suites whose fixtures seeded the per-task file now seed the graph (their intent — a relation that excludes
  a task from ownership conflicts, a redirect that changes status, a CLI relation — is unchanged).
- Full suite: 504 tests in 56 files, all passing; `tsc --noEmit` clean; `dist/cli.js` rebuilt.
