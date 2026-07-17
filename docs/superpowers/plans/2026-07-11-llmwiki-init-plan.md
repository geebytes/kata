# Governed LLM Wiki Initialization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a project-local `.llmwiki` markdown knowledge base that can be initialized from a specified documentation path, incrementally ingested, queried, linted, and linked to governed Kata Wiki records.

**Architecture:** Keep `.llmwiki/` as the human/agent-readable markdown wiki layer and `.kata/wiki/` as the governed JSON provenance/status ledger. The slice creates `.llmwiki` structure, imports source documents into immutable `raw/docs/`, writes `SCHEMA.md`, `index.md`, `log.md`, supports `orient`, `ingest`, `query`, and `lint`, and creates governed candidate records for synthesized pages.

**Tech Stack:** TypeScript ESM, Node.js `fs/promises`, existing Kata CLI and Vitest test suite.

## Global Constraints

- `.llmwiki/raw/` sources are immutable inputs; updates must be logged rather than silently overwritten.
- Wiki helps agents understand the project; correctness remains gated by CI/tests/Reviewer/Judge.
- Do not write generated/runtime artifacts outside the Kata project scope.
- Use TDD: failing tests before production code.
- Keep implementation dependency-free.

---

### Task 1: LLM Wiki module and initialization from docs path

**Files:**
- Create: `kata/src/wiki/llmwiki.ts`
- Test: `kata/tests/unit/llmwiki.test.ts`
- Modify: `kata/src/cli.ts`
- Modify: `kata/docs/wiki.md`

**Interfaces:**
- Produces: `initLlmWiki(input: InitLlmWikiInput): Promise<LlmWikiInitResult>`
- Produces: `orientLlmWiki(input?: LlmWikiInput): Promise<LlmWikiOrientation>`
- Produces: `ingestLlmWiki(input: IngestLlmWikiInput): Promise<LlmWikiIngestResult>`
- Produces: `queryLlmWiki(input: QueryLlmWikiInput): Promise<LlmWikiQueryResult>`
- Produces: `lintLlmWiki(input?: LlmWikiInput): Promise<LlmWikiLintReport>`
- CLI: `kata wiki init --from <path> [--wiki <path>]`, `kata wiki orient [--wiki <path>]`, `kata wiki ingest --from <path>`, `kata wiki query --q <question> [--file]`, `kata wiki lint [--wiki <path>]`

- [x] **Step 1: Write failing tests**

```ts
it('initializes .llmwiki from a documentation path', async () => {
  const root = await tempRoot();
  await mkdir(join(root, 'docs'), { recursive: true });
  await writeFile(join(root, 'docs', 'architecture.md'), '# Architecture\n\nAgents need context.\n', 'utf8');

  const result = await initLlmWiki({ root, from: join(root, 'docs') });

  expect(result.importedSources).toEqual(['raw/docs/architecture.md']);
  await expect(readFile(join(root, '.llmwiki/SCHEMA.md'), 'utf8')).resolves.toContain('Project LLM Wiki');
  await expect(readFile(join(root, '.llmwiki/index.md'), 'utf8')).resolves.toContain('[[raw/docs/architecture.md]]');
  await expect(readFile(join(root, '.llmwiki/log.md'), 'utf8')).resolves.toContain('init | Project LLM Wiki initialized');
});
```

- [x] **Step 2: Verify RED**

Run: `cd /app/kata && node node_modules/vitest/dist/cli.js run tests/unit/llmwiki.test.ts`
Expected: FAIL because `src/wiki/llmwiki.ts` does not exist.

- [x] **Step 3: Implement module**

Create a focused module that:
- creates `.llmwiki/{raw/docs,raw/articles,raw/papers,raw/assets,entities,concepts,comparisons,queries}`;
- scans `--from` for `.md`, `.mdx`, `.txt`;
- copies each source to `raw/docs/<relative-path>`;
- prepends raw frontmatter with `source_path`, `ingested`, and `sha256`;
- writes `SCHEMA.md`, `index.md`, and `log.md`.

- [x] **Step 4: Add CLI routing tests and parser implementation**

Test `main(['wiki', 'init', '--from', docsPath, '--wiki', '.llmwiki'])` and assert JSON output plus files.

- [x] **Step 5: Add orient/ingest/query/lint tests and implementation**

Test that `orient` reads schema/index/log, `ingest` writes summary pages plus `.kata/wiki` candidates, `query` cites and files useful answers, and `lint` catches required structure, source drift, broken links, orphan pages, missing frontmatter, and missing index entries.

- [x] **Step 6: Update docs**

Document the `.llmwiki` closed loop and commands in `kata/docs/wiki.md`.

- [x] **Step 7: Verify**

Run:

```bash
cd /app/kata
node node_modules/typescript/lib/tsc.js --noEmit
node node_modules/vitest/dist/cli.js run
```

Expected: typecheck exit 0 and all tests pass.

## Self-review

- Spec coverage: init from path, orientation, ingest, query, lint, governed-record linkage, and docs are covered.
- Placeholder scan: no TBD/TODO placeholders.
- Type consistency: exported function names and CLI commands are fixed above.
