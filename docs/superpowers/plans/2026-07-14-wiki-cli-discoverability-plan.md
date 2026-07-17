# Wiki CLI Discoverability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent coding agents from guessing unsupported Wiki commands by making the Kata Wiki CLI self-describing and supporting the two common discovery aliases.

**Architecture:** Keep the canonical enrichment flow unchanged: `wiki task --kind enrich` creates an LLM task packet and `wiki register` creates governed records. Add a read-only command catalog for empty/help invocations, map `wiki propose` to the canonical enrichment packet, and expose candidate records through `wiki candidate`; skills teach only canonical commands while documenting the alias as compatibility input.

**Tech Stack:** TypeScript, Node.js, Vitest, generated platform skills.

## Global Constraints

- `wiki propose` must not directly promote knowledge or bypass Reviewer/Judge governance.
- `wiki candidate` is read-only and returns only records whose status is `candidate`.
- Empty and help invocations must return success with canonical examples.
- Canonical commands remain `wiki task`, `wiki lint`, `wiki verify`, `wiki register`, `wiki promote`, and `wiki reject`.

---

### Task 1: Test CLI discovery and aliases

**Files:**
- Modify: `tests/unit/llmwiki.test.ts`
- Modify: `src/cli.ts`

**Interfaces:**
- `kata wiki`, `kata wiki --help`, and `kata wiki -h` return `{ command: 'wiki help', commands: [...] }`.
- `kata wiki propose [--from <path>]` returns the same packet shape as `kata wiki task --kind enrich`.
- `kata wiki candidate` returns `{ command: 'wiki candidate', candidates: WikiRecord[] }`.

- [ ] **Step 1: Write failing tests**

```ts
expect(await captureJsonOutput(() => main(['wiki', '--help', '--root', root]))).toMatchObject({
  command: 'wiki help',
  commands: expect.arrayContaining(['task --kind enrich', 'register', 'candidate']),
});
expect(await captureJsonOutput(() => main(['wiki', 'propose', '--root', root]))).toMatchObject({ command: 'wiki task', kind: 'enrich' });
```

- [ ] **Step 2: Verify RED**

Run: `/home/work/.nvm/versions/node/v22.23.1/bin/node node_modules/vitest/vitest.mjs run tests/unit/llmwiki.test.ts`

Expected: FAIL with `Unknown wiki command`.

- [ ] **Step 3: Implement the smallest dispatcher changes**

Add a command catalog, normalize `propose` to `task --kind enrich`, and filter `readWikiRecords(root)` for candidates. Keep promote/reject approval requirements unchanged.

- [ ] **Step 4: Verify GREEN**

Run the Task 1 command and confirm the new cases pass.

### Task 2: Align generated Skills and documentation

**Files:**
- Modify: `src/adapters/manifest.ts`
- Modify: `README.md`
- Modify: `README_ZH.md`
- Test: `tests/golden/adapters.test.ts`

**Interfaces:**
- Generated OpenCode and Codex wiki skills list canonical commands and state that `propose` is a compatibility alias, not a direct candidate/promotion operation.

- [ ] **Step 1: Write/extend an adapter golden assertion**

```ts
expect(renderedSkill).toContain('kata wiki task --kind enrich');
expect(renderedSkill).toContain('Do not guess Wiki CLI subcommands');
```

- [ ] **Step 2: Verify RED, then update the manifest and docs**

Run: `/home/work/.nvm/versions/node/v22.23.1/bin/node node_modules/vitest/vitest.mjs run tests/golden/adapters.test.ts`

Expected before implementation: the generated skill lacks the no-guessing directive.

- [ ] **Step 3: Verify full regression**

Run:

```sh
/home/work/.nvm/versions/node/v22.23.1/bin/node node_modules/vitest/vitest.mjs run
/home/work/.nvm/versions/node/v22.23.1/bin/node node_modules/typescript/bin/tsc -p tsconfig.build.json
```

Expected: all Kata tests and the TypeScript build pass.
