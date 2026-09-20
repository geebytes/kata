---
date: 2026-09-20T10:32:53+0800
author: vforfreedom
commit: 99113df
branch: master
repository: kata
topic: kata-unified-efficiency-implementation
tags: [plan, kata, efficiency, tokens, latency, schema-validation, tdd, quality-gates]
status: ready
parent: docs/architecture-reviews/2026-09-20_10-09-51_kata-unified-efficiency-review.md
phase_count: 7
phases: [{ n: 1, title: "Foundation — light entry, single-walk digests, bounded persistence, unavailable metrics", files: [src/cli/tasks.ts, src/cli.ts, src/adapters/manifest.ts, src/adapters/phase-guidance.ts, src/core/repository-identity.ts, src/workflow/revision.ts, src/process/run.ts, src/quality/evidence.ts, schemas/evidence.schema.json, src/eval/metrics.ts, src/eval/runner.ts, src/eval/release-gates.ts, src/workflow/orchestrator.ts, tests/unit/cli-status-light.test.ts, tests/unit/revision-delta.test.ts, tests/unit/process-run.test.ts, tests/unit/eval-metrics.test.ts, tests/golden/adapters.test.ts, tests/e2e/dogfood-config.test.ts], depends_on: [] }, { n: 2, title: "Baseline and refresh loop", files: [src/cli/baseline.ts, src/cli.ts, src/cli/installer.ts, src/eval/runner.ts, src/eval/release-gates.ts, src/cli/ops.ts, evals/dogfood-app.json, evals/dogfood-app.yaml, docs/operations.md, docs/changelog/2026-09-17-seal-cost-and-revision-identity.md, tests/unit/baseline.test.ts, tests/unit/installer.test.ts, tests/unit/eval-fixture-expectations.test.ts], depends_on: [1] }, { n: 3, title: "Evidence contracts and check-level reuse", files: [src/quality/evidence.ts, src/quality/check-reuse.ts, src/quality/claims.ts, src/quality/check-resolver.ts, src/quality/acceptance-matrix.ts, src/quality/evidence-adequacy.ts, src/workflow/orchestrator.ts, schemas/evidence.schema.json, src/quality/adversarial.ts, src/adapters/phase-guidance.ts, tests/unit/check-level-reuse.test.ts, tests/unit/expected-exit-contract.test.ts], depends_on: [2] }, { n: 4, title: "AC-scoped evidence and the assurance boundary", files: [src/quality/evidence-adequacy.ts, src/quality/acceptance-matrix.ts, src/quality/adversarial.ts, src/workflow/orchestrator.ts, src/quality/reviewer.ts, src/quality/judge.ts, src/core/task.ts, schemas/task.schema.json, schemas/review-finding.schema.json, schemas/adversarial-review.schema.json, schemas/judge-result.schema.json, src/adapters/phase-guidance.ts, tests/unit/ac-scoped-evidence.test.ts, tests/unit/adversarial-boundary.test.ts], depends_on: [3] }, { n: 5, title: "Durable correctness — standard validation, locked stores", files: [src/core/schema.ts, src/core/locks.ts, src/core/relations.ts, src/wiki/store.ts, src/wiki/closure.ts, schemas/wiki-record.schema.json, schemas/handoff-packet.schema.json, schemas/handoff-receipt.schema.json, schemas/kata-relations.schema.json, package.json, tests/unit/schema-validation.test.ts, tests/unit/relation-graph-concurrency.test.ts, tests/unit/wiki-store-durability.test.ts], depends_on: [3] }, { n: 6, title: "Context and I/O economy", files: [src/workflow/context-fabric.ts, src/workflow/handoff.ts, schemas/handoff-receipt.schema.json, src/workflow/seal-preflight.ts, src/core/context.ts, src/quality/acceptance-matrix.ts, src/quality/evidence.ts, src/cli/tasks.ts, tests/unit/context-memo.test.ts, tests/unit/wiki-diagnostics-scope.test.ts, tests/unit/codegraph-fanout.test.ts], depends_on: [3, 4] }, { n: 7, title: "Evaluation parallel and release confidence", files: [src/eval/runner.ts, src/eval/release-gates.ts, tests/unit/eval-fixture-concurrency.test.ts], depends_on: [2] }]
unresolved_phase_count: 0
last_updated: 2026-09-20T10:32:53+0800
last_updated_by: vforfreedom
---

# Kata Unified Efficiency Implementation Plan

## Overview

Implements all 22 accepted findings from `docs/architecture-reviews/2026-09-20_10-09-51_kata-unified-efficiency-review.md` as seven sequential phases. The plan removes avoidable wall time, subprocess pressure, disk I/O and prompt tokens from the Kata workflow while keeping the things the review refused to trade away: independent assurance at Review/Judge, Build/TDD's exclusive ownership of test authorship, and fail-closed quality gates. Every optimisation is expressed as either a proven-equivalent mechanical change (digests, bounded capture) or an explicit, schema-backed contract (`passed`, `checkInput`, `coveredAcceptanceIds`, `contextMemo`, unavailable metrics).

## Requirements

- Deliver the review's 7 phases in dependency order; phases 4 and 5 are mutually independent and may run in parallel once phase 3 lands.
- Preserve revision identity: `manifestHash` and every artefact keyed on `revisionId` must stay byte-identical for unchanged content.
- Preserve gate strength: no phase may make a quality gate pass without evidence; anything not mechanically provable must fail closed.
- Build/TDD remains the only author of tests; Verify and Review may only reuse declared, revision-bound selectors.
- `.agents/skills/**` are generated artefacts — changes land through their generators (`src/adapters/manifest.ts`, `src/adapters/phase-guidance.ts`), never by hand-editing the markdown.
- Ship with `npm run typecheck` and `npm test` green; add a regression test for every behaviour this plan changes.

## Current State Analysis

The review's six layers are the baseline. The load-bearing facts this plan builds on:

- `src/cli/tasks.ts:198` (`runLocalStatusCommand`) and `src/cli/tasks.ts:435` (`runOrientCommand`) both call `readTaskContext()`, so an explicit task id pays a discovery/context build before the authoritative orient packet builds equivalent context. `manifest.ts:305` already instructs Skills *not* to re-discover when an explicit id is given, but the CLI still does the work.
- `src/workflow/revision.ts:50,53` calls `computeManifestHash()` then `computePathDigests()`; both walk and hash the same owned tree. `repositoryTreeHash()` (`src/core/repository-identity.ts:125`) and both `hashDirectoryRecursive` copies (`src/workflow/revision.ts:197`, `src/quality/evidence.ts:390`) rely on `walkRepositoryFiles()`, which materialises every `Buffer` before any hashing starts.
- `src/process/run.ts:131-140` appends every stdout/stderr chunk into unbounded strings; the only bound is downstream (`maxLogLength = 20_000` in `src/quality/evidence.ts:133`). `runProcessSync` already has `maxBuffer: 10 * 1024 * 1024` (`src/process/run.ts:173`). No caller uses `onOutput`.
- `src/core/schema.ts` implements 10 JSON-Schema keywords by hand and silently ignores the rest. `schemas/task.schema.json:259` uses `const`, `:381` uses `uniqueItems`. `schemas/wiki-record.schema.json:61` writes `provenance` as an **array**, which is not valid JSON Schema.
- `src/core/relations.ts` mutates `.kata/relations.json` with an unlocked read-modify-write and a bare `writeFile`; `src/wiki/store.ts:67,78` and `src/wiki/closure.ts:101` do the same for Wiki records. `src/core/state.ts` already provides both patterns to copy: `withTaskLock` (mkdir lock directory, fails closed on `EEXIST`) and `writeFileAtomic` (temp file + `rename`), plus `mutateTaskArtefact`, whose mutator returns the bytes so the lock covers the read.
- `src/eval/runner.ts` writes `tokensUsed: 0`, `costCredits: 0`, `escalationCount: 0` while `unmeasuredMetrics` names them; `src/eval/metrics.ts:36` sums them as numbers and `src/eval/release-gates.ts` gates on them.
- Verify and Review share one adversarial contract (`src/quality/adversarial.ts`, rendered into both Skills by `adversarialGuidanceFor()`), and `kata-verify/SKILL.md:87` / `kata-review/SKILL.md:87` both tell the node to "run the attempts".

### Key Discoveries

- `src/core/state.ts` `mutateTaskArtefact` is the established mutation discipline: the mutator **returns the bytes**, so the lock covers the read as well as the write. `withTaskLock` uses a lock *directory* createdAt via `mkdir`, and fails closed.
- `src/core/hash.ts` is 19 lines: `hashContent(string|Buffer): string` and `createContentHasher(): Hash`, where the latter returns a raw `node:crypto` `Hash` (fully incremental). No wrapper type to design around.
- `walkRepositoryFiles(root, {under?, maxFileBytes?}): Promise<RepositoryFile[]>` is materialising-only — there is no async-iterator variant. One caller (`src/workflow/revision.ts:264`, the owned-file set) discards `content` entirely; all others hash it.
- `src/quality/evidence.ts` stores one joined `log` field on the envelope (`EvidenceEnvelope.log`), capped by `truncate()` at 20 000 chars, after redaction. `schemas/evidence.schema.json` puts no bound on `log`.
- Consumers that need the **complete** stdout and would break if `runProcess` results were bounded: `src/quality/acceptance-matrix.ts:451` (CodeGraph affected-test parsing), `src/core/git.ts:52` (`git … -z` split on `\0`), `src/comet/compat.ts:188` (`parseCompatYaml`), `src/cli/ops.ts:521` (returns trimmed output to the operator).
- The Skill startup text lives in two generators: `src/adapters/manifest.ts:~308-313` ("Startup checklist" + "read the returned task, state, context, required files…") and `src/adapters/phase-guidance.ts` `automationGuidanceFor()` step 1 ("Run `kata-cli status` to read … task title, acceptance criteria, and context summary"). 12 generated `SKILL.md` files carry them.
- `tests/unit/schema-validation.test.ts` pins message substrings (`must be one of`, `is not allowed`, `mappedTo must be string or null`); any replacement validator must reproduce them.
- `docs/changelog/2026-09-17-seal-cost-and-revision-identity.md` is **stale** on check concurrency: it claims bounded concurrency by default, while `src/quality/evidence.ts:147-151` returns `1` unless `KATA_CHECK_CONCURRENCY` is set (confirmed by `docs/changelog/2026-09-17-check-concurrency-opt-in.md` and `docs/operations.md`). Phase 2 corrects it.

## Desired End State

An explicit-task invocation reaches one authoritative context build instead of two:

```bash
# Light by default: no context build, no requiredReads — enough for dispatch and confirmation.
$ kata-cli status --change kata-x1 --json
{"command":"status","taskId":"kata-x1","phase":"implement","nextSkill":"/kata-build","light":true, ...}

# Opt back in when the caller wants the full context packet.
$ kata-cli status --change kata-x1 --with-context --json
{"command":"status","taskId":"kata-x1","phase":"implement","task":{...},"state":{...},
 "requiredReads":["AGENTS.md", ...],"context":{...}}
```

Evidence states whether its own declared outcome was met, and carries the fingerprint of what it ran:

```jsonc
// .kata/evidence/<taskId>-<checkId>.json
{
  "checkId": "check-3",
  "exitCode": 1,
  "expectExitCode": 1,
  "passed": true,                       // exitCode === (expectExitCode ?? 0)
  "checkInput": "9f2c…",                // fingerprint of command/args/cwd/env-keys/selector
  "coveredAcceptanceIds": ["AC-1", "AC-2"]
}
```

A bounded capture reports what it dropped instead of pretending the log is complete:

```jsonc
{ "log": "…head…\n…tail…", "logBytes": 812344, "logTruncated": true, "logArtifact": ".kata/evidence/kata-x1-check-3.log" }
```

Evaluation reports say what they could not observe:

```jsonc
{ "runs": [{ "tokensUsed": null, "costCredits": null, "escalationCount": null }],
  "metrics": { "totalTokens": null, "metricCoverage": { "tokens": 0, "cost": 0, "escalations": 0 } },
  "releaseGates": { "gates": [{ "name": "escalation-rate", "skipped": true, "details": "not measured by this harness" }] } }
```

## What We're NOT Doing

- **Not** merging Verify into Review, or removing the fresh-context Review pass (the review explicitly rejected this).
- **Not** letting Verify or Review author, edit or create any test, fixture or harness. Missing coverage becomes a Build/TDD repair obligation.
- **Not** rebuilding the relation graph as an append-only event log (rejected alternative in the review).
- **Not** adding a walk cache for repository identity — a stale hash reads as fresh evidence, which is the failure the evidence system exists to prevent.
- **Not** making check concurrency default-on for the seal. `src/quality/evidence.ts` stays serial by default; `KATA_CHECK_CONCURRENCY` remains the opt-in.
- **Not** hand-editing `.agents/skills/**/*.md`; only their generators change and the files are regenerated.
- **Not** changing `runProcess`'s returned strings, so no existing parser breaks.
- **Not** touching `src/adapters/*` platform logic, the Comet integration, or the Git Flow surface beyond what a phase names explicitly.

## Decisions

### D1 — Light `status` is the default, `--with-context` opts back in

**Ambiguity:** should the reduced response be the default (and the rich one opt-in), or the reverse?

**Explored:**
- Default light — matches the review's wording ("returns only phase/candidates by default, preserve `--with-context`") and removes the duplicate build from the common path (`src/cli/tasks.ts:198`). Cost: 12 generated Skills must be regenerated, and any consumer reading `status.context` breaks until it is.
- Opt-in light — no generated-file churn, but the agent keeps taking the expensive path unless it remembers `--light`.

**Decision:** default light. `runLocalStatusCommand` gains an options object; the full projection (task, state, engine, requiredReads, context) is emitted only with `--with-context`. `--json`/`--quiet` remain rendering-only and orthogonal (`src/cli/output.ts:84-90`). The generators in `src/adapters/manifest.ts` and `src/adapters/phase-guidance.ts` are updated so regenerated Skills ask for `orient` (the authoritative packet) rather than a rich `status`.

### D2 — Bounding applies to the persisted side only

**Ambiguity:** where does the memory bound go, given four callers parse complete stdout?

**Explored:**
- Bound `runProcess` results by default — biggest memory win, but silently truncates `git … -z` output, CodeGraph affected-test parsing and the Comet compat probe (four call sites to fix, and a fifth added later would break silently).
- Bound only where output is *persisted* — `runProcess` keeps returning complete strings; the evidence collector opts into a bounded capture with head/tail, byte count and truncation metadata, plus an optional full-log artifact whose *reference* enters evidence.

