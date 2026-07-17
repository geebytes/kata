# Kata Usage Guide

This guide describes the normal project workflow after `kata init`.

Kata has one north star:

> Wiki helps agents avoid project-context mistakes; CI, tests, Reviewer, and Judge prevent code-correctness mistakes.

## 1. Bootstrap a project

```bash
cd your-project
kata init
kata doctor
```

In an interactive terminal, `kata init` uses a Comet-style selectable wizard for language, install scope, and detected platforms. In automation, use:

```bash
kata init --yes
```

The initializer installs Kata skills/rules/hooks for detected coding tools, initializes `.kata/`, and initializes `.llmwiki/` from `docs/` when present. Comet project initialization is coordinated from the same command.

The selected language is also an agent response contract. If `kata init` selected `中文`, generated Skills and project rules require all user-facing natural-language responses to use Chinese. Kata persists the selection in `.kata-config.json`, so later `kata update` runs reuse it without requiring `--language zh`. This is separate from model routing; Kata does not call an LLM API to enforce it, but every installed Skill tells the coding agent how to respond.

## 2. Start work through a skill

Use the installed slash commands from your coding tool:

```text
/kata-open <change-id>
/kata-design <change-id>
/kata-build <change-id>
/kata-verify <change-id>
/kata-review <change-id>
/kata-judge <change-id>
/kata-archive <change-id>
```

Kata separates target, control, evidence, and execution units:

| Unit | Purpose | Owns workflow state? |
| --- | --- | --- |
| Change | User goal, scope, release/theme container | No; derived from tasks |
| Task | Smallest governed workflow unit | Yes: `taskId + phase` |
| Artifact | Evidence, review, judge, handoff, model route, Wiki candidate | No; influences task `nextAction` |
| Step | Agent-local execution plan item | No; not cross-platform state |

The workflow control unit is the smallest object that can be independently accepted, handed off, verified, reviewed, judged, and archived: the **Task**. Change status should be computed from its tasks rather than driving `/kata-build`, `/kata-review`, or `/kata-judge` directly.

Inside one Git branch, later skill invocations may omit the change id after activation:

```text
/kata-build
/kata-review
```

The skill should resolve the task id in this order: explicit skill input first, then `kata status` for the same-branch active task, then same-branch task discovery. If exactly one task is discovered, the skill may continue without asking. If multiple same-branch tasks exist, `kata status` returns `candidates` plus a `recommended` action derived from upstream artifacts such as `review.json`, `judge.json`, and evidence envelopes; the agent should ask the user to confirm the recommendation instead of asking them to remember a change id.

When an accidental placeholder task, parallel change, or follow-up task is covered by another governed task, record the relationship instead of asking future agents to guess:

```bash
kata tasks relate \
  --from fix-code-style-arch-boundaries \
  --to repair-code-standards-boundaries \
  --type covered_by \
  --reason "covered by the specific repair task"
```

Terminal relation types are `covered_by`, `superseded_by`, `duplicate_of`, and `merged_into`. `kata status --change <source>` and `kata orient --change <source>` follow those relations to the target task and include `relationRedirects`. Non-terminal relation types such as `parent_of`, `spawned_from`, and `related_to` document lineage without redirecting workflow.

For relations across changes and tasks, use the generic graph:

```bash
# Change owns or groups a task. This documents ownership; it does not change task workflow control.
kata relations add \
  --from change:full-chain-quality-optimization \
  --to task:repair-code-standards-boundaries \
  --type contains \
  --reason "change contains this repair task"

# Change-to-change replacement.
kata relations add \
  --from change:old-quality-plan \
  --to change:full-chain-quality-optimization \
  --type superseded_by

kata relations show --id change:full-chain-quality-optimization
```

Think of Kata relations as four edge classes:

- Ownership edges (`contains`, `implements`) organize goals and tasks.
- Lineage edges (`parent_of`, `spawned_from`, `repairs`) explain where a task came from.
- Control edges (`covered_by`, `superseded_by`, `duplicate_of`, `merged_into`, `depends_on`, `blocked_by`) affect scheduling; task-to-task terminal control edges are followed by `status`/`orient`.
- Context edges (`related_to`) enrich orientation but do not redirect workflow.

Every non-trivial agent session should begin with:

```bash
kata status
kata orient --role implementer --platform <platform> --task-kind implementation
kata hooks activate --change <change-id> --role implementer --platform <platform>
```

