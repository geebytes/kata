# Operations

## CLI reference

| Command | Description |
|---------|-------------|
| `kata init` | Unified setup: coordinates Comet init and installs Kata Skills/rules/hooks/Wiki for detected platforms. Silent on success unless `--json` is passed |
| `kata update` | Update installed Skills. Silent on success unless `--json` is passed |
| `kata uninstall` | Remove installed Skills. Silent on success unless `--json` is passed |
| `kata discover` | List detected platforms |
| `kata doctor [--platform <name>]` | Verify installed skills, rules, hooks, command bridges, and Wiki presence. Without `--platform`, checks all detected project platforms |
| `kata orient --change <id>` | Aggregate project constraints, LLM Wiki entrypoints, model route, handoff guards, and next suggested Skill |
| `kata handoff create --task <id> --from <role> --to <role>` | Create a platform-neutral context packet for the same Git worktree and branch |
| `kata handoff show --task <id> --id <handoff-id>` | Print the packet and its required reads, evidence and permissions |
| `kata handoff verify --task <id> --id <handoff-id>` | Verify packet Git anchors against the current worktree |
| `kata handoff acknowledge --task <id> --id <handoff-id> --platform <name> --role <role>` | Record the receiving platform and role after it has read the packet |
| `kata hooks activate --change <id> --role <role>` | Bind platform write hooks to the active Kata task and role |
| `kata hooks status` | Show the active hook task, if any |
| `kata hooks deactivate` | Clear active hook task scope |
| `kata status <change>` | Show Comet change status |
| `kata next <change>` | Show next Comet action |
| `kata eval <manifest>` | Run evaluation from manifest |
| `kata comet install [--version <ver>]` | Install or update Comet binary via npm |
| `kata comet update` | Update Comet to latest npm version |
| `kata comet version` | Show compatibility range and installed version |
| `kata comet path` | Resolve Comet binary location |
| `kata comet verify` | Check Comet binary exists, is executable, and is compatible |
| `kata codegraph explore <query...>` | Explore code via CodeGraph: source + call paths in one shot |
| `kata codegraph query <search>` | Search for symbols in the codebase |
| `kata codegraph impact <symbol>` | Analyze what code is affected by changing a symbol |
| `kata codegraph affected [files...]` | Find test files affected by changed source files |
| `kata codegraph node [name]` | One symbol's source + caller/callee trail |
| `kata codegraph status` | Show CodeGraph index status and statistics |
| `kata codegraph index` | Rebuild the full CodeGraph index from scratch |
| `kata codegraph sync` | Sync changes since last CodeGraph index |

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
kata orient --change <change-id> --role implementer --task-kind implementation
kata hooks activate --change <change-id> --role implementer
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
4. `kata hooks activate` makes platform hooks enforce phase/role write scope.
5. The `orient` output tells the adapter which tier each role defaults to from `.kata-config.json`. Model selection is always the user's decision in their host platform.
6. CLI gates, CI/tests, Reviewer, and Judge enforce correctness.

## Cross-platform handoff

Use a handoff when work changes from one platform or role to another. It does not transfer chat history and does not require the two tools to share a provider or model.

```bash
kata handoff create --task auth-hardening --from implementer --to reviewer --platform opencode
kata handoff verify --task auth-hardening --id handoff-<id>
kata handoff acknowledge --task auth-hardening --id handoff-<id> \
  --platform codex --role reviewer
```

Packets are valid only in the worktree and branch where they were created. A changed HEAD, branch, or diff hash invalidates the packet. Regenerate it after an implementation change; a receipt records that an agent accepted context, not that code is correct.

After `handoff acknowledge`, the receiving task becomes the local active task. That means a low-tier implementer can normally continue with:

```bash
kata status
kata build
```

without repeating `--change <id>`. When multiple unfinished same-branch tasks exist, Kata does not guess; `kata status` returns candidates and a recommended next action for the skill/user to confirm.

After archive or when leaving Kata-governed work, clear the active hook:

```bash
kata hooks deactivate
```

## Coding-agent Wiki enrichment

LLM-assisted Wiki work is skill-driven, not binary-driven. The Kata binary emits deterministic task packets:

```bash
kata wiki task --kind enrich --from docs
```

Then the installed `/kata-wiki-enrich` Skill uses the current coding agent's LLM capability to read `requiredReads` and write synthesized pages under the packet's `writeTargets`. After the agent writes pages, run the packet's deterministic follow-up commands such as `kata wiki lint` and `kata wiki verify`.

Conversation-derived knowledge is captured only when the user explicitly asks to remember or sediment it, such as “记住这个”, “沉淀到 wiki”, “以后都按这个”, “record this rule”, or “add to wiki”. The agent writes a short source note, ingests/registers it as a candidate, and does not promote it directly.

## Quality gates

The verification pipeline enforces strict ordering:

1. **Model route artifact** — configured reviewer/judge routes are recorded before role transitions, including both recommendation and user/agent decision
2. **Hard evidence** — lint, typecheck, test, CI, security
3. **Evidence freshness** — diff hash must match current project state
4. **Reviewer clearance** — no blocking findings
5. **Judge PASS** — all acceptance criteria pass
6. **Wiki candidate** — only from passed tasks