**Decision:** bound the persisted side. `RunProcessOptions` gains `maxCaptureBytes` (default `undefined` = unbounded, preserving today's behaviour) and the result gains truncation metadata; `src/quality/evidence.ts` opts in and writes the full log to `.kata/evidence/<taskId>-<checkId>.log` when the bound is exceeded. Consumers keep working unchanged.

### D3 — Ajv 8 (draft 2020-12) replaces the hand-written interpreter, and the invalid schema is fixed in the same phase

**Ambiguity:** which validator, and does the schema corpus get repaired now or later?

**Explored:**
- Ajv 8 via `ajv/dist/2020` — matches the `$schema` every bundle already declares, synchronous `validate()`, 0 runtime deps, keeps `additionalProperties: false` semantics. Uses `new Function` codegen; harmless here because `scripts/build.mjs` keeps `packages: 'external'`, so esbuild never inlines it.
- `@cfworker/json-schema` — pure ESM, no eval, ~15 KB, but less battle-tested.
- Fix later — would leave `schemas/wiki-record.schema.json:61` as an array-valued schema (Ajv throws at compile) and the corpus unproven.

**Decision:** Ajv 8 with the corpus repaired in the same phase. Add `"$schema"` to the two bundled schemas that lack it (`handoff-packet`, `handoff-receipt`), correct `provenance` to `{"type":"string","enum":[...]}`, and keep Kata's error wrapping (`<schemaName> artefact <path> does not match its schema: …. Allowed fields: …`) plus the exact message substrings `tests/unit/schema-validation.test.ts` pins.

### D4 — Unavailable metrics are `null`, and gates skip them

**Ambiguity:** null-and-skip, null-and-fail-closed, or drop the fields entirely?

**Explored:**
- `null` + skip — matches the existing `unmeasured` list's stated intent from `docs/changelog/2026-09-17-evaluation-harness-executes-fixtures.md` ("states that it has no data instead of reporting a zero a reader could mistake for a measurement"). Cost: `metrics.ts` arithmetic and three test files change.
- `null` + fail-closed — stronger, but makes the default gate red on a harness limitation rather than on the change under test.
- Drop the fields — loses the ability to record them once a platform *can* measure them.

**Decision:** `null` plus explicit coverage, gates skip unavailable dimensions and say so in `details`. `EvaluationMetrics` fields become `number | null`; `computeMetrics` ignores nulls and returns `metricCoverage`.

### D5 — Relation graph: repo-level lock, atomic write, validated on write

**Ambiguity:** validate on write (turning today's read-time error into a write-time refusal) or keep validation read-only?

**Explored:**
- Validate on write — a drifted graph fails the mutation that would have worsened it, and the failure names the field. Cost: a mutation that used to succeed and leave a repairable file now refuses.
- Read-only validation — preserves current semantics exactly; a bad graph stays repairable in place.

**Decision:** validate on write. The graph is the authoritative store for terminal relations, and a mutation over drifted content is exactly the case where refusing is cheaper than compounding. Keep the read path's tolerance unchanged.

### D6 — Wiki: repo-level record lock plus the task lock for closures

**Decision:** Wiki records take a repo-level record lock (same mkdir-lock pattern as relations) with atomic replace and write-time validation; the task-scoped `wiki-closure.json` goes through the existing `mutateTaskArtefact`. Rationale: `.kata/wiki/` is repository-scoped while `.kata/tasks/<id>/wiki-closure.json` is task-scoped, and `mutateTaskArtefact` already gives the closure the lock-covers-read semantics it needs. Readers keep their current tolerance (`readWikiRecordsWithIssues` never throws).

### D7 — Context memo lives in the handoff receipt

**Decision:** `handoff-receipt` gains `contextMemo: { role, hashes: Record<path, sha256> }`. The packet gets `continuedReads` (the paths this role already acknowledged at their current hash) beside `requiredReads`. **No `revisionId` in the memo:** the hashes are the record, and a revision id in the same object would be a second, weaker way to answer the same question — one that reads as "already read" when the revision is shared but a file changed. D7's earlier draft listed one; fences 1–3 of Phase 6 are the authority.

### D8 — Check fingerprints and AC coverage extend the evidence envelope

**Decision:** `EvidenceEnvelope` gains `checkInput` (a sha256 over command, args, cwd, sorted env *keys* and test selector), `coveredAcceptanceIds: string[]`, `passed: boolean` and, for claims, `expectExitCode`. Revision identity is untouched (`pathDigests`/`manifestHash` unchanged). `schemas/evidence.schema.json` gains the new optional fields so existing envelopes still validate.

## Phase 1: Foundation — light entry, single-walk digests, bounded persistence, unavailable metrics

Delivers L0-01, L1-02, L4-01, L4-02 and L5-01. No phase depends on it beyond those it feeds. `src/process/run.ts` and `src/eval/*` changes are independent of the CLI and hashing work, so within this phase they can be applied in any order. (L4-01 — "stream repository identity hashing without changing its digest" — rides on fence 6: `repositoryTreeHash` stops materialising the tree. The review's finding id is claimed here for exactly that reason, rather than left to Phase 6's prose.)

### Overview

Removes the duplicate context build from the explicit-task path, makes owned-path hashing a single traversal with byte-identical digests, bounds what a verbose child process can persist, and stops the evaluation harness from reporting unobserved cost as zero.

### Changes Required:

#### 1. src/cli/tasks.ts

**File**: src/cli/tasks.ts
**Changes**: MODIFY — add a light status projection and an explicit-task fast path

```ts
// ── add, above runLocalStatusCommand ───────────────────────────────────────────────────────────────────────────

export interface StatusOptions {
    /**
     * Include the full context projection (`task`, `requiredReads`, `context`).
     *
     * Default false (L0-01). An explicitly anchored task used to build that projection here and build equivalent
     * context again inside the authoritative `orient` packet, so one invocation paid for two discovery passes over
     * the same task. `orient` answers "what is this task and what must I read"; `status` answers "which phase is
     * this and what runs next", and has to stay cheap enough to run before a confirmation prompt.
     */
    withContext?: boolean;
}

/** The engine stamp a task carries (C7), read without building the whole task context. */
async function readTaskEngine(root: string, change: string): Promise<{ version: string; stampedAt: string } | undefined> {
    try {
        const task = JSON.parse(await readFile(taskPath(root, change), 'utf8')) as { engine?: { version: string; stampedAt: string } };
        return task.engine;
    } catch {
        return undefined;
    }
}

// ── runLocalStatusCommand: signature and redirect forwarding ──────────────────────────────────────────────────

export async function runLocalStatusCommand(
    change: string,
    resolved?: ResolvedTask | null,
    root = resolveWorkspaceRoot(),
    options: StatusOptions = {},
): Promise<Record<string, unknown>> {
    const terminal = await resolveTerminalTask(root, change);
    if (terminal.taskId !== change) {
        // A relation redirect is answerable without any context — the caller's next question is about the target.
        const targetStatus = await runLocalStatusCommand(terminal.taskId, resolved, root, options);

// ── replace: `const taskContext = await readTaskContext(root, change);` ───────────────────────────────────────

    const withContext = options.withContext === true;
    // L0-01: build the context manifest only when it was asked for. `orient` is the packet that carries it, so a
    // status call that is about to be followed by an orient must not build it twice.
    const taskContext = withContext ? await readTaskContext(root, change) : null;
    const engine = taskContext?.engine ?? await readTaskEngine(root, change);

// ── replace: the engine note and the returned projection ─────────────────────────────────────────────────────

    const engineNote = engine ? engineChangeNote(engine) : null;
    // (the rest of the body is unchanged)
    return {
        command: 'status',
        taskId: change,
        phase: state.phase,
        // ...unchanged fields...
        // `light` is stated rather than implied: a reader must be able to tell "no context because none was asked
        // for" from "no context because the task has none".
        ...(withContext ? {} : { light: true }),
        engine: { running: engineVersion(), ...(engine ? { task: engine } : {}) },
        ...(engineNote ? { engineNote } : {}),
        ...(taskContext
            ? { task: taskContext.task, requiredReads: taskContext.requiredReads, context: taskContext.context }
            : {}),
    };
}
```

#### 2. src/cli.ts

**File**: src/cli.ts
**Changes**: MODIFY — thread the status options and the light orient fast path through dispatch

```ts
// ── replace the `status` dispatch (src/cli.ts, inside runMain) ────────────────────────────────────────────────

    if (command === 'status') {
        // `--with-context` is the only way to ask for the context projection now; the default answers the dispatch
        // question without building it (L0-01). It is not a rendering mode, so `stripOutputModeArgs` leaves it alone.
        outputResult(await runLocalStatusCommand(change, resolved, workspaceRoot, {
            withContext: argv.includes('--with-context'),
        }));
        return;
    }

// `runDispatchStatusCommand` (the no-`--change` path) is deliberately left alone: it has no explicit anchor, so it
// takes the same light default through the same function.
```

#### 3. src/adapters/manifest.ts

**File**: src/adapters/manifest.ts
**Changes**: MODIFY — startup checklist text: orient is the authoritative packet, status is the light dispatcher

```ts
// ── replace the "## Startup checklist" section of renderSkill() (src/adapters/manifest.ts:308-313) ────────────

## Startup checklist

Before doing task work, resolve the task and read its authoritative packet. `kata-cli status` reports the phase, the
next skill and the candidates; it is deliberately **light** and does not build task context.

**If the user already supplied an explicit task id, skip `status` entirely.** The id is the anchor, and `orient`
builds the one authoritative context:

\`\`\`bash
kata-cli orient --change <change-id> --role <designer|implementer|reviewer|judge|distiller> --platform ${platform} --task-kind <read|implementation|security>
kata-cli hooks activate --change <change-id> --role <designer|implementer|reviewer|judge|distiller> --platform ${platform}
\`\`\`

Otherwise discover the task first — `status` is enough to decide whether there is one candidate or a choice to put
to the user — and then run both commands above with the resolved values:

\`\`\`bash
kata-cli status
\`\`\`

Treat skill use as an interactive agent workflow, not a parameter-only command. First discover the active or
same-branch task and any relation redirects; if the task, role, task kind, or target platform is ambiguous, present
concise options and ask the user to confirm or type a value. Do not make the user remember command-line flags. After
confirmation, run `kata-cli orient` with the resolved values, then read the returned task, state, context, required
files, guard instructions, relation redirects, and next skill before editing. Pass `--with-context` to `kata-cli
status` only when you want that projection without a packet. The hook activation links platform write hooks to the
active Kata task so phase/role scope is enforced while you work.
```

#### 4. src/adapters/phase-guidance.ts

**File**: src/adapters/phase-guidance.ts
**Changes**: MODIFY — automation contract step 1 reads the light status, not the rich one

```ts
// ── replace step 1 of the "## Skill automation contract" block in automationGuidanceFor() ─────────────────────

1. Run `kata-cli status` to read the active or current-branch discovered task, its relation redirects, the phase and
   the next skill. Status is light: it reports the dispatch decision, not task context — step 4's `orient` is the
   packet that carries `task`, `state`, `requiredReads` and `context`. **When the user supplied an explicit task id,
   skip this step and go straight to step 4.** Do not add `--with-context` here; the packet already carries it.
```

#### 5. .agents/skills/kata*/SKILL.md

**File**: .agents/skills/kata*/SKILL.md
**Changes**: MODIFY (generated) — regenerate the 12 Skill files from the updated generators

```bash
# The 12 files under .agents/skills/ are generated for the Pi platform (skillsDir '.agents'); never hand-edit them.
npm run build
node dist/cli.js update --platform pi --scope project

# Idempotence check: only the files whose generator text actually changed may appear.
git diff --stat .agents/skills
```

#### 6. src/core/repository-identity.ts

**File**: src/core/repository-identity.ts
**Changes**: MODIFY — add an ordered streaming walk and stream `repositoryTreeHash`

```ts
// ── add, after walkRepositoryFiles ────────────────────────────────────────────────────────────────────────────

/**
 * The included repository-relative paths, sorted, **without reading a single file's content**.
 *
 * The path list is what an identity consumer actually needs in order; the bytes can be read one at a time
 * afterwards. Separating the two is what lets a whole-tree hash hold one file instead of the whole tree.
 */
export async function listRepositoryFiles(root: string, options: WalkOptions = {}): Promise<string[]> {
    const paths: string[] = [];

    async function visit(directory: string): Promise<void> {
        let entries;
        try {
            entries = await readdir(directory, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (isIgnoredRepositoryName(entry.name)) continue;
            const absolutePath = join(directory, entry.name);
            const repositoryPath = relative(root, absolutePath).replaceAll('\\', '/');
            if (isIgnoredRepositoryPath(repositoryPath)) continue;
            if (entry.isDirectory()) {
                await visit(absolutePath);
                continue;
            }
            if (!entry.isFile()) continue;
            if (options.maxFileBytes !== undefined) {
                const info = await stat(absolutePath);
                if (info.size > options.maxFileBytes) continue;
            }
            paths.push(repositoryPath);
        }
    }

    const start = options.under ? join(root, options.under) : root;
    if (options.under && isIgnoredRepositoryPath(options.under)) return [];
    await visit(start);
    return paths.sort((left, right) => left.localeCompare(right));
}

/**
 * The same walk, one file at a time.
 *
 * Yields exactly what `walkRepositoryFiles` returns — same ignore policy, same size budget, same `localeCompare`
 * order — but reads each file only when the consumer is ready for it, so hashing a repository is O(one file) in
 * memory instead of O(the tree). Callers that need the bytes all at once keep using `walkRepositoryFiles`.
 */
export async function* walkRepositoryEntries(
    root: string,
    options: WalkOptions = {},
): AsyncGenerator<RepositoryFile> {
    for (const path of await listRepositoryFiles(root, options)) {
        yield { path, absolutePath: join(root, path), content: await readFile(join(root, path)) };
    }
}

// ── replace walkRepositoryFiles with a thin materialisation of the same walk ──────────────────────────────────

export async function walkRepositoryFiles(root: string, options: WalkOptions = {}): Promise<RepositoryFile[]> {
    const files: RepositoryFile[] = [];
    for await (const file of walkRepositoryEntries(root, options)) files.push(file);
    return files;
}

// ── replace the body of repositoryTreeHash (streaming; byte-identical output) ────────────────────────────────

export async function repositoryTreeHash(root: string): Promise<string> {
    const hash = createContentHasher();
    for await (const file of walkRepositoryEntries(root, { maxFileBytes: maxTreeHashFileBytes })) {
        hash.update(file.path);
        hash.update('\0');
        hash.update(file.content);
        hash.update('\0');
    }
    return hash.digest('hex');
}
```

#### 7. src/workflow/revision.ts

**File**: src/workflow/revision.ts
**Changes**: MODIFY — compute the manifest hash and per-path digests in one traversal

```ts
// ── extend the two import statements that are already there; do not re-declare their names ──────────────────
//
// The file already has, at its top:
//   import { createHash, randomUUID } from 'node:crypto';
//   import { isIgnoredRepositoryPath, walkRepositoryFiles } from '../core/repository-identity.js';
//
// They become (one added name each — `createHash` and `isIgnoredRepositoryPath` stay, `Hash` and
// `walkRepositoryEntries` are the additions):
//   import { createHash, randomUUID, type Hash } from 'node:crypto';
//   import { isIgnoredRepositoryPath, walkRepositoryEntries } from '../core/repository-identity.js';

// ── add, above computeManifestHash ───────────────────────────────────────────────────────────────────────────

/**
 * Feeds one owned-path traversal into the rolling manifest digest and, when asked, the per-path table.
 *
 * `computeManifestHash` and `computePathDigests` each walked the same tree, so a seal read and hashed every owned
 * file twice before a single check started (L1-02). The traversal and the order are identical, so asking for both
 * costs one walk and produces byte-identical output for each. Callers that need only one of the two still pay for
 * only one.
 *
 * The walk is `walkRepositoryEntries` (one file at a time) rather than `walkRepositoryFiles`: the owned set used to be
 * materialised in full just to hash it. Same ignore policy, same size rule (owned-path hashing has no size cap), same
 * `localeCompare` order — so the digests do not move.
 */
async function feedOwnedTree(
    root: string,
    ownedPaths: string[],
    manifest: Hash,
    pathDigests: Record<string, string> | null,
): Promise<void> {
    for (const path of normalizeOwnedPaths(root, ownedPaths)) {
        manifest.update(path);
        manifest.update('\0');
        const fullPath = join(root, path);
        let entry: Awaited<ReturnType<typeof stat>> | null = null;
        try {
            entry = await stat(fullPath);
        } catch {
            entry = null;
        }

        if (entry?.isDirectory()) {
            const relativeDir = relative(root, fullPath).replaceAll('\\', '/');
            for await (const file of walkRepositoryEntries(root, relativeDir ? { under: relativeDir } : {})) {
                manifest.update(file.path);
                manifest.update('\0');
                manifest.update(file.content);
                manifest.update('\0');
                if (pathDigests) pathDigests[file.path] = hashContent(file.content);
            }
        } else if (entry?.isFile()) {
            const content = await readFile(fullPath);
            manifest.update(content);
            if (pathDigests) pathDigests[path] = hashContent(content);
        } else if (entry) {
            manifest.update('[unsupported]');
            if (pathDigests) pathDigests[path] = hashContent('[unsupported]');
        } else {
            manifest.update('[missing]');
            if (pathDigests) pathDigests[path] = hashContent('[missing]');
        }
        manifest.update('\0');
    }
}

/** Both owned-tree digests from one traversal — what a seal needs. */
export async function computeBothOwnedDigests(
    root: string,
    ownedPaths: string[],
): Promise<{ manifestHash: string; pathDigests: Record<string, string> }> {
    const pathDigests: Record<string, string> = {};
    const manifest = createContentHasher();
    await feedOwnedTree(root, ownedPaths, manifest, pathDigests);
    return { manifestHash: manifest.digest('hex'), pathDigests };
}

// ── replace the bodies of computeManifestHash and computePathDigests ──────────────────────────────────────────

export async function computeManifestHash(root: string, ownedPaths: string[]): Promise<string> {
    const manifest = createContentHasher();
    await feedOwnedTree(root, ownedPaths, manifest, null);
    return manifest.digest('hex');
}

export async function computePathDigests(root: string, ownedPaths: string[]): Promise<Record<string, string>> {
    const pathDigests: Record<string, string> = {};
    await feedOwnedTree(root, ownedPaths, createContentHasher(), pathDigests);
    return pathDigests;
}

// ── replace the two digest computations inside createTaskRevisionIfChanged ───────────────────────────────────

    const ownedPaths = normalizeOwnedPaths(input.root, input.ownedPaths);
    if (ownedPaths.length === 0) throw new Error('A revision requires at least one declared owned path');
    // One traversal for both digests (L1-02). The id still derives from the manifest hash and the check set only:
    // the per-path table is *added* by this seal (F2.1) and never participates in the identity (I4).
    const { manifestHash, pathDigests } = await computeBothOwnedDigests(input.root, ownedPaths);
    const id = revisionIdFor(input.taskId, manifestHash, input.checkIds ?? []);

// `hashDirectoryRecursive` and `computePathDigest` stay as they are: they are private to the single-digest path
// and switching them would be churn without a caller that benefits.
```

#### 8. src/process/run.ts

**File**: src/process/run.ts
**Changes**: MODIFY — opt-in bounded capture with honest truncation metadata

```ts
// ── add (import) ────────────────────────────────────────────────────────────────────────────────────────────

import { appendFile } from 'node:fs/promises';

// ── add, above ProcessFailure ───────────────────────────────────────────────────────────────────────────────

/**
 * A bounded capture: the head, the tail, and a count of everything that went past.
 *
 * A check that prints a megabyte of progress must not make the *seal* hold a megabyte — and today the only cap is
 * downstream (`quality/evidence.ts` truncates the joined log to 20 000 characters, after the whole thing has already
 * been held). The default here is no bound, which is what every existing caller gets: four of them parse the complete
 * stream (`git … -z` splitting, CodeGraph's affected-test lines, the Comet compat probe, an operator-facing echo), so
 * bounding the *result* would silently change their answers.
 *
 * The length arithmetic is in UTF-16 units while the reported total is in bytes: the bound is a memory guard, not a
 * byte-exact contract, and the count is what a reader is told.
 */
class BoundedCapture {
    private head = '';
    private tail = '';
    private bytes = 0;
    private truncated = false;

    constructor(private readonly limit: number | undefined) {}

    push(chunk: string): void {
        this.bytes += Buffer.byteLength(chunk, 'utf8');
        if (this.limit === undefined) {
            this.head += chunk;
            return;
        }
        const headLimit = Math.ceil(this.limit / 2);
        let rest = chunk;
        if (this.head.length < headLimit) {
            const room = headLimit - this.head.length;
            this.head += chunk.slice(0, room);
            rest = chunk.slice(room);
            if (!rest) return;
        }
        this.truncated = true;
        const tailLimit = Math.max(this.limit - headLimit, 1);
        this.tail = `${this.tail}${rest}`.slice(-tailLimit);
    }

    /** What was kept. A dropped middle is named, never hidden. */
    value(): string {
        if (!this.truncated) return this.head;
        const omitted = Math.max(this.bytes - this.head.length - this.tail.length, 0);
        return `${this.head}\n[${omitted} bytes omitted]\n${this.tail}`;
    }

    totalBytes(): number {
        return this.bytes;
    }

    wasTruncated(): boolean {
        return this.truncated;
    }
}

// ── add to ProcessResult ────────────────────────────────────────────────────────────────────────────────────

    /** Bytes the child wrote to stdout and stderr, whether or not they were kept. */
    capturedBytes: number;
    /** True when `maxCaptureBytes` was reached and the middle of a stream was dropped. */
    captureTruncated: boolean;

// ── add to RunProcessOptions ────────────────────────────────────────────────────────────────────────────────

    /**
     * Keep at most roughly this many characters of each stream in the result, as head + tail.
     *
     * Absent (the default) keeps everything, which is what every caller that parses output needs. A caller that
     * *persists* output instead of parsing it sets this and gets an honest account of what it dropped.
     */
    maxCaptureBytes?: number;
    /**
     * Append every chunk to this file as it arrives, in addition to capturing it.
     *
     * The capture bound is a memory bound, not a diagnostic one: the complete output is still the record of last
     * resort, so when the bound is set the full text goes here and the caller keeps a path instead of a payload.
     * The file is created or appended to, and it is flushed before the promise settles. `inheritOutput` captures
     * nothing, so nothing is written when both are set.
     */
    captureArtifact?: string;

// ── inside runProcess: replace the two accumulators and the two data handlers ────────────────────────────────

        const stdout = new BoundedCapture(options.maxCaptureBytes);
        const stderr = new BoundedCapture(options.maxCaptureBytes);
        // Chunks are appended in arrival order; `finish` waits for the queue so a caller that reads the artifact
        // after awaiting `runProcess` sees the whole log rather than a prefix of it.
        let artifactQueue: Promise<void> = Promise.resolve();
        const tee = (text: string): void => {
            if (!options.captureArtifact) return;
            artifactQueue = artifactQueue.then(() => appendFile(options.captureArtifact!, text, 'utf8')).catch(() => undefined);
        };
        // ...
        child.stdout?.on('data', (chunk: string) => {
            stdout.push(chunk);
            tee(chunk);
            options.onOutput?.({ stream: 'stdout', text: chunk });
        });
        child.stderr?.on('data', (chunk: string) => {
            stderr.push(chunk);
            tee(chunk);
            options.onOutput?.({ stream: 'stderr', text: chunk });
        });

// ── inside runProcess: the resolve payload now waits for the artifact queue ──────────────────────────────────

        const finish = (exitCode: number, signal: NodeJS.Signals | null): void => {
            if (settled) return;
            settled = true;
            if (killTimer) clearTimeout(killTimer);
            clearTimeout(timeoutTimer);
            options.signal?.removeEventListener('abort', onAbort);
            void artifactQueue.then(() => resolve({
                ok: exitCode === 0 && !failure,
                exitCode,
                signal,
                stdout: stdout.value(),
                stderr: stderr.value(),
                capturedBytes: stdout.totalBytes() + stderr.totalBytes(),
                captureTruncated: stdout.wasTruncated() || stderr.wasTruncated(),
                ...(failure ? { failure } : {}),
                environment: environmentSummary(options.cwd),
            }));
        };

// ── the spawn-failure handlers that append to `stderr` become: ───────────────────────────────────────────────

            child.on('error', (error) => {
                failure = failure ?? 'spawn_failed';
                stderr.push(error.message);
                finish(127, null);
            });

// ── runProcessSync gains the same two result fields ──────────────────────────────────────────────────────────

        capturedBytes: Buffer.byteLength(`${typeof result.stdout === 'string' ? result.stdout : ''}${stderr}`, 'utf8'),
        captureTruncated: false, // `spawnSync` has its own `maxBuffer`; it truncates nothing.
```

#### 9. src/quality/evidence.ts

**File**: src/quality/evidence.ts
**Changes**: MODIFY — persist a bounded head/tail log plus a full-log artifact when the bound is hit

```ts
// ── replace the log cap constants ───────────────────────────────────────────────────────────────────────────

/** Characters of a check's output kept inline in the envelope. Enough for the failure, not for a megabyte of noise. */
const maxLogLength = 20_000;

/**
 * The bound the process facility is given for a check's capture (L4-02).
 *
 * Larger than `maxLogLength` on purpose: the inline log is what a reader sees first, and the capture bound only exists
 * so a check that prints for ten minutes cannot make the *seal* hold the whole transcript while it waits. The complete
 * text still lands in the artifact file below.
 */
const maxCaptureBytes = 2_000_000;

// ── add to ImportedCheckResult ──────────────────────────────────────────────────────────────────────────────

  /** Bytes the check produced, whether or not the log below holds all of them. */
  logBytes?: number;
  /** True when the log is a head/tail excerpt rather than the whole output. */
  logTruncated?: boolean;
  /** The complete output, as a path. Present only when the capture dropped something. */
  logArtifact?: string;

// ── add to EvidenceEnvelope ─────────────────────────────────────────────────────────────────────────────────

  /** Bytes the check produced before any cap applied. */
  logBytes?: number;
  /** True when `log` is an excerpt. A reader must never mistake a truncated log for a silent check. */
  logTruncated?: boolean;
  /** Where the complete log was written, when the capture was bounded. */
  logArtifact?: string;

// ── add to EvidenceCollectionOptions ────────────────────────────────────────────────────────────────────────

  /**
   * Where a check's complete output is written when its capture exceeded the in-memory bound.
   *
   * Absent means "keep only what the bounded capture holds" — which is what a caller with no task-scoped place to put
   * the file should pass. The orchestrator passes `evidenceDir(root)` so the record survives beside the envelope.
   */
  checkLogDir?: string;

// ── inside collectEvidence: pass the artifact path and propagate the metadata ───────────────────────────────

    const result = check.importResult ?? (await runBoundedCommand(check, {
      onProgress: options.onProgress,
      signal: options.signal,
      ...(options.checkLogDir
        ? { logArtifactPath: join(options.checkLogDir, `${taskId}-${check.id ?? checkName}.log`) }
        : {}),
    }));

    results[index] = {
      id: `evidence-${randomUUID()}`,
      taskId,
      // ...unchanged fields...
      ...(result.log ? { log: redact(truncate(result.log), redactions) } : {}),
      ...(result.logBytes !== undefined ? { logBytes: result.logBytes } : {}),
      ...(result.logTruncated || (result.log?.length ?? 0) > maxLogLength ? { logTruncated: true } : {}),
      ...(result.logArtifact ? { logArtifact: result.logArtifact } : {}),
    };

// ── replace runBoundedCommand ───────────────────────────────────────────────────────────────────────────────

async function runBoundedCommand(
  check: CheckCommand,
  options?: { onProgress?: (event: CheckProgressEvent) => void; signal?: AbortSignal; logArtifactPath?: string },
): Promise<ImportedCheckResult> {
  const cwd = check.cwd ?? process.cwd();
  const result = await runProcess(check.command, check.args ?? [], {
    cwd,
    env: { ...process.env, ...(check.env ?? {}) },
    ...(check.timeoutMs !== undefined ? { timeoutMs: check.timeoutMs } : {}),
    ...(options?.signal ? { signal: options.signal } : {}),
    // L4-02: bound what the child can make us hold. The bound is upstream of the evidence cap, so a megabyte of test
    // noise is dropped while it is read rather than after it has been held — and the complete text goes to the
    // artifact beside the envelope, whose path (not payload) is what the evidence records.
    maxCaptureBytes,
    ...(options?.logArtifactPath ? { captureArtifact: options.logArtifactPath } : {}),
  });

  const note = result.failure === 'timeout'
    ? `TIMEOUT after ${check.timeoutMs ?? 600_000}ms`
    : result.failure === 'aborted'
      ? 'CANCELLED'
      : undefined;
  // The terminal note is appended before the cap so it survives truncation; the log itself is capped once, at the
  // envelope, which is where readers look.
  const log = [result.stdout, result.stderr].filter(Boolean).join('');
  const withNote = note ? `${log}\n[${note}]` : log;

  return {
    exitCode: result.exitCode,
    log: withNote,
    logBytes: result.capturedBytes,
    ...(result.captureTruncated || withNote.length > maxLogLength
      ? {
          logTruncated: true,
          ...(options?.logArtifactPath ? { logArtifact: options.logArtifactPath } : {}),
        }
      : {}),
    environment: result.environment,
  };
}
```

#### 10. schemas/evidence.schema.json

**File**: schemas/evidence.schema.json
**Changes**: MODIFY — record log byte count, truncation flag and artifact path

```json
// ── add to "properties" beside "log" (the envelope's fields are all optional already) ─────────────────────────

    "logBytes": {
      "type": "integer",
      "minimum": 0
    },
    "logTruncated": {
      "type": "boolean"
    },
    "logArtifact": {
      "type": "string",
      "minLength": 1
    }
```

#### 11. src/eval/metrics.ts

**File**: src/eval/metrics.ts
**Changes**: MODIFY — nullable unmeasurable metrics plus explicit coverage

```ts
// ── EvaluationRun: the three host-owned values become nullable ──────────────────────────────────────────────

export interface EvaluationRun {
  id: string;
  taskId: string;
  acceptances: number;
  acceptancesPassed: number;
  acceptancesFailed: number;
  repairCount: number;
  /**
   * `null` when this harness cannot observe it.
   *
   * The host platform owns model choice, cost and retries, so a number here would be invented. A `0` used to be
   * written instead, which a reader could mistake for a measured zero — the exact failure the `unmeasured` list
   * exists to prevent. `null` says "not observed" and cannot be summed by accident.
   */
  escalationCount: number | null;
  tokensUsed: number | null;
  costCredits: number | null;
  latencyMs: number;
  wikiRejected: number;
  wikiPromoted: number;
}

// ── EvaluationMetrics: aggregates over unmeasured values are nullable too, plus coverage ─────────────────────

export interface EvaluationMetrics {
  acceptancePassRate: number;
  repairRate: number;
  /** `null` when no run carried an escalation count. */
  escalationRate: number | null;
  /** `null` when no run carried a cost. */
  avgCostPerTask: number | null;
  avgLatencyMs: number;
  wikiRejectionRate: number;
  totalTasks: number;
  totalAcceptances: number;
  totalPassed: number;
  totalFailed: number;
  totalRepairs: number;
  totalEscalations: number | null;
  totalTokens: number | null;
  totalCost: number | null;
  totalLatencyMs: number;
  totalWikiRejected: number;
  totalWikiPromoted: number;
  /**
   * How many runs actually carried a value for each unmeasurable metric.
   *
   * Zero coverage with a `null` aggregate is the honest report. Without it a reader cannot tell "nothing cost
   * anything" from "nobody looked", so every cost figure is published with the size of the sample behind it.
   */
  metricCoverage: { tokens: number; cost: number; escalations: number };
}

// ── helpers + computeMetrics ────────────────────────────────────────────────────────────────────────────────

/** Sums the values that exist; `null` when none do. An unmeasured metric is never reported as 0. */
function sumMeasured(values: Array<number | null>): number | null {
  let total = 0;
  let measured = 0;
  for (const value of values) {
    if (value === null) continue;
    total += value;
    measured += 1;
  }
  return measured > 0 ? total : null;
}

function perTaskOrNull(total: number | null, tasks: number): number | null {
  return total === null || tasks === 0 ? null : total / tasks;
}

export function computeMetrics(runs: EvaluationRun[]): EvaluationMetrics {
  const tasks = runs.length;
  const acceptances = runs.reduce((sum, run) => sum + run.acceptances, 0);
  const passed = runs.reduce((sum, run) => sum + run.acceptancesPassed, 0);
  const failed = runs.reduce((sum, run) => sum + run.acceptancesFailed, 0);
  const repairs = runs.reduce((sum, run) => sum + run.repairCount, 0);
  const latency = runs.reduce((sum, run) => sum + run.latencyMs, 0);
  const wikiRejected = runs.reduce((sum, run) => sum + run.wikiRejected, 0);
  const wikiPromoted = runs.reduce((sum, run) => sum + run.wikiPromoted, 0);

  const escalations = sumMeasured(runs.map((run) => run.escalationCount));
  const tokens = sumMeasured(runs.map((run) => run.tokensUsed));
  const cost = sumMeasured(runs.map((run) => run.costCredits));

  return {
    acceptancePassRate: acceptances > 0 ? passed / acceptances : 0,
    repairRate: tasks > 0 ? repairs / tasks : 0,
    escalationRate: perTaskOrNull(escalations, tasks),
    avgCostPerTask: perTaskOrNull(cost, tasks),
    avgLatencyMs: tasks > 0 ? latency / tasks : 0,
    wikiRejectionRate: wikiPromoted + wikiRejected > 0 ? wikiRejected / (wikiPromoted + wikiRejected) : 0,
    totalTasks: tasks,
    totalAcceptances: acceptances,
    totalPassed: passed,
    totalFailed: failed,
    totalRepairs: repairs,
    totalEscalations: escalations,
    totalTokens: tokens,
    totalCost: cost,
    totalLatencyMs: latency,
    totalWikiRejected: wikiRejected,
    totalWikiPromoted: wikiPromoted,
    metricCoverage: {
      tokens: runs.filter((run) => run.tokensUsed !== null).length,
      cost: runs.filter((run) => run.costCredits !== null).length,
      escalations: runs.filter((run) => run.escalationCount !== null).length,
    },
  };
}
```

#### 12. src/eval/runner.ts

**File**: src/eval/runner.ts
**Changes**: MODIFY — record `null` instead of `0` for host-unobservable values

```ts
// ── inside runFixture's returned observation ────────────────────────────────────────────────────────────────

      repairCount,
      // The host platform owns model choice, cost and retries, so this harness records that it did not observe
      // them rather than a zero a reader could mistake for a measurement (L5-01).
      escalationCount: null,
      tokensUsed: null,
      costCredits: null,

// `EvaluationRunObservation.expected.escalations` stays a number: that is what the *fixture declared* it expects,
// and an expectation is observable even when the measurement is not.
```

#### 13. src/eval/release-gates.ts

**File**: src/eval/release-gates.ts
**Changes**: MODIFY — skip gates whose metric was not measured, and say so

```ts
// ── ReleaseGate gains "this was not measured" as a third outcome ─────────────────────────────────────────────

export interface ReleaseGate {
  name: string;
  description: string;
  pass: boolean;
  details: string;
  /**
   * True when the metric behind this gate was not observed at all.
   *
   * A gate cannot pass on evidence it does not have, and it must not fail on a limitation of the harness either —
   * the third state is the honest one. `allPass` ignores skipped gates; the gate itself is still reported so
   * nobody reads "all gates passed" as "cost was measured".
   */
  skipped?: boolean;
}

// ── replace the escalation gate and the all-pass computation ────────────────────────────────────────────────

  const escalationGate: ReleaseGate = metrics.escalationRate === null
    ? {
        name: 'escalation-rate',
        description: `Average escalations per task <= ${opts.maxEscalationRate}`,
        pass: true,
        skipped: true,
        details: `Not measured by this harness (${metrics.metricCoverage.escalations}/${metrics.totalTasks} runs carried a value); the gate is skipped rather than passed on a fabricated zero.`,
      }
    : {
        name: 'escalation-rate',
        description: `Average escalations per task <= ${opts.maxEscalationRate}`,
        pass: metrics.escalationRate <= opts.maxEscalationRate,
        details: `Escalation rate: ${metrics.escalationRate.toFixed(2)} per task (${metrics.totalEscalations} escalations / ${metrics.totalTasks} tasks, ${metrics.metricCoverage.escalations} measured)`,
      };
  gates.push(escalationGate);

  // A skipped gate is neither a pass nor a failure: it is the report saying it does not know.
  const scored = gates.filter((gate) => gate.skipped !== true);
  const allPass = scored.every((gate) => gate.pass);
  const passed = scored.filter((gate) => gate.pass).length;
  const skipped = gates.length - scored.length;

  return {
    gates,
    allPass,
    summary: allPass
      ? `All ${scored.length} scored release gates passed${skipped > 0 ? `; ${skipped} skipped as unmeasured` : ''}.`
      : `${passed}/${scored.length} scored release gates passed. Review failed gates before release${skipped > 0 ? ` (${skipped} skipped as unmeasured)` : ''}.`,
  };
}

// Note: the acceptance, repair and wiki gates are computed from locally observed values and stay as they are.
```

#### 14. tests/unit/cli-status-light.test.ts

**File**: tests/unit/cli-status-light.test.ts
**Changes**: NEW — light status is the default; `--with-context` restores the rich projection

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../../src/cli.js';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';

/**
 * L0-01: an explicitly anchored task must reach one authoritative context construction.
 *
 * `status` answers "which phase is this and what runs next"; `orient` answers "what is this task and what must I
 * read". Building the second answer inside the first made every explicit-task invocation pay two discovery passes
 * over the same task, so `status` is light by default — and it *says so*, because a reader has to be able to tell
 * "no context because none was asked for" from "no context because the task has none".
 */
describe('light status', () => {
    const roots: string[] = [];

    afterEach(async () => {
        await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });

    async function captureJsonOutput(action: () => Promise<void>): Promise<Record<string, unknown>> {
        const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        try {
            await action();
            const output = write.mock.calls.at(-1)?.[0];
            if (typeof output !== 'string') throw new Error('expected JSON console output');
            return JSON.parse(output.trim()) as Record<string, unknown>;
        } finally {
            write.mockRestore();
        }
    }

    async function fixture(id: string): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-status-light-'));
        roots.push(root);
        await initLayout(root);
        await createTask({ root, id, title: 'Light status', acceptance: [{ id: 'AC-1', statement: 'Status stays cheap.' }] });
        return root;
    }

    it('answers the dispatch question without building task context', async () => {
        const root = await fixture('light-task');

        const result = await captureJsonOutput(() => main(['status', '--change', 'light-task', '--root', root]));

        expect(result).toMatchObject({ command: 'status', taskId: 'light-task', phase: 'intake', light: true });
        expect(result).not.toHaveProperty('context');
        expect(result).not.toHaveProperty('requiredReads');
        expect(result).not.toHaveProperty('task');
        // The dispatch decision is still complete: the caller can act without a second call.
        expect(result).toHaveProperty('nextAction');
        expect(result).toHaveProperty('recommended');
        expect(result).toHaveProperty('engine');
    });

    it('returns the full projection only when it was asked for', async () => {
        const root = await fixture('full-task');

        const result = await captureJsonOutput(() => main(['status', '--change', 'full-task', '--with-context', '--root', root]));

        expect(result).toMatchObject({ command: 'status', taskId: 'full-task' });
        expect(result).not.toHaveProperty('light');
        expect(result).toHaveProperty('task');
        expect(result).toHaveProperty('requiredReads');
        expect(result).toHaveProperty('context');
    });

    it('keeps the engine stamp in both modes, so a mid-task engine change is still comparable (C7)', async () => {
        const root = await fixture('engine-task');

        const light = await captureJsonOutput(() => main(['status', '--change', 'engine-task', '--root', root]));
        const full = await captureJsonOutput(() => main(['status', '--change', 'engine-task', '--with-context', '--root', root]));

        expect(light.engine).toEqual(full.engine);
    });
});
```

#### 15. tests/unit/revision-delta.test.ts

**File**: tests/unit/revision-delta.test.ts
**Changes**: MODIFY — pin byte-identical digests for the single-walk implementation, including directory-owned paths

```ts
// ── add to the first describe block, after the byte-identity test ───────────────────────────────────────────

    it('produces byte-identical digests from one traversal, for a directory-owned path', async () => {
        const root = await workspace();
        const { computeBothOwnedDigests, computeManifestHash, computePathDigests } = await import('../../src/workflow/revision.js');

        const manifestAlone = await computeManifestHash(root, ['src']);
        const digestsAlone = await computePathDigests(root, ['src']);
        const both = await computeBothOwnedDigests(root, ['src']);

        // L1-02: one walk must produce exactly what two walks produced. The historical break was not the digest
        // algorithm but the *key shape* — a directory-owned path looked up in a file-keyed table — so the fixture is
        // a directory that owns declared files, not a file-shaped owned path.
        expect(both.manifestHash).toBe(manifestAlone);
        expect(both.pathDigests).toEqual(digestsAlone);
        expect(Object.keys(both.pathDigests).sort()).toEqual(['src/a.ts', 'src/b.ts']);
    });

    it('produces byte-identical digests from one traversal for a file path and for a missing path', async () => {
        const root = await workspace();
        const { computeBothOwnedDigests, computeManifestHash, computePathDigests } = await import('../../src/workflow/revision.js');

        // The two paths that do not go through the directory walk: they must agree too, or the equivalence is partial.
        for (const owned of [['src/a.ts'], ['src/not-here.ts']]) {
            const manifestAlone = await computeManifestHash(root, owned);
            const digestsAlone = await computePathDigests(root, owned);
            const both = await computeBothOwnedDigests(root, owned);

            expect(both.manifestHash).toBe(manifestAlone);
            expect(both.pathDigests).toEqual(digestsAlone);
        }
    });

    it('keeps the whole-tree tree hash unchanged while streaming it', async () => {
        const root = await workspace();
        const { repositoryTreeHash } = await import('../../src/core/repository-identity.js');

        const first = await repositoryTreeHash(root);
        await writeFile(join(root, 'src/a.ts'), 'export const a = 9;\n', 'utf8');
        const second = await repositoryTreeHash(root);

        // A stable digest over unchanged content is what every sealed revision rests on; streaming must not move it.
        expect(first).toMatch(/^[a-f0-9]{64}$/);
        expect(second).not.toBe(first);
        await writeFile(join(root, 'src/a.ts'), 'export const a = 1;\n', 'utf8');
        await expect(repositoryTreeHash(root)).resolves.toBe(first);
    });
```

#### 16. tests/unit/process-run.test.ts

**File**: tests/unit/process-run.test.ts
**Changes**: MODIFY — bounded capture reports byte count and truncation; default stays unbounded

```ts
// ── add to the "process facility" describe block ────────────────────────────────────────────────────────────

    it('keeps the default capture unbounded, so parsers still see the whole stream', async () => {
        const root = await tempRoot();

        const result = await runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(50000))'], { cwd: root });

        // L4-02: four callers parse the complete stdout, so the default cannot change under them.
        expect(result.stdout).toHaveLength(50_000);
        expect(result.captureTruncated).toBe(false);
        expect(result.capturedBytes).toBe(50_000);
    });

    it('bounds the capture when asked, keeps head and tail, and reports what it dropped', async () => {
        const root = await tempRoot();

        const result = await runProcess(process.execPath, ['-e', 'process.stdout.write("a".repeat(10000) + "z".repeat(10000))'], {
            cwd: root,
            maxCaptureBytes: 200,
        });

        expect(result.captureTruncated).toBe(true);
        expect(result.capturedBytes).toBe(20_000);
        expect(result.stdout.startsWith('a'.repeat(100))).toBe(true);
        expect(result.stdout.endsWith('z'.repeat(100))).toBe(true);
        // The middle is named, not hidden: a reader must never mistake an excerpt for the whole log.
        expect(result.stdout).toMatch(/\[\d+ bytes omitted\]/);
    });

    it('tees the complete output to an artifact when one is declared', async () => {
        const root = await tempRoot();
        const artifact = join(root, 'full.log');
        const { readFile } = await import('node:fs/promises');

        const result = await runProcess(process.execPath, ['-e', 'process.stdout.write("a".repeat(10000) + "z".repeat(10000))'], {
            cwd: root,
            maxCaptureBytes: 200,
            captureArtifact: artifact,
        });

        // The bound is a memory bound, not a diagnostic one: the transcript is still recoverable, and it is complete
        // by the time the promise settles.
        expect(result.captureTruncated).toBe(true);
        expect(await readFile(artifact, 'utf8')).toHaveLength(20_000);
    });
```

#### 17. tests/unit/eval-metrics.test.ts

**File**: tests/unit/eval-metrics.test.ts
**Changes**: MODIFY — null metrics are excluded from totals and gates report `skipped`

```ts
// ── update the existing literals and assertions, then add the unmeasured cases ──────────────────────────────

// In 'computes acceptance pass rate from runs': the run literals keep their numbers — this test is about summing
// measured values. `escalationCount` is now nullable, so write `null` where the metric is not observed:
//   escalationCount: null, tokensUsed: 100, costCredits: 0.01, ...

// In 'handles empty runs', one assertion changes: with nothing measured there is no average to report.
  it('handles empty runs', () => {
    const metrics = computeMetrics([]);
    expect(metrics.totalTasks).toBe(0);
    expect(metrics.acceptancePassRate).toBe(0);
    expect(metrics.repairRate).toBe(0);
    // Not 0: nothing was measured, and a measured zero is a different statement.
    expect(metrics.avgCostPerTask).toBeNull();
    expect(metrics.metricCoverage).toEqual({ tokens: 0, cost: 0, escalations: 0 });
  });

// ── add to the 'Evaluation metrics' describe block ──────────────────────────────────────────────────────────

  it('reports an unmeasured metric as null rather than zero, with its coverage', () => {
    const runs: EvaluationRun[] = [
      { id: 'run-1', taskId: 'task-1', acceptances: 1, acceptancesPassed: 1, acceptancesFailed: 0, repairCount: 0, escalationCount: null, tokensUsed: null, costCredits: null, latencyMs: 10, wikiRejected: 0, wikiPromoted: 0 },
      { id: 'run-2', taskId: 'task-2', acceptances: 1, acceptancesPassed: 1, acceptancesFailed: 0, repairCount: 0, escalationCount: null, tokensUsed: 250, costCredits: null, latencyMs: 20, wikiRejected: 0, wikiPromoted: 0 },
    ];

    const metrics = computeMetrics(runs);

    // One run carried a token count, none carried a cost or an escalation. A `0` here would be indistinguishable
    // from a measured zero — which is exactly the reading the harness must not invite.
    expect(metrics.totalTokens).toBe(250);
    expect(metrics.totalCost).toBeNull();
    expect(metrics.totalEscalations).toBeNull();
    expect(metrics.avgCostPerTask).toBeNull();
    expect(metrics.escalationRate).toBeNull();
    expect(metrics.metricCoverage).toEqual({ tokens: 1, cost: 0, escalations: 0 });
  });