`kata status` is not just a phase check. It first uses a same-branch active task; if none exists, it inspects non-archived Kata tasks created on the current Git branch. With one task it returns the change id, phase, next skill, task title, acceptance criteria, required reads, and Wiki/context summary. The returned `nextSkill` is artifact-aware: if a task is in `review` but `review.json` contains blocking findings, `nextSkill` becomes `/kata-build` with `recommended.reason = repair_blocking_review_findings`; the raw phase mapping remains available as `phaseNextSkill = /kata-judge`. The output also includes `nextAction.slashCommand` and `nextAction.cliCommand`, for example `/kata-build repair-code-standards-boundaries` and `kata build --change repair-code-standards-boundaries`. Skills should show the slash command first and use the CLI command only as a fallback for non-interactive environments. With multiple tasks it returns dispatch candidates ordered by urgency: blocking review findings, failed Judge repair scopes, failing evidence, `hardVerify` awaiting review, `review` awaiting Judge, then ordinary build/design work.

When `/kata-build` is invoked from `review` with blocking findings, Kata records a repair re-entry:

```text
review → implement → hardVerify
```

The re-entry is written to `state-events.jsonl`, `current-state.json`, and `.kata/tasks/<id>/repair.json`. After the repair build reaches `hardVerify`, old blocking review findings are treated as stale for dispatch; the next action becomes `/kata-review` for a fresh independent review.

For cross-platform repair, this enables short prompts. In OpenCode, Claude Code, Copilot, or Codex, a user can type:

```text
/kata
```

or:

```text
/kata-collect
```

The skill runs `kata status` or `kata collect`, reads the recommended task, and asks for a short confirmation such as “发现上游 blocking review findings，建议作为 implementer repair，是否开始？”. After confirmation it runs `kata orient` for the recommended role and proceeds with the matching `/kata-*` skill. If a skill was invoked with an explicit task id, pass that id to `kata orient --change <change-id>`.

Read the files returned in `requiredReads` before editing. The important ones are usually:

- `AGENTS.md`
- `.kata/skills-index.md`
- `.llmwiki/SCHEMA.md`
- `.llmwiki/index.md`
- `.llmwiki/log.md`

## 3. Hand work to any coding platform

Kata shares context through repository artifacts, not through a platform's chat history. The first version supports handoff only inside the **same Git worktree and branch**.

For `/kata-build`, `/kata-review`, `/kata-judge`, `/kata-verify`, and `/kata-archive`, the installed Skill performs this handoff sequence itself. Users normally do not run the commands below; they are provided for CI, a generic tool, or troubleshooting.

Before another platform or role takes over, create a packet:

```bash
# The current implementer hands the task to a reviewer.
kata handoff create --task <change-id> --from implementer --to reviewer --platform opencode

# The receiving agent verifies the same HEAD, branch and diff, then reads all paths in requiredReads.
kata handoff verify --task <change-id> --id <handoff-id>
kata handoff show --task <change-id> --id <handoff-id>

# It records the platform and role that actually accepted the packet.
kata handoff acknowledge --task <change-id> --id <handoff-id> \
  --platform github-copilot --role reviewer
```

The packet contains task acceptance criteria, authoritative Wiki context, evidence and prior artifact paths, Git anchors, and allowed writes. If HEAD, branch, or working-tree diff changes, `handoff verify` returns `valid: false`; create a fresh packet before handing work onward.

`handoff acknowledge` also writes the receiving task, role, platform, branch, and origin into `.kata/runtime/active-task.json`. After acknowledgement, the receiving platform can usually run `/kata-build` or `kata status` without repeating the task id. If no active task exists and exactly one unfinished same-branch task is present, `kata status` auto-activates it with the next suggested role. If multiple unfinished tasks exist, Kata still returns candidates and a recommendation instead of guessing.

This works equally for Codex, OpenCode, GitHub Copilot, Claude Code, and the generic adapter. The receiver must use the packet rather than relying on a prior agent's summary.

### Trust-boundary pauses

Kata skills automate the current phase, not the whole lifecycle. When `kata status` or `kata orient` returns `nextAction.requiresUserConfirmation: true`, the agent must stop and ask the user before invoking the next `/kata-*` skill.

