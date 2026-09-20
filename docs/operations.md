# Operations

## CLI reference

| Command | Description |
|---------|-------------|
| `kata-cli init` | Unified setup: coordinates Comet init and installs Kata Skills/rules/hooks/Wiki for detected platforms. Silent on success unless `--json` is passed |
| `kata-cli update` | Update installed Skills, then refresh the managed runtime by policy (`--refresh` / `--no-refresh`, default `auto`). Silent on success unless `--json` is passed |
| `kata-cli uninstall` | Remove installed Skills. Silent on success unless `--json` is passed |
| `kata-cli discover` | List detected platforms |
| `kata-cli doctor [--platform <name>]` | Verify installed skills, rules, hooks, command bridges, and Wiki presence. Without `--platform`, checks all detected project platforms |
| `kata-cli orient --change <id>` | Aggregate project constraints, LLM Wiki entrypoints, model route, handoff guards, and next suggested Skill |
| `kata-cli handoff create --task <id> --from <role> --to <role>` | Create a platform-neutral context packet for the same Git worktree and branch |
| `kata-cli handoff show --task <id> --id <handoff-id>` | Print the packet and its required reads, evidence and permissions |
| `kata-cli handoff verify --task <id> --id <handoff-id>` | Verify packet Git anchors against the current worktree |
| `kata-cli handoff acknowledge --task <id> --id <handoff-id> --platform <name> --role <role>` | Record the receiving platform and role after it has read the packet |
| `kata-cli hooks activate --change <id> --role <role>` | Bind platform write hooks to the active Kata task and role |
| `kata-cli hooks status` | Show the active hook task, if any |
| `kata-cli hooks deactivate` | Clear active hook task scope |
| `kata-cli status <change>` | Show Comet change status |
| `kata-cli next <change>` | Show next Comet action |
| `kata-cli eval <manifest>` | Run evaluation from manifest |
| `kata-cli baseline [--platform <p>] [--language en\|zh] [--change <id>]` | Measure rendered payload bytes/tokens and the authoritative read sizes before a phase runs |
| `kata-cli adversarial brief <task-id> [--since <rev>] [--mode verify\|cold]` | Render the independent pass's brief and store it; only a stored brief's hash satisfies the gate |
| `kata-cli adversarial record <task-id> --from-file <result.json>` | Seal a pass's verdict and its revision binding (see *Independent adversarial review*) |
| `kata-cli adversarial note <task-id> --from-file <line.json>` | Append one heartbeat line — the work a killed pass would otherwise take with it |
| `kata-cli adversarial finding add <task-id> --from-file <finding.json>` | Record one finding as it is confirmed, before the verdict |
| `kata-cli adversarial status <task-id>` | Both nodes' gate state, the heartbeat, and a delta round's measured saving |
| `kata-cli findings list \| defer \| accept \| carry <task-id>` | Give a finding a disposition (`blocking`/`major` cannot be deferred or accepted) |
| `kata-cli revision digests <task-id> [--since <rev>]` | The per-path content table a delta round is measured against |
| `kata-cli comet install [--version <ver>]` | Install or update Comet binary via npm |
| `kata-cli comet update` | Update Comet to latest npm version |
| `kata-cli comet version` | Show compatibility range and installed version |
| `kata-cli comet path` | Resolve Comet binary location |
| `kata-cli comet verify` | Check Comet binary exists, is executable, and is compatible |
| `kata-cli codegraph explore <query...>` | Explore code via CodeGraph: source + call paths in one shot |
| `kata-cli codegraph query <search>` | Search for symbols in the codebase |
| `kata-cli codegraph impact <symbol>` | Analyze what code is affected by changing a symbol |
| `kata-cli codegraph affected [files...]` | Find test files affected by changed source files |
| `kata-cli codegraph node [name]` | One symbol's source + caller/callee trail |
| `kata-cli codegraph status` | Show CodeGraph index status and statistics |
| `kata-cli codegraph index` | Rebuild the full CodeGraph index from scratch |
| `kata-cli codegraph sync` | Sync changes since last CodeGraph index |