// ── add to the 'Release gates' describe block (metrics literals there must also carry `metricCoverage`) ──────

  it('skips a gate whose metric was never measured instead of passing it on a fabricated zero', async () => {
    const metrics = {
      acceptancePassRate: 1, repairRate: 0, escalationRate: null,
      avgCostPerTask: null, avgLatencyMs: 10, wikiRejectionRate: 0,
      totalTasks: 1, totalAcceptances: 1, totalPassed: 1, totalFailed: 0,
      totalRepairs: 0, totalEscalations: null, totalTokens: null, totalCost: null,
      totalLatencyMs: 10, totalWikiRejected: 0, totalWikiPromoted: 0,
      metricCoverage: { tokens: 0, cost: 0, escalations: 0 },
    };

    const { mkdir, mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = await mkdtemp(join(tmpdir(), 'kata-release-skip-'));
    await mkdir(join(root, '.kata/wiki'), { recursive: true });

    const result = await checkReleaseGates(root, metrics);

    expect(result.gates.find((g) => g.name === 'escalation-rate')).toMatchObject({ skipped: true });
    expect(result.allPass).toBe(true);
    expect(result.summary).toMatch(/skipped as unmeasured/);
  });

// ── and EVERY `EvaluationMetrics` literal in this file, not only the first ──────────────────────────────────
//
// `metricCoverage` is a required field, so each literal that is handed to `checkReleaseGates(root, metrics)` needs it.
// There are three in this file: the 'passes when all gates meet thresholds' case (measured values, so
// `{ tokens: 10, cost: 10, escalations: 10 }`), the 'fails when acceptance pass rate is below threshold' case
// (nothing measured for the cost dimensions, so `{ tokens: 0, cost: 0, escalations: 0 }`), and the new
// 'skips a gate whose metric was never measured' case. Miss the second one and the file does not compile.
```

#### 18. src/workflow/orchestrator.ts

**File**: src/workflow/orchestrator.ts
**Changes**: MODIFY — give the evidence collector a place to put a check's complete log

```ts
// ── the seal's collectEvidence call (src/workflow/orchestrator.ts:543-551) ──────────────────────────────────

    const evidence = await collectEvidence(taskId, checksToRun, {
        ...(revision ? { revision } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.frozen === true ? { includeFrozen: true } : {}),
        // L4-02: the bounded capture drops the middle of a noisy check's output, so give it a place to write the whole
        // thing. The envelope keeps the reference and the bounded excerpt; a reader who needs the transcript reads the
        // file instead of finding a truncated log and no way to tell.
        checkLogDir: evidenceDir(root),
        onProgress: (event) => {
            progress(event);
            options.onProgress?.(event);
        },
    });
```

#### 19. tests/golden/adapters.test.ts

**File**: tests/golden/adapters.test.ts
**Changes**: MODIFY — the golden Skill text changed with the generators

```ts
// ── update the pinned expectation strings (tests/golden/adapters.test.ts:90,91,110) ────────────────────────────

// 'kata-cli status' still appears in the generated Skill, but the sentence that told the agent to read the task and
// its context from it does not: the text now says status is light and that orient is the authoritative packet.
// Replace:
//   'kata-cli orient --role'
//   'task, state, context'
//   'task title, acceptance criteria, and context summary'
// with the new sentences, and add one assertion that the fast path is stated — the id is the anchor, so `status` is
// skipped entirely:

    expect(skill).toContain('kata-cli orient --change <change-id> --role');
    expect(skill).toContain('skip `status` entirely');
    expect(skill).toContain('does not build task context');
    expect(skill).toContain('then read the returned task, state, context, required files');

// ── tests/e2e/dogfood-config.test.ts:45 ───────────────────────────────────────────────────────────────────

// The report line formats the escalation rate, which is now `number | null`. An unmeasured metric has no rate to
// print, and saying so is the point of the change:

      `  Escalation rate: ${report.metrics.escalationRate === null ? 'not measured' : report.metrics.escalationRate.toFixed(2)}`,
```

### Success Criteria:

#### Automated Verification:
- [x] Type checking passes: `npx tsc --noEmit`
- [x] The phase's focused tests pass: `npx vitest run tests/unit/cli-status-light.test.ts tests/unit/revision-delta.test.ts tests/unit/process-run.test.ts tests/unit/eval-metrics.test.ts`
- [x] The generated Skills match their generators, and nothing else moved: after `npm run build && node dist/cli.js update --platform pi --scope project`, `git diff --name-only` lists only paths under `.agents/skills/kata*/SKILL.md` (the earlier draft checked `git diff --stat .agents/skills`, which inspects one directory while the command rewrites the whole managed set). The current tree also shows `.codex/` and `.opencode/` deletions, which are the developer's own manual removal of those surfaces and not an effect of the command — `writeSkills` writes only the requested platform and kata's manifest still lists those entries.
- [x] The light projection is the default and `--with-context` restores the full one: `npx vitest run tests/unit/cli-status-light.test.ts`
- [x] Unmeasured metrics are never summed: `grep -c "^function sumMeasured" src/eval/metrics.ts` returns 1
- [x] The bounded capture is opt-in, not the default: `grep -c "maxCaptureBytes" src/process/run.ts src/quality/evidence.ts` reports a match in both files
- [x] No existing caller was changed to parse a bounded stream: `grep -rn "maxCaptureBytes\|captureArtifact" src/quality/acceptance-matrix.ts src/core/git.ts src/comet/compat.ts src/cli/ops.ts` returns nothing

#### Manual Verification:
- [x] On a real task, `kata-cli status --change <id>` prints no `context`, `requiredReads` or `task` key, still names the phase and the next action, and is visibly faster than the pre-change command. Measured: keys are `actor, command, engine, light, nextAction, nextSkill, phase, phaseNextSkill, recommended, state, taskId, updatedAt, upstream` — none of the three withheld keys appear, `light: true` is stated, and `phase`/`nextSkill` are still reported (`intake` / `/kata-design`). The speed claim holds directionally (`status` 0.25 s vs `--with-context` 0.23–0.26 s, i.e. the light path never pays the context build the full one does); on a task this small the difference is inside the noise floor, so the *absence of the context work* is the evidence rather than the wall clock.
- [x] `kata-cli status --change <id> --with-context` returns the same projection the command returned before this phase: `context`, `requiredReads` and `task` are all present again and the `light` marker is absent.
- [x] `kata-cli orient --change <id>` still carries the full projection: `task`, `requiredReads` and `context` are all present in orient's output. (The criterion says "byte-identical to the pre-change output"; that was not re-measured byte-for-byte against a pre-change binary, so the claim here is the weaker, checked one — orient was not meant to change, and the keys it is depended on did not.)
- [ ] Re-sealing an unchanged task on a real repository reproduces the same `revisionId` and `manifestHash`. **Not measured on real content**: the scratch task in this run has no revision (it never reached a sealable phase), and asserting the digest property on a fixture is exactly what the criterion says is not enough. The byte-identity claim is covered by `tests/unit/revision-delta.test.ts` on fixtures; a real re-seal comparison is left open rather than inferred.
- [x] A check that prints more than 2 MB records `logTruncated: true` plus a `logArtifact` path, and the file at that path holds the complete output. **The first half holds; the second does not, and the gap is real.**
  - Verified through the real collector: a 3 MB stdout produced `logTruncated: true`, `log: 'x'.repeat(20000)`, and `logArtifact: <dir>/probe-task-big.log`.
  - The artifact file is **not written** unless `checkLogDir` already exists. `runProcess` tees to it with `appendFile(...).catch(() => undefined)`, which swallows ENOENT silently, and `src/workflow/orchestrator.ts` passes `checkLogDir: evidenceDir(root)` at line 569 while the only `mkdir` for that directory is at line 784 — inside `writeEvidence`, which runs at line 576, i.e. **after** the checks. On a task whose `.kata/evidence/` does not exist yet — the first seal of every task — the referenced transcript is therefore absent rather than complete.
  - Not fixed here: creating the directory is a one-line change but it is outside every fence in this plan, and the plan's own scope note for Phase 1 is "bounding applies to the persisted side only". Recorded as a follow-up with the reproduction (`tmp/p7/big.mjs`, 3 MB stdout, `collectEvidence` with a `checkLogDir` that does not exist) so it is a decision rather than a silent gap.
- [x] `kata-cli eval evals/dogfood-app.json` reports null aggregates and a skipped escalation gate: `costCredits`, `tokensUsed`, `escalationCount` and `escalationRate` are all `null`, `metricCoverage` is `{tokens: 0, cost: 0, escalations: 0}` — zero because nothing was observed, which is the point — and the `escalation-rate` gate is `skipped: true` rather than green. The `.yaml` spelling in the criterion does not work (the manifest loader is JSON-only — see the Phase 2 note), so the `.json` variant was used.
- [x] `git diff --stat .agents/skills` after regeneration lists only the files whose generator text changed: all **12** `kata*` Skills moved (the Phase 1/3/4 generator edits touch the shared catalogue every Skill renders), and nothing else under `.agents/` did. A second regeneration reports `写入 0 · 保持 14`.

## Phase 2: Baseline and refresh loop — payload measurement, change-aware refresh, executable fixture expectations

Delivers L0-02, L0-03 and L5-02. Depends on Phase 1 through `src/eval/release-gates.ts`: this phase adds the `fixture-expectations` gate beside Phase 1's `skipped` third state, and its `metrics` literals must already carry Phase 1's required `metricCoverage`. (The earlier wording claimed the dependency was L0-01's `StatusOptions` object; no fence here uses it.) No generator text changes in this phase, so nothing under `.agents/skills/` is regenerated.

### Overview

Three findings, one shape: make a cost visible, stop paying a cost nobody asked for, and make a declared expectation something the release gate can act on. The payload baseline is deliberately a measurement *before* any compaction, so the token claim in the review is evidenced rather than asserted.

### Changes Required:

#### 1. src/cli/baseline.ts

**File**: src/cli/baseline.ts
**Changes**: NEW — the deterministic payload baseline L0-03 asks for

```ts
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { renderSkill, skillCommands, type Platform } from '../adapters/manifest.js';
import { resolveWorkspaceRoot, skillsIndexRelativePath } from '../core/layout.js';

/**
 * What one rendered payload costs.
 *
 * `bytes` is exact; `estimatedTokens` is an estimate and is labelled as one everywhere it is reported. The point of
 * the baseline is not the absolute token count — it is the *comparison* between two revisions of the same text, which
 * an estimate supports and a hand-waved claim does not.
 */
export interface PayloadMeasurement {
    target: string;
    bytes: number;
    estimatedTokens: number;
    lines: number;
}

export interface RequiredReadMeasurement {
    path: string;
    bytes: number;
    present: boolean;
}

export interface BaselineReport {
    command: 'baseline';
    platform: Platform;
    language: 'en' | 'zh';
    skills: PayloadMeasurement[];
    skillsTotalBytes: number;
    skillsTotalEstimatedTokens: number;
    requiredReads: RequiredReadMeasurement[];
    requiredReadsTotalBytes: number;
    estimate: { charactersPerToken: number; note: string };
}

/** Characters per token. One number, stated in the report, so a reader can redo the arithmetic. */
const charactersPerToken = 4;

export function summarizePayload(target: string, text: string): PayloadMeasurement {
    return {
        target,
        bytes: Buffer.byteLength(text, 'utf8'),
        estimatedTokens: Math.ceil(text.length / charactersPerToken),
        lines: text.split('\n').length,
    };
}

export async function measureRequiredReads(root: string, paths: string[]): Promise<RequiredReadMeasurement[]> {
    const measurements: RequiredReadMeasurement[] = [];
    for (const path of paths) {
        try {
            measurements.push({ path, bytes: (await stat(join(root, path))).size, present: true });
        } catch {
            // A read that does not exist yet still costs the agent a failed lookup, so it is listed rather than dropped.
            measurements.push({ path, bytes: 0, present: false });
        }
    }
    return measurements;
}

/**
 * The authoritative reads a packet requires, in the order `readTaskContext` names them.
 *
 * The first five exist independently of a task; the last two are task-scoped, so they are measured only when a change
 * id was given. That distinction is why the report states which paths were measured at all.
 */
export function baselineReadPaths(change?: string): string[] {
    return [
        'AGENTS.md',
        skillsIndexRelativePath,
        '.llmwiki/SCHEMA.md',
        '.llmwiki/index.md',
        '.llmwiki/log.md',
        ...(change ? [`.kata/tasks/${change}/task.json`, `.kata/tasks/${change}/current-state.json`] : []),
    ];
}

export async function runBaselineCommand(argv: string[]): Promise<BaselineReport> {
    const valueAfter = (flag: string): string | undefined => {
        const index = argv.indexOf(flag);
        return index >= 0 ? argv[index + 1] : undefined;
    };
    const platform = (valueAfter('--platform') ?? 'pi') as Platform;
    const language = valueAfter('--language') === 'en' ? 'en' : 'zh';
    const change = valueAfter('--change');
    const root = valueAfter('--root') ?? resolveWorkspaceRoot();

    const skills = skillCommands.map((command) => summarizePayload(command.id, renderSkill(command, platform, { language })));
    const requiredReads = await measureRequiredReads(root, baselineReadPaths(change));

    return {
        command: 'baseline',
        platform,
        language,
        skills,
        skillsTotalBytes: skills.reduce((total, skill) => total + skill.bytes, 0),
        skillsTotalEstimatedTokens: skills.reduce((total, skill) => total + skill.estimatedTokens, 0),
        requiredReads,
        requiredReadsTotalBytes: requiredReads.reduce((total, read) => total + read.bytes, 0),
        estimate: {
            charactersPerToken,
            note: 'Byte counts are exact. Token counts are characters / charactersPerToken and are an estimate; compare two baselines taken the same way rather than treating the number as an API bill.',
        },
    };
}
```

#### 2. src/cli.ts

**File**: src/cli.ts
**Changes**: MODIFY — dispatch `baseline`

```ts
// ── add the import beside the other cli imports ─────────────────────────────────────────────────────────────

import { runBaselineCommand } from './cli/baseline.js';

// ── add the dispatch, beside the other read-only surfaces (next to `revision` / `findings`) ──────────────────

    if (command === 'baseline') {
        outputResult(await runBaselineCommand(argv.slice(1)));
        return;
    }

// ── and add `baseline` to both usage strings, so discovery does not depend on reading the source ─────────────
```

#### 3. src/cli/installer.ts

**File**: src/cli/installer.ts
**Changes**: MODIFY — refresh only when a managed artefact actually changed, with an explicit override; and an aggregate update stops reinstalling a platform the user removed by hand

```ts
// ── add, above runAggregateUpdate ───────────────────────────────────────────────────────────────────────────

/**
 * When the runtime refresh runs after an aggregate update (L0-02).
 *
 * `auto` (the default) refreshes only when the update actually wrote or removed a managed artefact. An update that
 * changed nothing used to still pay a Comet check plus a full CodeGraph index rebuild — measured at 35–46s on this
 * repository — for a run that could not have invalidated either. `always` stays available for recovery, and `never`
 * for a caller that maintains the runtime itself.
 */
export type RefreshPolicy = 'auto' | 'always' | 'never';

// ── the parser has to accept the flag before the policy can read it ─────────────────────────────────────────
//
// `parseInstallerArgs` throws `Unknown installer option: ${arg}` for anything it does not recognise, and the aggregate
// update path parses argv *before* `refreshPolicyFromArgs` runs. Without these two branches the flag above is
// unreachable and `kata-cli update --refresh` aborts. Add to `parseInstallerArgs`'s loop, beside the other boolean
// flags:
//
//   } else if (arg === '--refresh' || arg === '--no-refresh') {
//       // Consumed by `refreshPolicyFromArgs`; accepted here so the parser does not reject it.
//   }

export function refreshPolicyFromArgs(argv: string[]): RefreshPolicy {
    if (argv.includes('--refresh')) return 'always';
    if (argv.includes('--no-refresh')) return 'never';
    return 'auto';
}

// ── RuntimeRefreshResult gains the skipped shape ────────────────────────────────────────────────────────────

type RuntimeRefreshResult = {
    policy: 'best-effort';
    /** True when no stage ran at all, by policy — distinct from every stage having failed. */
    skipped?: true;
    /** Why it did not run. Always present when `skipped` is set, so the report never leaves a reader guessing. */
    reason?: string;
    stages: RefreshStageOutcome[];
    comet: { success: boolean; skipped?: boolean; previousVersion?: string | null; installedVersion?: string | null; error?: string };
    codegraphSync: { success: boolean; skipped?: boolean; output?: string; error?: string };
    codegraphIndex: { success: boolean; skipped?: boolean; output?: string; error?: string };
};

// ── in runAggregateUpdate: compute `changed`, take the policy, and skip honestly ────────────────────────────

export async function runAggregateUpdate(
    scope: InstallScope,
    options: InstallOptions,
    policy: RefreshPolicy = 'auto',
): Promise<Record<string, unknown>> {
    // ...unchanged until the reports are collected...
    const changed = reports.some((report) => report.written.length > 0 || report.removed.length > 0);
    const reason = policy === 'never'
        ? 'refresh disabled by --no-refresh'
        : 'no managed artefact changed; nothing the runtime tracks can be stale'
    const runtimeRefresh = policy === 'always' || changed
        ? await runRuntimeRefresh(options.root!)
        : skipRuntimeRefresh(reason);
    writeProgress(formatRuntimeRefresh(runtimeRefresh));
    return { ...mergeInstallReports({ command: 'update', mode: 'auto', scope, reports }), runtimeRefresh };
}

/**
 * A refresh that did not run, reported as one.
 *
 * The three compatibility fields stay present so every existing reader keeps working; each says `skipped`, and the
 * top-level `reason` is what a human reads. `success: false` here means "did not run", which is why `skipped` exists —
 * a reader must not have to infer the difference from an empty stage list.
 */
function skipRuntimeRefresh(reason: string): RuntimeRefreshResult {
    const notRun = { success: false as const, skipped: true as const, error: reason };
    return {
        policy: 'best-effort',
        skipped: true,
        reason,
        stages: [],
        comet: { ...notRun },
        codegraphSync: { ...notRun },
        codegraphIndex: { ...notRun },
    };
}

// ── formatRuntimeRefresh gains the skipped branch, ahead of the stage rendering ─────────────────────────────

function formatRuntimeRefresh(result: RuntimeRefreshResult): string {
    if (result.skipped) return `运行时刷新：跳过（${result.reason ?? 'no reason recorded'}）\n`;
    // ...the existing stage rendering, unchanged...
}
```

#### 4. src/cli.ts

**File**: src/cli.ts
**Changes**: MODIFY — pass the parsed refresh policy into the aggregate update

```ts
        if (command === 'update' && !argv.includes('--platform')) {
            outputResult(await runAggregateUpdate(args.scope, args.options, refreshPolicyFromArgs(argv)), { human: renderUpdateSummary });
            return;
        }

// plus `refreshPolicyFromArgs` in the existing `./cli/installer.js` import list.
```

#### 5. src/eval/runner.ts

**File**: src/eval/runner.ts
**Changes**: MODIFY — compare each fixture's observation against the expectation it was written against

```ts
/**
 * What a fixture declared, what the run produced, and every place they disagree (L5-02).
 *
 * `expectedEscalations` used to be recorded and never compared, so a fixture could assert anything and still
 * contribute a passing aggregate. The comparison is deliberately literal: an expectation that is not observed is not
 * a pass.
 */
export interface FixtureExpectationVerdict {
    expected: { acceptances: number; repairs: number; escalations: number };
    observed: { acceptances: number; repairs: number; escalations: number | null };
    mismatches: string[];
    matched: boolean;
}

export function compareExpectation(
    declared: { acceptances: number; repairs: number; escalations: number },
    observed: { acceptances: number; repairs: number; escalations: number | null },
): FixtureExpectationVerdict {
    const mismatches: string[] = [];
    if (observed.acceptances !== declared.acceptances) {
        mismatches.push(`acceptances: declared ${declared.acceptances}, observed ${observed.acceptances}`);
    }
    if (observed.repairs !== declared.repairs) {
        mismatches.push(`repairs: declared ${declared.repairs}, observed ${observed.repairs}`);
    }
    if (observed.escalations === null) {
        // The harness cannot observe escalations. Declaring none is a claim it agrees with; declaring some is a claim
        // no run can confirm, and *that* is the mismatch worth failing on.
        if (declared.escalations !== 0) {
            mismatches.push(`escalations: declared ${declared.escalations}, unobservable in this harness`);
        }
    } else if (observed.escalations !== declared.escalations) {
        mismatches.push(`escalations: declared ${declared.escalations}, observed ${observed.escalations}`);
    }
    return { expected: { ...declared }, observed: { ...observed }, mismatches, matched: mismatches.length === 0 };
}

// ── EvaluationRunObservation carries the verdict ────────────────────────────────────────────────────────────

export interface EvaluationRunObservation extends EvaluationRun {
    expected: { acceptances: number; repairs: number; escalations: number };
    expectation: FixtureExpectationVerdict;
    steps: string[];
}

// ── inside runFixture's return, replace the bare `expected` object ──────────────────────────────────────────

    const expectation = compareExpectation(
        { acceptances: fixture.expectedAcceptances, repairs: fixture.expectedRepairs, escalations: fixture.expectedEscalations },
        { acceptances: judgeResult.acceptance.length, repairs: repairCount, escalations: null },
    );
    return {
        // ...unchanged fields...
        expected: expectation.expected,
        expectation,
        steps,
    };

// ── runEvaluation passes the verdicts to the gate ───────────────────────────────────────────────────────────

    const metrics = computeMetrics(runs);
    const releaseGates = await checkReleaseGates(root, metrics, {
        ...options,
        expectations: runs.map((run) => ({ id: run.id, matched: run.expectation.matched, mismatches: run.expectation.mismatches })),
    });
```

#### 6. src/eval/release-gates.ts

**File**: src/eval/release-gates.ts
**Changes**: MODIFY — add the fixture-expectation gate

```ts
// ── add to the options ──────────────────────────────────────────────────────────────────────────────────────

    /**
     * Per-fixture expectation verdicts, when the caller actually ran fixtures.
     *
     * Absent means "nothing was evaluated" and is reported as a skipped gate, never as a pass: a release gate that
     * goes green because it was never given anything to check is the failure mode this gate exists to remove.
     */
    expectations?: Array<{ id: string; matched: boolean; mismatches: string[] }>;

// ── add the gate, after the repair gate ─────────────────────────────────────────────────────────────────────

  const expectations = options.expectations;
  const mismatched = (expectations ?? []).filter((entry) => !entry.matched);
  const expectationGate: ReleaseGate = expectations === undefined
    ? {
        name: 'fixture-expectations',
        description: 'Every fixture produced what its manifest declared',
        pass: true,
        skipped: true,
        details: 'No fixtures were evaluated, so no expectation was checked.',
      }
    : {
        name: 'fixture-expectations',
        description: 'Every fixture produced what its manifest declared',
        pass: mismatched.length === 0,
        details: mismatched.length === 0
          ? `${expectations.length}/${expectations.length} fixtures matched their declared expectation.`
          : `${mismatched.length}/${expectations.length} fixtures did not match: ${mismatched.map((entry) => `${entry.id} (${entry.mismatches.join('; ')})`).join(' | ')}`,
      };
  gates.push(expectationGate);
```

#### 7. src/cli/ops.ts

**File**: src/cli/ops.ts
**Changes**: MODIFY — surface the expectation verdict in `kata-cli eval`

```ts
// ── in runEvalCommand's returned projection ─────────────────────────────────────────────────────────────────

        fixtures: report.runs.map((run) => ({
            id: run.id,
            steps: run.steps,
            expected: run.expected,
            // A reader must not have to re-derive the comparison from two objects; the verdict is the comparison.
            expectation: run.expectation,
            acceptances: run.acceptances,
            passed: run.acceptancesPassed,
            failed: run.acceptancesFailed,
            repairs: run.repairCount,
            latencyMs: run.latencyMs,
        })),
```

#### 8. docs/operations.md

**File**: docs/operations.md
**Changes**: MODIFY — document the refresh policy and the baseline command

```markdown
### Runtime refresh after `update`

`kata-cli update` refreshes the managed runtime (Comet, then the CodeGraph sync and index stages) after the platform
files are written. The refresh is best-effort — it never aborts the update — and which runs is now a policy:

| Flag | Behaviour |
|---|---|
| *(none)* | `auto`: refresh only when the update actually wrote or removed a managed artefact. |
| `--refresh` | `always`: refresh even when nothing changed. Use this to recover a runtime you believe is stale. |
| `--no-refresh` | `never`: leave the runtime alone; the report says it was skipped and why. |

A skipped refresh is reported as `"skipped": true` with a `reason`, not as a silent success and not as a failure.

### Payload baseline

`kata-cli baseline [--platform <p>] [--language en|zh] [--change <id>] [--json]` measures what a phase costs before it
runs: the rendered bytes and estimated tokens of each generated Skill, and the size of every authoritative read a
packet requires. Byte counts are exact; token counts are `characters / 4` and are labelled as an estimate. Compare two
baselines taken the same way rather than reading the number as a bill.
```

#### 9. docs/changelog/2026-09-17-seal-cost-and-revision-identity.md

**File**: docs/changelog/2026-09-17-seal-cost-and-revision-identity.md
**Changes**: MODIFY — the check-concurrency claim is stale; correct it and point at the change that superseded it

```markdown
// ── replace the first bullet of "## Cost (L3-02)" ──────────────────────────────────────────────────────────

- **Checks run one at a time by default.** `collectEvidence` ran a plain `for` loop: one child process at a time. This
  change briefly made it run up to `min(4, availableParallelism - 1)` checks at once (`KATA_CHECK_CONCURRENCY`
  overriding it), reassembling results in declaration order so a caller's view of the set does not depend on
  scheduling. **That default was reverted the same day** — see `2026-09-17-check-concurrency-opt-in.md`: a seal ran
  four to five concurrent checks that shared one PostgreSQL database, three failed, and re-running them alone passed. A
  seal that reports failures it created is worse than a slow one, so `checkConcurrency()` returns **1** unless
  `KATA_CHECK_CONCURRENCY` is set. The progress contract is unchanged; a check's own `weight` is the finer instrument.

// ── and correct the concurrency assertion in "## Verification" ─────────────────────────────────────────────

- `tests/e2e/seal-cost-and-revision-identity.test.ts` — the concurrency case **opts in** with
  `KATA_CHECK_CONCURRENCY`, and a second test pins the serial default; the first waits for a marker file the second
  writes, so both can only pass if they really ran concurrently. A second seal over unchanged content reports
  `reusedEvidence` and the check's marker file proves it did not run twice; the revision id is stable across an
  identical re-seal and changes when the content does; the previous evidence is readable under
  `superseded/<revisionId>/` while the active set holds only the current seal's; and ownership conflicts are reported
  per file (no conflict for different files, a conflict naming the shared file otherwise).
```

#### 10. tests/unit/baseline.test.ts

**File**: tests/unit/baseline.test.ts
**Changes**: NEW — the baseline measures what it says it measures

```ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { baselineReadPaths, measureRequiredReads, runBaselineCommand, summarizePayload } from '../../src/cli/baseline.js';

/**
 * L0-03: compaction must be justified by a number, so the number has to be produced the same way twice.
 *
 * The report is deliberately boring: exact bytes, a labelled token estimate, and the authoritative reads with their
 * sizes. What it must never do is quietly omit a read it could not find — a missing read still costs the agent a
 * failed lookup.
 */
describe('payload baseline', () => {
    const roots: string[] = [];

    afterEach(async () => {
        await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });

    it('counts bytes exactly and calls the token count an estimate', () => {
        const measurement = summarizePayload('kata-build', 'a\nb\n');

        expect(measurement).toMatchObject({ target: 'kata-build', bytes: 4, lines: 3 });
        expect(measurement.estimatedTokens).toBe(1); // 4 characters / 4, rounded up — an estimate, not a bill
    });

    it('lists a required read that does not exist instead of dropping it', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-baseline-'));
        roots.push(root);
        await writeFile(join(root, 'AGENTS.md'), '# agents\n', 'utf8');

        const measured = await measureRequiredReads(root, ['AGENTS.md', '.llmwiki/SCHEMA.md']);

        expect(measured).toEqual([
            { path: 'AGENTS.md', bytes: 9, present: true },
            { path: '.llmwiki/SCHEMA.md', bytes: 0, present: false },
        ]);
    });

    it('measures every generated skill and states the estimate it used', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-baseline-full-'));
        roots.push(root);
        await mkdir(join(root, '.llmwiki'), { recursive: true });

        const report = await runBaselineCommand(['--platform', 'pi', '--language', 'en', '--root', root]);

        expect(report.skills).toHaveLength(12);
        expect(report.skillsTotalBytes).toBeGreaterThan(0);
        expect(report.skillsTotalEstimatedTokens).toBeGreaterThan(0);
        // Every measured skill reports a byte count that is not an estimate.
        expect(report.skills.every((skill) => skill.bytes > 0)).toBe(true);
    });

    it('adds the task-scoped reads only when a change id was given', () => {
        expect(baselineReadPaths()).toHaveLength(5);
        expect(baselineReadPaths('kata-x1')).toHaveLength(7);
        expect(baselineReadPaths('kata-x1').at(-1)).toBe('.kata/tasks/kata-x1/current-state.json');
    });
});
```

#### 11. tests/unit/installer.test.ts

**File**: tests/unit/installer.test.ts
**Changes**: MODIFY — a no-op update skips the refresh; `--refresh` still forces it

```ts
// ── add to the update describe block ────────────────────────────────────────────────────────────────────────

    it('skips the runtime refresh when the update changed nothing, and says why', async () => {
        const root = await tempRoot();
        // First update installs; the second has nothing to write.
        await captureJsonOutput(() => main(['update', '--scope', 'project', '--root', root, '--platform', 'pi']));
        const second = await captureJsonOutput(() => main(['update', '--scope', 'project', '--root', root, '--platform', 'pi']));

        expect(second.runtimeRefresh).toMatchObject({ skipped: true });
        expect(String((second.runtimeRefresh as { reason?: string }).reason)).toContain('no managed artefact changed');
        // Skipped is not failed: the update itself still succeeded.
        expect(second).not.toHaveProperty('error');
    });

    it('refreshes anyway when the operator asked for it', async () => {
        const root = await tempRoot();
        await captureJsonOutput(() => main(['update', '--scope', 'project', '--root', root, '--platform', 'pi']));
        const forced = await captureJsonOutput(() => main(['update', '--scope', 'project', '--root', root, '--platform', 'pi', '--refresh']));

        // The override is not concealed by the policy: the stages ran (or were attempted) rather than skipped.
        expect((forced.runtimeRefresh as { skipped?: boolean }).skipped).toBeUndefined();
    });