Every phase command result also returns the next operation. After `/kata-build repair-code-standards-boundaries`, for example, the command result includes `nextAction.slashCommand` such as `/kata-verify repair-code-standards-boundaries` and `nextAction.cliCommand` such as `kata verify --change repair-code-standards-boundaries`. Skills must show the slash command to the user before stopping, even when no model/platform switch is required.

This protects the points where users often want to switch model tier or platform:

| Boundary | When it appears | Required user choice |
| --- | --- | --- |
| `review_gate` | after `/kata-verify` passes | keep current reviewer platform/model, or switch |
| `judge_gate` | after `/kata-review` reaches `review` | keep current Judge platform/model, or switch to higher trust |
| `archive_gate` | after Judge reaches `judge`/`distill` | archive now, enrich Wiki first, or collect more evidence |

`/kata-judge` also enforces this at the command layer: it refuses to run directly from `hardVerify`. Run `/kata-verify` and `/kata-review` first, then choose where Judge should run.

## 4. Use Wiki as project memory, not correctness proof

Initialize or refresh raw Wiki inputs:

```bash
kata wiki init --from docs
kata wiki ingest --from docs/developer
kata wiki lint
kata wiki verify
```

When synthesis needs LLM judgment, do not configure model keys in the Kata binary. Ask the coding agent to use the installed skill:

```bash
kata wiki task --kind enrich --from docs
```

Then invoke `/kata-wiki-enrich` and let the agent write concept/entity/comparison/query pages under the packet's `writeTargets`. After that, run the deterministic follow-up commands from the packet.

Conversation is not automatically copied into the Wiki. Skills only capture conversation-derived knowledge when the user gives a durable-knowledge signal such as “记住这个”, “沉淀到 wiki”, “以后都按这个”, “record this rule”, or “add to wiki”. The agent should convert the point into a short source note, ingest/register it as a Wiki candidate, and leave promotion to the normal governed review path.

## 5. Model policy (optional)

Kata's model policy is declarative, not command-driven. Edit `.kata-config.json` directly to configure model tiers, role minimums, and escalation rules:

```json
{
  "modelPolicy": {
    "defaultTier": "economy",
    "tiers": ["economy", "capable", "frontier"],
    "defaultSelection": "current",
    "repairLimit": 2,
    "roles": {
      "implementer": { "tier": "economy" },
      "reviewer": { "tier": "capable" },
      "judge": { "tier": "frontier" }
    }
  }
}
```

Kata does not own model selection or switch models automatically. At trust boundaries (`review_gate`, `judge_gate`), it pauses so the user can choose the model in their host platform's own selector before continuing. Kata records only that the user was asked; it does not record which model was used.

Model selection is always the user's decision. A configured tier is an advisory minimum — Kata will not refuse work because a particular model was not selected. Correctness still belongs to evidence, Reviewer, and Judge.

## 6. Verify before archive

The normal correctness chain is:

```text
implementation
  → hard evidence: lint/typecheck/test/CI/security
  → reviewer findings
  → judge result
  → Wiki candidate
  → archive
```

Wiki entries become durable project knowledge only after promotion:

```bash
kata wiki promote <wiki-id> --by <reviewer> --role reviewer
```

## 7. Optional structural code memory

Structural code-memory tools such as CodeGraph or `codebase-memory-mcp` are useful companions for navigating large repositories. They answer questions like “who calls this symbol?” or “what files are affected?” much more cheaply than repeated grep/read loops.

They are not a replacement for `.llmwiki`:

- structural index: current code topology and impact analysis
- `.llmwiki`: project rules, decisions, terminology, workflows, and durable context
- CI/tests/Reviewer/Judge: correctness gates

When a `codegraph` CLI is available, Kata exposes convenience wrappers:

```bash
kata codegraph status
kata codegraph explore "runtime bootstrap"
kata codegraph impact "createTask"
```

Every generated `/kata-*` skill now includes the same CodeGraph-assisted search contract. After orientation and required context reads, agents should use CodeGraph before broad repository scans when they need code understanding, impact analysis, or affected-test targeting. CodeGraph results are hints, not proof: agents must still verify with direct file reads, focused `rg`, and the normal CI/test/Reviewer/Judge gates. If CodeGraph is unavailable or stale, the skill should record the fallback and continue with repository search.

If no structural index tool is installed, Kata still works; use normal repository search and keep the Wiki/governance loop unchanged.

## 8. Leave the guarded session

After archive or when switching away from Kata-governed work:

```bash
kata hooks deactivate
```