### Options

| Flag | Applies to | Description |
|------|------------|-------------|
| `--platform <name>` | init, update, uninstall | Target platform |
| `--scope <project\|global>` | init, update, uninstall | Install scope |
| `--dry-run` | init, update, uninstall | Preview without writing |
| `--force` | init, update, uninstall | Overwrite conflicts |
| `--json` | init, update, uninstall | Print the install/update/uninstall report to stdout. Without this flag these installer commands are silent on success |
| `--quiet` | all commands | Suppress JSON stdout even when a command would normally print it |
| `--root <path>` | init, update, uninstall | Project root |
| `--home <path>` | init, update, uninstall | Home directory |
| `--yes` | init | Non-interactive auto-detect and install detected project platforms |
| `--wiki-from <path>` | init, update | Initialize `.llmwiki/` from a documentation path |
| `--no-wiki` | init, update | Skip `.llmwiki/` initialization |
| `--change <id>` | open, design, build, verify, archive, hooks activate | Change identifier |
| `--role <role>` | orient, hooks activate | Role to resolve (`implementer`, `reviewer`, `judge`, `distiller`) |
| `--task-kind <kind>` | orient | Task kind, e.g. `read`, `implementation`, `security` |
| `--from <role>` / `--to <role>` | handoff create | Sender and receiver roles |
| `--id <handoff-id>` | handoff show, verify, acknowledge | Handoff packet identifier |

## Agent orientation

Every installed `/kata-*` Skill starts with the same project-orientation command:

```bash
kata-cli orient --change <change-id> --role implementer --task-kind implementation
kata-cli hooks activate --change <change-id> --role implementer
```

The output is a compact startup packet for AI coding tools:

- `requiredReads` points to `AGENTS.md`, `.kata/skills-index.md`, and `.llmwiki` entry files.
- `guardInstructions` comes from the current task phase and role handoff.
- `modelRoute` resolves the normalized tier/provider/model contract from `.kata-config.json`.
- `nextSkill` suggests the next `/kata-*` Skill after considering both phase and upstream artifacts; `phaseNextSkill` keeps the raw phase mapping when an artifact override exists.
- `nextAction` provides the exact next operation in both forms: `slashCommand` for coding-agent chat and `cliCommand` for scripts/non-interactive fallback.
- active hooks bind platform write interception to the task phase and role.
- `handoff` identifies a canonical packet under `.kata/tasks/<id>/handoffs/`; a receiving agent verifies it before using another platform's work.
- `active-task.json` is updated automatically by successful workflow commands, `handoff acknowledge`, explicit `hooks activate`, and `status` when exactly one unfinished same-branch task exists.

This is the intended trigger chain:

1. Project `AGENTS.md` loads repository constraints.
2. `.llmwiki` loads durable project knowledge.
3. `/kata-*` Skill loads the workflow step.
4. `kata-cli hooks activate` makes platform hooks enforce phase/role write scope.
5. The `orient` output tells the adapter which tier each role defaults to from `.kata-config.json`. Model selection is always the user's decision in their host platform.
6. CLI gates, CI/tests, Reviewer, and Judge enforce correctness.

## Cross-platform handoff

Use a handoff when work changes from one platform or role to another. It does not transfer chat history and does not require the two tools to share a provider or model.

```bash
kata-cli handoff create --task auth-hardening --from implementer --to reviewer --platform opencode
kata-cli handoff verify --task auth-hardening --id handoff-<id>
kata-cli handoff acknowledge --task auth-hardening --id handoff-<id> \
  --platform codex --role reviewer
```

Packets are valid only in the worktree and branch where they were created. A changed HEAD, branch, or diff hash invalidates the packet. Regenerate it after an implementation change; a receipt records that an agent accepted context, not that code is correct.