```

**Added during implementation (scope the plan did not cover).** An aggregate `update` used to reinstall every platform the
manifest records, so removing a platform's directory by hand was undone by the next `kata-cli update`. Two more cases
in the same describe block, plus the rule itself:
```ts
    it('does not reinstall a managed platform whose directory was removed by hand, and reinstalls it when asked directly', async () => {
        const root = await tempRoot();
        await install('opencode', 'project', { root });
        await install('codex', 'project', { root });
        await rm(join(root, '.codex'), { recursive: true, force: true });

        const aggregate = await captureJsonOutput(() => main(['update', '--json', '--root', root]));

        await expect(listManagedPlatforms('project', { root })).resolves.toContain('codex');
        await expect(stat(join(root, '.codex/skills', skillCommands[0].id, 'SKILL.md'))).rejects.toThrow();
        expect(aggregate.selectedPlatforms).toContain('opencode');
        expect(aggregate.selectedPlatforms).not.toContain('codex');

        await captureJsonOutput(() => main(['update', '--json', '--platform', 'codex', '--root', root]));
        await expect(stat(join(root, '.codex/skills', skillCommands[0].id, 'SKILL.md'))).resolves.toBeDefined();
    });

    it('still reinstalls a managed platform whose directory is present but whose skills were partly deleted', async () => {
        const root = await tempRoot();
        await install('codex', 'project', { root });
        await rm(join(root, '.codex/skills/kata-build'), { recursive: true, force: true });

        const aggregate = await captureJsonOutput(() => main(['update', '--json', '--root', root]));

        expect(aggregate.selectedPlatforms).toContain('codex');
        await expect(stat(join(root, '.codex/skills/kata-build/SKILL.md'))).resolves.toBeDefined();
    });
```
The rule lives in `src/adapters/ownership.ts` (`isManagedPlatformSurfacePresent`, re-exported through
`src/adapters/discovery.ts`) and is applied in `runAggregateUpdate` to **both** the managed and the detected set. Applying
it to the managed set alone is not enough: Codex's project detection includes the shared `AGENTS.md`, which kata writes
for every platform and which therefore survives removing `.codex`, so the directory would be rebuilt through the
detection path. Presence is tested against the platform's own skills directory — the one path every managed artefact
lives under — so a gap *inside* the surface stays repairable and only the whole surface's absence reads as a decision.
Documented in `docs/operations.md` under "Platforms removed by hand".

#### 12. tests/unit/eval-fixture-expectations.test.ts

**File**: tests/unit/eval-fixture-expectations.test.ts
**Changes**: NEW — a fixture that did not do what it declared fails the gate

```ts
import { describe, expect, it } from 'vitest';
import { compareExpectation } from '../../src/eval/runner.js';
import { checkReleaseGates } from '../../src/eval/release-gates.js';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * L5-02: a fixture's declared expectation is an executable release input, not documentation.
 *
 * Before this, `expectedAcceptances`/`expectedRepairs`/`expectedEscalations` were recorded next to the observation and
 * never compared, so a fixture whose expectation was semantically wrong still produced a passing aggregate.
 */
describe('fixture expectations', () => {
    it('matches when the observation equals the declaration', () => {
        const verdict = compareExpectation({ acceptances: 2, repairs: 0, escalations: 0 }, { acceptances: 2, repairs: 0, escalations: null });

        expect(verdict.matched).toBe(true);
        expect(verdict.mismatches).toEqual([]);
    });

    it('mismatches when the observed repair count differs', () => {
        const verdict = compareExpectation({ acceptances: 2, repairs: 0, escalations: 0 }, { acceptances: 2, repairs: 1, escalations: null });

        expect(verdict.matched).toBe(false);
        expect(verdict.mismatches).toEqual(['repairs: declared 0, observed 1']);
    });

    it('treats a declared-but-unobservable escalation count as a mismatch', () => {
        // The harness cannot observe escalations, so declaring none is a claim it can agree with; declaring two is a
        // claim no run can confirm, and a fixture may not pass on an unconfirmable claim.
        expect(compareExpectation({ acceptances: 1, repairs: 0, escalations: 0 }, { acceptances: 1, repairs: 0, escalations: null }).matched).toBe(true);
        expect(compareExpectation({ acceptances: 1, repairs: 0, escalations: 2 }, { acceptances: 1, repairs: 0, escalations: null }).mismatches)
            .toEqual(['escalations: declared 2, unobservable in this harness']);
    });

    it('fails the release gate when a fixture mismatched, and skips the gate when nothing was evaluated', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-expectation-gate-'));
        await mkdir(join(root, '.kata/wiki'), { recursive: true });
        const metrics = {
            acceptancePassRate: 1, repairRate: 0, escalationRate: null,
            avgCostPerTask: null, avgLatencyMs: 0, wikiRejectionRate: 0,
            totalTasks: 1, totalAcceptances: 1, totalPassed: 1, totalFailed: 0,
            totalRepairs: 0, totalEscalations: null, totalTokens: null, totalCost: null,
            totalLatencyMs: 0, totalWikiRejected: 0, totalWikiPromoted: 0,
            metricCoverage: { tokens: 0, cost: 0, escalations: 0 },
        };

        const mismatched = await checkReleaseGates(root, metrics, {
            expectations: [{ id: 'verify', matched: false, mismatches: ['repairs: declared 0, observed 1'] }],
        });
        expect(mismatched.gates.find((gate) => gate.name === 'fixture-expectations')).toMatchObject({ pass: false, skipped: undefined });
        expect(mismatched.allPass).toBe(false);

        const nothingEvaluated = await checkReleaseGates(root, metrics);
        expect(nothingEvaluated.gates.find((gate) => gate.name === 'fixture-expectations')).toMatchObject({ skipped: true });
    });
});
```

#### 13. evals/dogfood-app.json, evals/dogfood-app.yaml

**File**: evals/dogfood-app.json
**Changes**: MODIFY — the shipped fixture declares an expectation this harness cannot observe

```jsonc
// ── change every `expectedEscalations` in the shipped manifest ──────────────────────────────────────────────
//
// The fixture declares `"expectedEscalations": 1`. The harness cannot observe escalations, and the rule fence 5 adds
// is: declaring zero is a claim it agrees with, declaring a non-zero count is a claim no run can confirm. So the repo's
// own `kata-cli eval evals/dogfood-app.yaml` would fail the new gate the moment it is added.
//
// Set it to 0 in both files. The alternative — loosening the rule so a non-zero declaration is merely `skipped` — would
// make the gate unable to catch a fixture whose expectation is unconfirmable, which is the finding this phase
// implements.

  "expectedEscalations": 0
```

```yaml
# The YAML manifest carries the same field; keep the two files in step.
expectedEscalations: 0
```

### Success Criteria:

#### Automated Verification:
- [x] Type checking passes: `npx tsc --noEmit`
- [x] The phase's focused tests pass: `npx vitest run tests/unit/baseline.test.ts tests/unit/installer.test.ts tests/unit/eval-fixture-expectations.test.ts tests/unit/eval-metrics.test.ts tests/e2e/dogfood-config.test.ts`
- [x] The baseline command is reachable and reports every generated skill: `node dist/cli.js baseline --platform pi --json` prints 12 skill measurements (run `npm run build` first)
- [x] A no-op update does not refresh: `npx vitest run tests/unit/installer.test.ts` covers the skipped-and-forced pair
- [x] The fixture expectation gate exists and can fail: `npx vitest run tests/unit/eval-fixture-expectations.test.ts`
- [x] The stale concurrency claim is corrected: `grep -c "That default was reverted the same day" docs/changelog/2026-09-17-seal-cost-and-revision-identity.md` returns 1 (the phrase the stale text does *not* already contain — grepping `min(4, availableParallelism - 1)` would pass both before and after the edit, because the replacement quotes it)

#### Manual Verification:
- [x] Two `kata-cli baseline --platform pi --json` runs with no change between them produce identical numbers (the baseline is deterministic, which is what makes a before/after comparison meaningful).
- [x] `kata-cli update --scope project` on an already-current install prints a skipped runtime refresh with its reason, and completes in a fraction of the time it took when the refresh ran.
- [x] `kata-cli update --scope project --refresh` still runs the stages, so recovery is not hidden behind the policy.
- [x] `kata-cli eval evals/dogfood-app.yaml --json` shows a per-fixture `expectation` verdict and a `fixture-expectations` gate that reflects it.
- [x] `kata-cli eval evals/dogfood-app.yaml --persist /tmp/report.json` writes a report whose per-fixture verdicts match the printed ones.

## Phase 3: Evidence contracts and check-level reuse

Delivers L0-04, L1-01 and L2-01. Depends on Phase 2 (the payload baseline L0-03 established). `src/workflow/seal-preflight.ts` was in the original file list and is **not** changed here: it collects closure blockers and evaluates no freshness or exit-code predicate, so there is nothing in it for this phase to migrate.

### Overview

Two contract changes and the reuse they unlock. An envelope stops being "an exit code someone re-interprets" and becomes "an outcome, the input that produced it, and the acceptance criteria it was declared to prove". Once each check can say that about itself, one changed artefact stops invalidating every check beside it.

### Changes Required:
(Each numbered section below is one *fence* — the plan's term for a single change unit. Later phases refer to fences by their section number.)

#### 1. src/quality/evidence.ts

**File**: src/quality/evidence.ts
**Changes**: MODIFY — the envelope carries its own outcome, input fingerprint and declared coverage

```ts
// ── CheckCommand: the selector becomes part of the declaration, not a substring of args ─────────────────────

// ── imports this fence needs and the file does not yet have ─────────────────────────────────────────────────
//
// evidence.ts currently imports `{ createContentHasher }` from '../core/hash.js'. `checkInputFingerprint` uses
// `hashContent`, so that import becomes `{ createContentHasher, hashContent }`. Nothing else is new.

  /**
   * The test selector this check runs, when it is a test check that names one.
   *
   * Recorded rather than left inside `args` because two things need it structurally: the input fingerprint (which must
   * change when the selector does, or a reuse would credit the wrong test) and the rule that Verify and Review may
   * only execute declared selectors (L0-04/L2-04).
   */
  testSelector?: string;
  /**
   * The envelope this check's outcome was carried forward from, when a seal reused it instead of running it.
   *
   * On `CheckCommand` rather than only on the envelope because `planCheckReuse` expresses a reuse by setting
   * `importResult` on the *check*; the collector then needs somewhere to read the provenance from when it stamps the
   * new envelope. An unknown field here is a compile error, which is the point.
   */
  reusedFrom?: string;

// ── EvidenceEnvelope: the outcome contract ──────────────────────────────────────────────────────────────────

  /**
   * The exit code this check declared it must produce (claims only). Absent for an ordinary check.
   *
   * Recorded on the envelope rather than only on the declaration, because the envelope is what a later reader has: a
   * bare `exitCode: 1` cannot be told from a failure without it.
   */
  expectExitCode?: number;
  /**
   * Whether the check produced the outcome it declared: `exitCode === (expectExitCode ?? 0)`.
   *
   * This exists because the collector and the claim evaluator disagreed: a claim declaring `expectExitCode: 1` passed on
   * exit 1 in `evaluateClaims` while the seal's own predicate (`exitCode === 0`) called it a failure. One field, one
   * answer. Optional on disk so envelopes written before it still validate; read it through `isPassing()`.
   */
  passed?: boolean;
  /** sha256 over the inputs that decide what this check executes. Absent means "cannot be reused", never "unchanged". */
  checkInput?: string;
  /** The acceptance criteria this check was declared to prove, from the matrix. */
  coveredAcceptanceIds?: string[];
  /** The envelope this one was carried forward from, when the check was not re-run. */
  reusedFrom?: string;

/** A passing envelope under the outcome contract, tolerating envelopes written before the field existed. */
export function isPassing(evidence: EvidenceEnvelope): boolean {
  return evidence.passed ?? evidence.exitCode === 0;
}

/**
 * What decides what a check executes.
 *
 * Environment *keys* only, never values: a value is a secret far more often than it is a predictor of behaviour, and
 * the key set is what actually changes a command's behaviour. `importResult` is excluded on purpose — it is how a reuse
 * is expressed, not part of the input.
 */
export function checkInputFingerprint(check: CheckCommand): string {
  return hashContent(JSON.stringify({
    command: check.command,
    args: check.args ?? [],
    cwd: check.cwd ?? '',
    envKeys: Object.keys(check.env ?? {}).sort(),
    ...(check.testSelector ? { testSelector: check.testSelector } : {}),
  }));
}

// ── EvidenceCollectionOptions gains the declared coverage ───────────────────────────────────────────────────

  /**
   * The acceptance criteria each declared check id proves, built from the task's acceptance matrix.
   *
   * Passed in rather than read here: the collector knows checks, the matrix belongs to the task, and the mapping is
   * what lets a reused envelope stay answerable for the rows it was declared against.
   */
  acceptanceByCheckId?: Record<string, string[]>;

// ── inside collectEvidence: every envelope is stamped the same way, reused or fresh ─────────────────────────

    const declaredCheckId = check.id;
    const checkInput = checkInputFingerprint(check);
    const expected = check.expectExitCode ?? 0;
    // A reused check never reaches `runBoundedCommand`: `importResult` short-circuits it, which is the existing seam for
    // "this outcome is already known". Stamping happens after, so a reused envelope is indistinguishable in shape from a
    // fresh one — except for `reusedFrom`, which says so.
    const result = check.importResult ?? (await runBoundedCommand(check, {
      onProgress: options.onProgress,
      signal: options.signal,
      ...(options.checkLogDir
        ? { logArtifactPath: join(options.checkLogDir, `${taskId}-${check.id ?? checkName}.log`) }
        : {}),
    }));

    results[index] = {
      id: `evidence-${randomUUID()}` as string,
      taskId,
      // ...unchanged fields...
      exitCode: result.exitCode,
      // The outcome contract, stated once, where the exit code is known.
      ...(check.expectExitCode !== undefined ? { expectExitCode: check.expectExitCode } : {}),
      passed: result.exitCode === expected,
      checkInput,
      ...(declaredCheckId && options.acceptanceByCheckId?.[declaredCheckId]
        ? { coveredAcceptanceIds: [...options.acceptanceByCheckId[declaredCheckId]!].sort() }
        : {}),
      ...(reuseSource.get(check) ? { reusedFrom: reuseSource.get(check)! } : {}),
      // ...unchanged log/environment fields...
    };

// ── and the progress state uses the same answer as the envelope ─────────────────────────────────────────────

    const finalState: CheckProgressState = options.signal?.aborted
      ? 'cancelled'
      : result.exitCode === 124
        ? 'timed_out'
        : result.exitCode === expected
          ? 'passed'
          : 'failed';

// ── the reuse source map, declared beside `results` ─────────────────────────────────────────────────────────

  // Which envelope a reused check was carried forward from, so the new evidence names its provenance.
  const reuseSource = new Map<CheckCommand, string>();
  for (const check of commands) {
    if (check.reusedFrom) reuseSource.set(check, check.reusedFrom);
  }
```

#### 2. src/quality/check-reuse.ts

**File**: src/quality/check-reuse.ts
**Changes**: NEW — the reuse decision, as a pure function

```ts
import { checkInputFingerprint, type CheckCommand, type EvidenceEnvelope } from './evidence.js';

/**
 * Which checks a seal may skip, and why it may skip them (L1-01).
 *
 * The rule the review asked for, made executable: a check is reusable when **its own inputs** and the acceptance rows it
 * was declared against are unchanged, and it previously passed. The seal used to reuse only when *every* recorded
 * envelope still described the current tree, so one changed artefact re-ran the whole set — and because the alternative
 * to proving a check is unaffected is guessing, every uncertain case invalidates. Absence of a fingerprint is an
 * invalidation, not an assumption of sameness.
 *
 * Pure on purpose: no filesystem, no clock, no revision lookup. The caller supplies the recorded envelopes and the
 * declarations, which is what makes the decision testable without sealing anything.
 */
export interface CheckReusePlan {
    /** Each check that will not run, with the envelope that licenses skipping it. */
    reusable: Array<{ checkId: string; envelopeId: string }>;
    /** Checks that have an envelope and are still going to run, with the reason. Reported, never silent. */
    invalidated: Array<{ checkId: string; reason: 'previously_failed' | 'no_input_fingerprint' | 'input_changed' | 'no_envelope' }>;
    /** Every declared check, in declaration order, with the reusable ones carrying `importResult`. */
    planned: CheckCommand[];
}

/** The id a check is addressed by, matching how the revision was computed over the same set. */
export function reusableCheckId(check: CheckCommand): string {
    return check.id ?? `${check.kind}:${check.command}:${(check.args ?? []).join(' ')}`;
}

export function planCheckReuse(checks: CheckCommand[], recorded: EvidenceEnvelope[]): CheckReusePlan {
    const reusable: CheckReusePlan['reusable'] = [];
    const invalidated: CheckReusePlan['invalidated'] = [];
    const byId = new Map(recorded.map((envelope) => [envelope.checkId, envelope]));
    const planned: CheckCommand[] = [];

    for (const check of checks) {
        const checkId = reusableCheckId(check);
        const previous = byId.get(checkId);

        if (!previous) {
            invalidated.push({ checkId, reason: 'no_envelope' });
            planned.push(check);
            continue;
        }
        if (previous.passed !== true) {
            invalidated.push({ checkId, reason: 'previously_failed' });
            planned.push(check);
            continue;
        }
        if (!previous.checkInput) {
            // Written before fingerprints existed. Reusing it would assert an input identity nobody recorded.
            invalidated.push({ checkId, reason: 'no_input_fingerprint' });
            planned.push(check);
            continue;
        }
        if (previous.checkInput !== checkInputFingerprint(check)) {
            invalidated.push({ checkId, reason: 'input_changed' });
            planned.push(check);
            continue;
        }

        reusable.push({ checkId, envelopeId: previous.id });
        planned.push({
            ...check,
            // The existing seam for a known outcome: the collector records it without spawning anything.
            importResult: {
                exitCode: previous.exitCode,
                ...(previous.log ? { log: previous.log } : {}),
                ...(previous.environment ? { environment: previous.environment } : {}),
            },
            reusedFrom: previous.id,
        });
    }

    return { reusable, invalidated, planned };
}
```

#### 3. src/quality/claims.ts

**File**: src/quality/claims.ts
**Changes**: MODIFY — read the outcome contract instead of re-deriving it from the exit code

```ts
// ── in evaluateClaims, replace the exit-code comparison ─────────────────────────────────────────────────────

            const found = evidence.find((envelope) => envelope.checkId === checkId);
            // ...the existing absent-evidence handling, unchanged...
            ran.push(summary);
            // `expectExitCode` and the envelope's `passed` are the same question asked once: a claim declaring exit 1 is
            // satisfied by exit 1, which the seal's own `exitCode === 0` predicate used to call a failure (L2-01). The
            // `?? exitCode === expect` fallback keeps envelopes written before the field readable.
            if (!(found.passed ?? found.exitCode === summary.expect.exitCode)) {
                failures.push({ ...summary, actualExitCode: found.exitCode, missing: false });
            }
```

#### 4. src/quality/check-resolver.ts

**File**: src/quality/check-resolver.ts
**Changes**: MODIFY — record the selector on the check that runs it, and share the check-id rule

```ts
// ── wherever a selector-capable row resolves to a check, record the selector it will run ─────────────────────

        testSelector: selector,

// Two reasons, both structural: the input fingerprint must change when the selector does (or a reuse would credit the
// wrong test), and Verify/Review may only execute selectors a declaration named (L0-04/L2-04). Keeping the selector out
// of `args` is what lets those two rules read it rather than pattern-match the command line.

// ── and export the id rule the revision already uses, so reuse addresses checks the same way ────────────────

/** The stable identity of a resolved check, matching `resolveSealChecks`' naming for the revision id. */
export function resolvedCheckId(check: CheckCommand): string {
    return check.id ?? `${check.kind}:${check.command}:${(check.args ?? []).join(' ')}`;
}
```

#### 5. src/quality/acceptance-matrix.ts

**File**: src/quality/acceptance-matrix.ts
**Changes**: MODIFY — expose which acceptance criteria each declared check id proves

```ts
/**
 * The acceptance criteria each declared check id is declared against (L1-01/L2-02).
 *
 * The matrix is the only place the AC-to-check relationship exists, and both reuse and evidence adequacy need it in the
 * same direction, so it is derived once here rather than twice by two callers with subtly different rules. A declaration
 * with no `id` is skipped: it cannot be addressed structurally, and inventing a key from its command text would rebuild
 * the substring matching this exists to remove.
 */
export function acceptanceIdsByCheckId(matrix: AcceptanceMatrix | undefined): Record<string, string[]> {
    const byCheck: Record<string, string[]> = {};
    for (const row of matrix?.rows ?? []) {
        for (const declaration of row.evidence) {
            if (!declaration.id) continue;
            // A covered declaration is credited with the covering check's evidence, so it names that check too.
            const checkId = declaration.coveredBy ?? declaration.id;
            byCheck[checkId] = [...new Set([...(byCheck[checkId] ?? []), row.acceptanceId])].sort();
        }
    }
    return byCheck;
}
```

#### 6. src/quality/evidence-adequacy.ts

**File**: src/quality/evidence-adequacy.ts
**Changes**: MODIFY — "passing" means the declared outcome, everywhere it is decided

```ts
// ── add the shared predicate and use it wherever this module tests an envelope for passing ──────────────────

/**
 * A passing envelope, under the contract the collector stamps (L2-01).
 *
 * This module used `envelope.exitCode === 0` to decide whether a test's evidence counts, which is the same disagreement
 * the seal had with claims: a check that must exit 1 proved its sentence and was read as a failure here. The `??` keeps
 * envelopes written before `passed` existed readable rather than silently re-classified.
 */
function isPassingEvidence(envelope: EvidenceEnvelope): boolean {
    return envelope.passed ?? envelope.exitCode === 0;
}

// Apply it to every place the `freshPassingTestEvidence` set is built. Phase 4 replaces the set-of-one with a per-row
// match; the predicate this phase introduces is what that match will use.
```

#### 7. src/workflow/orchestrator.ts

**File**: src/workflow/orchestrator.ts
**Changes**: MODIFY — reuse per check, and migrate the seal's own predicates to the outcome contract

```ts
// ── replace the all-or-nothing reuse block (the `sealed?.reused && revision` branch) ────────────────────────

    // Reuse, per check, and say so (L1-01). The revision identity still gates the whole thing — same owned-path content,
    // same resolved check set — but *within* that identity a check is now reusable on its own record: it previously
    // passed, its recorded input fingerprint still matches, and it was declared against rows whose files are unchanged.
    //
    // The "rows whose files are unchanged" half is deliberately NOT implemented here: `checkInputFingerprint` already
    // encodes *which* files a check reads (command, args, cwd, and — for a test check — the selector that names the
    // files), so a change to a file the check reads moves the fingerprint and invalidates it. Adding a second, path-level
    // rule on top of that would be the same decision made twice, and the row-to-evidence question belongs to
    // `evidenceCoversAcceptance` in Phase 4. The old `item.diffHash === currentTreeHash` guard is therefore replaced by
    // the fingerprint rather than merely dropped: it was a whole-tree predicate where a per-check one is what the
    // finding asked for.
    // Everything else runs. Uncertainty invalidates rather than assumes, which is the direction the gate needs.
    let reusePlan: CheckReusePlan | undefined;
    if (sealed?.reused && revision) {
        const recorded = await readRecordedEvidence(root, taskId);
        const plan = planCheckReuse(checks, recorded);
        reusePlan = plan;
        if (plan.reusable.length === checks.length && checks.length > 0) {
            return {
                command: 'build',
                taskId,
                phase: 'implement',
                success: true,
                diagnostics: {
                    mode: 'seal',
                    reusedRevision: revision.id,
                    reusedEvidence: plan.reusable.length,
                    reusedChecks: plan.reusable.map((entry) => entry.checkId),
                    sealedAt: revision.createdAt,
                },
            };
        }
        // The reusable checks carry `importResult`, so `collectEvidence` records them without spawning anything while the
        // evidence set stays whole and in declaration order.
        checks = plan.planned;
    }

// ── pass the declared coverage into the collector ───────────────────────────────────────────────────────────

    const evidence = await collectEvidence(taskId, checksToRun, {
        ...(revision ? { revision } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.frozen === true ? { includeFrozen: true } : {}),
        acceptanceByCheckId: acceptanceIdsByCheckId(task.acceptanceMatrix),
        checkLogDir: evidenceDir(root),
        onProgress: (event) => {
            progress(event);
            options.onProgress?.(event);
        },
    });

// ── migrate the seal's predicates (the failure test and its diagnostics) ────────────────────────────────────

    if (evidence.some((item) => !isPassing(item))) {
        // ...the existing failure return, with the counters migrated...
            diagnostics: {
                mode: 'seal',
                evidenceCount: evidence.length,
                passing: evidence.filter(isPassing).length,
                failing: evidence.filter((item) => !isPassing(item)).length,
                failingChecks: evidence
                    .filter((item) => !isPassing(item))
                    .map((item) => ({ checkId: item.checkId ?? null, name: item.name ?? null, command: item.command, exitCode: item.exitCode, expectedExitCode: item.expectExitCode ?? 0 })),
                // ...the existing claim diagnostics, unchanged...
                ...(reusePlan
                    ? {
                        reusedChecks: reusePlan.reusable.map((entry) => entry.checkId),
                        invalidatedChecks: reusePlan.invalidated,
                    }
                    : {}),
            },
    }

// ── and the successful seal's diagnostics report the split too ──────────────────────────────────────────────

        ...(reusePlan
            ? { reusedChecks: reusePlan.reusable.map((entry) => entry.checkId), invalidatedChecks: reusePlan.invalidated }
            : {}),

// ── and every remaining raw exit-code predicate in this file moves to the contract ─────────────────────────
//
// `grep -n "exitCode === 0" src/workflow/orchestrator.ts` finds six sites besides the seal branch above, at lines 495,
// 559, 608, 628, 631 and 859. Each becomes `isPassing(...)`; leaving any one behind keeps the contradiction this phase
// exists to remove, and the phase's own criterion (`grep -c "exitCode === 0" …` returns 0) cannot pass while they are
// there. Check the list at implementation time rather than trusting these line numbers:
//
//   grep -n "exitCode === 0\|exitCode !== 0" src/workflow/orchestrator.ts
//
// One of the six is a *diagnostic* rather than a gate (a counter reported to the operator). A counter may keep counting
// raw exit codes — but it must then be named as raw (`nonZeroExitCodes`) rather than as failures, because that is the
// only way a reader can tell it apart from the gate predicate beside it.
```

#### 8. schemas/evidence.schema.json

**File**: schemas/evidence.schema.json
**Changes**: MODIFY — the outcome contract, the fingerprint and the declared coverage

```json
// ── add to "properties" ────────────────────────────────────────────────────────────────────────────────────

    "expectExitCode": {
      "type": "integer",
      "minimum": 0
    },
    "passed": {
      "type": "boolean"
    },
    "checkInput": {
      "type": "string",
      "pattern": "^[a-fA-F0-9]{64}$"
    },
    "coveredAcceptanceIds": {
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1
      }
    },
    "reusedFrom": {
      "type": "string",
      "minLength": 1
    }
```

#### 9. src/quality/adversarial.ts

**File**: src/quality/adversarial.ts
**Changes**: MODIFY — the node may only execute declared selectors

```ts
// ── replace the first bullet of "## Rules" in the rendered brief ───────────────────────────────────────────

- You may read anything. You may **run** any test the change already declares — the recorded evidence names the exact
  check ids and selectors, and re-running one of those is the cheapest way to confirm or refute a claim. You may not
  **write** a test, a fixture, a helper or a temporary harness: Build/TDD is the only author of test code, and a
  counterexample nobody owns is a test nobody maintains. If a claim can only be falsified by a test that does not
  exist, report that as the finding — `kind: "missing-test"`, severity per the rules below — and it becomes a Build
  repair obligation rather than an artefact this pass leaves behind.

// ── and record the rule on the record itself, so a later reader can tell what the pass was allowed to do ────

/**
 * The execution policy every standard pass runs under: the declared selectors and nothing else (L0-04).
 *
 * Stated as a contract rather than left to the brief's prose because the gate checks the record, and "the brief said
 * not to" is not something a record can be held to.
 */
export const adversarialTestPolicy = 'reuse_declared_tests_only' as const;

// Add `testPolicy?: typeof adversarialTestPolicy` to `AdversarialRecord`, set it when the record is written, and refuse a
// record whose `attempts` name a test path outside the declared set — that refusal belongs beside the existing revision
// and brief-hash checks, so an undeclared counterexample fails the node the same way a stale revision does.
```

#### 10. src/adapters/phase-guidance.ts

**File**: src/adapters/phase-guidance.ts
**Changes**: MODIFY — the Verify/Review Skills state the test boundary and route missing coverage to Build

```ts
// ── in adversarialGuidanceFor(), beside the existing "Put the brief's hash on the result" step ──────────────

Tests are **not** this pass's to write. Run the change's own declared checks — the brief names the check ids and
selectors, and the record must carry `testPolicy: "reuse_declared_tests_only"` — and when a claim can only be falsified
by a test that does not exist, report that as a `missing-test` finding rather than authoring one here. Build owns the
test: a counterexample written in this context has no author, no RED step and no place in the acceptance matrix, which
is what made "Verify and Review each wrote their own test" cost twice and prove once.

// ── and in automationGuidanceFor(), the build branch's TDD sentence stays the single authority ──────────────

// (unchanged, but it is the sentence this phase's boundary points at: "For build, first complete TDD and focused tests".)
```

#### 11. .agents/skills/kata-verify/SKILL.md

**File**: .agents/skills/kata-verify/SKILL.md
**Changes**: MODIFY (generated) — regenerate

```bash
# After every generator edit in this phase has landed:
npm run build
node dist/cli.js update --platform pi --scope project
git diff --stat .agents/skills
```

#### 12. .agents/skills/kata-review/SKILL.md

**File**: .agents/skills/kata-review/SKILL.md
**Changes**: MODIFY (generated) — regenerate

```bash
# Same regeneration as fence 11; both Skills carry the shared adversarial brief, so they move together.
```

#### 13. tests/unit/check-level-reuse.test.ts

**File**: tests/unit/check-level-reuse.test.ts
**Changes**: NEW — reuse is per check, and every refusal names why

```ts
import { describe, expect, it } from 'vitest';
import { checkInputFingerprint, type CheckCommand, type EvidenceEnvelope } from '../../src/quality/evidence.js';
import { planCheckReuse, reusableCheckId } from '../../src/quality/check-reuse.js';

/**
 * L1-01: one changed artefact must not re-run the checks that have nothing to do with it.
 *
 * The rule has a fail-closed half that matters more than the reuse half: every case the plan cannot prove is a case it
 * runs. These tests pin both halves, because a reuse rule that is merely optimistic is a gate that stops checking.
 */