Any gate failure returns the task to bounded repair. Blocking reviewer findings in `review.json` route the task back through `/kata-build`, which records `review → implement → hardVerify` in `state-events.jsonl` and `.kata/tasks/<id>/repair.json`. Judge FAIL follows the same repair discipline from `judge → implement → hardVerify`.

## Evaluation

Run a workflow evaluation:

```bash
kata eval evals/my-manifest.json
```

This produces a report with metrics and release gate results.

### Metrics

| Metric | Description |
|--------|-------------|
| Acceptance pass rate | Passed / total acceptance criteria |
| Repair rate | Average repairs per task |
| Escalation rate | Average escalations per task |
| Cost per task | Average cost credits |
| Latency | Average milliseconds per task |
| Wiki rejection rate | Rejected / (promoted + rejected) |

## Release gates

Before release, Kata checks:

1. **Acceptance pass rate** >= 80%
2. **Repair rate** <= 1.0 per task
3. **Escalation rate** <= 0.5 per task
4. **Wiki governance** — records present
5. **Wiki rejection rate** <= 50%

All gates must pass for release.

## Rollback

```bash
# Dry-run rollback to see what would be removed
kata uninstall --dry-run

# Full rollback — removes only Kata-owned files
kata uninstall

# Re-install after rollback
kata init
```

Rollback preserves:
- User-modified Skill files (reported as conflicts)
- Existing `AGENTS.md` content — Kata removes only its managed block
- `.kata/tasks/` — task history remains readable
- `.kata/evidence/` — evidence envelopes preserved
- `.kata/wiki/` — Wiki records preserved

## Comet management

`kata comet` manages the external `comet` binary (published as `@rpamis/comet` on npm).

The binary is **auto-installed during `kata init`** — no separate install step needed. These subcommands are for post-init diagnostics and manual updates:

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
5. **No download logic in Kata**: Kata delegates binary management entirely to npm; it does not download tarballs, manage `PATH`, or handle permissions. If `npm install -g` requires `sudo`, run it manually and then use `kata comet verify`.

### Typical workflow

```bash
# Check current state
kata comet version
kata comet verify

# Update to latest
kata comet update

# Install a specific version
kata comet install --version 0.4.0-beta.3

# Verify after install
kata comet verify
```

## Optional structural code memory

`kata codegraph` wraps an installed `codegraph` CLI for code intelligence tasks. This is optional: Kata's skills, `.llmwiki`, model routing, hooks, and quality gates continue to work without CodeGraph.

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

CodeGraph may also be available as an MCP tool when a host platform configures it. The `kata codegraph` CLI is useful for non-interactive or deterministic contexts. If the `codegraph` binary is missing, commands return `success: false` with the underlying error.

### Wiki grounding workflow

When a structural index is available, the wiki enrich skill can use it for code grounding:

1. Run `kata codegraph status` to verify an index is available and current.
2. Use `kata codegraph explore <topic>` to find relevant source files.
3. Use `kata codegraph node <file>` to read a source file with line numbers.
4. Use `.llmwiki` and `kata orient` for project rules, decisions, and task context.
5. Use CI/tests/Reviewer/Judge for correctness.

## Smart dispatch

The `/kata` Skill reads the current task phase and recommends the next Skill. The phase-to-Skill mapping is:

| Phase | Next Skill | CLI equivalent |
|-------|-----------|----------------|
| `intake` | `/kata-design` | `kata design --change <id>` |
| `plan` | `/kata-build` | `kata build --change <id>` |
| `implement` | `/kata-build` | `kata build --change <id>` |
| `hardVerify` | `/kata-review` | `kata review --change <id>` |
| `review` | `/kata-judge` | `kata judge --change <id>` |
| `judge` | `/kata-archive` | `kata archive --change <id>` |
| `distill` | `/kata-archive` | `kata archive --change <id>` |
| `archive` | `/kata` (dispatch) | `kata status` |

### Detection

```bash
# Show current phase and next Skill
kata status --change <change-id>

# In a skill-driven same-branch session, use the active task
kata status

# Show next Comet action
kata next --change <change-id>
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
  "error": "Evidence stale: diff hash changed since collection. Rebuild with 'kata build --change <id>'"
}
```

### Phase transition errors

| Phase | Common errors | Suggested action |
|-------|--------------|------------------|
| `open` | Change already exists, missing template | Use `--force` or specify a new ID |
| `design` | Missing acceptance criteria, invalid schema | Check acceptance format in schemas/ |
| `build` | Evidence collection failed, test failure, type error | Fix reported issues, re-run `kata build` |
| `verify` | Stale evidence, blocking reviewer finding, judge FAIL | Read repair scope in judge output; fix scoped files; `kata build` re-enters bounded repair from `judge` when the FAIL result is repairable, then run `kata verify` |
| `archive` | Missing evidence, judge not PASS, wiki ingest failed | Ensure all gates passed; check wiki source path |
| `hotfix` | Not in hotfix phase, capability not declared | Use normal `open → design → build → verify → archive` flow |
| `tweak` | Change too large for tweak, missing --change | Use `design/build/verify` for non-trivial changes |

### Cross-platform handoff drift

`kata handoff verify` compares the packet's branch, HEAD, and source diff hash with the current
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