After `handoff acknowledge`, the receiving task becomes the local active task. That means a low-tier implementer can normally continue with:

```bash
kata-cli status
kata-cli build
```

without repeating `--change <id>`. When multiple unfinished same-branch tasks exist, Kata does not guess; `kata-cli status` returns candidates and a recommended next action for the skill/user to confirm.

After archive or when leaving Kata-governed work, clear the active hook:

```bash
kata-cli hooks deactivate
```

## Coding-agent Wiki enrichment

LLM-assisted Wiki work is skill-driven, not binary-driven. The Kata binary emits deterministic task packets:

```bash
kata-cli wiki task --kind enrich --from docs
```

Then the installed `/kata-wiki-enrich` Skill uses the current coding agent's LLM capability to read `requiredReads` and write synthesized pages under the packet's `writeTargets`. After the agent writes pages, run the packet's deterministic follow-up commands such as `kata-cli wiki lint` and `kata-cli wiki verify`.

Conversation-derived knowledge is captured only when the user explicitly asks to remember or sediment it, such as “记住这个”, “沉淀到 wiki”, “以后都按这个”, “record this rule”, or “add to wiki”. The agent writes a short source note, ingests/registers it as a candidate, and does not promote it directly.

## Quality gates

### What a seal runs, and what it can defer

`kata-cli build <task> --seal` resolves the check set from, in order: an explicit `--check`, the project's
`.kata-config.json` `quality.buildChecks`, the `## Acceptance Gate` block an installed skill documents, then the built-in
fallback. `kata-cli build <task> --list-checks` prints that set — each check's id, kind, command, source, timeout and what
it cost last — **without running anything**, so the cost of a seal is visible before paying it.

A declared check may carry a **tier**:

- `tier: "seal"` (the default, and what every check does when the field is absent) runs on every seal;
- `tier: "frozen"` is deferred at seal and run when the artefact is frozen — `build --seal --frozen`, which is what the
  freeze points use. Deferred checks are named in the result (`diagnostics.deferredChecks`), in progress events
  (`skipped`, `reason: "frozen_tier"`) and in `--list-checks`, so "declared but not run" is never silent.