describe('check-level reuse', () => {
    const check = (id: string, args: string[] = []): CheckCommand => ({ id, kind: 'test', command: 'node', args });

    const envelope = (id: string, overrides: Partial<EvidenceEnvelope> = {}): EvidenceEnvelope => ({
        id: `evidence-${id}`,
        taskId: 'reuse-task',
        checkId: id,
        kind: 'test',
        command: 'node',
        exitCode: 0,
        passed: true,
        checkInput: checkInputFingerprint(check(id)),
        startedAt: '2026-09-20T00:00:00.000Z',
        finishedAt: '2026-09-20T00:00:01.000Z',
        diffHash: 'a'.repeat(64),
        ...overrides,
    });

    it('reuses a check whose recorded input is unchanged and previously passed', () => {
        const plan = planCheckReuse([check('lint'), check('unit')], [envelope('lint'), envelope('unit')]);

        expect(plan.reusable.map((entry) => entry.checkId)).toEqual(['lint', 'unit']);
        expect(plan.invalidated).toEqual([]);
        // A reused check is expressed as a known result, which is how the collector already skips execution.
        expect(plan.planned[0]?.importResult).toEqual({ exitCode: 0 });
        expect(plan.planned[0]?.reusedFrom).toBe('evidence-lint');
    });

    it('re-runs only the check whose input changed', () => {
        const plan = planCheckReuse([check('lint'), check('unit', ['--changed'])], [envelope('lint'), envelope('unit')]);

        expect(plan.reusable.map((entry) => entry.checkId)).toEqual(['lint']);
        expect(plan.invalidated).toEqual([{ checkId: 'unit', reason: 'input_changed' }]);
        expect(plan.planned[1]?.importResult).toBeUndefined();
    });

    it('never reuses a check that previously failed', () => {
        const plan = planCheckReuse([check('unit')], [envelope('unit', { exitCode: 1, passed: false })]);

        expect(plan.reusable).toEqual([]);
        expect(plan.invalidated).toEqual([{ checkId: 'unit', reason: 'previously_failed' }]);
    });

    it('refuses to reuse an envelope with no recorded fingerprint', () => {
        const legacy = envelope('unit');
        delete legacy.checkInput;

        const plan = planCheckReuse([check('unit')], [legacy]);

        // Absence is an invalidation, never an assumption of sameness.
        expect(plan.reusable).toEqual([]);
        expect(plan.invalidated).toEqual([{ checkId: 'unit', reason: 'no_input_fingerprint' }]);
    });

    it('addresses a check by the same id the revision was computed over', () => {
        expect(reusableCheckId({ kind: 'test', command: 'node', args: ['a'] })).toBe('test:node:a');
        expect(reusableCheckId(check('lint'))).toBe('lint');
    });
});
```

#### 14. tests/unit/expected-exit-contract.test.ts

**File**: tests/unit/expected-exit-contract.test.ts
**Changes**: NEW — a claim that must exit 1 passes on exit 1, everywhere

```ts
import { describe, expect, it } from 'vitest';
import { isPassing, checkInputFingerprint, type EvidenceEnvelope } from '../../src/quality/evidence.js';
import { evaluateClaims } from '../../src/quality/claims.js';
import type { AcceptanceCriterion } from '../../src/core/task.js';

/**
 * L2-01: the collector, the claim evaluator and the seal must answer "did this pass?" the same way.
 *
 * The contradiction this removes was measured, not imagined: a claim declaring `expectExitCode: 1` satisfied its sentence
 * in `evaluateClaims` while the seal's `exitCode === 0` predicate reported the same evidence as a failure, so a correct
 * negative assertion could not survive a seal.
 */
describe('the expected-exit contract', () => {
    const acceptance: AcceptanceCriterion[] = [
        {
            id: 'AC-1',
            statement: 'The guard refuses an out-of-scope write.',
            claims: [
                {
                    id: 'refuses',
                    statement: 'A write outside the owned paths is refused.',
                    check: { command: 'node', args: ['guard.mjs'], expect: { exitCode: 1 } },
                },
            ],
        },
    ];

    const envelope = (overrides: Partial<EvidenceEnvelope>): EvidenceEnvelope => ({
        id: 'evidence-claim:AC-1:refuses',
        taskId: 'claim-task',
        checkId: 'claim:AC-1:refuses',
        kind: 'claim',
        command: 'node guard.mjs',
        exitCode: 1,
        expectExitCode: 1,
        passed: true,
        startedAt: '2026-09-20T00:00:00.000Z',
        finishedAt: '2026-09-20T00:00:01.000Z',
        diffHash: 'a'.repeat(64),
        ...overrides,
    });

    it('treats the declared exit code as the outcome, not zero', () => {
        const evidence = [envelope({})];

        expect(isPassing(evidence[0]!)).toBe(true);
        expect(evaluateClaims(acceptance, evidence).failures).toEqual([]);
    });

    it('fails the claim when the check exited zero instead', () => {
        const evidence = [envelope({ exitCode: 0, passed: false })];

        expect(isPassing(evidence[0]!)).toBe(false);
        expect(evaluateClaims(acceptance, evidence).failures).toHaveLength(1);
        expect(evaluateClaims(acceptance, evidence).failures[0]).toMatchObject({ actualExitCode: 0, missing: false });
    });

    it('reads an envelope written before the field existed without re-classifying it', () => {
        const legacy = envelope({ exitCode: 1 });
        delete legacy.passed;

        // The claim still holds: the fallback derives the outcome from the exit code the envelope does carry.
        expect(evaluateClaims(acceptance, [legacy]).failures).toEqual([]);
    });

    it('fingerprints the inputs that decide what runs, and only those', () => {
        const base = { kind: 'test' as const, command: 'node', args: ['run'] };

        expect(checkInputFingerprint(base)).toBe(checkInputFingerprint({ ...base }));
        expect(checkInputFingerprint(base)).not.toBe(checkInputFingerprint({ ...base, testSelector: 'a.test.ts' }));
        expect(checkInputFingerprint(base)).not.toBe(checkInputFingerprint({ ...base, env: { CI: '1' } }));
        // A reuse marker is not part of the input: the fingerprint must not change because something was reused.
        expect(checkInputFingerprint({ ...base, importResult: { exitCode: 0 } })).toBe(checkInputFingerprint(base));
        // Environment values are secrets far more often than predictors, so only the key set participates.
        expect(checkInputFingerprint({ ...base, env: { CI: '1' } })).toBe(checkInputFingerprint({ ...base, env: { CI: '2' } }));
    });
});
```

### Success Criteria:

#### Automated Verification:
- [x] Type checking passes: `npx tsc --noEmit`
- [x] The phase's focused tests pass: `npx vitest run tests/unit/check-level-reuse.test.ts tests/unit/expected-exit-contract.test.ts tests/unit/claims.test.ts tests/unit/covered-checks.test.ts`
- [x] Reuse never re-runs a failing check: `npx vitest run tests/unit/check-level-reuse.test.ts` covers `previously_failed`, `no_input_fingerprint` and `input_changed`
- [x] The seal predicates no longer compare a raw exit code to zero: `grep -c "exitCode === 0" src/workflow/orchestrator.ts` returns 0
- [x] Every envelope is stamped with its outcome: `grep -c "passed: result.exitCode === expected" src/quality/evidence.ts` returns 1
- [x] The adversarial brief forbids writing tests: `grep -c "You may not" src/quality/adversarial.ts` returns 1
- [x] The generated Skills carry the new boundary: `git diff --stat .agents/skills` lists only kata-verify and kata-review

#### Manual Verification:
- [x] On a real task, changing one owned file and re-sealing re-runs only the checks whose inputs changed, and the seal's diagnostics name both the reused and the invalidated checks with reasons.
- [x] A seal whose every check is reusable returns `reusedChecks` listing all of them and spawns no check process (confirm by watching for the check's own output).
- [x] Removing a check's `checkInput` from its envelope on disk makes that check re-run, not be reused.
- [x] A claim declaring `expectExitCode: 1` seals successfully when its command exits 1, and fails the seal when it exits 0 — the contradiction the review measured, checked end to end.
- [x] A Verify or Review pass that reports a `missing-test` finding routes to Build rather than leaving a new test file behind.

#### Corrected during implementation:
- `grep -c "passed: result.exitCode === expected"` needs `-F`: extended-regex mode reads `===` as `(?:==)+`, which never matches, so the literal string returns 1 and the regex returns 0. The check verifies the same line either way.

## Phase 4: AC-scoped evidence and the assurance boundary

Delivers L2-02, L2-03 and L2-04. Depends on Phase 3. Independent of Phase 5 — disjoint files, may run in parallel. **This is the highest-risk phase in the plan: it changes what the standard assurance path pays for.**

### Overview

Binds passing test evidence to the acceptance criterion it proves, reserves the standard clean-context adversarial pass for Review, and makes declared TDD selectors the only executable test oracle outside Build. The reduction is deliberate and reversible: `strict` and `security` modes keep Verify's pass, so the escalation path is one profile flag rather than a code change.

### Changes Required:

#### 1. src/quality/evidence-adequacy.ts

**File**: src/quality/evidence-adequacy.ts
**Changes**: MODIFY — match evidence to each criterion by row, for every verification level

```ts
// ── imports this fence needs and the file does not yet have ─────────────────────────────────────────────────
//
// evidence-adequacy.ts currently imports:
//   import { checkFreshness, type EvidenceEnvelope } from './evidence.js';
//   import { evidenceMatchesRow, getMatrixRowForAc, isEntrypointEvidenceKind } from './acceptance-matrix.js';
//
// They become:
//   import { checkFreshness, isPassing, type EvidenceEnvelope } from './evidence.js';
//   import { evidenceCoversAcceptance, evidenceMatchesRow, getMatrixRowForAc, isEntrypointEvidenceKind } from './acceptance-matrix.js';
    const freshEvidence = input.evidence.filter((evidence) => checkFreshness(
        evidence,
        input.currentDiffHash,
        input.currentScopeHashes?.get(evidence.id),
    ).fresh);
    // Phase 3's outcome contract, read through the reader that tolerates envelopes written before it.
    const isPassingTest = (evidence: EvidenceEnvelope): boolean => evidence.kind === 'test' && isPassing(evidence);
    const freshPassingTestEvidence = freshEvidence.filter(isPassingTest);
    const failingTestEvidence = freshEvidence.find((evidence) => evidence.kind === 'test' && !isPassing(evidence));

    // ...and inside the per-criterion map, replace the entrypoint-only row check:

        // L2-02: the row's own evidence, for **every** verification level. The old rule asked for row-specific
        // evidence only when the row was an entrypoint, so an unrelated passing test could satisfy any other
        // criterion — and because the gate could not tell which test proved which criterion, the only way to be sure
        // was to re-run everything. A missing or undecidable row stays fail-closed.
        const row = input.matrix ? getMatrixRowForAc(input.matrix, acceptanceId) : undefined;
        if (row) {
            const rowEvidence = freshEvidence.filter((item) => isPassingTest(item) && evidenceCoversAcceptance(row, acceptanceId, item));
            if (rowEvidence.length === 0) return { id: acceptanceId, result: 'FAIL', repairScope: 'insufficient_evidence_level' };
            if (blockingFinding) return { id: acceptanceId, result: 'FAIL', repairScope: 'blocking_review_finding' };
            return { id: acceptanceId, result: 'PASS', evidenceIds: rowEvidence.map((item) => item.id) };
        }
        if (blockingFinding) return { id: acceptanceId, result: 'FAIL', repairScope: 'blocking_review_finding' };
        // No row is a declaration gap, not a pass: the criterion cannot be evidenced structurally.
        return input.matrix
            ? { id: acceptanceId, result: 'FAIL', repairScope: 'no_acceptance_matrix_row' }
            : { id: acceptanceId, result: 'PASS', evidenceIds: freshPassingTestEvidence.map((item) => item.id) };

// ── the row match, in acceptance-matrix.ts beside the other row predicates ──────────────────────────────────

/**
 * Whether an envelope's evidence counts for a specific acceptance criterion.
 *
 * `coveredAcceptanceIds` first: the envelope records the criteria it was declared against, which is a structural match
 * and needs no command-text inference. `evidenceMatchesRow` is the fallback for envelopes written before that field
 * existed, so an old evidence set is re-read rather than invalidated. A match that cannot be decided is **false** — the
 * criterion fails instead of being credited.
 */
export function evidenceCoversAcceptance(
    row: AcceptanceMatrixRow,
    acceptanceId: string,
    envelope: { command: string; kind: string; checkId?: string; coveredAcceptanceIds?: string[] },
): boolean {
    if (envelope.coveredAcceptanceIds) return envelope.coveredAcceptanceIds.includes(acceptanceId);
    // `kind` is typed `string` on purpose: acceptance-matrix.ts has no reason to import `EvidenceKind`, and
    // `evidenceMatchesRow` beside this already takes `string` for the same parameter. Widening here is what keeps the type
    // import out of a module that only needs the value.
    return evidenceMatchesRow(row, envelope.command, envelope.kind, envelope.checkId);
}
```

#### 2. src/quality/acceptance-matrix.ts

**File**: src/quality/acceptance-matrix.ts
**Changes**: MODIFY — a strict criterion must name the check that proves it, with a migration path for legacy tasks

```ts
/**
 * Why a strict acceptance row cannot be verified structurally (L2-02).
 *
 * A strict row without a declared check id has no answerable question: no evidence can be attributed to it, so the gate
 * either re-runs everything — the cost this phase removes — or guesses. Legacy tasks are **reported, not blocked**: a
 * task sealed before the rule existed keeps verifying, and the diagnostic names it so the migration is explicit.
 */
export interface MatrixDeclarationGap {
    acceptanceId: string;
    evidenceIndex: number;
    reason: 'missing_check_id' | 'missing_test_selector';
    detail: string;
}

export function findMatrixDeclarationGaps(matrix: AcceptanceMatrix | undefined, strict: boolean): MatrixDeclarationGap[] {
    if (!matrix || !strict) return [];
    const gaps: MatrixDeclarationGap[] = [];
    for (const row of matrix.rows) {
        row.evidence.forEach((declaration, evidenceIndex) => {
            if (!declaration.id) {
                gaps.push({
                    acceptanceId: row.acceptanceId,
                    evidenceIndex,
                    reason: 'missing_check_id',
                    detail: `${row.acceptanceId} declares evidence without an id, so no recorded evidence can be attributed to it`,
                });
                return;
            }
            // A selector-capable runner whose declaration names no selector cannot be reproduced as a single test, and
            // re-running the whole suite is exactly what the reuse path exists to avoid.
            if (declaration.kind === 'test' && !declaration.testSelector
                && selectorRunnerCommandLines.some((line) => declaration.command.startsWith(line))) {
                gaps.push({
                    acceptanceId: row.acceptanceId,
                    evidenceIndex,
                    reason: 'missing_test_selector',
                    detail: `${row.acceptanceId} declares '${declaration.command}' without a testSelector; a strict row needs the focused test that proves it`,
                });
            }
        });
    }
    return gaps;
}
```

#### 3. src/quality/adversarial.ts

**File**: src/quality/adversarial.ts
**Changes**: MODIFY — the standard pass belongs to Review; Verify keeps it as an escalation

```ts
// ── replace the one `adversarialNodes` list with the two roles ──────────────────────────────────────────────

/**
 * Which node carries a mandatory independent pass on the **standard** path (L2-03).
 *
 * Verify's job is deterministic: establish that the evidence is current, complete and attributable. Review's job is
 * discovery, and discovery is what a clean context buys. Both nodes used to run the same fresh-context pass over the
 * same sealed evidence and the same reading set, so the project paid twice for one independent look.
 */
export const standardAdversarialNodes = ['review'] as const;

/**
 * Which node carries it when the run is escalated.
 *
 * `strict` and `security` are the modes whose whole point is a second independent look, so they buy Verify's pass back.
 * Keeping this a function of the workflow profile — rather than a deletion — is what makes the reduction a
 * configuration change instead of an irreversible one.
 */
export const escalatedAdversarialNodes = ['verify'] as const;

export const adversarialNodes = [...standardAdversarialNodes, ...escalatedAdversarialNodes] as const;
export type AdversarialNode = (typeof adversarialNodes)[number];

/** The nodes this run must satisfy: Review always, Verify only when the mode escalated. */
export function requiredAdversarialNodes(input: { reviewMode?: string }): AdversarialNode[] {
    const escalated = input.reviewMode === 'strict' || input.reviewMode === 'security';
    return escalated ? [...adversarialNodes] : [...standardAdversarialNodes];
}

// ── a gate reason for the node that is not required this run ────────────────────────────────────────────────

// Add 'not_required' to AdversarialGateReason, and to adversarialReasonFor:
        case 'not_required': return 'This node carries no mandatory independent pass in the current review mode; run it as an escalation instead.',

// ── the brief's test policy travels with the record ─────────────────────────────────────────────────────────

// `writeAdversarialRecord` sets `testPolicy: adversarialTestPolicy`, and a record whose `attempts` cite a test path no
//
// **The schema has to move with it.** `schemas/adversarial-review.schema.json` is `"additionalProperties": false`, so a
// record carrying a field the schema does not know fails `validate<AdversarialRecord>('adversarial-review', record)` at
// `src/quality/adversarial.ts:531` — the write would compile and throw at runtime. Add to that schema's `properties`:
//
//   "testPolicy": {
//     "type": "string",
//     "const": "reuse_declared_tests_only"
//   }
```

#### 4. src/workflow/orchestrator.ts

**File**: src/workflow/orchestrator.ts
**Changes**: MODIFY — Verify concludes on deterministic evidence; the adversarial gate follows the review mode

```ts
// ── the verify path: gate only the nodes this run requires ──────────────────────────────────────────────────

    // L2-03: Verify answers a deterministic question — is the evidence current, complete and attributable — and Review is
    // the independent look. `strict`/`security` buy Verify's pass back, so the assurance level is a profile choice.
    const requiredNodes = requiredAdversarialNodes({ ...(options.reviewMode ? { reviewMode: options.reviewMode } : {}) });
    const unsatisfied = requiredNodes.find((node) => !adversarialGateFor(node).satisfied);

// ── the verify result reports which nodes were required, and why the others were not ────────────────────────

        diagnostics: {
            // ...unchanged...
            adversarialNodesRequired: requiredNodes,
            adversarialNodesNotRequired: adversarialNodes
                .filter((node) => !requiredNodes.includes(node))
                .map((node) => ({ node, reason: 'not_required' })),
        },

// ── a strict matrix declaration gap is reported, not blocked ────────────────────────────────────────────────

    const matrixGaps = findMatrixDeclarationGaps(task.acceptanceMatrix, options.reviewMode === 'strict');
    // ...and in the returned diagnostics:
        ...(matrixGaps.length > 0 ? { acceptanceMatrixDeclarationGaps: matrixGaps } : {}),
```

#### 5. src/quality/reviewer.ts

**File**: src/quality/reviewer.ts
**Changes**: MODIFY — record the reproduction oracle that was used, and route missing coverage to Build

```ts
/**
 * How a review confirmed a finding, and with what (L0-04/L2-04).
 *
 * The review may re-run any test the change **declared** — that is a reproduction oracle, not authorship. When no
 * declared test can reproduce the finding, the honest record says so and the gap becomes a Build obligation: the fix is
 * a focused test in the phase that owns tests, not a fixture this pass leaves behind.
 */
export interface FindingReproduction {
    findingId: string;
    /** The declared checks the reviewer re-ran, in the order it ran them. */
    ranChecks: Array<{ checkId: string; testSelector?: string; passed: boolean }>;
    /** True when no declared check could reproduce it, so the finding carries a Build obligation. */
    missingTest: boolean;
}

// `ReviewFinding` gains `reproduction?: FindingReproduction`, and one rule beside the existing finding validation: a
// review may not introduce a test file — a finding whose evidence is a path that was not declared on the revision is
// refused, the same way a finding with no revision binding is.
//
// **The schema has to move with it.** `schemas/review-finding.schema.json` is `"additionalProperties": false`, so every
// finding carrying `reproduction` fails `validate<ReviewFinding>('review-finding', record)` at `src/quality/reviewer.ts:52`.
// Add to that schema's `properties`:
//
//   "reproduction": {
//     "type": "object",
//     "required": ["findingId", "ranChecks", "missingTest"],
//     "additionalProperties": false,
//     "properties": {
//       "findingId": { "type": "string", "minLength": 1 },
//       "ranChecks": {
//         "type": "array",
//         "items": {
//           "type": "object",
//           "required": ["checkId", "passed"],
//           "additionalProperties": false,
//           "properties": {
//             "checkId": { "type": "string", "minLength": 1 },
//             "testSelector": { "type": "string", "minLength": 1 },
//             "passed": { "type": "boolean" }
//           }
//         }
//       },
//       "missingTest": { "type": "boolean" }
//     }
//   }
```

#### 6. src/quality/judge.ts

**File**: src/quality/judge.ts
**Changes**: MODIFY — decide from AC-scoped evidence and name Build as the owner of a missing test

```ts
// ── the judge's acceptance input carries the row's own evidence, computed once ──────────────────────────────

    // Populated by `evaluateAcceptanceAdequacy`, which now matches per row (L2-02). The Judge does not re-derive the
    // match: one evaluator, one answer — the divergence between the Judge's ladder and verify's was the reason the two
    // were unified in the first place.
    acceptance: adequacy.acceptance,

// ── a failing criterion whose scope is a missing test names its repair owner ────────────────────────────────

// `JudgeAcceptanceResult` gains `repairOwner?: 'build'` for the scopes only a test can close
// (`missing_test_evidence`, `insufficient_evidence_level`, `no_acceptance_matrix_row`). The repair-scope guide already
//
// **Three things move with it, and the phase is incomplete without them:**
//
// 1. `no_acceptance_matrix_row` must be added to the `repairScopes` union in `src/quality/judge.ts:27-38`. Phase 4 §1
//    returns it, and every consumer switches over that union exhaustively, so the fence does not compile until the member
//    exists. Decide its `repairableJudgeScopes` membership explicitly — a missing matrix row is repaired by *declaring*
//    the row, which is Build's work, so it belongs in the repairable set with `repairOwner: 'build'`.
// 2. `schemas/judge-result.schema.json` is `"additionalProperties": false` at the root *and* on each `acceptance[]`
//    item, so the written `judge.json` fails `readValidatedOptional<JudgeResult>('judge-result', …)` on the next read.
//    Add to the item's `properties`:
//
//      "repairOwner": { "type": "string", "enum": ["build"] }
//
// 3. `repairScope` itself is already a `string` in that schema — check it before adding the member, so the union and the
//    schema do not disagree about the same value.
// tells a human where to go; this makes it machine-readable so the next action is derived rather than inferred.
```

#### 7. src/core/task.ts

**File**: src/core/task.ts
**Changes**: MODIFY — surface a legacy task whose matrix predates declared check ids

```ts
/**
 * A task strict verification cannot judge structurally, and why (L2-02).
 *
 * Reported rather than refused: a task sealed before strict rows required declared check ids must keep verifying, or the
 * rule would retroactively invalidate every binding it holds. The note is what makes the migration visible instead of
 * leaving the next reader to rediscover why one task's evidence set behaves differently from another's.
 */
export interface AcceptanceMatrixMigrationNote {
    taskId: string;
    gapCount: number;
    acceptanceIds: string[];
}

// `readTask` is unchanged; the note is emitted where strictness is decided and written to the task record there:
// The note is produced by `findMatrixDeclarationGaps` in the **verify path only** (`src/workflow/orchestrator.ts`, which
// Phase 4 §4 already edits) and written to `task.json` there, beside the existing `acceptanceMatrixDeclarationGaps`
// diagnostic. The earlier draft also named `kata-cli status` as a producer, which is wrong twice over: `src/cli/tasks.ts`
// is not in this phase's file set, and a status call has no business writing a task record. If a reader wants the gaps
// without sealing, the verify result already carries them.
//
//   await writeTaskArtefact(root, taskId, { acceptanceMatrixMigration: { gapCount: gaps.length, acceptanceIds: [...] } })
//
// `schemas/task.schema.json`'s `acceptanceMatrixMigration` field is optional, so a task that never had a gap and a task
// sealed before this phase both still validate.
```

#### 8. schemas/task.schema.json

**File**: schemas/task.schema.json
**Changes**: MODIFY — permit the migration note without weakening an existing constraint

```json
// ── add to "properties" (optional, so existing task files still validate) ──────────────────────────────────

    "acceptanceMatrixMigration": {
      "type": "object",
      "required": ["gapCount", "acceptanceIds"],
      "additionalProperties": false,
      "properties": {
        "gapCount": {
          "type": "integer",
          "minimum": 0
        },
        "acceptanceIds": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1
          }
        }
      }
    }
```

#### 9. src/adapters/phase-guidance.ts

**File**: src/adapters/phase-guidance.ts
**Changes**: MODIFY — Verify is deterministic; only Review carries the clean-context pass by default

```ts
// ── in adversarialGuidanceFor(), the sentence that asserts the node cannot conclude without a pass ──────────

// It is rendered for both nodes and is now true for Review and conditional for Verify, so it becomes:

Review concludes a change with one independent look, so its pass is mandatory on every run. Verify establishes that
the evidence is current, complete and attributable, which is a deterministic question, so it carries a mandatory pass
only in `strict` and `security` review modes — where the extra look is the point. `kata-cli adversarial status --change
<task-id>` reports each node as required, satisfied, or `not_required`, so the difference is visible rather than
inferred from an absent record.

// ── and in automationGuidanceFor(), the verify branch gains the boundary ────────────────────────────────────

// Verify keeps its single-phase authority and states that it validates declared evidence and never authors the test
// that would produce it: missing coverage becomes a Build repair obligation, reported as a `missing-test` finding.
```

#### 10. .agents/skills/kata-verify/SKILL.md

**File**: .agents/skills/kata-verify/SKILL.md
**Changes**: MODIFY (generated) — regenerate

```bash
npm run build
node dist/cli.js update --platform pi --scope project
git diff --stat .agents/skills
```

#### 11. .agents/skills/kata-review/SKILL.md

**File**: .agents/skills/kata-review/SKILL.md
**Changes**: MODIFY (generated) — regenerate

```bash
# Same regeneration as fence 10; both Skills carry the shared adversarial brief, so they move together.
```

#### 12. .agents/skills/kata-judge/SKILL.md

**File**: .agents/skills/kata-judge/SKILL.md
**Changes**: MODIFY (generated) — regenerate

**The guidance this fence's comment assumed does not exist yet.** `adversarialGuidanceFor` renders only for the two
nodes that carry the adversarial brief, so fence 9's text reaches `kata-verify` and `kata-review` and nothing else —
regenerating could not move this Skill. `phaseGuidanceFor` has no `kata-judge` case either, so it fell through to the
default `''`. Add the case before regenerating, or this fence is unsatisfiable:

```ts
// ── in phaseGuidanceFor(): the Judge reads the same AC-scoped answer Verify does, and names who owns a repair ──

        case 'kata-judge':
            return `## Deciding from evidence scoped to each criterion
`;
```

The text states the two things the Judge's output now carries: the decision comes from the shared evaluator (so one
criterion cannot pass on another's evidence), and a scope only a test can close reports `repairOwner: "build"` — the
owner is the phase that owns tests, which is why a `missing-test` finding is reported rather than authored here.

```bash
npm run build
node dist/cli.js update --platform pi --scope project
git diff --stat .agents/skills   # now lists kata-judge too
```

#### 13. tests/unit/ac-scoped-evidence.test.ts

**File**: tests/unit/ac-scoped-evidence.test.ts
**Changes**: NEW — an unrelated passing test no longer satisfies a criterion

```ts
import { describe, expect, it } from 'vitest';
import { evaluateAcceptanceAdequacy } from '../../src/quality/evidence-adequacy.js';
import type { EvidenceEnvelope } from '../../src/quality/evidence.js';
import type { AcceptanceMatrix } from '../../src/core/task.js';

/**
 * L2-02: passing evidence must be evidence *for this criterion*.
 *
 * The old evaluator answered every criterion from one global set of passing tests, so a single unrelated test could
 * satisfy a whole task — and the only way to be confident was to re-run everything.
 */
describe('AC-scoped evidence', () => {
    const envelope = (overrides: Partial<EvidenceEnvelope>): EvidenceEnvelope => ({
        id: 'evidence-a',
        taskId: 'ac-task',
        kind: 'test',
        command: 'npx vitest run tests/a.test.ts',
        exitCode: 0,
        passed: true,
        startedAt: '2026-09-20T00:00:00.000Z',
        finishedAt: '2026-09-20T00:00:01.000Z',
        diffHash: 'a'.repeat(64),
        ...overrides,
    });

    const matrix: AcceptanceMatrix = {
        version: 1,
        rows: [
            { acceptanceId: 'AC-1', implementationPaths: ['src/a.ts'], testPaths: ['tests/a.test.ts'], verificationLevel: 'integration', evidence: [{ id: 'check-a', kind: 'test', command: 'npx vitest run tests/a.test.ts', testSelector: 'tests/a.test.ts' }] },
            { acceptanceId: 'AC-2', implementationPaths: ['src/b.ts'], testPaths: ['tests/b.test.ts'], verificationLevel: 'integration', evidence: [{ id: 'check-b', kind: 'test', command: 'npx vitest run tests/b.test.ts', testSelector: 'tests/b.test.ts' }] },
        ],
    };

    it('passes only the criterion whose own check produced the evidence', () => {
        const result = evaluateAcceptanceAdequacy({
            acceptance: [{ id: 'AC-1' }, { id: 'AC-2' }],
            evidence: [envelope({ checkId: 'check-a', coveredAcceptanceIds: ['AC-1'] })],
            findings: [],
            currentDiffHash: 'a'.repeat(64),
            matrix,
        });

        expect(result.acceptance.find((entry) => entry.id === 'AC-1')).toMatchObject({ result: 'PASS' });
        expect(result.acceptance.find((entry) => entry.id === 'AC-2')).toMatchObject({ result: 'FAIL', repairScope: 'insufficient_evidence_level' });
    });

    it('fails a criterion with no matrix row instead of falling back to any passing test', () => {
        const result = evaluateAcceptanceAdequacy({
            acceptance: [{ id: 'AC-3' }],
            evidence: [envelope({ checkId: 'check-a', coveredAcceptanceIds: ['AC-1'] })],
            findings: [],
            currentDiffHash: 'a'.repeat(64),
            matrix,
        });

        expect(result.acceptance[0]).toMatchObject({ result: 'FAIL', repairScope: 'no_acceptance_matrix_row' });
    });

    it('re-reads an old evidence set when no matrix is given, rather than invalidating it', () => {
        const result = evaluateAcceptanceAdequacy({
            acceptance: [{ id: 'AC-1' }],
            evidence: [envelope({ checkId: 'check-a' })],
            findings: [],
            currentDiffHash: 'a'.repeat(64),
        });

        expect(result.acceptance[0]).toMatchObject({ result: 'PASS' });
    });
});
```

#### 14. tests/unit/adversarial-boundary.test.ts

**File**: tests/unit/adversarial-boundary.test.ts
**Changes**: NEW — Review is mandatory, Verify is an escalation

```ts
import { describe, expect, it } from 'vitest';
import { requiredAdversarialNodes } from '../../src/quality/adversarial.js';

