# A `GitFlowPlan` is persisted where a schema-validated `GitFlowState` is required

**Version 0.2.0** (`cad5bb4`). Found while running a real task end to end in a downstream repository (`zenmpai`), not by
reading: `kata-cli design` refused a task whose `task.json` kata had itself written one command earlier.

> **All five findings are fixed**, with a case whose mutation turns it red, in the section *Fixed* at the end. Two further
> defects of the same class were found while fixing them; they are recorded there too. Every measurement below is the one
> the finding was made with — the report itself is unchanged, because it is the record of what was seen.

**F1 is high** — `isolationMode: git_flow` cannot reach `design`. It is deterministic, not racy. F2–F5 are small surface
and diagnostic drifts found on the same run.

## Findings

| # | finding | class (this repo's own vocabulary, `docs/design/2026-09-27-the-seven-defect-classes.md`) | where |
|---|---|---|---|
| F1 | a `GitFlowPlan` (`command: string[]`) is written into `task.json`, which `schemas/task.schema.json` forbids (`gitFlow.additionalProperties: false`); the divergence surfaces only at the next schema-validating read | 5 `a-part-checked-as-the-whole`, 2 `declaration-claiming-reality` | `src/core/git-flow.ts:101,102,279`; `src/core/workflow-profile.ts:52`; `src/cli/workflow.ts:144-146`; `src/cli/relations.ts:52-53` |
| F2 | `kata-cli open` documents `[--title <text>]`; nothing parses it | 6 `a-definition-with-no-consumer` | `src/cli/usage.ts:16` |
| F3 | `kata-cli git-flow` documents `<start\|finish\|status>`; the implementation accepts only `apply` | 6 | `src/cli/usage.ts:43` vs `src/cli/relations.ts:33` |
| F4 | `requiredReads` names `.kata/skills-index.md` in a repository that never ran `kata-cli init`, and nothing on the path says why it is missing | 2 | `src/cli/tasks.ts:331`, `src/core/layout.ts:514` |
| F5 | the schema-failure diagnostic enumerates the **root** schema's allowed fields for a violation deep inside it | — (diagnostic quality) | `src/core/schema.ts:191-195` |

---

## F1 — the channel

### Symptom (verbatim)

```
task artefact /app/.kata/tasks/photography-validation-p0-p1-5/task.json does not match its schema:
$.workflowProfile.gitFlow.command is not allowed.
Allowed fields: acceptance, acceptanceMatrix, acceptanceMatrixMigration, boundaries, branch, createdAt, engine, id,
instruments, ownedPaths, phase, relations, requirements, title, updatedAt, upstreamCoverage, workflowProfile.
```

`kata-cli design` exits 1 with that message and the phase stays `intake`. `kata-cli status` and `orient` keep working
(they read the file without the schema), so the surface looks healthy while the gate is closed — the failure appears one
command later, at the step the handoff told the agent to take.

### How the field got there

`task.json` is written by `updateGitFlowProfile(root, taskId, gitFlow: GitFlowState)`
(`src/core/workflow-profile.ts:52`), whose body is `{ ...profile, gitFlow }` inside `mutateTaskArtefact` — **no schema
validation on the write**. Its call sites hand it a `GitFlowPlan`, not a state:

- `src/cli/relations.ts:52-53` — `const state = inspected.status === 'pending_confirmation' ? applyGitFlowPlan(root, inspected) : inspected;`
  `inspectGitFlow`'s "branch already exists and is current" path returns `{ …, status: 'active', command: [] }`
  (`src/core/git-flow.ts:101`), and that object is stored as-is.
- `src/cli/workflow.ts:144-146` — after every successful command under git_flow isolation (and at `open`), the
  `inspectGitFlow` result is persisted the same way.

`applyGitFlowPlan` is the only path that projects a plan down to a state: it constructs the object field by field
(`src/core/git-flow.ts:258-275`). That is why the branch-had-to-be-created path looks fine and the
branch-was-already-current path does not.

`GitFlowPlan extends GitFlowState` (`src/core/git-flow.ts:23`), so TypeScript sees a plan as an acceptable state and the
extra property is invisible at the type level. The runtime guard that would have caught it, `isGitFlowState`
(`src/core/workflow-profile.ts:81-89`), inspects `strategy`, `branch`, `baseBranch`, `status`, `installation` and
ignores anything else — **a part checked as the whole**.