A declaration may also name the check that **covers** it (`coveredBy: "<check id>"`, typically the project's suite):
the covering check still runs, and the declaration is credited with its evidence instead of running its own second copy
of the same work. It appears under `diagnostics.coveredChecks`.

The verification pipeline enforces strict ordering:

1. **Model route artifact** — configured reviewer/judge routes are recorded before role transitions, including both recommendation and user/agent decision
2. **Hard evidence** — lint, typecheck, test, CI, security
3. **Evidence freshness** — diff hash must match current project state
4. **Reviewer clearance** — no blocking findings
5. **Judge PASS** — all acceptance criteria pass
6. **Wiki candidate** — only from passed tasks

Any gate failure returns the task to bounded repair. Blocking reviewer findings in `review.json` route the task back through `/kata-build`, which records `review → implement → hardVerify` in `state-events.jsonl` and `.kata/tasks/<id>/repair.json`. Judge FAIL follows the same repair discipline from `judge → implement → hardVerify`. These backward links are recognized repair returns: recovery replays them as chain links, so the projection keeps the post-repair `hardVerify` instead of rewinding to the phase the repair started from.

## Giving a check its own weight

Checks run **serially by default**, because the platform cannot know what they share: in one measured project the
integration checks drop and recreate rows in a single PostgreSQL database, so running them together fails for reasons the
change under test did not cause. A project that knows its checks are independent opts into concurrency with
`KATA_CHECK_CONCURRENCY`.

That switch is per-project and blunt, though. A project whose checks are *themselves* parallel (`pytest -n auto`) sizes each
one for a whole machine, so running N of them at once multiplies the load by N — measured in this workspace as
`4 × -n auto` oversubscribing 48 cores and making the checks **slower and flakier than serial**.

So a check declares how much of the machine it takes:

```json
{ "quality": { "buildChecks": [
  { "id": "lint", "command": "make", "args": ["lint"] },
  { "id": "suite", "command": "make", "args": ["test-parallel"], "weight": 8 }
] } }
```

`weight` defaults to `1`. With `KATA_CHECK_CONCURRENCY=4` the lint check still shares a slot, and the suite — whose weight
exceeds the limit — **runs alone**, which is what it needs: it is already using every core it was going to get. A nonsense
weight is rejected at the config boundary with the reason, rather than silently treated as a licence to run unbounded.

## Environment variables

Everything kata reads from the environment, and what each one changes. All are optional: the default is the documented
behaviour of each surface, and nothing here is needed for an ordinary run.

| Variable | Default | What it changes |
|---|---|---|
| `KATA_CHECK_CONCURRENCY` | `1` (serial) | How many checks a seal may run at once. Serial by default because the platform cannot know what two checks share; raise it only for checks known to be independent, and prefer a check's own `weight` (see *Giving a check its own weight*) |
| `KATA_EVAL_CONCURRENCY` | `1` (serial) | How many evaluation fixtures `kata-cli eval` may run at once. Each fixture already gets its own temporary root, so the isolation is real — but serial is the default for the same reason as the seal's, and a resource-related fixture failure is reported with the concurrency that produced it. A value that is not a positive integer falls back to `1` rather than serialising silently or failing |
| `KATA_CODEGRAPH_INDEX_TIMEOUT_MS` | `300000` | Budget for the `codegraph index` stage of `update`. It is a full rebuild — measured at 35–46 s on a 972-file index — so it does **not** share the smaller budget the incremental `sync` stage uses; a stage that exceeds its budget is reported as `timed_out` with the budget it had |
| `KATA_RUNTIME_REFRESH_TIMEOUT_MS` | `30000` | Budget for the runtime refresh's non-index stages (`comet`, `codegraph sync`). The refresh is best-effort: no stage failure aborts the platform update |
| `KATA_GITFLOW_TIMEOUT_MS` | `300000` | Budget for a Git Flow subcommand. Both the interactive and non-interactive paths are bounded by it, so a git operation cannot hang an unattended run |
| `KATA_LANGUAGE` | `zh` | Language for the prompts kata renders into a task's status and pause instructions (`en`/`zh`). An explicit language on the call wins over it; a task's own record does not override it |

## Worktrees

`isolated_worktree` used to be a declaration kata could not act on: every host nested worktrees in its own place
(`.claude/worktrees/`, `.codex/…`, a sibling directory), so nothing resolved the workspace root on the agent's behalf.
Kata owns the convention now:

```bash
kata-cli worktree create --change <task-id> [--branch <name>] [--base <ref>] [--path <dir>]
kata-cli worktree list
kata-cli worktree remove <path> [--force]
```

- **Where they live.** Linked worktrees go under `<repo>/.kata/worktrees/<task>`, which is ignored by git **and** by
  repository identity, so a nested worktree never appears as untracked paths in its primary checkout and never counts as
  workspace drift.
- **What a created worktree carries.** Kata's ignore rules, and the task's own state — copied in when the branch's commit
  predates the task (task state is tracked, so an older base would otherwise check out an empty workspace). The session
  pointer is deliberately **not** copied: activate in the worktree (`kata-cli hooks activate --change <task> --role <role>`).
- **Which checkout a command uses.** A task shared by a nested worktree and its primary checkout resolves to the
  **nearest** owner — the checkout the command runs in. From the primary checkout it resolves to the primary checkout.
  Sibling worktrees that own the task with no owner above them still fail closed (`Multiple descendant worktrees own…`),
  because nothing in the invocation says which one was meant; `--root` selects one explicitly.
- **Removal.** `git worktree remove` semantics: uncommitted changes are refused unless `--force`, and a forced removal
  says so in its result rather than passing silently.

### What git sees

`.kata/runtime/` and `.kata/worktrees/` are written into `.gitignore` — at hook activation (which every flow performs),
at `worktree create`, and at `init`. `.kata/runtime/` holds the active-task pointer, a **session** pointer: when it is
committed, a worktree or a fresh clone checks it out, and the hook guard then enforces a task nobody activated in that
checkout against whoever is working there.

Task state itself stays tracked (that is what lets a worktree inherit the task), which also means branches fork task
state and merging them merges it.

## Independent adversarial review

Verify and review are the two nodes where the context that produced the change is the worst available judge of it: it
shares the implementation's assumptions, its blind spots, and its reading of its own evidence. Both nodes therefore
require an **independent adversarial pass** over the sealed revision, executed in a context that did not author the
change — the host platform's own subagent facility, a fresh session, no prior conversation.

Kata cannot start a subagent or inspect the host's session. What it does is render the brief, check the result against
the revision and that brief, and hold the gate:

```bash
kata-cli adversarial brief  --change <task-id> --node verify|review [--since <revision-id>] [--mode verify|cold]
kata-cli adversarial record --change <task-id> --node verify|review --from-file <result.json> \
    --elapsed-ms <how long the pass took> [--tool-uses <how many tool calls>]
kata-cli adversarial note   --change <task-id> --node verify|review --from-file <line.json>      # heartbeat, one line per batch
kata-cli adversarial finding add --change <task-id> --node verify|review --from-file <finding.json>  # as confirmed
kata-cli adversarial waive  --change <task-id> --node verify|review --reason "<why>"
kata-cli adversarial status --change <task-id>                        # both nodes, plus the heartbeat
```

The brief states the sealed revision, the **round framing** (`verify` lists the author's claims; `cold` withholds them so
the reviewer forms its own hypothesis), the acceptance criteria under test, the sealed evidence with the paths to read it
and the project-declared checks **not** to re-run, a bounded starting set of files to read, and the exact JSON result
shape. It instructs the reviewer to read the repository rather than the brief, to form and run at least one
**falsification attempt per claim**, and to report a finding for every defect it confirmed.

`--since <revision-id>` renders a **delta brief**: the brief names only what changed since that revision, and the gate
then requires the round to cover the whole change surface (`delta_stale` otherwise). `--mode` overrides the framing for one
round; by default it **rotates**, and it will not rotate into `cold` while a `blocking`/`major` finding is unrepaired.

**A pass writes as it goes.** `note` appends one heartbeat line per *batch* of work (not per hypothesis — every separate
invocation is a full turn of the reviewer's own loop, which is what a pass mostly costs), and `finding add` records a
finding the moment it is confirmed. A pass that dies mid-run therefore keeps its work: `status` reports the heartbeat, and
a `record` later in the round keeps the findings that arrived separately. Until `record` runs there is no verdict, so a
partial pass can never read as a passed one.

The gate:

- `kata-cli verify` succeeds only with a recorded pass for the current revision, or an explicit waiver.
- `kata-cli review --approve` likewise — an approval is the review's conclusion.
- A pass recorded against another revision, without the fresh-context attestation, or against a brief kata did not issue
  does not satisfy the gate; `status` reports which of those it was. `brief` stores every brief it hands out, and `record`
  accepts only a hash from that store — a brief it renders but never issued does not count, and neither does one issued for
  another revision. The refusal happens before anything is written, so a bad record cannot damage a good one.
- Findings at `blocking` or `major` severity from the pass stop the node until they are repaired, exactly as reviewer
  findings do.
- A waiver satisfies the gate and is reported as a waiver, never hidden.

`executedInFreshContext`/`contextNote` are attested by the executing agent, in the same way host model confirmation is.
Kata checks everything else: that the pass names this revision, that it answered a brief kata **issued** for this node and
revision, and that it actually attempted something. The scope a delta round is judged against comes from that issued brief,
never from a flag on `record` — so the surface the gate checks is the surface the reviewer was given.

## Evaluation

Run a workflow evaluation:

```bash
kata-cli eval evals/my-manifest.json [--persist report.json]
```

The harness executes every fixture the manifest declares — open, design, a sealed build, a repair round for fixtures that declare repairs, and the Judge's acceptance results for the sealed evidence — and reports what the runs produced next to the expectation each fixture was written against. `--persist` writes the full report, including per-fixture steps, to a JSON file.

### Metrics

| Metric | Description |
|--------|-------------|
| Acceptance pass rate | Judge PASS criteria / total criteria, measured per run |
| Repair rate | Repair rounds recorded in the state log / tasks |
| Latency | Measured milliseconds per fixture |
| Wiki rejection rate | Rejected / (promoted + rejected) |
| Escalation rate, cost per task, tokens | **Not measured.** Model choice, cost and retries belong to the host platform, so the report lists them under `unmeasured` instead of reporting a zero |

## Release gates

Before release, Kata checks:

1. **Acceptance pass rate** >= 80%
2. **Repair rate** <= 1.0 per task
3. **Escalation rate** <= 0.5 per task
4. **Wiki governance** — records present
5. **Wiki rejection rate** <= 50%

All gates must pass for release. A gate whose metric was not measured is reported as `skipped` and does not count
toward the pass/fail total, so "all gates passed" never means "cost was measured".

### Runtime refresh after `update`

`kata-cli update` refreshes the managed runtime (Comet, then the CodeGraph sync and index stages) after the platform
files are written. The refresh is best-effort — it never aborts the update — and which runs is now a policy:

| Flag | Behaviour |
|---|---|
| *(none)* | `auto`: refresh only when the update actually wrote or removed a managed artefact. |
| `--refresh` | `always`: refresh even when nothing changed. Use this to recover a runtime you believe is stale. |
| `--no-refresh` | `never`: leave the runtime alone; the report says it was skipped and why. |

A skipped refresh is reported as `"skipped": true` with a `reason`, not as a silent success and not as a failure.
### Platforms removed by hand

An aggregate `kata-cli update` (no `--platform`) targets every platform the install manifest records, plus every
platform detected in the project. A platform whose own skills directory no longer exists is **skipped**, with the
reason printed:

```text
跳过 opencode：其目录已被移除，更新不再重建（要恢复请用 --platform opencode 显式安装）
```

Deleting `.opencode/` (or `.codex/`, `.cursor/`, …) by hand is how you say you do not want that surface. Without this
rule the manifest entry outlived the deletion and the next aggregate update silently rebuilt the whole directory, so the
decision lasted exactly one command.

Two things this does **not** do:

- It does not touch the explicit path. `kata-cli update --platform opencode` still installs, which is the deliberate way back.
- It does not treat a *partial* deletion as a removal. The probe is the platform's skills directory: if the directory is
  there but individual skills are missing, that is damage and update repairs it. Only the absence of the whole surface
  reads as a decision.

Detection is unchanged: a platform can still be *detected* (Codex reports through the shared `AGENTS.md`, which kata
writes for every platform and which survives removing `.codex`), but detection alone no longer forces a reinstall.


### Payload baseline

`kata-cli baseline [--platform <p>] [--language en|zh] [--change <id>] [--json]` measures what a phase costs before it
runs: the rendered bytes and estimated tokens of each generated Skill, and the size of every authoritative read a
packet requires. Byte counts are exact; token counts are `characters / 4` and are labelled as an estimate. Compare two
baselines taken the same way rather than reading the number as a bill.

## Rollback

```bash
# Dry-run rollback to see what would be removed
kata-cli uninstall --dry-run

# Full rollback — removes only Kata-owned files
kata-cli uninstall

# Re-install after rollback
kata-cli init
```

Rollback preserves:
- User-modified Skill files (reported as conflicts)
- Existing `AGENTS.md` content — Kata removes only its managed block
- `.kata/tasks/` — task history remains readable
- `.kata/evidence/` — evidence envelopes preserved
- `.kata/wiki/` — Wiki records preserved

## Comet management

`kata-cli comet` manages the external `comet` binary (published as `@rpamis/comet` on npm).

The binary is **auto-installed during `kata-cli init`** — no separate install step needed. These subcommands are for post-init diagnostics and manual updates:

| Subcommand | Description |
|------------|-------------|
| `install [--version <ver>]` | Install Comet via `npm install -g @rpamis/comet`. If `--version` is omitted, installs latest. |
| `update` | Check npm for latest version; skip if current matches, otherwise install. |
| `version` | Show compatibility range (`comet-compat.yaml`) and the installed version. |
| `path` | Resolve the `comet` binary location via `which`. |
| `verify` | Check binary exists, is executable, reports a version, and falls within the declared compatibility range. |

### How it works

1. **Package manager**: uses `npm` for global Comet installation, independent of the current project's lockfile.
2. **Installation**: `npm install -g @rpamis/comet@<version>`. The package's `postinstall` script links the `comet` binary.
3. **Version check**: runs `comet --version`, parses semver from stdout.
4. **Compatibility sync**: if the installed version falls outside `comet-compat.yaml`'s `minVersion`–`maxVersion` range, the manifest is automatically updated to match the new version. No manual YAML edits needed.
5. **No download logic in Kata**: Kata delegates binary management entirely to npm; it does not download tarballs, manage `PATH`, or handle permissions. If `npm install -g` requires `sudo`, run it manually and then use `kata-cli comet verify`.

### Typical workflow

```bash
# Check current state
kata-cli comet version
kata-cli comet verify

# Update to latest
kata-cli comet update

# Install a specific version
kata-cli comet install --version 0.4.0-beta.3

# Verify after install
kata-cli comet verify
```

## Optional structural code memory

`kata-cli codegraph` wraps an installed `codegraph` CLI for code intelligence tasks. This is optional: Kata's skills, `.llmwiki`, model routing, hooks, and quality gates continue to work without CodeGraph.

Use this layer for structural code questions such as symbol search, call paths, impact analysis, or affected tests. Treat it as a complement to `.llmwiki`, not as governed project knowledge.

### Subcommands

| Subcommand | Description |
|------------|-------------|
| `explore <query...>` | Explore an area: relevant symbols' source + call paths in one shot |
| `query <search>` | Search for symbols in the codebase |
| `impact <symbol>` | Analyze what code is affected by changing a symbol |
| `affected [files...]` | Find test files affected by changed source files |
| `node [name]` | One symbol's source + caller/callee trail, or read a file with line numbers |
| `status` | Show index status and statistics |
| `index` | Rebuild the full index from scratch |
| `sync` | Sync changes since last index |

### Use in agent skills

CodeGraph may also be available as an MCP tool when a host platform configures it. The `kata-cli codegraph` CLI is useful for non-interactive or deterministic contexts. If the `codegraph` binary is missing, commands return `success: false` with the underlying error.

### Wiki grounding workflow

When a structural index is available, the wiki enrich skill can use it for code grounding:

1. Run `kata-cli codegraph status` to verify an index is available and current.
2. Use `kata-cli codegraph explore <topic>` to find relevant source files.
3. Use `kata-cli codegraph node <file>` to read a source file with line numbers.
4. Use `.llmwiki` and `kata-cli orient` for project rules, decisions, and task context.
5. Use CI/tests/Reviewer/Judge for correctness.

## Smart dispatch

The `/kata` Skill reads the current task phase and recommends the next Skill. The phase-to-Skill mapping is:

| Phase | Next Skill | CLI equivalent |
|-------|-----------|----------------|
| `intake` | `/kata-design` | `kata-cli design --change <id>` |
| `plan` | `/kata-build` | `kata-cli build --change <id>` |
| `implement` | `/kata-build` | `kata-cli build --change <id>` |
| `hardVerify` | `/kata-review` | `kata-cli review --change <id>` |
| `review` | `/kata-judge` | `kata-cli judge --change <id>` |
| `judge` | `/kata-archive` | `kata-cli archive --change <id>` |
| `distill` | `/kata-archive` | `kata-cli archive --change <id>` |
| `archive` | `/kata` (dispatch) | `kata-cli status` |

### Detection

```bash
# Show current phase and next Skill
kata-cli status --change <change-id>

# In a skill-driven same-branch session, use the active task
kata-cli status

# Show next Comet action
kata-cli next --change <change-id>
```

The `status` output includes `nextSkill` (for example `/kata-review` after hard evidence is collected) that maps to the phase column above. If running inside a platform that supports slash commands, invoke the suggested Skill directly; otherwise use the CLI equivalent.

## Workflow diagnostics

Every workflow command returns a JSON envelope. Common fields:

| Field | Type | Description |
|-------|------|-------------|
| `command` | string | The invoked command name |
| `taskId` | string | Change identifier |
| `phase` | string | Current workflow phase (`intake`, `plan`, `implement`, `hardVerify`, `review`, `judge`, `distill`, `archive`) |
| `success` | boolean | Whether the command completed without errors |
| `diagnostics` | object (optional) | Additional diagnostic info; present on success and partial success |
| `error` | string (optional) | Error message; present only when `success` is false |

### Success example

```json
{
  "command": "verify",
  "taskId": "my-change",
  "phase": "judge",
  "success": true,
  "diagnostics": {
    "reviewFindings": 2,
    "judgeResults": "PASS",
    "acceptancePassed": 3,
    "acceptanceTotal": 3,
    "evidenceCollected": ["lint", "typecheck", "test"],
    "message": "All gates passed"
  }
}
```

### Error example

```json
{
  "command": "verify",
  "taskId": "my-change",
  "phase": "hardVerify",
  "success": false,
  "error": "Evidence stale: diff hash changed since collection. Rebuild with 'kata-cli build --change <id>'"
}
```

### Phase transition errors

| Phase | Common errors | Suggested action |
|-------|--------------|------------------|
| `open` | Change already exists, missing template | Use `--force` or specify a new ID |
| `design` | Missing acceptance criteria, invalid schema | Check acceptance format in schemas/ |
| `build` | Evidence collection failed, test failure, type error | Fix reported issues, re-run `kata-cli build` |
| `verify` | Stale evidence, blocking reviewer finding, judge FAIL | Read repair scope in judge output; fix scoped files; `kata-cli build` re-enters bounded repair from `judge` when the FAIL result is repairable, then run `kata-cli verify` |
| `archive` | Missing evidence, judge not PASS, wiki ingest failed | Ensure all gates passed; check wiki source path |
| `hotfix` | Not in hotfix phase, capability not declared | Use normal `open → design → build → verify → archive` flow |
| `tweak` | Change too large for tweak, missing --change | Use `design/build/verify` for non-trivial changes |

### Cross-platform handoff drift

`kata-cli handoff verify` compares the packet's branch, HEAD, and source diff hash with the current
worktree. Agent/runtime artifacts such as `.kata/`, `.codex/`, `.claude/`, `.opencode/`, and
Kata-owned GitHub hook/skill/instruction files are excluded from that source diff hash. A packet
therefore remains valid when another platform only writes receipts, hooks, sessions, or generated
skill wrappers, but still fails with `diff_mismatch` when source, tests, docs, or other project files
change after packet creation.

### Escalation diagnostics

When a verification loop exhausts its retry budget, diagnostics include:

```json
{
  "command": "verify",
  "taskId": "my-change",
  "phase": "hardVerify",
  "success": false,
  "diagnostics": {
    "retriesExhausted": true,
    "repairAttempts": 3,
    "escalationSuggested": true,
    "message": "Escalation triggered. Consider using a higher-tier model for this role or checking the modelPolicy in .kata-config.json."
  }
}
```

After escalation, re-run the phase command with the resolved model tier.