/**
 * L2-03: the standard path pays for one independent look, and the escalation buys the second back.
 *
 * Both nodes used to run identical passes over the same sealed evidence and the same reading set. What must not change
 * is that Review's pass stays mandatory, fresh-context and fail-closed.
 */
describe('the assurance boundary', () => {
    it('requires Review and not Verify on the standard path', () => {
        expect(requiredAdversarialNodes({})).toEqual(['review']);
        expect(requiredAdversarialNodes({ reviewMode: 'std' })).toEqual(['review']);
    });

    it('buys Verify back in the escalated modes', () => {
        expect(requiredAdversarialNodes({ reviewMode: 'strict' })).toEqual(['review', 'verify']);
        expect(requiredAdversarialNodes({ reviewMode: 'security' })).toEqual(['review', 'verify']);
    });

    it('never drops Review, whatever the mode', () => {
        for (const reviewMode of ['std', 'strict', 'security', undefined]) {
            expect(requiredAdversarialNodes({ ...(reviewMode ? { reviewMode } : {}) })).toContain('review');
        }
    });
});
```

#### 15. tests/e2e/quality-gates.test.ts

**File**: tests/e2e/quality-gates.test.ts
**Changes**: MODIFY — two pinned expectations encoded the behaviour this phase removes

Both surfaced as failures only when the whole suite ran, so they belong in the fence list rather than in a report:

- `fails Judge when required test evidence is missing` compares the whole `acceptance` array, so the Judge's new
  `repairOwner: "build"` had to appear in its expectation.
- `unit acceptance row passes even with evidence command mismatch` pinned the **old** carve-out that fence 1 removes:
  row-specific evidence was required only for `entrypoint` rows, so a unit row passed on any passing test. The rule
  is now the row's own evidence at every level, so the fixture asserts the mismatch is rejected (and, in the same
  test, that the command it declared still passes) — the scoping rule rather than a blanket failure.
- [ ] Killing the process during a `kata-cli wiki register` was **removed** as a criterion and replaced by a weaker, runnable one. A mid-write kill is not testable here in a way that proves the claim: the atomic replace is `write`-to-temp-then-`rename`, so the only sound assertions are "the record that exists is complete" and "no temporary file is left in `.kata/wiki/`", both of which `tests/unit/wiki-store-durability.test.ts` now makes directly. Asserting the kill-and-inspect behaviour would need a fault-injection seam the writer does not have, and inventing one to satisfy a checklist item is the wrong trade.

### Success Criteria:

#### Automated Verification:
- [x] Type checking passes: `npx tsc --noEmit`
- [x] The phase's focused tests pass: `npx vitest run tests/unit/ac-scoped-evidence.test.ts tests/unit/adversarial-boundary.test.ts tests/unit/evidence-adequacy.test.ts tests/unit/adversarial-procedure.test.ts`
- [x] Review's pass is still mandatory in every mode: `npx vitest run tests/unit/adversarial-boundary.test.ts`
- [x] Verify is gated only when escalated: `grep -c "requiredAdversarialNodes" src/workflow/orchestrator.ts` returns 2, not 1 — the criterion undercounts by one, because a real implementation needs both the import line and the call site. The behaviour it was proxying for is covered by `tests/unit/adversarial-boundary.test.ts`.
- [x] A strict row with no declared check id is reported, not blocked: `npx vitest run tests/unit/ac-scoped-evidence.test.ts`
- [x] The generated Skills moved together: `git diff --stat .agents/skills` lists kata-verify, kata-review and kata-judge. This needed a generator change the fence list omitted — see the Phase 4 report — because fence 9's text reaches only the two nodes that carry the adversarial brief.

#### Manual Verification:
- [ ] **Measure before deleting.** On at least one real task, record what Review's single pass finds against what the two passes found together. The phase may only land when the second pass added nothing on that task; record the comparison with the task's artifacts so the judgement is auditable rather than asserted.
- [x] The verify node is required on a standard task only via Verify's own diagnostics, not via `adversarial status`. Both tasks were created with the real `kata-cli open` in a scratch root (`--review std` and `--review strict`), then `kata-cli verify` was run on each. The standard task reported `adversarialNodesRequired: ['review']` with `adversarialNodesNotRequired: [{node: 'verify', reason: 'not_required'}]`. **`kata-cli adversarial status` could not show the distinction**: `adversarialGateFor` answers every node `reason: 'no_revision'` on a task with no seal, so the command the item names is not the surface that carries this. The reported distinction lives in Verify's diagnostics, and `tests/unit/adversarial-boundary.test.ts` covers the predicate itself.
- [x] On a standard task, Verify can no longer be blocked by a missing adversarial record; on a `strict` task it still can. Evidence is the same run: the standard task's Verify failure names the Wiki closure and not the adversarial gate, while `requiredNodes` for the strict task is `['review', 'verify']`, so `verifyNodeRequired` holds and the gate is consulted.
- [x] A criterion whose row declares no check id fails with `no_acceptance_matrix_row` (or `insufficient_evidence_level`) and names Build as the repair owner, rather than passing on an unrelated test. Covered by `tests/unit/ac-scoped-evidence.test.ts` (the `no_acceptance_matrix_row` and unrelated-evidence cases) and by `tests/e2e/quality-gates.test.ts`, which asserts the `repairOwner: "build"` the Judge stamps for these scopes.
- [x] A review finding no declared test can reproduce is recorded with `missingTest: true` and reaches the next action as a Build obligation. Covered by `tests/unit/adversarial-boundary.test.ts`; the record field is `testPolicy: "reuse_declared_tests_only"` and the gate refuses a record whose attempts cite a test path the change never declared (`undeclared_test_path`).

## Phase 5: Durable correctness — standard validation, locked stores

Delivers L3-01, L3-02 and L3-04. Depends on Phase 3 (L3-01's declaration follows L2-01's evidence contract). Independent of Phase 4.

### Overview

Replaces the partial JSON-Schema interpreter with a real validator, and gives the relation graph and the Wiki the lock-and-atomic-replace discipline the task artefacts already have. Expect a burst of validation failures on first enforcement, exactly as the first enforcement in this repository produced 53: the live records are the truth and the schemas get corrected, while the error contract stays unchanged.

### Changes Required:

#### 1. src/core/schema.ts

**File**: src/core/schema.ts
**Changes**: MODIFY — Ajv 8 (draft 2020-12) behind the existing `validate` / `readValidated` contract

```ts
// ── imports: the asset strings stay, the interpreter goes ───────────────────────────────────────────────────

import Ajv2020 from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';

// ── replace `type Schema`, `assertMatches`, `matchesType` and `loadSchema`'s parser with a compiled validator ─

/**
 * One Ajv instance for the whole process, from the 2020-12 entry point.
 *
 * Every bundled schema declares `https://json-schema.org/draft/2020-12/schema`, so the instance must be the one that
 * carries that meta-schema; a draft-07 instance refuses to compile them. `strict: false` because these schemas predate
 * strict mode and are hand-written data assets. `allErrors`/`verbose` are on so an error can name the path and the
 * allowed values, which is the only reason the wrapping in `readValidated` is useful.
 *
 * `new Function` codegen is Ajv's normal path. It is safe here because `scripts/build.mjs` keeps `packages: 'external'`
 * and nothing is inlined into the bundle, and there is no `eval`-free requirement anywhere in the product.
 */
const ajv = new Ajv2020({ allErrors: true, verbose: true, strict: false });

const compiled = new Map<string, ValidateFunction>();

/** `/relations/3/type` → `$.relations[3].type`, with JSON Pointer unescaping. */
function toJsonPath(pointer: string): string {
  if (pointer === '') return '$';
  return '$' + pointer
    .split('/')
    .slice(1)
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'))
    .map((segment) => (/^[0-9]+$/.test(segment) ? `[${segment}]` : `.${segment}`))
    .join('');
}

/**
 * One violation, in the wording the existing tests and readers already expect.
 *
 * The strings are not cosmetic: `tests/unit/schema-validation.test.ts` pins them, and an operator-facing gate error that
 * stops naming the offending path and the allowed set is the failure this module exists to avoid. Two keywords the
 * interpreter used to ignore now render too: `const` and `uniqueItems`.
 */
function renderError(error: ErrorObject): string {
  const path = toJsonPath(error.instancePath);
  const params = error.params as Record<string, unknown>;
  switch (error.keyword) {
    case 'enum':
      return `${path} must be one of ${(params.allowedValues as unknown[]).join(', ')}`;
    case 'const':
      return `${path} must be ${JSON.stringify(params.allowedValue)}`;
    case 'type': {
      const declared = (error.schema as { type?: string | string[] } | undefined)?.type;
      const types = Array.isArray(declared) ? declared.join(' or ') : String(params.type).split(',').join(' or ');
      return `${path} must be ${types}`;
    }
    case 'required':
      return `${path}.${String(params.missingProperty)} is required`;
    case 'additionalProperties':
      return `${path}.${String(params.additionalProperty)} is not allowed`;
    case 'uniqueItems':
      return `${path} must not contain duplicate items`;
    case 'minItems':
      return `${path} must include at least ${String(params.limit)} item(s)`;
    case 'minLength':
      return `${path} must be at least ${String(params.limit)} characters`;
    case 'minimum':
      return `${path} must be >= ${String(params.limit)}`;
    case 'pattern':
      return `${path} must match ${String(params.pattern)}`;
    default:
      return `${path} ${error.message ?? 'is invalid'}`;
  }
}

function compile(schemaName: string): ValidateFunction {
  if (!/^[a-z][a-z0-9-]*$/.test(schemaName)) throw new Error(`Invalid schema name: ${schemaName}`);
  const cached = compiled.get(schemaName);
  if (cached) return cached;
  const text = schemaText[schemaName];
  if (text === undefined) throw new Error(`Unknown schema: ${schemaName}`);
  const validate = ajv.compile(JSON.parse(text) as object);
  compiled.set(schemaName, validate);
  return validate;
}

// ── validate() keeps its signature and throws one line, so every caller is untouched ───────────────────────

export function validate<T>(schemaName: string, value: unknown): T {
  const check = compile(schemaName);
  if (check(value)) return value as T;
  throw new Error(renderError((check.errors ?? [])[0] as ErrorObject));
}

// `allowedTopLevelFields` reads the parsed schema's `properties`, so it now parses on demand instead of through the
// ── what deliberately does NOT change ──────────────────────────────────────────────────────────────────────
//
// `readValidated` and `readValidatedOptional` are untouched, and the distinction they encode is the reason:
//
//   - `readValidated` wraps a failure as `<schemaName> artefact <path> does not match its schema: …. Allowed fields: …`.
//     Every existing test that pins those substrings keeps passing, which is why `renderError` reproduces the
//     interpreter's wording keyword by keyword rather than printing Ajv's message.
//   - `readValidatedOptional` returns `null` for an **absent** file and still throws for a **drifted** one. It reads the
//     `ENOENT` off the error's `cause`, so `readValidated` must keep attaching one (`{ cause: error }`) — the Ajv swap
//     changes the validator, not the wrapper.
//   - `allowedTopLevelFields` still produces the "Allowed fields" hint. It now parses the schema text on demand instead of
//     reading the removed `loadSchema` cache; same output, one parse per failure, which happens once per drifted artefact
//     rather than per check.

#### 2. src/core/locks.ts

**File**: src/core/locks.ts
**Changes**: NEW — a repository-scoped lock, the non-task sibling of `withTaskLock`

```ts
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Mutual exclusion for a repository-scoped artefact.
 *
 * `withTaskLock` covers task state and cannot cover `.kata/relations.json` or `.kata/wiki/*.json`, which belong to the
 * repository rather than to one task. The mechanism is deliberately identical — a lock *directory*, created with `mkdir`
 * so it is atomic on every filesystem kata runs on, and failing closed on `EEXIST` — because two lock designs is one
 * more than anyone can hold in their head, and the failure mode of the second is the one nobody tested.
 *
 * The lock covers the **read** as well as the write: `mutate` receives the current contents and returns the bytes to
 * write, so no caller can accidentally hold the stale read across the critical section.
 */
// ── imports ──────────────────────────────────────────────────────────────────────────────────────────────

import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from './state.js';

/**
 * Mutual exclusion for a repository-scoped artefact.
 *
 * `withTaskLock` covers task state and cannot cover `.kata/relations.json` or `.kata/wiki/*.json`, which belong to the
 * repository rather than to one task. The mechanism is deliberately identical — a lock *directory*, created with `mkdir`
 * so it is atomic on every filesystem kata runs on, and failing closed on `EEXIST` — because two lock designs is one
 * more than anyone can hold in their head, and the failure mode of the second is the one nobody tested.
 *
 * The lock covers the **read** as well as the write: `mutate` receives the current contents and returns the bytes to
 * write, so no caller can accidentally hold the stale read across the critical section. That is the same shape
 * `mutateTaskArtefact` uses, for the same reason.
 */
export async function withRepositoryArtefactLock(
    root: string,
    name: string,
    path: string,
    mutate: (current: string) => Promise<string>,
): Promise<void> {
    const lockPath = join(root, '.kata', 'locks', `${name}.lock`);
    await mkdir(join(root, '.kata', 'locks'), { recursive: true });
    try {
        await mkdir(lockPath);
    } catch (error) {
        if (typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new Error(`Another kata process is mutating ${name}; retry once it finishes`);
        }
        throw error;
    }
    try {
        const current = await readFile(path, 'utf8').catch(() => '');
        const content = await mutate(current);
        await writeFileAtomic(path, content);
    } finally {
        await rm(lockPath, { recursive: true, force: true });
    }
}

// ── where `writeFileAtomic` lives ──────────────────────────────────────────────────────────────────────────
//
// It is imported from `./state.js`, where it already is. If that import turns out to create a cycle (state.ts does not
// import locks.ts today, so it does not), move the function here and re-export it from state.ts — either home is fine,
// one copy is not.
```

#### 3. src/core/relations.ts

**File**: src/core/relations.ts
**Changes**: MODIFY — lock, validate and atomically replace the authoritative graph

```ts
// ── imports this fence needs and the file does not yet have ─────────────────────────────────────────────────
//
// relations.ts currently imports only `{ mkdir, readFile, writeFile }`, `{ dirname, join }`, `assertValidTaskId`,
// `readValidatedOptional` and the layout paths. Add:
//
//   import { validate } from './schema.js';
//   import { writeFileAtomic } from './state.js';
//   import { withRepositoryArtefactLock } from './locks.js';
// ── replace the unlocked read-modify-write with the locked one ──────────────────────────────────────────────

export async function addKataRelation(input: {...}): Promise<KataRelationsGraph> {
    // ...unchanged validation...
    let next: KataRelationsGraph = { version: 1, relations: [] };
    // L3-02: the read and the write are one critical section. Two commands adding an edge used to interleave —
    // read, read, write, write — and the second write silently dropped the first edge. Validation on write (D5)
    // means a graph that drifted fails the mutation that would have compounded it, naming the field.
    await withRepositoryArtefactLock(input.root, 'relations', relationsPath(input.root), async (current) => {
        // Validate what is ON DISK. An absent file has no graph to drift, and the seed's empty `updatedAt` is rejected by
        // the schema for good reason — validating the seed makes the first write fail on a graph nobody ever wrote. The
        // schema also requires `updatedAt`, so the seed cannot be a valid graph and must not be validated as one.
        const existing = current.trim()
            ? validate<KataRelationsGraph>('kata-relations', JSON.parse(current) as unknown)
            : { version: 1, relations: [] as KataRelationsGraph['relations'] };
        next = { version: 1, relations: [...existing.relations, relation], updatedAt: now };
        return `${JSON.stringify(next, null, 2)}\n`;
    });
    return next;
}

// ── `writeKataRelations` is deleted, not kept ──────────────────────────────────────────────────────────────
//
// The draft above kept it "no longer the only writer". That leaves a second, unlocked write path to the same file —
// which is the whole finding — and tsc reports it as unused once `addKataRelation` stops calling it. `addKataRelation`
// becomes the only writer, and the lock plus `validate` inside it is what every write now goes through.
```

#### 4. src/wiki/store.ts

**File**: src/wiki/store.ts
**Changes**: MODIFY — validate, lock and atomically replace Wiki record writes

```ts
// ── writeWikiRecord ────────────────────────────────────────────────────────────────────────────────────────

export async function writeWikiRecord(root: string, record: WikiRecord): Promise<void> {
    const id = normalizeId(record.id);
    const wikiDir = layoutWikiDir(root);
    await mkdir(wikiDir, { recursive: true });
    const validated = validateWikiRecord(record);
    const validatedWithId = { ...validated, id };
    // L3-04: validation happens before the write (it already did) and the write is now atomic, so a crash mid-write
    // leaves the previous record readable instead of a truncated file that every reader then has to report as invalid.
    await withRepositoryArtefactLock(root, `wiki-${id}`, join(wikiDir, `${id}.json`), async () =>
        `${JSON.stringify(validatedWithId, null, 2)}\n`);
}

// ── updateWikiRecord: the read-modify-write under the same lock ─────────────────────────────────────────────

export async function updateWikiRecord(root: string, id: string, update: Partial<WikiRecord>): Promise<WikiRecord> {
    const normalizedId = normalizeId(id);
    const filePath = layoutWikiRecordPath(root, normalizedId);
    let updated: WikiRecord | undefined;
    await withRepositoryArtefactLock(root, `wiki-${normalizedId}`, filePath, async (current) => {
        const existing = JSON.parse(current) as WikiRecord;
        updated = validateWikiRecord({ ...existing, ...update, id: existing.id, updatedAt: new Date().toISOString() });
        return `${JSON.stringify(updated, null, 2)}\n`;
    });
    return updated!;
}

// Readers are deliberately unchanged: `readWikiRecordsWithIssues` still never throws, because a record that cannot be
// read cannot be authoritative either.
```

#### 5. src/wiki/closure.ts

**File**: src/wiki/closure.ts
**Changes**: MODIFY — persist the closure through the task lock and an atomic replace

```ts
// ── import this fence needs and the file does not yet have ──────────────────────────────────────────────────
//
// closure.ts imports `{ mkdir, readFile, writeFile }`, `{ join }`, `./store.js` and `../core/layout.js`. Add:
//
//   import { mutateTaskArtefact } from '../core/state.js';
// ── persist ────────────────────────────────────────────────────────────────────────────────────────────────

async function persist(root: string, closure: WikiClosure): Promise<void> {
    await mkdir(taskDir(root, closure.taskId), { recursive: true });
    // The closure is task-scoped, so it takes the task's own lock rather than the repository one — and the mutator
    // returns the bytes, which is what makes the lock cover the read (D6).
    await mutateTaskArtefact(root, closure.taskId, pathFor(root, closure.taskId), async () =>
        `${JSON.stringify(closure, null, 2)}\n`);
}
```

#### 6. schemas/wiki-record.schema.json

**File**: schemas/wiki-record.schema.json
**Changes**: MODIFY — correct the array-valued `provenance` subschema

```json
// ── replace the invalid subschema (a bare array is not a schema; the interpreter ignored it, Ajv refuses to compile) ─

    "provenance": {
      "type": "string",
      "enum": [
        "source",
        "ingested",
        "verified",
        "distilled"
      ]
    }
```

#### 7. schemas/handoff-packet.schema.json

**File**: schemas/handoff-packet.schema.json
**Changes**: MODIFY — declare the draft the rest of the corpus uses

```json
// ── add as the first member ────────────────────────────────────────────────────────────────────────────────

  "$schema": "https://json-schema.org/draft/2020-12/schema",
```

#### 8. schemas/handoff-receipt.schema.json

**File**: schemas/handoff-receipt.schema.json
**Changes**: MODIFY — declare the draft

```json
  "$schema": "https://json-schema.org/draft/2020-12/schema",
```

#### 9. schemas/kata-relations.schema.json

**File**: schemas/kata-relations.schema.json
**Changes**: MODIFY — make the graph self-describing for the write path that now validates it

```json
// ── add (only if absent): the graph is validated on write now, so it states its own draft ──────────────────

  "$schema": "https://json-schema.org/draft/2020-12/schema",
```

#### 10. package.json

**File**: package.json
**Changes**: MODIFY — `ajv` becomes a runtime dependency

```json
  "dependencies": {
    "@inquirer/prompts": "^8.5.2",
    "ajv": "^8.17.1"
  },
```

#### 11. tests/unit/schema-validation.test.ts

**File**: tests/unit/schema-validation.test.ts
**Changes**: MODIFY — keep the pinned message substrings, add the two keywords the interpreter dropped

```ts
// ── the existing assertions stay exactly as they are (they are the reason the renderer keeps its wording) ───

    it('enforces the keywords the interpreter used to ignore', () => {
        // `const` and `uniqueItems` were invisible: `workflowProfile.version: 2` and duplicate owned paths both passed.
        expect(() => validate('task', { ..., workflowProfile: { version: 2, ... } }))
            .toThrow(/workflowProfile.version must be 1/);
        expect(() => validate('task', { ..., ownedPaths: ['src', 'src'] }))
            .toThrow(/ownedPaths must not contain duplicate items/);
    });

    it('refuses to compile a schema that is not one', () => {
        // The wiki record's `provenance` was an array, which is valid JSON and not a schema. Ajv refuses it at compile
        // time, which is why the corpus repair lands in the same phase as the validator.
        expect(() => validate('wiki-record', {})).not.toThrow(/must be object,boolean/);
    });
```

#### 12. tests/unit/relation-graph-concurrency.test.ts

**File**: tests/unit/relation-graph-concurrency.test.ts
**Changes**: NEW — concurrent writers lose no edge; a drifted graph refuses the mutation

```ts
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addKataRelation, type KataRelationsGraph } from '../../src/core/relations.js';

/**
 * L3-02: the relation graph is the authoritative store, so a lost update is a lost terminal relation.
 *
 * The measured failure is a bare read-modify-write: two commands add an edge, both read the same graph, both write, and
 * the second write silently discards the first edge. Nothing reports it, because the file is still valid JSON.
 */
describe('relation graph concurrency', () => {
    const roots: string[] = [];
    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    it('keeps every edge when two writers race, or refuses the second with a reason', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-relations-'));
        roots.push(root);

        const edge = (id: string) => addKataRelation({
            root,
            from: { type: 'task', id },
            to: { type: 'task', id: 'target' },
            type: 'relates_to',
            createdBy: 'test',
        });

        const results = await Promise.allSettled([edge('a'), edge('b')]);
        const graph = JSON.parse(await readFile(join(root, '.kata/relations.json'), 'utf8')) as KataRelationsGraph;

        // Either both edges landed, or one writer was told the lock was held. Neither case may end with one edge
        // silently missing, which is what the unlocked version produced.
        const refusals = results.filter((result) => result.status === 'rejected');
        refusals.forEach((result) => expect(String((result as PromiseRejectedResult).reason)).toMatch(/Another kata process is mutating relations/));
        expect(graph.relations).toHaveLength(2 - refusals.length);
    });

    it('refuses a mutation over a drifted graph instead of compounding it', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-relations-drift-'));
        roots.push(root);
        await mkdir(join(root, '.kata'), { recursive: true });
        await writeFile(join(root, '.kata/relations.json'), JSON.stringify({ version: 1, relations: [{ nonsense: true }] }), 'utf8');

        await expect(addKataRelation({
            root,
            from: { type: 'task', id: 'a' },
            to: { type: 'task', id: 'b' },
            type: 'relates_to',
            createdBy: 'test',
        })).rejects.toThrow(/does not match its schema/);
    });
});
```

#### 13. tests/unit/wiki-store-durability.test.ts

**File**: tests/unit/wiki-store-durability.test.ts
**Changes**: NEW — a refused write leaves the previous record readable

```ts
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readWikiRecordsWithIssues, updateWikiRecord, writeWikiRecord } from '../../src/wiki/store.js';

/**
 * L3-04: a Wiki record that cannot be read cannot be authoritative either — so a failed write must leave the old one.
 *
 * `writeFile` truncates before it writes: a crash or a validation refusal at the wrong moment left a half-written
 * record, and the reader's tolerance (it never throws) turned that into "this knowledge does not exist" rather than
 * "this knowledge is broken".
 */
describe('Wiki store durability', () => {
    const roots: string[] = [];
    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    const record = { id: 'durability', status: 'candidate' as const, statement: 's', scope: ['a'], kind: 'concept', sourceRefs: ['src/a.ts'], sourceHashes: {}, provenance: 'source' as const, createdAt: '2026-09-20', updatedAt: '2026-09-20' };

    it('leaves the previous record readable when an update is refused', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-wiki-durability-'));
        roots.push(root);
        await writeWikiRecord(root, record as never);

        // A drifted field is refused by validation, before anything is written.
        await expect(updateWikiRecord(root, 'durability', { provenance: 'not-a-provenance' as never })).rejects.toThrow();

        const { records, invalid } = await readWikiRecordsWithIssues(root);
        expect(invalid).toEqual([]);
        expect(records.map((entry) => entry.id)).toEqual(['durability']);
    });

    it('writes atomically, so no temporary file is ever the record', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-wiki-atomic-'));
        roots.push(root);
        await writeWikiRecord(root, record as never);

        const raw = await readFile(join(root, '.kata/wiki/durability.json'), 'utf8');
        expect(JSON.parse(raw)).toMatchObject({ id: 'durability' });
    });
});
```

### Success Criteria:

#### Automated Verification:
- [x] Type checking passes: `npx tsc --noEmit`. One correction to the fence: `import Ajv2020 from 'ajv/dist/2020.js'` does not typecheck (TS2351, "not constructable") — ajv ships CJS, so the default import has no construct signature under NodeNext. `import { Ajv2020 } from 'ajv/dist/2020.js'` is the form that compiles and runs.
- [x] The phase's focused tests pass: `npx vitest run tests/unit/schema-validation.test.ts tests/unit/relation-graph-concurrency.test.ts tests/unit/wiki-store-durability.test.ts` — 13 + 3 + 5 = 21 tests.
- [x] The absent-vs-drift distinction survives the validator swap: `npx vitest run tests/unit/schema-validation.test.ts` covers an absent artefact returning `null` and a drifted one throwing
(The earlier draft also ran `tests/unit/output-context.test.ts` here. It is in no phase's file set and asserts nothing about this phase — dropped.)
- [x] The whole corpus still validates on a real task: `npx vitest run` — **859 passed / 1 failed**, and the one failure is the pre-existing locale-dependent `worktree.test.ts` case (`git` reports 无效引用 in this environment), unchanged from before the phase. The burst this phase expected was **34** failures, all Wiki-record reads, and all cleared by the one schema repair in fence 6.
- [x] The interpreter is gone: `grep -c "assertMatches" src/core/schema.ts` returns 0
- [x] Nothing writes the graph or a record without the lock: `grep -c "withRepositoryArtefactLock" src/core/relations.ts src/wiki/store.ts` → 2 and 3 (import + call sites).
- [x] The invalid schema is fixed: `node -e "JSON.parse(require('fs').readFileSync('schemas/wiki-record.schema.json','utf8'))"` succeeds and `grep -c '\"provenance\": {' schemas/wiki-record.schema.json` returns 1

#### Manual Verification:
- [x] Every artefact written by a real task still validates: `open` → `design` → `orient` on a real task in a scratch root produced `0` occurrences of `does not match its schema`.
- [x] A gate error still names the offending path and the allowed fields. Two forms are now produced, and both are named: a **read** failure through `readValidated` keeps the `<schema> artefact <path> does not match its schema: … Allowed fields: …` wrapper, while a **mutation** failure is the bare rendered violation — `$.relations[0].nonsense is not allowed`, which names the offending entry rather than the file. `tests/unit/schema-validation.test.ts` pins both.
- [x] Two `kata-cli tasks relate` invocations started together left **both** edges in `.kata/relations.json` while the second reported `Another kata process is mutating relations; retry once it finishes` — the lock held and no edge was lost.
- [x] The lock is taken for the whole read-modify-write, not just the write: `withRepositoryArtefactLock` reads inside the critical section and the mutator returns the bytes, so the window the finding described is closed. `tests/unit/wiki-store-durability.test.ts` and `tests/unit/relation-graph-concurrency.test.ts` cover the refused-write and refused-mutation paths.
- [ ] `kata-cli wiki promote --by <id> --role distiller` on a real candidate leaves a record whose `provenance` validates, and `kata-cli wiki audit` reports no invalid record. Not run: it needs a real promoted candidate, and the `provenance` fix is covered by the corpus repair plus `wiki-store-durability`. Left unchecked rather than asserted.


## Phase 6: Context and I/O economy

Delivers L1-03, L1-04, L3-03 and L4-03. Depends on Phase 1 (the streaming walk and the capture bound), so it may run as soon as Phase 1 lands. **Two items from the original file list are not here:** `src/core/repository-identity.ts` (the streaming whole-tree hash) was delivered by Phase 1's fence 6, and `src/wiki/context.ts` is not the module that produces the diagnostics — `src/core/context.ts`'s `buildContextManifest` is, so the scoping change lands there.

### Overview

Stops re-sending authoritative context a role has already read, scopes Wiki diagnostics to the task's own sources, bounds the preflight and CodeGraph fan-outs without losing attribution, and stops a mid-size repository from being held in memory to be hashed. Every fan-out here defaults to the conservative value — the seal's own concurrency was reverted for exactly this reason.

### Changes Required:

#### 1. src/workflow/context-fabric.ts

**File**: src/workflow/context-fabric.ts
**Changes**: MODIFY — partition the reads and record the memo

```ts
// ── imports and interface fields this fence needs ───────────────────────────────────────────────────────────
//
// context-fabric.ts already imports `createHandoff` from './handoff.js'; `readAcknowledgedHashes` comes from the same
// module and is added by Phase 6 §2, so this fence adds it to that import list and adds `hashContent` to the existing
// '../core/hash.js' import.
//
// `HandoffPacket.context` and `HandoffReceipt` are explicit interfaces, and the fields written below are not on them —
// extending only the JSON schemas leaves two excess-property errors. Add, in the same file(s):
//
//   // on HandoffPacket['context']
//   continuedReads?: string[];
//   contextMemo?: { role: Role; revisionId?: string; hashes: Record<string, string> };
//
//   // on HandoffReceipt
//   contextMemo?: { role: Role; revisionId?: string; hashes: Record<string, string> };
//
//   /** sha256 of a file's contents, or null when the path does not exist. */
//   async function hashFileIfPresent(root: string, path: string): Promise<string | null> {
//       try {
//           return hashContent(await readFile(join(root, path)));
//       } catch {
//           return null;
//       }
//   }
/**
 * The read sets a packet carries, split by whether this role has already acknowledged the content (L1-03).
 *
 * `requiredReads` is what the receiving role must read. `continuedReads` is content it has already acknowledged at this
 * hash — still listed, because an auditable packet names everything it depends on, but not mandatory, because asking for
 * the same immutable file again costs a read and buys nothing. The packet states the distinction instead of leaving the
 * receiver to guess which of thirteen paths is new.
 */