Measured on the artefacts kata wrote in that one task:

| command that wrote it | `gitFlow` as persisted |
|---|---|
| `kata-cli open --isolation git_flow` (dirty worktree) | `{"strategy":"manual","branch":"","baseBranch":"","status":"failed","command":[],"reason":"worktree_dirty"}` |
| `kata-cli git-flow apply --confirm` (branch already current) | `{"strategy":"git-flow","branch":"feature/…","baseBranch":"develop","status":"active","command":[]}` |

Both were committed straight from the commands' own writes, with no hand edit. The field lands on **every** git_flow
open whatever the worktree state, because `inspectGitFlow` carries `command` on all six of its returns (`:76`, `:88`,
`:101`, `:102`, `:109`, `:279`).

### Blast radius

`git_flow` isolation is unusable end to end on this build: `open` succeeds, `status`/`orient` succeed, and the first
`readTask` consumer refuses. Since `design` is the mandated next step after `open`, a git_flow task cannot be started at
all without hand-editing `task.json` — the route `quality/declaration-change.ts` names in its docstring as the defect it
fixed for `upstreamCoverage` and `acceptanceMatrix`: *a declaration with a reader and no governed writer*.

### Why no test caught it

- `tests/unit/git-flow.test.ts:187` **asserts** that `command: []` is present in `inspectGitFlow`'s `worktree_dirty`
  return. That is right for a plan and is exactly the property the writer must not persist; the test pins the shape at
  the boundary where the two types meet.
- `tests/e2e/git-flow.test.ts` reads the written `task.json` with `readFile` + `JSON.parse` (`:45`, `:51`, `:86`, `:107`)
  and asserts with `toMatchObject`, which ignores extra properties. The artefact is never handed to the reader that
  rejects it.
- `tests/property/schema.property.test.ts:68` builds its `gitFlow` fixture **without** `command` — the schema-legal
  shape — and its negative case mutates `installation.status`, a sibling field. The property is satisfied by a fixture
  no writer produces.
- Nothing in the repository validates a writer's output against the schema it will be read by. `npm run check:wiring`
  covers "a schema nothing bundles or registers"; it does not cover "a writer that can produce a schema-invalid
  artefact".

`docs/changelog/2026-09-17-one-gitflow-execution-model.md` states the intent this violates: *"the persisted profile is
schema-validated, so the record and the schema moved together."* For `reason` and `output` they did. For `command` the
record moved and the schema did not.

### Shape of a fix (implemented — see *Fixed*)

1. **One projection.** `toGitFlowState(plan: GitFlowPlan): GitFlowState` — or have `inspectGitFlow` return the state and
   the plan as two fields so a caller cannot hand one where the other is required. The `{ ...profile, gitFlow }` spread
   is what let a plan through.
2. **Validate on the write.** `updateGitFlowProfile` should run its result through `validate('task', …)`, as
   `quality/declaration-change.ts` already does, so a writer cannot persist a record its reader rejects.
3. **A check with a mutation.** Take each writer's output and hand it to `readTask`; delete the projection and it must
   go red. That is the missing half of `check:wiring`.

---

## F2 — a documented flag no code reads

`kata-cli open --change <id> --isolation <mode> --development <mode> --review <mode> [--bootstrap-file <path>] [--title <text>]`
is what `--help` answers (`src/cli/usage.ts:16`), and no path reads `--title`: the title comes from
`openRequirements[0]?.statement.slice(0,80) ?? 'Change <id>'` (`src/cli/workflow.ts:98`). Measured: a `--title` passed
to `open` is dropped silently and the task is persisted as `"title": "Change photography-validation-p0-p1-5"`.
`hotfix` and `tweak` carry the same `options.title ??` fallback, so the flag is dead on all three.
`tests/unit/help-never-mutates.test.ts` guards that `--help` never mutates — not that what it prints is reachable.

## F3 — a documented surface the parser refuses

`kata-cli git-flow --help` answers `<start|finish|status> --change <task-id>` (`src/cli/usage.ts:43`);
`runGitFlowCommand` throws for anything other than `apply` (`src/cli/relations.ts:33`). `git-flow apply` is also what
`nextAction` tells an operator to run, so the surviving verb is the undocumented one.

## F4 — a required read that cannot exist yet

