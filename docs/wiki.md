# Wiki Lifecycle

Kata now has two complementary Wiki layers:

- `.llmwiki/` — Karpathy/Hermes-style markdown knowledge base for project understanding.
- `.kata/wiki/` — governed JSON ledger for provenance, approval, drift, and task evidence.

The boundary is intentional:

> `.llmwiki` helps agents avoid “not understanding the project”; CI, tests, Reviewer, and Judge prevent “the code itself is wrong.”

Structural code-memory tools such as CodeGraph or `codebase-memory-mcp` can make code navigation cheaper, but they are separate from Wiki governance. They help answer code-topology questions; `.llmwiki` preserves project rules, decisions, terminology, and durable agent context.

## Project LLM Wiki

Initialize a project-local markdown wiki from an existing documentation path:

```bash
kata-cli init --wiki-from docs
kata-cli init --wiki-from /path/to/project-docs
```

`kata-cli wiki init --from <path>` remains available as a lower-level command, but the normal project setup path is `kata-cli init`, so the Kata binary manages Skills, project contract files, `.kata/`, and `.llmwiki/` together.

Kata deliberately separates deterministic file governance from LLM synthesis:

- The `kata` binary initializes structure, copies raw sources, computes hashes, emits task packets, lints, verifies drift, and records provenance.
- The `/kata-wiki-enrich` Skill asks the current coding agent to use its own LLM capability to read raw sources and write synthesized concept/entity/comparison pages.
- Kata does not require provider API keys or direct model SDK configuration for Wiki initialization or task packet generation.

This creates:

```text
.llmwiki/
├── SCHEMA.md
├── index.md
├── log.md
├── raw/
│   ├── docs/
│   ├── articles/
│   ├── papers/
│   └── assets/
├── entities/
├── concepts/
├── comparisons/
└── queries/
```

The `raw/docs/` files are copied from the specified path and receive frontmatter:

```yaml
---
source_path: docs/developer/architecture.md
ingested: 2026-07-11T00:00:00.000Z
sha256: <body hash>
---
```

Agents should run orientation before using the Wiki:

```bash
kata-cli wiki orient
```

Orientation reads `SCHEMA.md`, `index.md`, and the recent `log.md`, matching the Hermes LLM Wiki rule that an agent must orient before ingesting, querying, or linting.

For day-to-day governed coding, prefer the higher-level project orientation command:

```bash
kata-cli orient --change <change-id> --role implementer --task-kind implementation
```

It includes the `.llmwiki` entry files in `requiredReads` and also returns the current role guard instructions, model route, and next suggested `/kata-*` Skill. Use `kata-cli wiki orient` when you only need the Wiki layer; use `kata-cli orient` when an agent is about to work on a Kata task.

Health check the Wiki:

```bash
kata-cli wiki lint
```

Ask the coding agent to perform LLM-assisted enrichment through a deterministic task packet:

```bash
kata-cli wiki task --kind enrich --from docs
```

The task packet returns `requiredReads`, `writeTargets`, `instructions`, and `followupCommands`. Use `/kata-wiki-enrich` in Codex, Claude Code, OpenCode, or another AI coding tool to perform the synthesis work, then run the returned deterministic checks.

The lint pass checks:

- required structure (`SCHEMA.md`, `index.md`, `log.md`, and required directories)
- raw-source hash drift
- missing page frontmatter
- broken wikilinks
- pages missing from `index.md`
- orphan pages with no inbound links

Incrementally ingest new sources:

```bash
kata-cli wiki ingest --from docs/runtime.md
kata-cli wiki ingest --from docs/developer
```

Ingest copies supported sources (`.md`, `.mdx`, `.txt`) into `raw/docs/`, creates deterministic summary pages in `concepts/`, updates `index.md` and `log.md`, and creates matching `.kata/wiki` candidate records with source hashes.

Query compiled Wiki pages:

```bash
kata-cli wiki query --q "How does the runtime bootstrap work?"
kata-cli wiki query --q "Compare API and worker responsibilities" --file
```