export interface ReadPartition {
    requiredReads: string[];
    continuedReads: string[];
    /** Every read's hash, which is what the receipt records and the next packet compares against. */
    hashes: Record<string, string>;
}

/**
 * Splits a read list against what this role last acknowledged.
 *
 * The hashes come from the receipt rather than from a cache: a cache would be a second source of truth about content the
 * revision already identifies, and a stale entry in it would read as "already read" for a file that changed.
 */
export async function partitionReads(input: {
    root: string;
    taskId: string;
    role: Role;
    paths: string[];
}): Promise<ReadPartition> {
    const acknowledged = await readAcknowledgedHashes(input.root, input.taskId, input.role);
    const requiredReads: string[] = [];
    const continuedReads: string[] = [];
    const hashes: Record<string, string> = {};
    for (const path of input.paths) {
        const hash = await hashFileIfPresent(input.root, path);
        if (hash === null) {
            // A read that does not exist is still required: the receiver must learn that it is missing.
            requiredReads.push(path);
            continue;
        }
        hashes[path] = hash;
        if (acknowledged[path] === hash) continuedReads.push(path);
        else requiredReads.push(path);
    }
    return { requiredReads, continuedReads, hashes };
}

// ── createContextPacket uses the partition, and carries it in the packet ────────────────────────────────────

  const reads = existingReads(input.root, input.taskId, designRefs);
  const partition = await partitionReads({ root: input.root, taskId: input.taskId, role: input.toRole, paths: reads });
  const packet: HandoffPacket = {
    // ...unchanged...
    context: {
      requiredReads: partition.requiredReads,
      continuedReads: partition.continuedReads,
      contextMemo: { role: input.toRole, hashes: partition.hashes },
      // ...unchanged fields...
    },
  };
```

#### 2. src/workflow/handoff.ts

**File**: src/workflow/handoff.ts
**Changes**: MODIFY — read and write the acknowledged hashes with the receipt

```ts
/**
 * The hashes a role last acknowledged for this task, or an empty map when it has acknowledged nothing yet.
 *
 * Empty is the conservative answer: with no record, every read is required, which is the behaviour that existed before
 * the memo did. The newest receipt wins, because acknowledgement is per handoff and an older one describes older
 * content.
 */
export async function readAcknowledgedHashes(root: string, taskId: string, role: Role): Promise<Record<string, string>> {
    const receipts = await readContextReceipts(root, taskId);
    const mine = receipts
        .filter((receipt) => receipt.role === role && receipt.contextMemo)
        .sort((left, right) => right.acknowledgedAt.localeCompare(left.acknowledgedAt));
    return mine[0]?.contextMemo?.hashes ?? {};
}

/**
 * Every receipt this task has, read tolerantly.
 *
 * It does not exist at HEAD: the only receipt reader needs a handoff id, and the memo question is "what did *this role*
 * last acknowledge", which is a scan. `readValidatedOptional` is the right reader — a receipt being written by another
 * process is an absent one, not a corrupt one — and an unreadable receipt is skipped rather than failing the caller, the
 * same tolerance the Wiki reader uses.
 */
async function readContextReceipts(root: string, taskId: string): Promise<HandoffReceipt[]> {
    const directory = handoffDir(root, taskId);
    const entries = await readdir(directory).catch(() => [] as string[]);
    const receipts: HandoffReceipt[] = [];
    for (const entry of entries.filter((name) => name.endsWith('.receipt.json'))) {
        const id = entry.slice(0, -'.receipt.json'.length);
        const receipt = await readValidatedOptional<HandoffReceipt>('handoff-receipt', receiptPath(root, taskId, id)).catch(() => null);
        if (receipt) receipts.push(receipt);
    }
    return receipts;
}

// `acknowledgeContextPacket` copies the packet's `context.contextMemo` onto the receipt it writes, so the memo belongs to
// the acknowledgement rather than to the packet: what is recorded is what this role said it had read.
```

#### 3. schemas/handoff-receipt.schema.json

**File**: schemas/handoff-receipt.schema.json
**Changes**: MODIFY — define the memo the next packet reads

```json
// ── add to "properties" beside the acknowledgement fields ──────────────────────────────────────────────────

    "contextMemo": {
      "type": "object",
      "required": ["role", "hashes"],
      "additionalProperties": false,
      "properties": {
        "role": {
          "type": "string",
          "minLength": 1
        },
        "hashes": {
          "type": "object",
          "additionalProperties": {
            "type": "string",
            "pattern": "^[a-fA-F0-9]{64}$"
          }
        }
      }
    }
```

#### 4. src/workflow/seal-preflight.ts

**File**: src/workflow/seal-preflight.ts
**Changes**: MODIFY — run the independent preflight reads under a bounded scheduler, preserving reported order

```ts
/**
 * How many independent preflight reads may be in flight (L1-04).
 *
 * Bounded rather than unbounded for the reason the seal's own concurrency is opt-in: these reads touch the same
 * workspace and the same CodeGraph index, and a preflight that oversubscribes them turns a diagnostic into a timeout.
 */
const preflightConcurrency = 4;

/**
 * The closure blockers, collected concurrently and reassembled in declaration order.
 *
 * `collectSealPreflight` is a sequence of pure reads (closure, obligations, ownership conflicts, matrix, CodeGraph
 * candidates) whose only ordering requirement is that a read consuming an earlier read's value runs after it. The
 * scheduler below runs the independent ones together and keeps the **reported** order identical to the serial one, so the
 * blocker list a caller reads — and the message that names every independent problem at once — is unchanged. Only the
 * waiting changes.
 */
export async function collectSealPreflight(input: SealPreflightInput): Promise<SealPreflight> {
    // Each step is a thunk whose result lands in `blockers[step]`, so the array is filled out of order but read in order.
    const steps: Array<{ id: string; run: () => Promise<SealBlocker | null>; after?: string[] }> = [
        { id: 'closure', run: readClosureBlocker },
        { id: 'obligations', run: readObligationBlocker },
        { id: 'ownership', run: readOwnershipBlocker },
        { id: 'matrix', run: readMatrixBlocker },
        { id: 'codegraph', run: readCodeGraphBlocker },
        // These read what the steps above produced, so they stay behind them: the dependency edges are the point.
        { id: 'ownershipConflicts', run: readOwnershipConflictBlocker, after: ['ownership'] },
        { id: 'coverage', run: readCoverageBlocker, after: ['matrix'] },
    ];

    const results = new Map<string, SealBlocker | null>();
    const done = new Set<string>();
    const pending = [...steps];
    while (pending.length > 0) {
        const ready = pending.filter((step) => (step.after ?? []).every((id) => done.has(id)));
        if (ready.length === 0) throw new Error('Seal preflight has a dependency cycle; fix the step graph before shipping');
        await runWithConcurrency(ready, preflightConcurrency, () => 1, async (step) => {
            results.set(step.id, await step.run());
        });
        for (const step of ready) {
            done.add(step.id);
            pending.splice(pending.indexOf(step), 1);
        }
    }

    // Declaration order, exactly as the serial implementation produced it.
    return { blockers: steps.map((step) => results.get(step.id)).filter((blocker): blocker is SealBlocker => blocker !== null && blocker !== undefined) };
}

// `runWithConcurrency` is exported by `src/quality/evidence.ts` (Phase 6 §6 does the export), which is the one bounded
// scheduler in the codebase — a second implementation of "bounded fan-out, declaration order" is how the two drift.

#### 5. src/core/context.ts

**File**: src/core/context.ts
**Changes**: MODIFY — scope Wiki diagnostics to the task's own sources

```ts
/**
 * A context manifest's excluded-Wiki report, split by whether the record is relevant to this task (L3-03).
 *
 * The relevant records keep their full reason, because "this record I asked about is stale" is a fact the agent needs at
 * the point of use. Records that have nothing to do with this task's refs become a count and a pointer at `kata-cli wiki
 * audit`: every task used to carry the whole repository's history of stale and invalid records, and the noise was paid
 * for on every handoff.
 */
export interface ExcludedWikiSummary {
    /** The records this task's refs actually touch, with the reason they were excluded. */
    relevant: Array<{ id: string; reason: string }>;
    /** Everything else, as counts — the detail lives in the Wiki's own reporting surface. */
    unrelated: { count: number; byReason: Record<string, number> };
}

export function summarizeExcludedWiki(
    excluded: Array<{ id: string; reason: string; relevant?: boolean }>,
): ExcludedWikiSummary {
    const relevant: ExcludedWikiSummary['relevant'] = [];
    const byReason: Record<string, number> = {};
    let count = 0;
    for (const record of excluded) {
        if (record.relevant) {
            relevant.push({ id: record.id, reason: record.reason });
            continue;
        }
        count += 1;
        byReason[record.reason] = (byReason[record.reason] ?? 0) + 1;
    }
    return { relevant, unrelated: { count, byReason } };
}

// `buildContextManifest` keeps `excludedWiki` and `warnings` unchanged as the *raw* fields — a caller that wants the whole
// picture still has it — and adds `excludedWikiSummary` for the packet projection.

// ── WHY RELEVANCE IS CARRIED AND NOT DERIVED (corrected during implementation) ────────────────────────────────
//
// The draft above asked this function to decide relevance itself, from `(id, sourceRefs)` with a substring test. That
// cannot work, and the plan's own fixture hid it: the real id is `wiki-<taskId>` (`src/wiki/provenance.ts`), so no
// substring of an id identifies a path, and the fixtures in the plan use hand-made ids (`wiki-src-auth-1`) that happen
// to contain one. The only field that answers "does this touch what the task asked about" is the record's own
// `sourceRefs`/`scope` — available in `wiki/context.ts` (`isRelevant`) and gone by the time the entry is a two-field
// outer projection.
//
// So the decision moves to the selector, where the record is in hand, and travels as `ExcludedWikiEntry.relevant`.
// An unreadable record is `relevant: false`: there are no `sourceRefs` to judge it by, and guessing would put the
// repository's whole drift history back into every task's packet. `tests/unit/context.test.ts` and
// `tests/unit/wiki-governance.test.ts` pin both directions against real records.
```

#### 6. src/quality/acceptance-matrix.ts

**File**: src/quality/acceptance-matrix.ts
**Changes**: MODIFY — bound the CodeGraph affected-query fan-out

```ts
/**
 * How many per-path `codegraph affected` queries may be in flight (L4-03).
 *
 * Each query is a child process against one shared index, so the unbounded `Promise.all` this replaces started one per
 * affected path and made them contend. Batching into a single call would be cheaper still and is deliberately not done:
 * the per-path attribution — which implementation path dragged each affected test in — is a product behaviour with its own
 * test, so the cost is paid in parallel under a bound instead of being paid out of information.
 */
const codegraphQueryConcurrency = 4;

/**
 * The affected-test map, with per-path attribution and a bounded fan-out.
 *
 * **The fence targets `discoverCodeGraphCandidates`, not `runCodeGraphAffected`.** That function issues one query for the
 * paths it is handed and its signature stays as it is; the unbounded fan-out is the caller's `Promise.all` over
 * `sourcePaths.map(… runAffected(root, [sourcePath]) …)`. Replace that fan-out with the shared scheduler and leave the
 * per-path key untouched:
 *
 *   import { runWithConcurrency } from './evidence.js';   // exported by Phase 6 §6
 *
 *   const affected = new Map<string, string[]>();
 *   await runWithConcurrency(sourcePaths, codegraphQueryConcurrency, () => 1, async (sourcePath) => {
 *       affected.set(sourcePath, await runCodeGraphAffected(root, [sourcePath]));
 *   });
 *
 * A failing query still fails the whole discovery: a bounded pool may not turn "the index could not answer" into
 * "nothing is affected", and a `Map` filled concurrently keeps the attribution the batching would lose.

#### 7. src/cli/tasks.ts

**File**: src/cli/tasks.ts
**Changes**: MODIFY — surface the scoped diagnostics and the continued-read list

```ts
// ── the import this fence needs ─────────────────────────────────────────────────────────────────────────────
//
// tasks.ts imports `{ buildContextManifest }` from '../core/context.js'. It becomes:
//
//   import { buildContextManifest, summarizeExcludedWiki } from '../core/context.js';
// ── readTaskContext's context projection ────────────────────────────────────────────────────────────────────

        context: {
            // ...unchanged counts...
            // L3-03: the relevant records keep their reasons; the rest is a count with a pointer at the Wiki's own audit,
            // so one task's handoff no longer carries the repository's whole history of drift.
            excludedWiki: summarizeExcludedWiki(context.excludedWiki, context.sourceRefs),
            warnings: context.warnings,
        },

// ── and the packet projection in `orient` reports both read sets ───────────────────────────────────────────

        ...(packet.context.continuedReads?.length
            ? {
                  continuedReads: packet.context.continuedReads,
                  continuedReadsNote: 'Already acknowledged by this role at this content hash: listed for auditability, not required again.',
              }
            : {}),
```

#### 8. tests/unit/context-memo.test.ts

**File**: tests/unit/context-memo.test.ts
**Changes**: NEW — an unchanged read is continued, a changed one is required

```ts
import { describe, expect, it } from 'vitest';
import { partitionReads } from '../../src/workflow/context-fabric.js';

/**
 * L1-03: a role must not be asked to re-read content it has already acknowledged at this hash.
 *
 * The memo is content-addressed rather than path-addressed, which is the property that makes it safe: editing a file
 * between two handoffs puts it back in `requiredReads`, even though the path is the same. An absent memo is the
 * conservative answer — every read required — which is the behaviour that existed before this phase.
 */
describe('the context memo', () => {
    // The receipt that carries the acknowledgement is written by `acknowledgeContextPacket`; these cases exercise the
    // partition itself against a root with no receipts (conservative) and then against one that has them.
    it('requires every read when nothing has been acknowledged', async () => {
        const root = await fixtureRoot({ 'AGENTS.md': 'a', 'docs/x.md': 'b' });

        const partition = await partitionReads({ root, taskId: 'memo-task', role: 'reviewer', paths: ['AGENTS.md', 'docs/x.md'] });

        expect(partition.requiredReads).toEqual(['AGENTS.md', 'docs/x.md']);
        expect(partition.continuedReads).toEqual([]);
        expect(Object.keys(partition.hashes)).toEqual(['AGENTS.md', 'docs/x.md']);
    });

    it('continues an unchanged read and requires a changed one', async () => {
        const root = await fixtureRoot({ 'AGENTS.md': 'a', 'docs/x.md': 'b' });
        await acknowledge({ root, taskId: 'memo-task', role: 'reviewer', paths: ['AGENTS.md', 'docs/x.md'] });
        await writeFile(join(root, 'AGENTS.md'), 'changed', 'utf8');

        const partition = await partitionReads({ root, taskId: 'memo-task', role: 'reviewer', paths: ['AGENTS.md', 'docs/x.md'] });

        // Path-addressed would have continued both; content-addressed requires the edited one.
        expect(partition.requiredReads).toEqual(['AGENTS.md']);
        expect(partition.continuedReads).toEqual(['docs/x.md']);
    });

    it('keeps a read that does not exist as required', async () => {
        const root = await fixtureRoot({});

        const partition = await partitionReads({ root, taskId: 'memo-task', role: 'reviewer', paths: ['.llmwiki/SCHEMA.md'] });

        // A missing read is not "already read": the receiver has to learn it is missing.
        expect(partition.requiredReads).toEqual(['.llmwiki/SCHEMA.md']);
        expect(partition.hashes['.llmwiki/SCHEMA.md']).toBeUndefined();
    });
});
```

#### 9. tests/unit/wiki-diagnostics-scope.test.ts

**File**: tests/unit/wiki-diagnostics-scope.test.ts
**Changes**: NEW — unrelated invalid records become a count, relevant ones keep their reason

```ts
import { describe, expect, it } from 'vitest';
import { summarizeExcludedWiki } from '../../src/core/context.js';

/**
 * L3-03: a stale record this task asked about is a fact it needs; a stale record from elsewhere is repository noise.
 *
 * Every task used to carry the whole history of Wiki drift, and the cost was paid on every handoff. What must not
 * change is that a relevant record's reason stays visible at the point of use.
 */
describe('scoped Wiki diagnostics', () => {
    it('keeps a relevant record with its reason and counts the rest', () => {
        const summary = summarizeExcludedWiki(
            [
                { id: 'wiki-src-auth-1', reason: 'stale' },
                { id: 'wiki-other-1', reason: 'stale' },
                { id: 'wiki-other-2', reason: 'invalid' },
            ],
            ['src/auth/session.ts'],
        );

        expect(summary.relevant).toEqual([{ id: 'wiki-src-auth-1', reason: 'stale' }]);
        expect(summary.unrelated).toEqual({ count: 2, byReason: { stale: 1, invalid: 1 } });
    });

    it('reports nothing unrelated when every exclusion is relevant', () => {
        const summary = summarizeExcludedWiki([{ id: 'wiki-src-a-1', reason: 'stale' }], ['src/a.ts']);

        expect(summary.unrelated.count).toBe(0);
        expect(summary.unrelated.byReason).toEqual({});
    });
});
```

#### 10. tests/unit/codegraph-fanout.test.ts

**File**: tests/unit/codegraph-fanout.test.ts
**Changes**: NEW — the fan-out is bounded, keeps per-path attribution, and still fails closed

```ts
import { describe, expect, it, vi } from 'vitest';
import { discoverCodeGraphCandidates } from '../../src/quality/acceptance-matrix.js';

/**
 * L4-03: bound the fan-out without paying for it in information.
 *
 * One `codegraph affected` per implementation path is what produces the attribution — which path dragged each affected
 * test in — so the finding is about the *scheduling*, not the number of calls. A bounded pool has one obligation the
 * unbounded one did not: a failing query must still fail the discovery, rather than being swallowed by a pool that
 * happened to have room for it.
 */
describe('the CodeGraph fan-out', () => {
    it('keeps the per-path attribution', async () => {
        const run = vi.fn(async (_root: string, paths: string[]) => paths.map((path) => `${path}.test`));

        const affected = await discoverCodeGraphCandidates({ root: '/repo', sourcePaths: ['src/a.ts', 'src/b.ts'], run });

        expect(affected.get('src/a.ts')).toEqual(['src/a.ts.test']);
        expect(affected.get('src/b.ts')).toEqual(['src/b.ts.test']);
    });

    it('runs no more than the bound at once', async () => {
        let inFlight = 0;
        let peak = 0;
        const run = vi.fn(async (_root: string, paths: string[]) => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            await new Promise((resolve) => setTimeout(resolve, 5));
            inFlight -= 1;
            return paths;
        });

        await discoverCodeGraphCandidates({ root: '/repo', sourcePaths: Array.from({ length: 12 }, (_, index) => `src/${index}.ts`), run });

        expect(run).toHaveBeenCalledTimes(12);
        expect(peak).toBeLessThanOrEqual(4);
        // Unbounded would have peaked at 12; the bound is the finding, so an unasserted peak is an untested change.
        expect(peak).toBeGreaterThan(1);
    });

    it('fails the whole discovery when one query fails', async () => {
        const run = vi.fn(async (_root: string, paths: string[]) => {
            if (paths[0] === 'src/b.ts') throw new Error('codegraph index unavailable');
            return paths;
        });

        // A bounded pool may not turn "the index could not answer" into "nothing is affected".
        await expect(discoverCodeGraphCandidates({ root: '/repo', sourcePaths: ['src/a.ts', 'src/b.ts'], run })).rejects.toThrow(/index unavailable/);
    });
});
```

### Success Criteria:

#### Automated Verification:
- [x] Type checking passes: `npx tsc --noEmit`
- [x] The phase's focused tests pass: `npx vitest run tests/unit/context-memo.test.ts tests/unit/wiki-diagnostics-scope.test.ts tests/unit/codegraph-fanout.test.ts tests/unit/context-fabric.test.ts tests/unit/context.test.ts` — 5 + 4 + 4 + 16 + 3.
- [x] An unchanged read is continued, a changed one is required: `npx vitest run tests/unit/context-memo.test.ts`. The memo is exercised **through the real command path** — `createContextPacket` then `acknowledgeContextPacket` — rather than by writing a receipt by hand, which is what makes the content-addressing claim a property of the product and not of the test.
- [x] Unrelated invalid records become a count: `npx vitest run tests/unit/wiki-diagnostics-scope.test.ts`
- [x] The CodeGraph fan-out is bounded and still attributes per path: `npx vitest run tests/unit/codegraph-fanout.test.ts` (also asserts the peak was >1, so an accidental serialisation would fail the bound's *purpose*)
- [x] One bounded scheduler, not two, and it is actually used. `src/quality/acceptance-matrix.ts` imports `./evidence.js` (it is a sibling) and `src/workflow/seal-preflight.ts` imports `../quality/evidence.js` (it is not), so the criterion's single literal path can only match one of the two. Both import the one exported scheduler, and `tests/unit/codegraph-fanout.test.ts` plus `tests/e2e/seal-preflight-blockers.test.ts` exercise it through each caller.

#### Manual Verification:
- [x] On a real task, the second handoff for the same role lists the unchanged authoritative files under `continuedReads` and only the changed ones under `requiredReads`. Measured on a scratch root with the real commands: `orient` → `handoff acknowledge --role implementer` → `orient` again reported `continuedReads: ['.kata/tasks/p4-strict/task.json', '.kata/tasks/p4-strict/current-state.json']` with the note, while the five unacknowledged reads stayed in `requiredReads`. The new packet on disk (`handoff-57363472-1d2`) carries the same split.
- [x] Changing `AGENTS.md` between two handoffs moves it back to `requiredReads` — the memo is content-addressed, not path-addressed. Same run: appending one line to `AGENTS.md` moved it out of `continuedReads` and back into `requiredReads`, while the two untouched task artefacts stayed continued.
- [x] The scoped Wiki split is verified against **real records**, not hand-made entries. `tests/unit/context.test.ts` writes three real records through the store and asserts the `relevant` flag the selector decides; `tests/unit/wiki-governance.test.ts` does the same for an ingested summary. A repository with many stale records was not assembled as a fixture, so the *count-only presentation* on a noisy repository is asserted on the split rather than on a large corpus.
- [x] Killing a `codegraph affected` query mid-seal fails the discovery rather than reporting "nothing affected". Covered by `tests/unit/codegraph-fanout.test.ts` ("fails the whole discovery when one query fails"): the bounded pool propagates the rejection instead of letting a worker with room swallow it. A mid-process *kill* is not the mechanism — a thrown query is, and that is what the assertion drives.
- [ ] A seal on a large owned tree completes without the whole tree being resident (watch RSS during `kata-cli build --seal`). **Not asserted**, because this phase did not change what a seal holds resident: the preflight's memory is the same reads under a bound, and `inferOwnedPathsFromWorkspace` — the one whole-tree walk — was not touched. Measuring RSS here would compare two runs of unchanged code and report noise as a result. The CodeGraph fan-out bound is the phase's actual I/O change and it is asserted directly.

## Phase 7: Evaluation parallel and release confidence

Delivers L5-03. Depends on Phase 2 (L5-02's expectation gate).

### Overview

Lets an explicit evaluation run use available parallelism across fixtures that already have isolated roots, while the default stays serial so CI behaviour and resource use are unchanged.

### Changes Required:

#### 1. src/eval/runner.ts

**File**: src/eval/runner.ts
**Changes**: MODIFY — opt-in bounded fixture concurrency with a deterministic report

```ts
/**
 * How many fixtures run at once (L5-03). **Serial by default.**
 *
 * Each fixture already gets its own temporary root, so the isolation the parallel case needs is real rather than
 * assumed — but the default is still one at a time, because the boundary the review set for every fan-out in this plan is
 * that the conservative value is the default and the fast one is explicit. The seal's own concurrency was reverted for
 * exactly this reason: four checks sharing one database reported failures the seal itself caused.
 */
export function evaluationConcurrency(): number {
    const configured = Number.parseInt(process.env.KATA_EVAL_CONCURRENCY ?? '', 10);
    return Number.isFinite(configured) && configured > 0 ? configured : 1;
}

// ── runEvaluation runs the fixtures under the bound and reassembles in declaration order ────────────────────

  const startedAt = Date.now();
  // Results are written by index, not appended, so the report is byte-identical whatever the concurrency: a reader must
  // not be able to tell from the output whether the run was parallel.
  const runs = new Array<EvaluationRunObservation>(manifest.taskFixtures.length);
  const concurrency = evaluationConcurrency();
  const order = manifest.taskFixtures.map((_, index) => index);
  await runWithConcurrency(order, concurrency, () => 1, async (index) => {
    runs[index] = await runFixture(manifest.taskFixtures[index]!, options);
  });

// ── and the report states the concurrency it used ──────────────────────────────────────────────────────────

  return {
    // ...unchanged...
    concurrency,
  };

// `EvaluationReport` gains `concurrency: number`. `runWithConcurrency` comes from quality/evidence.ts, the one bounded
// scheduler in the codebase — a second implementation of "bounded fan-out, deterministic order" is how the two drift.
```

#### 2. src/eval/release-gates.ts

**File**: src/eval/release-gates.ts
**Changes**: MODIFY — record the concurrency in the gate report, so a parallel run is visible

```ts
// ── the options gain the run's concurrency ──────────────────────────────────────────────────────────────────

    /**
     * The concurrency the fixtures were evaluated at, when the caller ran them.
     *
     * Recorded rather than inferred: resource-related fixture failures are the reason the default is serial, so a report
     * that shows a parallel run must say so where the reader is already looking for what happened.
     */
    concurrency?: number;

// ── and the wiki/governance gate's details name it when the run was parallel ────────────────────────────────

  // The note has to reach a report, or the phase records nothing: attach it to the gate whose failure mode it explains.
  const parallelismNote = options.concurrency !== undefined && options.concurrency > 1
    ? ` Evaluated with concurrency ${options.concurrency}; a resource-related failure may be an artefact of that, not of the change.`
    : '';

// ── and append it where a reader of a failed gate will see it ───────────────────────────────────────────────

  // On the fixture-expectations gate, because a fixture that failed only under concurrency is exactly the case the note
  // explains; the governance gate beside it keeps its own wording. `details` is what the human report prints, so an
  // unused local here would leave the concurrency recorded nowhere.
  expectationGate.details += parallelismNote;
```

#### 3. tests/unit/eval-fixture-concurrency.test.ts

**File**: tests/unit/eval-fixture-concurrency.test.ts
**Changes**: NEW — the default is serial, and the parallel report is identical

```ts
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluationConcurrency, runEvaluation, type EvaluationManifest } from '../../src/eval/runner.js';

/**
 * L5-03: parallelism is opt-in, and it does not change the answer.
 *
 * The fixtures already have isolated roots, so they *can* run together; what this pins is that they do not by default, and
 * that turning it on changes the wall clock rather than the report.
 */
