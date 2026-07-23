---
name: kata-wiki-enrich
description: Uses the coding agent LLM capability to enrich .llmwiki from deterministic Kata task packets. Use when initializing, enriching, linting, or distilling project wiki knowledge.
---

# /kata-wiki-enrich

platform: codex


Use this skill to inspect the Kata wiki-enrich workflow entrypoint.

## Skill-first operating rule

Prefer the `/kata-wiki-enrich` Skill as the human-facing interface. Use `kata wiki task --kind enrich` as the deterministic fallback inside the Skill or in non-interactive scripts. If the user passes an explicit task id (e.g. "/kata-build my-task"), use it as the immutable anchor for all subsequent operations; do not re-discover via `kata status` or same-branch resolution. If the user gives a short instruction, natural-language hint, or no parameters, discover the active/same-branch task with `kata status`, follow relation redirects, and ask for a concise confirmation only when multiple choices remain.

## Startup checklist

Before doing task work, run the project orientation command:

```bash
kata status
kata orient --role <designer|implementer|reviewer|judge|distiller> --platform codex --task-kind <read|implementation|security>
kata hooks activate --change <change-id> --role <designer|implementer|reviewer|judge|distiller> --platform codex
```

Treat skill use as an interactive agent workflow, not a parameter-only command. First discover the active or same-branch task and any relation redirects; if the task, role, task kind, or target platform is ambiguous, present concise options and ask the user to confirm or type a value. Do not make the user remember command-line flags. After confirmation, run `kata orient` with the resolved values, then read the returned task, state, context, required files, guard instructions, relation redirects, and next skill before editing. The hook activation links platform write hooks to the active Kata task so phase/role scope is enforced while you work.

## Phase-boundary pause

Treat `nextAction.requiresUserConfirmation=true` as a hard stop. Do not invoke the next /kata-* skill automatically. At model trust boundaries, stop so the user can use the host platform's own model selector before continuing. Kata has no model routing configuration or route artifact.

This is mandatory at trust boundaries:

- `implementation_gate`: stop after design and before the first build; a platform-neutral handoff packet is already available for any receiving platform.
- `review_gate`: stop after /kata-verify passes before /kata-review.
- `judge_gate`: stop after review before /kata-judge.
- `archive_gate`: stop after judge before /kata-archive.

## CodeGraph-assisted code search

After reading required context and before broad file scans, use CodeGraph when code understanding, impact analysis, or test targeting is needed:

```bash
kata codegraph status
kata codegraph explore "<feature, symbol, module, or error>"
kata codegraph impact "<symbol-or-file>"
kata codegraph affected <changed-file>...
```

Use CodeGraph to find likely source files, call paths, dependents, and affected tests. Then verify with direct file reads and focused `rg` searches before editing or reviewing. If CodeGraph is unavailable or stale, note the fallback and use `rg` plus requiredReads; do not block the workflow solely on CodeGraph.

## Portable context handoff

Before accepting work from another agent or platform, create or verify the canonical repository packet, read every path in its requiredReads field, then acknowledge the packet with the actual platform and role.

Run kata handoff verify --task <change-id> --id <handoff-id>, kata handoff show --task <change-id> --id <handoff-id>, then kata handoff acknowledge --task <change-id> --id <handoff-id> --platform codex --role <role>.

The packet's allowed writes and guard instructions are authoritative. Model selection belongs to the host platform and never bypasses CI, tests, Reviewer, or Judge.



```json kata-command-manifest
{
  "id": "kata-wiki-enrich",
  "slashCommand": "/kata-wiki-enrich",
  "cli": "kata wiki task --kind enrich",
  "phase": "wiki-enrich",
  "summary": "Uses the coding agent LLM capability to enrich .llmwiki from deterministic Kata task packets. Use when initializing, enriching, linting, or distilling project wiki knowledge."
}
```

## Trigger scenarios

- User asks to initialize or enrich .llmwiki from project docs.
- Agent needs to turn raw docs into durable concepts/entities/comparisons.
- Project knowledge should be captured without Kata binary calling model APIs.

## Input signals

Keywords and intents that should trigger this skill:

- `llmwiki`
- `wiki`
- `knowledge`
- `enrich`
- `distill`
- `初始化 wiki`
- `知识沉淀`
- `项目上下文`

## Output goals

- Read deterministic wiki task packets.
- Synthesize project knowledge into governed wiki pages.
- Run lint/verify and keep code correctness responsibility with CI/tests/reviewer/judge.

## Invocation

```bash
kata wiki task --kind enrich
```

The invocation is the deterministic CLI fallback for scripts and CI. In normal agent use, prefer conversation: discover candidates, recommend defaults, ask for confirmation, then run the resolved command.

## Guard enforcement

guard enforcement: CLI/CI-only

## Host model selection

Kata does not configure or route host-platform models. If this phase needs a different model, use the host platform's own selector before continuing; model choice is outside Kata state and does not create a route artifact.

请在当前平台的模型选择器或平台配置中完成切换，然后继续本次 Kata 命令。

## Coding-agent Wiki enrichment

This skill is where LLM work happens. Kata binary does **not** call model provider APIs for Wiki enrichment; it emits a deterministic task packet and the current coding agent performs reading, synthesis, and file edits.

1. Get the task packet:
   ```bash
   kata wiki task --kind enrich --from docs
   ```

   Do not guess Wiki CLI subcommands. Run `kata wiki --help` when discovery is needed. `kata wiki propose` is only a compatibility alias for the enrich task packet; it neither creates a governed record nor promotes knowledge. Use `kata wiki candidate` to inspect pending records.

2. Read every path in `requiredReads`, especially:
   - `.llmwiki/SCHEMA.md`
   - `.llmwiki/index.md`
   - `.llmwiki/log.md`
   - `.llmwiki/raw/docs/**`

3. **Ground every claim in source code.** `raw/docs/` are historical design docs — they may be outdated or differ from what was built. Before writing a page, read the actual source under `packages/` (`ports/`, `domains/`, `infrastructure/`, `adapters/`) to verify each architecture claim, method signature, file path, and table name. If source and design doc disagree, source wins.

4. As the coding agent, synthesize durable project knowledge:
   - concepts: architecture, workflow, invariants, conventions
   - entities: modules, services, commands, schemas
   - comparisons: alternatives and tradeoffs
   - queries: reusable answers worth filing
   - conversation-derived decisions only when the user explicitly asked to remember/capture them, or when they are stable task outcomes backed by files/evidence

5. Conversation capture covenant:
   - Trigger on clear user intents such as “记住这个”, “沉淀到 wiki”, “以后都按这个”, “record this rule”, “add to wiki”.
   - Convert the conversation point into a short source note with date, task id, source context, rule/decision, rationale, and scope.
   - Prefer task-owned notes under `.kata/tasks/<task-id>/wiki-notes/` or durable notes under `docs/conventions/`; then ingest/register them as candidates.
   - If the point is ambiguous, ask one short confirmation question before writing.
   - Never promote directly from chat; candidates need normal review/promotion.

6. Write only to task packet `writeTargets` such as `.llmwiki/concepts/`, `.llmwiki/entities/`, and `.llmwiki/comparisons/`. Do not edit `.llmwiki/raw/` manually.

7. Run deterministic checks:
   ```bash
   kata wiki lint
   kata wiki verify
   ```

8. Register synthesized pages as governed candidate records:
   ```bash
   kata wiki register
   ```

9. Complete the mandatory knowledge-closure decision before `/kata-verify` and `/kata-archive`. Decide it yourself from the task design, acceptance, source changes, and candidate records: reusable capability/rule/convention means `captured`; a local mechanical change with no durable knowledge means `not_applicable`. Create and register a grounded candidate before choosing `captured`. Only ask the user when those artifacts are genuinely ambiguous or contradictory. Never invoke bare `kata wiki closure` merely to make the user classify the task; always pass the selected decision and concrete reason:
   ```bash
   kata wiki closure --task <task-id> --decision captured --reason "<durable rule>" --candidate <wiki-id>
   kata wiki closure --task <task-id> --decision not_applicable --reason "<why no reusable knowledge changed>"
   ```

The Wiki helps future agents understand the project. It does not prove code correctness; CI, tests, Reviewer, and Judge own correctness.