Queries search the compiled markdown pages, return citations such as `[[concepts/runtime.md]]`, and `--file` stores valuable answers under `queries/` so exploration compounds into the Wiki.

## Conversation capture covenant

Kata does **not** dump ordinary chat logs into `.llmwiki`. Conversation is noisy, often speculative, and can quickly pollute future context.

Skills capture conversation-derived knowledge only when the user gives a clear durable-knowledge signal, for example:

- “记住这个”
- “沉淀到 wiki”
- “以后都按这个”
- “record this rule”
- “add to wiki”

When triggered, the agent should:

1. Convert the conversation point into a short source note with date, task id, source context, rule/decision, rationale, and scope.
2. Prefer `.kata/tasks/<task-id>/wiki-notes/` for task-owned notes.
3. Use `docs/conventions/` for durable project-wide conventions.
4. Ingest/register the note as a governed Wiki candidate.
5. Leave promotion to the normal review/promotion path.

Do not promote directly from chat. Conversation-derived records are candidates until reviewed, promoted, or rejected.

## Governed Wiki records

The Kata governed Wiki stores project understanding with full provenance — source references, content hashes, validation task IDs, and evidence links.

## Record structure

Wiki records are JSON files in `.kata/wiki/`:

```json
{
  "id": "wiki-task-42",
  "statement": "Payment processing uses Stripe API.",
  "scope": ["src/payment/"],
  "kind": "architecture-decision",
  "sourceRefs": ["src/payment/service.ts", "docs/adr/003-payment.md"],
  "sourceHashes": {
    "src/payment/service.ts": "abc123...",
    "docs/adr/003-payment.md": "def456..."
  },
  "validationTaskId": "task-42",
  "evidenceIds": ["evidence-task-42-hard"],
  "status": "candidate",
  "lastVerifiedAt": "",
  "createdAt": "2026-07-11T12:00:00.000Z",
  "updatedAt": "2026-07-11T12:00:00.000Z"
}
```

## Status lifecycle

```
candidate ──promote──► verified ──drift──► stale
    │                      │
    └──reject──► rejected  └──reject──► rejected
```

- **candidate** — generated from a passed task; not authoritative
- **verified** — approved via explicit promotion; used in context selection
- **stale** — source files changed or missing; cannot be used as authoritative
- **rejected** — explicitly rejected; archived for audit

## Candidate generation

Wiki candidates are generated only from tasks that passed all quality gates (hard evidence + reviewer clearance + Judge PASS). Generating a candidate from a failed or incomplete task throws an error.

LLM Wiki ingest also creates `.kata/wiki` records, but those records are `candidate` status and exist to track provenance of project-understanding pages. They are not proof of code correctness and must still be promoted/rejected through the governed lifecycle before becoming authoritative context.

```bash
# (called automatically during workflow)
kata-cli wiki propose <task-id>
```

## Drift detection

Run `wiki verify` to check all Wiki records against current source files:

```bash
kata-cli wiki verify
```

Records whose source hashes no longer match current file content are marked `stale`. Missing files also trigger stale marking.

## Conflict detection

Kata checks Wiki candidates against:

- Approved rules in `.kata/rules/`
- Spec documents in `docs/superpowers/specs/`
- Test assertions in `tests/`
- Source code referenced by the record

Conflicts route the task to `needs-clarification` for human review.

## Promotion

Promoting a candidate to verified requires an explicit approval event:

```bash
# Promote a Wiki candidate
kata-cli wiki promote <wiki-id> --by <reviewer> --role <role>
```

Promotion guards:
- Only `candidate` records can be promoted
- Non-existent records are rejected
- Records must pass conflict check
- Requires `reviewer` or `approver` role

## Context selection

When building task context, only `verified` Wiki records with matching source references or scope are included. Non-authoritative records (candidate, stale, rejected) are excluded, and warnings are emitted for stale source references.

## Fact priority

```
approved policy/ADR/contract
  > executable tests and CI evidence
  > current implementation behavior
  > verified Wiki (helpful but not proof)
  > candidate Wiki / agent summary (never authoritative)
```