`requiredReads` unconditionally lists `.kata/skills-index.md` (`src/cli/tasks.ts:331`, from
`src/core/layout.ts:514`). In a repository that has never run `kata-cli init` the file is absent, and neither the handoff
packet nor `status` says so. `adapters/doctor.ts:59` already classifies it as a `support` check, so the answer exists —
it is simply not on the path an agent is told to follow. Lower severity than F1: the agent can note the absence and
continue. Recorded because a dispatch that tells an agent to read a path never checks that the path is there.

## F5 — the diagnostic names the wrong object's allowed set

`readValidated` builds its hint from `allowedTopLevelFields(schemaName)` (`src/core/schema.ts:193-195`). For a violation
inside a nested subschema the reader is shown the **root** object's properties: in the message above, the allowed set of
`task.json` rather than of `workflowProfile.gitFlow`, which is the object that has no `command`. The hint is what makes
the message actionable, so deriving it from the failing subschema would be worth doing.

---

## Reproduction

- kata 0.2.0, this repository at `cad5bb4`; downstream repository `zenmpai`, branch
  `feature/photography-validation-p0-p1-5`.
- F1: any git-flow task reproduces it —
  `kata-cli open --change <id> --isolation git_flow --development tdd --review strict`, then
  `kata-cli design --change <id>` → the message above. `git show <commit>:<task.json>` over the task's history shows the
  field arriving with no hand edit, on both the `open` write and the `git-flow apply` write.

## Boundaries of this report

When this report was written no kata code was changed and no test was added; the fixes and the checks are implemented
now and recorded in the *Fixed* section. The quoted
artefacts come from one downstream task — the claim that *every* git_flow open is affected rests on all six
`inspectGitFlow` returns carrying `command`, which is readable in the source, not on a second end-to-end run. The local
unblock used was removing the `command` key from that one task's profile.

---

## Fixed

All five findings, each with a case that fails when the fix is removed. The verification numbers are at the end.

### F1 — two halves, because one half is what a future call site can forget

**One projection.** `toGitFlowState(plan)` in `src/core/git-flow.ts` picks the state's fields and nothing else, and every
persistence path calls it (`src/cli/relations.ts`, `src/cli/workflow.ts`). It is field-by-field rather than a spread, so a
field added to `GitFlowPlan` later is not in a state until someone decides it is.

The report named `applyGitFlowPlan`'s main return as the only projection. **It also leaked `command` on its early return**
— `{ ...plan, status: 'failed', reason: 'no_branch_command_recorded' }` — which is the branch reached when there is no
command to run, i.e. exactly the branch-already-current path that produced the reported artefact. Both returns project now.

**Validation on the write.** `updateGitFlowProfile` runs the task through `validate('task', …)` before the write, inside
the task lock, and refuses with:

```
refusing to persist a workflow profile this task's own schema rejects: $.workflowProfile.gitFlow.command is not allowed.
Fields allowed at $.workflowProfile.gitFlow: baseBranch, branch, installation, interactive, output, reason, status,
strategy. Nothing was written: the file on disk is unchanged.
```

The type cannot carry this: `GitFlowPlan extends GitFlowState` means the parameter's declared type is satisfied by the
very value that breaks the record. The writer is where it has to be caught, and it is caught before the file changes.

**A check that hands the artefact to the reader.** The new case writes through the persistence path and then calls
`readTask` — the schema-validating reader that refused the file. The old tests read `task.json` with `readFile` +
`JSON.parse` and asserted with `toMatchObject`, which ignores extra properties, so the artefact never met the reader that
rejects it. That is why nothing caught this, and it is the missing half named in `check:wiring`'s own terms.

Measured end to end in a scratch repository: `open --isolation git_flow --development tdd --review strict` stores
`{"strategy":"manual","branch":"feature/gf4","baseBranch":"master","status":"pending_confirmation"}` — no `command` — and
`design` then reaches `phase: plan` instead of refusing. `git-flow apply --confirm` writes its own state with no
`command` either.

### F2 — the flag has a reader, and the reader does not swallow the next flag

`--title` is honoured by `open`, `hotfix` and `tweak` (all three carried the fallback), with the old chain kept for the
case where nobody passes one. `hotfix` and `tweak` now document the flag, since they honour it.

**A third defect turned up here, of this report's own class.** There were **three** `valueAfter` implementations — in
`ops.ts`, `scope.ts` and `workflow.ts` — and they disagreed: `scope.ts` refused a value starting with `--`, the other two
returned it. So `open --title --isolation git_flow` set the title to `"--isolation"` on the path that was reached. They
are one function now (`argValue` in `src/cli/invocation.ts`), using the rule `parseChangeArg` already applied: a token
starting with `--` is a flag, not a value.