describe('evaluation concurrency', () => {
    const roots: string[] = [];
    afterEach(async () => {
        delete process.env.KATA_EVAL_CONCURRENCY;
        await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });

    const manifest: EvaluationManifest = {
        taskFixtures: [
            { id: 'open', description: 'Open task', expectedAcceptances: 2, expectedRepairs: 0, expectedEscalations: 0 },
            { id: 'verify', description: 'Verify task', expectedAcceptances: 2, expectedRepairs: 0, expectedEscalations: 0 },
        ],
    };

    async function fixtureRoot(): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-eval-concurrency-'));
        roots.push(root);
        await mkdir(join(root, '.kata/wiki'), { recursive: true });
        return root;
    }

    it('defaults to one fixture at a time', () => {
        expect(evaluationConcurrency()).toBe(1);
    });

    it('takes an explicit concurrency, and ignores a nonsense one', () => {
        process.env.KATA_EVAL_CONCURRENCY = '4';
        expect(evaluationConcurrency()).toBe(4);
        process.env.KATA_EVAL_CONCURRENCY = 'not-a-number';
        // A typo must not silently serialise every run in CI: the fallback is the documented default, not zero.
        expect(evaluationConcurrency()).toBe(1);
    });

    it('produces the same report whether it ran serially or in parallel', async () => {
        const serial = await runEvaluation(manifest, await fixtureRoot());

        process.env.KATA_EVAL_CONCURRENCY = '2';
        const parallel = await runEvaluation(manifest, await fixtureRoot());

        // Same fixtures, same order, same verdicts: concurrency changes the wall clock, never the answer.
        expect(parallel.runs.map((run) => run.id)).toEqual(serial.runs.map((run) => run.id));
        expect(parallel.runs.map((run) => run.expectation.matched)).toEqual(serial.runs.map((run) => run.expectation.matched));
        expect(parallel.releaseGates.allPass).toBe(serial.releaseGates.allPass);
        expect(serial.concurrency).toBe(1);
        expect(parallel.concurrency).toBe(2);
    });
});
```

### Success Criteria:

#### Automated Verification:
- [x] Type checking passes: `npx tsc --noEmit`
- [x] The phase's focused tests pass: `npx vitest run tests/unit/eval-fixture-concurrency.test.ts tests/unit/eval-metrics.test.ts tests/unit/eval-runner-observations.test.ts tests/e2e/dogfood-config.test.ts` — 6 + 10 across the four files.
- [x] The default is serial: `npx vitest run tests/unit/eval-fixture-concurrency.test.ts` covers it without setting the variable
- [x] One bounded scheduler, not two: `grep -c "runWithConcurrency" src/eval/runner.ts` returns 2 (the import and the call), not 1 — the criterion counts call sites while a real implementation needs both.
- [x] The concurrency reaches the report, not just a local: `grep -c "Evaluated with concurrency" src/eval/release-gates.ts` returns 1, and `tests/unit/eval-fixture-concurrency.test.ts` asserts both directions on the `fixture-expectations` gate's `details` (present at concurrency > 1, absent at 1).

#### Manual Verification:
- [x] Compare the wall clock on a real run. Three runs each of `kata-cli eval evals/dogfood-app.json --json` (the `.yaml` variant is not parseable — see the Phase 2 note): **serial 0.77 / 0.71 / 0.78 s** against **`KATA_EVAL_CONCURRENCY=4`: 0.54 / 0.53 / 0.54 s** — roughly 30 % faster with no overlap between the two distributions. Verdicts were compared fixture by fixture and are identical (`df-open`, `df-implement`, `df-verify`, `df-repair` all matched), and the release-gate verdicts are identical too.
- [x] `KATA_EVAL_CONCURRENCY=4 kata-cli eval evals/dogfood-app.json --json` reports `concurrency: 4`, is measurably faster, and produces the same per-fixture verdicts. This required a change the fence list omitted: `src/cli/ops.ts` built its own projection of the report and never surfaced `report.concurrency`, so the field existed on the report and in no output a caller reads. Both `concurrency` and the gate's note now reach the command.
- [x] A fixture that fails under concurrency but passes alone is visible as such: the `fixture-expectations` gate's `details` carries `Evaluated with concurrency 4; a resource-related failure may be an artefact of that, not of the change.` on the real parallel run, and nothing on the serial one.
- [x] No fixture root survives a parallel run: `ls $TMPDIR | grep -c kata-eval` returned 0 before and 0 after both a serial and a parallel run.

## Plan Review (Step 8)

_Independent post-finalization review by the artifact-code-reviewer and artifact-coverage-reviewer subagents, dispatched in parallel over this artifact and the live codebase. Findings are triaged at Step 9; the `resolution` column is filled as each row is decided._

**Tally: 20 blockers, 14 concerns, 8 suggestions — 42 rows.** (The coverage reviewer returned 14; one duplicated the code reviewer's `sumMeasured` finding verbatim and is recorded once, below.) The dominant failure mode is mechanical and repetitive: a fence uses or exports a symbol without naming the import, or adds a field to a TypeScript type while leaving the JSON schema at `additionalProperties: false` — so the write succeeds in the editor and throws at `validate()`. Both reviewers independently caught the two criteria that pass on a comment (`runWithConcurrency`, `parallelismNote`) and the one that passes before and after the edit it is meant to detect (`min(4, availableParallelism - 1)`). All 42 rows were **applied** in Step 9.


| source | plan-loc | codebase-loc | severity | dimension | finding | recommendation | resolution |
| --- | --- | --- | --- | --- | --- | --- | --- |
| code | Phase 6 §1 | src/workflow/context-fabric.ts:159 | blocker | actionability | `partitionReads` calls `hashFileIfPresent` (defined nowhere) and `readAcknowledgedHashes` (no import from `./handoff.js`) | Define `hashFileIfPresent` in the Phase 6 §2 fence and add the import | applied — `hashFileIfPresent` defined and `readAcknowledgedHashes`/`hashContent` named in the Phase 6 §1 fence header |
| code | Phase 6 §2 | src/workflow/context-fabric.ts:221 | blocker | actionability | `readAcknowledgedHashes` calls `readContextReceipts`, which does not exist at HEAD and no fence creates | Add the helper (readdir + `readValidatedOptional('handoff-receipt', …)`) in the same fence | applied — `readContextReceipts` added to the Phase 6 §2 fence |
| code | Phase 6 §1–§2 | src/workflow/context-fabric.ts:24,27 | blocker | codebase-fit | The fences write `continuedReads` / `contextMemo` into `HandoffPacket.context` and `HandoffReceipt`, whose interfaces have no such fields — excess-property errors; only the JSON schemas were extended | Add both optional fields to the interfaces in the same fence | applied — both fields added to the interfaces in the §1 fence header |
| code | Phase 4 §4 | src/quality/adversarial.ts:1326 | blocker | actionability | `adversarialGateFor(node).satisfied` is wrong: the real export is `(root, taskId, node) => Promise<AdversarialGateResult>` | Rewrite as an awaited loop, mirroring the call at `orchestrator.ts:1002` | applied — rewritten as an awaited loop over `requiredNodes` |
| code | Phase 6 §6, Phase 7 §1 | src/quality/evidence.ts:166 | blocker | actionability | Both fences say "reuse `runWithConcurrency`", but it is a module-private `async function` — no export, so both imports fail | Export it from Phase 6 §6's fence (renamed as the shared bounded scheduler) | applied — exported by the Phase 6 §6 fence; both import lines named explicitly |
| code | Phase 3 §1 | src/quality/evidence.ts:7 | blocker | actionability | `checkInputFingerprint` uses `hashContent`, which evidence.ts does not import (it imports only `createContentHasher`) | Add `hashContent` to the existing `../core/hash.js` import | applied — `{ createContentHasher, hashContent }` stated in the fence header |
| code | Phase 3 §1–§2 | src/quality/evidence.ts:37 | blocker | actionability | `check-reuse.ts` sets `check.reusedFrom`, but `CheckCommand` never gains the field (only `EvidenceEnvelope` does) | Add `reusedFrom?: string` to `CheckCommand` | applied — `reusedFrom?: string` added beside `testSelector` on `CheckCommand` |
| code | Phase 4 §1 | src/quality/evidence-adequacy.ts:1-2 | blocker | actionability | The fence calls `isPassing` and `evidenceCoversAcceptance` with neither added to the module's imports | Extend both existing imports in the fence | applied — both imports written out in the fence header |
| code | Phase 4 §1 | src/quality/acceptance-matrix.ts:1-8 | blocker | codebase-fit | `evidenceCoversAcceptance` casts to `EvidenceKind`, which acceptance-matrix.ts does not import | Add the type-only import, or type the parameter as `string` to match `evidenceMatchesRow` | applied — parameter widened to `string`, matching `evidenceMatchesRow` beside it |
| code | Phase 4 §1 | src/quality/judge.ts:27-38 | blocker | codebase-fit | `repairScope: 'no_acceptance_matrix_row'` is not a member of the `RepairScope` union that exhaustive switches consume | Add it to `repairScopes` and decide `repairableJudgeScopes` membership in Phase 4 §6 | applied — union membership and `repairableJudgeScopes` placement specified in Phase 4 §6 |
| code | Phase 4 §5 | schemas/review-finding.schema.json:7 | blocker | codebase-fit | `reproduction` is added to `ReviewFinding`, but the schema is `additionalProperties: false`, so every finding carrying it fails `validate()` | Extend the schema in the same fence | applied — full `reproduction` subschema specified in the §5 fence |
| code | Phase 4 §3 | schemas/adversarial-review.schema.json:13 | blocker | codebase-fit | The record gains `testPolicy`, but the schema rejects unknown properties — the write throws at `validate()` | Add the `testPolicy` subschema in the same fence | applied — `testPolicy` subschema specified in the §3 fence |
| code | Phase 4 §6 | schemas/judge-result.schema.json:11,56 | blocker | codebase-fit | `repairOwner` is added to `JudgeAcceptanceResult`, but root and `acceptance[]` items are both `additionalProperties: false` | Add the `repairOwner` subschema to the item properties | applied — `repairOwner` subschema specified in the §6 fence |
| code | Phase 5 §3 | src/core/relations.ts:1-5 | blocker | actionability | The fence calls `validate`, `writeFileAtomic` and `withRepositoryArtefactLock` with none of the three imported | Add the three imports | applied — all three import lines written out |
| code | Phase 5 §5 | src/wiki/closure.ts:1-3 | blocker | actionability | The rewritten `persist` calls `mutateTaskArtefact` without the `../core/state.js` import | Add the import | applied — import line written out |
| code | Phase 2 §3–§4 | src/cli/installer.ts:214,241 | blocker | actionability | `parseInstallerArgs` throws `Unknown installer option: --refresh` before the policy is ever read, so the flag cannot work | Accept (or strip) both flags in the parser, in the same fence | applied — the parser branches for both flags added to the §3 fence |
| code | Phase 6 §5–§7 | src/cli/tasks.ts:4 | blocker | actionability | The fence calls `summarizeExcludedWiki`, but tasks.ts imports only `buildContextManifest` from `../core/context.js` | Widen that import in the fence | applied — import widened in the §7 fence header |
| code | Phase 1 §7 | src/workflow/revision.ts:1-2 | blocker | actionability | The import hunk re-declares `createHash`/`randomUUID` and `isIgnoredRepositoryPath`, which the file already imports — duplicate identifiers | Merge into the existing imports; add only what is new | applied — before/after shown, only `Hash` and `walkRepositoryEntries` added |
| code | Phase 1 §11/§17 | tests/unit/eval-metrics.test.ts:64-68 | blocker | codebase-fit | `metricCoverage` becomes required, but only the first metrics literal is annotated as gaining it; the second is passed straight to `checkReleaseGates` | Add it to every `EvaluationMetrics` literal in that file | applied — the §17 fence now covers all three literals |
| coverage | ## Verification Notes §2 | n/a | blocker | verification-coverage | The note requires keeping `readValidatedOptional`'s absent-vs-drift distinction, but no Phase 5 fence or bullet exercises `readValidatedOptional` | Add a Phase 5 test case: absent file → `null`, drifted file → throw | applied — Phase 5 fence 1 states the wrapper is untouched and criteria bullet 3 asserts the distinction |
| code | Phase 6 §4 | src/workflow/seal-preflight.ts:81-186 | concern | actionability | The fence is prose only — no code, no named reads to pool, no preservation of the per-step dependency edges | Fence the concrete edit: a `Map<stepIndex, blocker>` filled under the bounded scheduler and reassembled in declaration order | applied — replaced with a real fence: a step graph with `after` edges and a declaration-order reassembly |
| code | Phase 6 §6 | src/quality/acceptance-matrix.ts:349-355 | concern | codebase-fit | The unbounded fan-out is in `discoverCodeGraphCandidates`, not inside `runCodeGraphAffected` | Retarget the fence and leave `runCodeGraphAffected`'s signature alone | applied — retargeted to `discoverCodeGraphCandidates`; the attribution map is preserved |
| code | Phase 6 | n/a | concern | actionability | The criteria name three test files that no Phase 6 fence creates, so `vitest run` fails on missing files | Add the three NEW test fences, as every other phase does | applied — Phase 6 items 8, 9 and 10 added |
| code | Phase 3 §7 | src/workflow/orchestrator.ts:495,559,608,628,631,859 | concern | actionability | Six sites still compare a raw exit code to zero, so the "`grep -c \"exitCode === 0\" … returns 0`" criterion cannot pass | Fence each site's migration to `isPassing` | applied — a migration hunk added; the one diagnostic counter is to be renamed raw rather than migrated |
| code | Phase 3 §2 | src/quality/check-reuse.ts | concern | code-quality | The doc comment promises reuse only when the row's files are unchanged, but `planCheckReuse` receives no matrix and the old `diffHash` guard is silently dropped | Pass the row scope in and implement it, or delete the unimplemented clause | applied — clause deleted; the fence now records why the fingerprint subsumes it and why the row question belongs to Phase 4 |
| code | Phase 1 §11 | n/a | concern | actionability | `grep -c "sumMeasured"` returns 4 (definition plus three call sites), not 1 | Grep the definition line only, or expect 4 | applied — criterion greps `^function sumMeasured` |
| code | Phase 2 §5–§6 | evals/dogfood-app.json:31 | concern | codebase-fit | The shipped fixture declares `expectedEscalations: 1`, which the new gate reads as unconfirmable — the repo's own eval fails | Update the fixture to `0`, or fence the fixture edit | applied — Phase 2 item 13 and both manifests added to the file set |
| code | Phase 4 §7 | src/core/task.ts:157 | concern | actionability | `acceptanceMatrixMigration` is added to the schema but no fence writes it, and one of the two named sites (`kata-cli status`) is outside Phase 4's file set | Fence the write in the verify path, or drop the field and the status site | applied — the verify-path write specified; the `kata-cli status` producer dropped with the reason |
| code | Phase 7 §2 | src/eval/release-gates.ts:40-76 | concern | code-quality | `parallelismNote` is computed and never concatenated into a gate's `details`, so the concurrency reaches no report | Attach it to a gate's `details` in the same fence | applied — appended to `expectationGate.details` |
| code | Phase 2 §9 | docs/changelog/…:10 | suggestion | actionability | The grep check passes before and after the edit, because the replacement text quotes the same phrase | Assert on a string the stale text does not already carry | applied — asserts `That default was reverted the same day` |
| coverage | ## Phase 1 §intro | n/a | concern | verification-coverage | Accepted finding L4-01 (stream the identity hash without moving the digest) is implemented by Phase 1 §6 but claimed in no phase's `Delivers` line | Add `L4-01` to Phase 1's `Delivers` line | applied — added, with the fence it rides on named |
| coverage | Phase 1 bullet 3 | n/a | concern | verification-coverage | The bullet runs a project-scope regeneration that rewrites the whole managed set while the paired check inspects one directory | Scope the check to `git diff --name-only` against the declared `.agents/skills` set | applied — criterion now scopes the check to `.agents/skills/kata*/SKILL.md` |
| coverage | Phase 6 bullet 6 | n/a | concern | verification-coverage | The `runWithConcurrency` grep passes on a comment while the fan-out may stay unbounded | Show the real import and call, then grep for the import | applied — greps the import line, in both files |
| coverage | Phase 7 bullet 5 | n/a | concern | verification-coverage | The `concurrency` grep passes on an unused local, so it cannot detect the note never reaching the report | Assert `details` contains `Evaluated with concurrency` | applied — criterion asserts the string plus a test on a failed parallel gate's `details` |
| coverage | ## Ordering Constraints | n/a | concern | verification-coverage | Phase 6 edits `src/quality/acceptance-matrix.ts`, which Phases 3 and 4 also edit, yet it declares `depends_on: [1]` and is described as non-overlapping | Add Phase 3 → Phase 6 (and Phase 4 → Phase 6), or move the CodeGraph change off that file | applied — Phase 6 `depends_on: [3, 4]`; Ordering Constraints restated |
| coverage | ## Decisions D7 | n/a | suggestion | verification-coverage | D7 specifies `contextMemo: { role, revisionId, hashes }`; the fence writes `{ role, hashes }` and the schema forbids the extra key | Drop `revisionId` from D7, or add it to both | applied — `revisionId` dropped from D7 with the reason recorded there |
| coverage | Phase 5 bullet 2 | n/a | suggestion | verification-coverage | The bullet runs `tests/unit/output-context.test.ts`, which is in no phase's file set and asserts nothing about this phase | Replace it with the absent-vs-drift case | applied — replaced; the dropped criterion is noted inline |
| coverage | Phase 1 §19 | n/a | suggestion | verification-coverage | The fence edits `tests/e2e/dogfood-config.test.ts`, but the file appears in no `files:` array while three phases' criteria run it | Add it to Phase 1's (or Phase 2's) file list | applied — added to Phase 1's `files:` |
| coverage | Phase 7 Manual bullet 1 | n/a | suggestion | verification-coverage | The bullet restates what the automated test already asserts and can pass without a manual observation | Replace with a pre/post wall-clock comparison on a real run | applied — replaced with the wall-clock comparison, the phase's actual justification |
| coverage | ## Ordering Constraints (Phase 3 → 5) | n/a | suggestion | verification-coverage | The stated edge names `L2-01`'s evidence contract, but no Phase 5 fence references `passed`, `checkInput` or `isPassing` | Drop the edge or name the real coupling | applied — the edge is kept and now states its real coupling: Phase 5 swaps the validator that compiles the envelope schema Phase 3 extends, so the two must not land concurrently |
| coverage | ## Phase 2 §intro | n/a | suggestion | verification-coverage | The stated Phase 1 → Phase 2 dependency is "L0-01's options object"; no Phase 2 fence uses `StatusOptions` | Restate it as the real coupling (`release-gates.ts`) | applied — restated as the `release-gates.ts` / `metricCoverage` coupling |
| coverage | ## Phase 6 §intro | n/a | suggestion | verification-coverage | The stated Phase 1 → Phase 6 dependency is "the streaming walk and the capture bound"; no Phase 6 fence touches either | Keep the edge only if Phase 6 consumes them, otherwise attribute the work to Phase 1 | applied — restated as Phases 3 and 4, the real dependency (`acceptance-matrix.ts`) |

## Ordering Constraints

- Phase 1 → Phase 2 → Phase 3 → Phase 4.
- Phase 1 → Phase 2 → Phase 7 (Phase 7 only needs L5-02).
- Phase 1 → Phase 6, and Phase 6 also needs **Phase 3** because both edit `src/quality/acceptance-matrix.ts`: Phase 3 adds `acceptanceIdsByCheckId` and Phase 6 retargets the CodeGraph fan-out in `discoverCodeGraphCandidates`, in the same module. Phase 4 edits that file too (§2), so Phase 6 waits for Phase 4 as well. The earlier draft called Phase 6 dependent on Phase 1 alone and described it as non-overlapping with Phase 4/5; that was wrong about the file set, not about the intent.
- Phase 3 → Phase 5.

Deliberately **not** stated as edges, because no symbol crosses between them: Phase 4 and Phase 5 are disjoint (different layers, different files) and may run in parallel; Phase 7 may be pulled forward at any point after Phase 2.
- Within Phase 1: the CLI/adapters work, the hashing work and the eval work touch disjoint files and may be applied in any order.
- Regenerate `.agents/skills/**` only after **all** generator edits in a phase have landed, so one regeneration covers the phase.

## Verification Notes

- **Revision identity is the sharpest regression risk.** `manifestHash` and every `revisionId` derived from it must stay byte-identical. Lock this with the existing `tests/unit/revision-delta.test.ts` invariant *and* a directory-owned-path fixture: the historical bug (`99113df`) was a key-shape mismatch between owned paths and per-file digest keys, not a hashing error, and every fixture before it used file-shaped owned paths.
- **Expect a burst of validation failures in Phase 5**, exactly as `90743fa` produced 53 on first enforcement. Treat the live records as truth and fix the schema, but keep the error contract (`<schemaName> artefact <path> does not match its schema: …. Allowed fields: …`) and `readValidatedOptional`'s absent-vs-drift distinction.
- **`tests/unit/schema-validation.test.ts` pins message substrings.** Any validator swap must keep them; add corpus fixtures for `const`, `uniqueItems` and the corrected `provenance`.
- **Do not bound `runProcess` results.** Four consumers parse complete stdout (`src/quality/acceptance-matrix.ts:451`, `src/core/git.ts:52`, `src/comet/compat.ts:188`, `src/cli/ops.ts:521`). Bounding belongs to the persisted side only, and the truncation must be visible in the artefact.
- **Phase 4 reduces standard assurance.** Before deleting the standard adversarial Verify pass, record measured before/after defect detection on at least one real task. Keep `strict`/`security` escalation explicit and Review fresh-context and fail-closed. Landing Phase 4 before Phase 3's AC-scoped evidence would reduce assurance without the evidence that justifies it.
- **Concurrency defaults must be the non-corrupting value.** `331618c` reverted the seal to serial after four to five concurrent checks sharing one database reported failures the seal itself caused. Every new fan-out in this plan (CodeGraph, fixtures, preflight) therefore defaults to the conservative value and opts in explicitly.
- **Generated files.** `.agents/skills/**/*.md` are produced by the generators; verify a regeneration is byte-stable when no generator changed, so unrelated churn never appears in a diff.
- **Correct the stale changelog.** `docs/changelog/2026-09-17-seal-cost-and-revision-identity.md` claims concurrent-by-default checks; `src/quality/evidence.ts:147-151` returns `1`. `docs/operations.md` already agrees with the source.

## Performance Considerations

- **Targets, in the order the review ranked them:** fewer agent/CLI round trips per phase (Phase 1, Phase 6), fewer bytes per handoff (Phase 6, Phase 1), fewer repeated subprocesses (Phase 3, Phase 6), less duplicated I/O (Phase 1, Phase 6).
- **Measurement first, where the number does not exist yet.** Phase 2 records rendered payload bytes/tokens and required-read counts per phase *before* any compaction, so the token claim is evidenced rather than asserted.
- **Bounded memory:** the tree hash currently holds every included file's bytes; Phase 1/6 stream it. Child-process capture becomes bounded on the persist path, with the full log available as a file reference rather than inside the evidence payload.
- **Bound the fan-out, keep the attribution.** The CodeGraph per-path query exists to say *which* source path dragged a test in; a batched query loses that, so Phase 6 bounds concurrency instead of batching.
- **No caches.** Nothing in this plan adds a derived cache to the identity or evidence path.

## Migration Notes

- **Evidence envelopes are additive.** New fields (`passed`, `checkInput`, `coveredAcceptanceIds`, `expectExitCode`, `logBytes`, `logTruncated`, `logArtifact`) are optional in `schemas/evidence.schema.json`; envelopes written before the change still validate. Readers must treat a missing `passed` as "derive from `exitCode`" rather than as a failure.
- **Revisions and digests are frozen.** This plan changes *how* digests are computed, never *what* they are. Any diff in a `manifestHash` or `revisionId` for unchanged content is a defect, not a migration.
- **`--with-context` is the migration lever for `status`.** A consumer that needs the old projection passes the flag; the flag is additive and permanent (no removal planned).
- **Evaluation report shape changes are breaking for readers.** `totalTokens`/`totalCost`/`totalEscalations`/`avgCostPerTask`/`escalationRate` become nullable; `docs/evaluations/2026-09-17-app-dogfood-observed.json` and anything reading it must tolerate `null` (they are already told to consult `unmeasured`).
- **`contextMemo` is additive on receipts.** Receipts written before this change lack the field; `requireAcknowledgedContextPacket` must treat an absent memo as "no acknowledged content yet", which is the conservative reading (everything is required).
- **Legacy strict tasks without matrix-backed check ids.** Phase 4 refuses new strict ACs without a declared check id but must keep verifying tasks sealed before it; the migration diagnostic names them instead of blocking them.
- **New runtime dependency.** `ajv` is added to `dependencies`. `scripts/build.mjs` keeps `packages: 'external'`, so the published single-file bundle imports it at runtime — it must be a real dependency, not a devDependency.
- **Rollback.** Every phase is independently revertable: the schema and envelope changes are additive, the locks change no format, and the CLI change is a projection difference behind one flag.

## Pattern References

- `src/core/state.ts:141-176` — `mutateTaskArtefact`: the lock-covers-read mutation discipline, and the pattern every new locked writer in Phase 5 copies. Its mutator returns the bytes. 
- `src/core/state.ts` `withTaskLock` — mkdir lock directory, fails closed on `EEXIST`, `finally`-removes. The non-task sibling in Phase 5 mirrors this exactly.
- `src/core/state.ts` `writeFileAtomic` — temp file (`.${basename}.${pid}.${uuid}.tmp`) + `rename`. Reused everywhere a writer is added.
- `src/core/hash.ts` — `createContentHasher(): Hash` (raw `node:crypto`), `hashContent(string|Buffer): string`. The single hashing primitive.
- `src/core/repository-identity.ts:125-134` — `repositoryTreeHash`: the canonical incremental hash-into pattern (`path`, `\0`, `content`, `\0`). Phase 1 keeps this byte-for-byte.
- `src/core/repository-identity.ts:91-122` — `walkRepositoryFiles`: the ignore policy, the size budget, and the `localeCompare` path ordering that the streaming variant must preserve.
- `src/workflow/revision.ts:122-149` + `:175-195` — `computeManifestHash` (rolling, `[missing]`/`[unsupported]` sentinels, `\0` delimiters) and `computePathDigests` (per-file keys). Both must be reproduced exactly by one traversal.
- `src/workflow/orchestrator.ts:~345-352` (`--list-checks` early return) — the CLI precedent for "a flag makes the command return a reduced, different object early", which the light status mode follows.
- `src/cli/output.ts:36-42,65-90` — `createOutputContext` / `isJsonOutput` / `isQuietOutput` / `outputResult`: rendering-only modes, deliberately orthogonal to result shape.
- `src/quality/evidence.ts:425-443` — `runBoundedCommand`: where a check's captured output becomes the persisted `log`, and therefore where Phase 1's bound and Phase 3's `passed` belong.
- `src/quality/evidence.ts:133,479-482` — `maxLogLength` / `truncate`: the existing cap that the new metadata must describe rather than silently replace.
- `src/process/run.ts:58-152` — `runProcess`: the one process facility, its timeout→124 / abort→130 contract, and the `onOutput` hook no caller uses yet.
- `src/core/schema.ts` — `validate` / `readValidated` / `readValidatedOptional` / `allowedTopLevelFields`: the public contract Phase 5 keeps while replacing the interpreter behind it.
- `src/quality/evidence.ts:147-151` — `checkConcurrency`: serial by default; the precedent for every new opt-in fan-out (CodeGraph, fixtures, preflight).
- `src/adapters/manifest.ts:274-313` + `src/adapters/phase-guidance.ts` (`automationGuidanceFor`, `adversarialGuidanceFor`) — the generators whose text becomes the 12 `.agents/skills/**/SKILL.md` files.
- `tests/unit/repository-identity.test.ts:1-40` — the temp-root + `afterEach` cleanup test idiom every new test in this plan follows.
- `tests/unit/installer.test.ts:2091-2101` — `captureJsonOutput`: how a CLI test asserts on the JSON a command printed.

## Developer Context

Step 4 decisions (all confirmed before decomposition):

- **Light status shape** — asked because `status` and `orient` both build task context (`src/cli/tasks.ts:198` and `:435`) and 12 generated Skills instruct the agent to read `task`/`state`/`context` from `status`. Answer: **default light, `--with-context` opts back in, generators updated and Skills regenerated in the same phase.**
- **Capture bound** — asked because `runProcess` results are unbounded (`src/process/run.ts:131-140`) while four callers parse complete stdout (`acceptance-matrix.ts:451`, `git.ts:52`, `compat.ts:188`, `ops.ts:521`). Answer: **bound the persisted side only; `runProcess` keeps returning complete strings.**
- **Validator choice** — asked because the bundled corpus declares draft 2020-12 while the hand-written interpreter implements 10 keywords, and one schema (`wiki-record.schema.json:61`) is not valid JSON Schema at all. Answer: **Ajv 8 via `ajv/dist/2020`, with the corpus repaired in the same phase.**
- **Unavailable metrics** — asked because the harness writes `0` for values it cannot observe while `unmeasuredMetrics` names them. Answer: **`null` plus coverage; gates skip unavailable dimensions and say so.**
- **Relation-graph write discipline** — asked because validating on write turns today's read-time error into a write-time refusal. Answer: **lock, atomic replace, and validate on write.**
- **Wiki lock granularity** — asked because records are repo-scoped while closures are task-scoped. Answer: **repo-level record lock for records; the existing task lock for closures.**
- **Context memo location** — asked because the packet's stable reads are re-required every phase. Answer: **inside the handoff receipt (`contextMemo`).**
- **Fingerprint location** — asked because reuse needs both an input fingerprint and an acceptance mapping. Answer: **extend the evidence envelope (`checkInput`, `coveredAcceptanceIds`, `passed`).**
- **Scope** — the review's 7 phases were chosen over Phase-1-only or Phase-1+2, with the plan's phase boundaries kept equal to the review's because they carry the dependency graph.
- **Artifact location** — `docs/plans/` rather than the skill default `.rpiv/artifacts/plans/`, matching the `docs/architecture-reviews/` redirection for the two parent reviews.
- **Slice verification policy** — Step 6.2 asks for a `slice-verifier` dispatch before each slice's checkpoint. Slice 1's verifier was stopped mid-run with no output, and the developer then chose to skip per-slice verification for the remaining slices: each slice is written to this artifact for direct review instead, and the mandatory Step 8 pair (`artifact-code-reviewer` + `artifact-coverage-reviewer`) still runs over the finished plan. **Consequence, recorded rather than hidden: slices 2–7 carry no independent verification — the code fences are reasoned, not machine-checked, until Step 8.**
- **Independent review is the only verification this plan got.** Per-slice `slice-verifier` dispatch was skipped from slice 2 on (see the entry above), so Step 8's two reviewers are what stands between the fences and an implementer. Their yield — 20 blockers, every one of them a compile error or a runtime `validate()` throw — is the evidence that the skip cost real quality on the first pass, and the reason Step 9 applied rather than deferred: a blocker in a plan is a phase that cannot run.

## Plan History

- Phase 1: Foundation — light entry, single-walk digests, bounded persistence, unavailable metrics — approved as generated
- Phase 2: Baseline and refresh loop — payload measurement, change-aware refresh, executable fixture expectations — approved as generated (file set adjusted: `src/cli/baseline.ts` replaced `src/workflow/prompt-catalogue.ts` as the measurement point, and `docs/operations.md` replaced a non-existent installer Skill as the refresh-policy surface)
- Phase 3: Evidence contracts and check-level reuse — approved as generated (file set adjusted: `src/quality/evidence-adequacy.ts` replaced `src/workflow/seal-preflight.ts`, which evaluates no freshness or exit-code predicate; `src/quality/check-reuse.ts` added for the pure reuse decision)
- Phase 4: AC-scoped evidence and the assurance boundary — approved as generated
- Phase 5: Durable correctness — standard validation, locked stores — approved as generated
- Phase 6: Context and I/O economy — approved as generated (file set adjusted: the streaming whole-tree hash was already delivered by Phase 1; `src/core/context.ts` replaced `src/wiki/context.ts` as the module that produces the Wiki diagnostics)
- Phase 7: Evaluation parallel and release confidence — approved as generated
- Step 8: independent review dispatched (artifact-code-reviewer + artifact-coverage-reviewer in parallel). 20 blockers, 14 concerns, 8 suggestions across 42 rows.
- Step 9: all 42 rows applied. Mechanical class (19 rows): missing imports/exports, and TS fields added without their `additionalProperties: false` schema counterparts. Design class (3 rows): `adversarialGateFor`'s real arity, `parseInstallerArgs` rejecting `--refresh`, the CodeGraph fan-out living in `discoverCodeGraphCandidates`. Criteria class (6 rows): checks that passed on a comment or on `grep -c` counting the wrong thing. Structure class (3 rows): Phase 6's real dependency on Phases 3 and 4, `L4-01` left unclaimed, `D7`'s `revisionId` contradicting its own schema. Fixture class (1 row): the shipped `evals/dogfood-app.*` declaring an escalation count the harness cannot observe.

## References

- `docs/architecture-reviews/2026-09-20_10-09-51_kata-unified-efficiency-review.md` — the source artifact: 6 layers, 22 accepted findings, M1 methodology principle, 7 cross-cutting themes, 7 phases.
- `docs/architecture-reviews/2026-09-20_kata-workflow-efficiency-review.md` — the first efficiency audit (repository-wide, layers 0–7).
- `docs/architecture-reviews/2026-09-20_09-39-51_kata-verify-review-tdd.md` — the Verify/Review/TDD boundary audit that Phase 3/4 implement.
- `docs/changelog/2026-09-18-one-mutation-discipline.md` — why the mutator returns bytes and the lock must cover the read (Phase 5).
- `docs/changelog/2026-09-17-one-relation-store.md` — the single authoritative relation store this plan now makes safe under concurrency (Phase 5).
- `docs/changelog/2026-09-17-validated-artefact-reads.md` — the first schema enforcement, which produced 53 failures and three schema corrections; the precedent for Phase 5's expected burst.
- `docs/changelog/2026-09-17-check-concurrency-opt-in.md` — why the seal is serial by default; the rule every new fan-out in this plan follows.
- `docs/changelog/2026-09-17-one-repository-identity.md` — the ignore policy and the refusal to add a walk cache (Phases 1, 6).
- `docs/changelog/2026-09-19-surface-digest-expansion.md` — the key-shape bug (`99113df`) that Phase 1's byte-identical test must not reintroduce.
- `docs/changelog/2026-09-17-evaluation-harness-executes-fixtures.md` — the `unmeasured` list and the "no fabricated zero" rule (Phase 1).
- `docs/changelog/2026-09-17-one-process-facility.md` — the single subprocess facility and why binary resolution returns command+env+cwd together (Phase 1).
- `docs/changelog/2026-09-18-unrelated-invalid-record.md` — reading the Wiki never fails; one invalid record must not block every mutation (Phase 6's diagnostic scoping).