### F3 — the usage line names the verb the parser accepts

`kata-cli git-flow apply --change <task-id> [--confirm]`. No other document mentioned `start|finish|status`.

### F4 — a required read is a read that exists

`requiredReads` now lists only paths that are present, and `absentRequiredReads` names what was left out with the command
that creates it:

```
requiredReads: ['.kata/tasks/gf4/task.json', '.kata/tasks/gf4/current-state.json']
absentRequiredReads: [{path: '.kata/skills-index.md', createdBy: 'kata-cli init', note: 'not present; kata-cli init creates it'},
                      {path: '.llmwiki/SCHEMA.md', createdBy: 'kata-cli wiki ingest', …}, …]
```

Carried on `status --with-context` and `orient` too, because a shorter list on its own is not something a reader can act
on: what was omitted and why is the actionable half. Existence is checked with `access`, and anything other than `ENOENT`
surfaces rather than being read as absence.

Three existing cases asserted that `requiredReads` **contains** `.llmwiki/SCHEMA.md` in workspaces that never created it —
they pinned a listing rather than a fact, which is how the handoff came to name a file an agent cannot read. They assert
the new contract: the reads that exist, plus the named absent ones.

### F5 — the hint names the object the violation is in

`readValidated` derived the allowed fields from the root schema whatever the violation. The structured Ajv error travels
with the message now (`validate` attaches `validationError`), and the hint walks `schemaPath` to the failing subschema:

```
before:  $.workflowProfile.gitFlow.command is not allowed. Allowed fields: acceptance, acceptanceMatrix, …, workflowProfile.
after:   $.workflowProfile.gitFlow.command is not allowed. Fields allowed at $.workflowProfile.gitFlow: baseBranch, branch,
         installation, interactive, output, reason, status, strategy.
```

Two shapes of `schemaPath` had to be handled, and the second was only visible by running it: an inline violation is
`#/properties/a/properties/b/additionalProperties`, while a violation inside a `$ref`'d schema is
`https://kata.dev/schemas/review-finding.schema.json/additionalProperties` — an absolute `$id` and then the path *within
that document*, which also means the id must not be split on `/`. The first version matched the schema table's **keys**
(`review-finding`) rather than its `$id`s, found nothing, and returned no hint at all — which is honest, and was still
wrong.

A field list is offered only where it is the remedy: `additionalProperties` ("this key is not allowed" → which keys are)
and `required`. For an `enum` or `type` failure the value is the answer and a field list reads like advice.

### And one more, found by the fix itself

**`createTask` could persist a schema-invalid record too.** With validation on the git-flow writer, the first scratch run
of the F1 reproduction refused *earlier* than intended:

```
refusing to persist a workflow profile this task's own schema rejects: $.upstreamCoverage.sources[0].ref is required.
Nothing was written: the file on disk is unchanged.
```

That message was correct and the record was already invalid when `open` wrote it — a hand-written bootstrap whose source
used `reference` instead of `ref` was accepted, and the task.json it created failed its schema on every later read. Same
class, one layer up, on the *creation* path. `createTask` now validates before writing:

```
refusing to create task gf3: the record would not match its schema, so every later read would fail.
$.upstreamCoverage.sources[0].ref is required Nothing was written.
```

### Verification

```
npx tsc --noEmit                              exit 0
npx vitest run                                167 files / 1060 tests / 0 failures  (165 / 1057 before)
npm run check:wiring                          clean (142 declared paths)
```

Mutation checks, each on the fix it covers:

| mutation | red cases |
|---|---|
| remove `validate('task', …)` from `updateGitFlowProfile` | 1 (`refuses to persist a profile this task's own schema rejects`) |
| make `toGitFlowState` a spread | 2 (`projects every shape…`, `hands a writer's output to the reader…`) |
| drop `argValue(argv, '--title')` from the title chain | 1 (`uses --title as the task's name`) |

New cases: `git-flow-plan-is-not-a-state` (3), `schema-diagnostic-names-the-failing-object` (4),
`a-documented-flag-has-a-reader` (3). Updated: `installer` (3 assertions that named files the fixture never created),
`schema-validation` (2 assertions pinning the old hint wording).
