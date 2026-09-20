---
date: 2026-09-20T00:54:57+0800
author: vforfreedom
commit: 99113df
branch: master
repository: kata
target: "."
target_kind: directory
layer_count: 8
phases: [evidence, triage, synthesis]
unresolved_finding_count: 0
status: completed
tags: [architecture-review, kata, workflow, efficiency, cost, latency, tokens]
last_updated: 2026-09-20T02:00:00+0800
last_updated_by: vforfreedom
last_updated_note: "Completed eight-layer evidence review and recorded 25 accepted, quality-preserving improvements plus one rejected redesign."
---

# Architecture review — Kata workflow efficiency, cost, latency, and token use

This review examines the Kata workflow implementation at the repository root, including its CLI/runtime, installed Skill assets, persistence contracts, and validation infrastructure. The audit is triggered as a standalone pre-optimization review: it assesses where governance guarantees create avoidable execution time, host-agent token use, subprocess work, or human queueing, without treating lower cost as sufficient justification to weaken correctness controls. Tests are evidence only; no implementation files are changed by this review.

---

## Conventions

### Finding shape

Each finding is a level-3 heading `### L<layer>-<seq> — <title>` with: **Evidence** (`file:line` and a short quote), **Current state**, **Desired state**, **Proposed improvement**, **Severity** (Low/Med/High), **Effort** (S/M/L), **Blast radius** (`internal`/`public-API`/`on-disk`/`cross-module`), **Class** (`polish`/`redesign`), **Status**, **Depends on**, and optional **Cross-cut tag**.

### Status legend

- `open` — candidate recorded but not yet triaged.
- `accepted` — will land; the selected outcome is recorded inline.
- `rejected` — declined with its rationale inline.
- `deferred` — valid but post-release.
- `withdrawn` — diagnosis disproved; retained for auditability.

### Layers (top → down)

| # | Layer | Files / responsibility |
|---|---|---|
| 0 | Public entry, command dispatch, and host Skill surface | `src/cli.ts`, `src/cli/*.ts`, `.agents/skills/kata*/SKILL.md` |
| 1 | Platform adaptation and installation | `src/adapters/*.ts`, generated Skill/manifest guidance assets |
| 2 | Lifecycle orchestration and cross-platform handoff | `src/workflow/{orchestrator,navigation,revision,handoff,context-fabric,seal-*.ts,...}` |
| 3 | Quality, evidence, and trust gates | `src/quality/*.ts`, `src/policy/*.ts` |
| 4 | Task state and durable governance contracts | `src/core/{task,state,relations,recovery,workflow-profile}.ts`, `schemas/*.schema.json` |
| 5 | Wiki and knowledge closure | `src/wiki/*.ts` |
| 6 | Infrastructure, repository I/O, hooks, and CodeGraph runtime | `src/{process,codegraph,hooks}/**`, `src/core/{git,layout,config,repository-identity,hash,ids}.ts` |
| 7 | Evaluation, release control, and build utilities | `src/eval/*.ts`, `scripts/build.mjs` |

---

## Methodology principles

1. **Correctness before savings.** A cached, scoped, concurrent, or compacted operation is acceptable only when the prior evidence/identity/authorization semantics are retained and regression-tested.
2. **Separate facts from verdicts.** Preserve raw data (`exitCode`, hashes, logs, host ownership) and compute explicit normalized outcomes; do not overload `0`, missing data, or a prose warning as a safety signal.
3. **Scope by authority.** Handoff context, Wiki diagnostics, design references, and enrichment inputs must be task-relevant by default; repository-wide repair remains visible through dedicated audit surfaces.
4. **Bound resources, retain escape hatches.** Use bounded pools, streaming hashing, and capped diagnostic capture as defaults. Keep explicit full/reconciliation/investigation modes for the exceptional case.
5. **Measure conditional optimizations.** Prompt compression, second-pass scope, and Wiki delta processing proceed only after comparable quality and latency evidence; speed alone cannot justify reduced scrutiny.
6. **Persist governance atomically.** State, relation, Wiki, and schema-validated records must not silently lose updates or permit invalid on-disk forms.

---

## Layer 0 — Public entry, command dispatch, and host Skill surface

Files: `src/cli.ts`, `src/cli/*.ts`, `.agents/skills/kata*/SKILL.md`.

### L0-01 — Make `status` lightweight by default

**Evidence**

`src/cli/tasks.ts:198`, `src/cli/tasks.ts:283-287`, `src/cli/tasks.ts:433-435`

```ts
const taskContext = await readTaskContext(root, change);
context = await buildContextManifest({ root, taskId: change, sourceRefs: [] });
const contextPacket = await createContextPacket({ root, taskId: change, fromRole: role, toRole: role, ... });
```

**Current state**

`status` and `orient` both materialize task context; `orient` additionally creates a Context Fabric packet. The prescribed `status → orient` Skill path therefore repeats context assembly and sends two agent-visible CLI payloads.

**Desired state**

A default status check reports only dispatch and minimal task state. Full context is materialized once by an explicit request or the command that needs it.

**Proposed improvement**

Make `status` omit `context` and acceptance details by default; add a compatible `--with-context` mode for JSON consumers and keep `orient` as the full-context path. Measure bytes read, response bytes, and wall time for the standard Skill entry sequence before and after.

- **Severity:** Med
- **Effort:** M
- **Blast radius:** public-API
- **Class:** redesign
- **Status:** **accepted** — default to lightweight `status`, retaining an opt-in compatibility view.
- **Depends on:** none
- **Cross-cut tag:** `T1-context-amplification`

### L0-02 — Make runtime refresh dependent on actual update changes

**Evidence**

`src/cli/installer.ts:20-43`, `src/cli/installer.ts:131-132`

```ts
for (const platform of targets) {
    const report = await update(platform, scope, options);
    reports.push(report);
}
const runtimeRefresh = await runRuntimeRefresh(options.root!);
const codegraphSync = await runCodegraphStage('sync');
const codegraphIndex = await runCodegraphStage('index');
```

**Current state**

Every aggregate update invokes best-effort runtime refresh after platform updates, then serially runs CodeGraph sync and index, even when reports contain no material asset or runtime change.

**Desired state**

The default update path spends external-update and index time only when an observed change requires it, while operators can still force a full refresh.

**Proposed improvement**

Introduce `--refresh=auto|always|never`. In `auto`, derive refresh necessity from update reports and detected runtime/version drift; report an explicit skip reason. Preserve current behaviour under `always` and cover unchanged, changed, and forced cases with integration tests.

- **Severity:** Med
- **Effort:** M
- **Blast radius:** public-API
- **Class:** redesign
- **Status:** **accepted** — add change-aware refresh with explicit `always` escape hatch.
- **Depends on:** none
- **Cross-cut tag:** `T2-change-aware-work`

### L0-03 — Retire global positional change-id inference incrementally

**Evidence**

`src/cli/invocation.ts:15-44`

```ts
// a new option means updating this list too.
if (value === '--platform' || value === '--root' || /* … */) {
    index += 1;
    continue;
}
```

**Current state**

`parseChangeArg()` guesses the positional change id through a shared, manually maintained list of flags that consume a value. New command options can be misread as task IDs unless this unrelated helper changes too.

**Desired state**

Each command family owns a typed invocation contract, so option expansion cannot silently alter task selection or generate agent retry loops.

**Proposed improvement**

For new and touched command families, use local typed parsers and require `--change` for mutating workflow commands; retain positional aliases behind compatibility tests. Remove the global helper only after all consumers migrate.

- **Severity:** Low
- **Effort:** M
- **Blast radius:** public-API
- **Class:** redesign
- **Status:** **accepted** — adopt a compatibility-tested, phased parser migration.
- **Depends on:** none
- **Cross-cut tag:** `T3-command-contract`

### Layer 0 — batch 0A (CLI source) — tally

| Status | Count |
|---|---|
| accepted | 3 |
| rejected | 0 |
| deferred | 0 |
| withdrawn | 0 |

Cross-cutting tags introduced: `T1-context-amplification`, `T2-change-aware-work`, `T3-command-contract`.
Cross-cutting tags reused: none.

Dependency edges within batch 0A: none.

### L0-04 — Give an explicit task id a deterministic fast path

**Evidence**

`.agents/skills/kata/SKILL.md:19`, `.agents/skills/kata/SKILL.md:25-28`, `.agents/skills/kata-collect/SKILL.md:19`, `.agents/skills/kata-collect/SKILL.md:25-28`

```text
If the user passes an explicit task id … do not re-discover via kata-cli status.
kata-cli status
kata-cli orient --role <…> --platform pi --task-kind <…>
kata-cli hooks activate --change <change-id> --role <…> --platform pi
```

**Current state**

The same Skill both forbids rediscovery for an explicit task id and mandates an unconditional three-command startup. Agents can follow either rule, so explicit invocations may still pay discovery, context, and output costs.

**Desired state**

An explicit task id follows one unambiguous, task-scoped preparation path; discovery remains available only when the task is absent.

**Proposed improvement**

Define an explicit-id fast path in the shared Kata skill contract: run `orient --change <id>` directly, reuse or activate the hook only when its task/role/branch does not match, and reserve `status` discovery for unanchored requests. Add fixture tests for both paths and all trust gates.

- **Severity:** Med
- **Effort:** M
- **Blast radius:** public-API
- **Class:** redesign
- **Status:** **accepted** — explicit task IDs use a task-scoped fast path instead of unconditional discovery.
- **Depends on:** L0-01
- **Cross-cut tag:** `T1-context-amplification`

### L0-05 — Establish a rendered-Skill context-cost baseline before compression

**Evidence**

`.agents/skills/kata/SKILL.md:17-65`, `.agents/skills/kata-collect/SKILL.md:17-65`

```text
Both files repeat the skill-first rule, startup checklist, trust-boundary pause,
CodeGraph guidance, portable handoff, and host-model policy before command-specific content.
```

**Current state**

The common protocol is repeated in each rendered Kata Skill, but Kata records no per-skill prompt-byte/token baseline. A proposed deduplication could merely move required reads into separate documents and fail to lower host-agent context cost.

**Desired state**

Any Skill-payload reduction is driven by measured rendered input size and preserves the self-contained safety constraints that a host actually receives.

**Proposed improvement**

Add a generation-time inventory of rendered Skill bytes, estimated tokens, shared-versus-command-specific sections, and host-required transitive reads. Establish a budget and snapshot test first; only then decide whether compact shared contracts reduce real per-invocation context.

- **Severity:** Low
- **Effort:** S
- **Blast radius:** internal
- **Class:** polish
- **Status:** **accepted** — measure rendered Skill context cost before choosing a compression design.
- **Depends on:** none
- **Cross-cut tag:** `T4-cost-observability`

### Layer 0 — batch 0B (dispatch and collection Skills) — tally

| Status | Count |
|---|---|
| accepted | 2 |
| rejected | 0 |
| deferred | 0 |
| withdrawn | 0 |

Cross-cutting tags introduced: `T4-cost-observability`.
Cross-cutting tags reused: `T1-context-amplification`.

Dependency edges within batch 0B: L0-04 depends on L0-01.

### L0-06 — Measure the second independent adversarial pass before narrowing it

**Evidence**

`.agents/skills/kata-verify/SKILL.md:71-73`, `.agents/skills/kata-review/SKILL.md:71-73`, `.agents/skills/kata-verify/SKILL.md:107-109`, `.agents/skills/kata-review/SKILL.md:94-95`

```text
verify and review both require a recorded adversarial pass over the sealed revision.
For a delta brief the gate checks every difference between two revisions.
Every separate invocation is a full turn of the reviewer loop, which is what a pass mostly costs.
```

**Current state**

Kata preserves independence at verify and review, and supports delta scopes, but the Skills provide no measured decision policy for the second pass when the revision is unchanged or only narrowly changed.

**Desired state**

Both trust gates retain independent scrutiny; the scope and framing of the second pass are selected from observed latency, tool-use, and finding-yield data rather than intuition.

**Proposed improvement**

Instrument and report full, delta, and unchanged-revision pass cost plus finding yield by node and brief mode. Define and test an evidence-backed policy for whether the second pass remains full, becomes delta, or uses a differentiated review lens; do not remove the independent gate without data and an explicit safety decision.

- **Severity:** Med
- **Effort:** M
- **Blast radius:** internal
- **Class:** redesign
- **Status:** **accepted** — measure before choosing a scope/lens policy for the second independent pass.
- **Depends on:** none
- **Cross-cut tag:** `T4-cost-observability`

### L0-07 — Offer task-scoped gate-answer reuse only by explicit consent

**Evidence**

`src/cli/workflow.ts:282-285`

```ts
// --for-task records the same answer for the whole task: the boundaries still exist
// and are still recorded, they just stop asking the same human the same question.
const forTask = argv.includes('--for-task');
```

**Current state**

The CLI supports a task-scoped reuse of the same approval choice, but phase Skills expose only a repeated hard stop. Users who intentionally want continuity cannot discover the existing opt-in and must answer equivalent prompts again.

**Desired state**

Trust boundaries remain visible and recorded, while a user who explicitly authorizes the same host-model/platform choice for the task avoids duplicate administrative pauses.

**Proposed improvement**

At the first applicable trust boundary, offer a clear opt-in to reuse that exact choice for the task through `kata gate approve --for-task`; show which later boundaries would reuse it and retain the default per-boundary stop. Never infer consent or apply this to archive without a fresh explicit decision.

- **Severity:** Low
- **Effort:** S
- **Blast radius:** public-API
- **Class:** polish
- **Status:** **accepted** — surface reuse as a voluntary, auditable choice; retain per-boundary default.
- **Depends on:** none
- **Cross-cut tag:** `T5-user-authority`

### Layer 0 — batch 0C (phase Skills) — tally

| Status | Count |
|---|---|
| accepted | 2 |
| rejected | 0 |
| deferred | 0 |
| withdrawn | 0 |

Cross-cutting tags introduced: `T5-user-authority`.
Cross-cutting tags reused: `T4-cost-observability`.

Dependency edges within batch 0C: none.

### Layer 0 — roll-up

| Status | Count |
|---|---|
| accepted | 7 |
| rejected | 0 |
| deferred | 0 |
| withdrawn | 0 |

Cross-cutting tags introduced: `T1-context-amplification`, `T2-change-aware-work`, `T3-command-contract`, `T4-cost-observability`, `T5-user-authority`.
Cross-cutting tags reused: none.

Dependency edges within Layer 0: L0-04 depends on L0-01.

---

## Layer 1 — Platform adaptation and installation

Files: `src/adapters/*.ts`, generated Skill and manifest guidance assets.

### L1-01 — Derive rendered capabilities from the platform definition

**Evidence**

`src/adapters/manifest.ts:260-276`, `src/adapters/platforms.ts:37-44`

```ts
// manifest.ts
codex: { skills: true, hooks: false, subAgents: true, modelSelection: true },
const guardMode = capabilities.hooks ? 'skills plus platform hooks' : 'CLI/CI-only';

// platforms.ts
hookFormat: 'claude-code',
capabilities: { skills: true, hooks: true, subAgents: true, modelSelection: true },
```

**Current state**

The renderer and the installer/discovery path maintain separate capability records. For Codex they already disagree: generated Skills advertise CLI/CI-only enforcement while the platform definition installs hooks.

**Desired state**

A platform has exactly one capability contract, consumed consistently by rendering, installation, discovery, diagnostics, and tests.

**Proposed improvement**

Make `platformDefinitions` the source of truth and derive the renderer capability view from `platformDefinitionById`; remove the duplicate capability map. Add a complete cross-platform contract test covering hook format, rendered guard mode, model-selection text, and generated support files.

- **Severity:** High
- **Effort:** M
- **Blast radius:** internal
- **Class:** redesign
- **Status:** **accepted** — consolidate to one platform capability fact source.
- **Depends on:** none
- **Cross-cut tag:** `T6-platform-contract`

### L1-02 — Separate shared project assets from per-platform ownership

**Evidence**

`src/cli/installer.ts:37-43`, `src/adapters/ownership.ts:179-181`

```ts
for (const platform of targets) {
    const report = await update(platform, scope, options);
    reports.push(report);
}
if (scope === 'project') {
    await writeProjectContractFiles(platform, scope, effectiveOptions, baseRoot, manifest, report);
    await manageProjectWiki(effectiveOptions, baseRoot, report);
}
```

**Current state**

Aggregate update runs the platform write flow for every target. Each project-scoped pass processes the same agent contract, skills index, and Wiki setup; their single relative paths are recorded as files owned by the last platform that writes them.

**Desired state**

Shared project assets would be materialized and owned once per aggregate update, independently of the number of platform projections.

**Proposed improvement**

Introduce a project-asset stage with project-level ownership after platform projections complete; make it responsible for the agent contract, index, and Wiki setup, with two-platform install/uninstall regression coverage.

- **Severity:** Med
- **Effort:** L
- **Blast radius:** public-API
- **Class:** redesign
- **Status:** **rejected** — retain independent per-platform ownership; its isolation benefit outweighs the repeated shared-asset work.
- **Depends on:** none
- **Cross-cut tag:** `T7-coalesced-work`

### L1-03 — Rebuild the Wiki enrichment packet only when stale

**Evidence**

`src/adapters/ownership.ts:363-366`

```ts
const enrichTask = await buildLlmWikiTask({ root, kind: 'enrich' });
const taskDir = layoutTaskDir(root, 'wiki-enrich');
await mkdir(taskDir, { recursive: true });
await writeFile(join(taskDir, 'task-packet.json'), `${JSON.stringify(enrichTask, null, 2)}\n`);
```

**Current state**

Every project install or update rebuilds and overwrites the same enrichment packet, even when its source documents, Wiki state, and effective configuration are unchanged.

**Desired state**

Update reports whether the packet was materialized or safely reused, while preserving freshness whenever the packet inputs change.

**Proposed improvement**

Store an input/content fingerprint with the packet and rebuild only when it differs; add an explicit stale reason to the install report and cover unchanged, source-changed, Wiki-changed, configuration-changed, and forced-refresh cases.

- **Severity:** Low
- **Effort:** M
- **Blast radius:** internal
- **Class:** polish
- **Status:** **accepted** — add fingerprint-based packet freshness checks.
- **Depends on:** none
- **Cross-cut tag:** `T8-incremental-materialization`

### Layer 1 — tally

| Status | Count |
|---|---|
| accepted | 2 |
| rejected | 1 |
| deferred | 0 |
| withdrawn | 0 |

Cross-cutting tags introduced: `T6-platform-contract`, `T7-coalesced-work`, `T8-incremental-materialization`.
Cross-cutting tags reused: none.

Dependency edges within Layer 1: none.

---

## Layer 2 — Lifecycle orchestration and cross-platform handoff

Files: `src/workflow/*.ts`.
### Evidence examined
- `src/workflow/context-fabric.ts`: `designRefsFor()` first gathers task-declared upstream/matrix references, then appends **every** `docs/superpowers/specs/*-design.md`; the resulting `designRefs` are placed in both packet context and `requiredReads` for implementer/reviewer/judge handoffs.
- `src/workflow/revision.ts`: `createTaskRevisionIfChanged()` calls `computeManifestHash()` and then `computePathDigests()`; for a directory ownership entry both recursively walk and read the same content before sealing.
- `src/workflow/orchestrator.ts`: seal reuse and relevant-check derivation already depend on the revision identity/path digest contract, so an optimization must preserve its deterministic hashes exactly.

### Findings and decisions
#### L2-01 — Bound handoff design context to the task (accepted)
- **Problem / impact:** The all-specs fallback grows every future handoff with unrelated historical design documents. That increases required reading, prompt tokens, and review latency while weakening relevance.
- **Decision:** Keep explicit `upstreamCoverage.sources[].ref` and `acceptanceMatrix.rows[].designRefs` as the primary set. A fallback may use only the task's exact design identity; multiple unbound candidates must be reported as ambiguity rather than silently attached.
- **Implementation guardrails:** Preserve existing packet verification; emit the selected source and rejected ambiguous candidates in packet diagnostics. Add tests for one explicit reference, one exact task fallback, and multiple unrelated specs.
- **Expected effect:** Handoff prompt/read volume becomes O(task references), not O(repository design history).
- **Evidence:** `src/workflow/context-fabric.ts` (`designRefsFor`, `createContextPacket`).

> Decision: `accept_task_bound_refs` (user selection).

> Status: accepted — include in consolidated plan.

#### L2-02 — Create revision identity and path digests in one deterministic scan (accepted)
- **Problem / impact:** Every directory-scoped seal reads and walks owned content twice: once for the rolling manifest hash and again for the per-file digests. Large source-tree ownership therefore pays duplicated I/O on the critical seal path.
- **Decision:** Introduce an internal snapshot builder that produces the existing `manifestHash` and `pathDigests` from one ordered walk, preserving the present byte ordering and revision-id formula.
- **Implementation guardrails:** Retain the public hash APIs as compatibility wrappers or prove all callers use the snapshot. Add equivalence fixtures for file, missing path, ignored entries, nested directory, and stable revision IDs; benchmark before/after on a representative owned tree.
- **Expected effect:** Removes one full owned-tree traversal per directory-scoped seal without weakening freshness or audit binding.
- **Evidence:** `src/workflow/revision.ts` (`createTaskRevisionIfChanged`, `computeManifestHash`, `computePathDigests`).

> Decision: `accept_single_snapshot` (user selection).

> Status: accepted — include in consolidated plan.

---

## Layer 3 — Quality, evidence, and trust gates

Files: `src/quality/*.ts`, `src/policy/*.ts`.

### Evidence examined
- `src/quality/evidence.ts` records a command's literal `exitCode`; the seal path treats any non-zero envelope as failure.
- `src/quality/claims.ts` explicitly supports any integer `expect.exitCode` and evaluates a claim against that declared value.
- `src/quality/acceptance-matrix.ts` launches one CodeGraph `affected` subprocess per sealed implementation path via unbounded `Promise.all`, to retain source-path attribution.
- `src/quality/adversarial.ts` renders a self-contained brief that includes extensive repeated methodology prose and examples on every independent pass.

### Findings and decisions
#### L3-01 — Separate actual exit code from evidence pass state (accepted)
- **Problem / impact:** A claim may declare `expectExitCode: 1`, but the collector and seal still treat its literal non-zero exit as a global failure before claim evaluation. The advertised non-zero claim semantics are therefore unreachable.
- **Decision:** Preserve the actual exit code for audit, add a declared expected outcome and explicit pass state to evidence, and use that pass state throughout seal/freshness/gate decisions. Legacy envelopes default to `exitCode === 0`.
- **Implementation guardrails:** Update schema and every generic `exitCode === 0` gate deliberately; keep `evaluateClaims()` comparing actual to expected. Add regression coverage for a passing non-zero claim, normal failed checks, and old evidence without the new fields.
- **Evidence:** `src/quality/evidence.ts` (`collectEvidence`); `src/quality/claims.ts` (`resolveClaimChecks`, `evaluateClaims`); `src/workflow/orchestrator.ts` (seal failure gate).

> Decision: `accept_explicit_check_outcome` (user selection).

> Status: accepted — correctness prerequisite for claim optimization.

#### L3-02 — Bound CodeGraph affected-test discovery (accepted)
- **Problem / impact:** A large strict task can spawn an unbounded number of `codegraph affected` child processes at once. Per-path attribution is valuable, but host saturation increases wall time and makes failures less diagnosable.
- **Decision:** Keep one logical query per source path and fail-closed parsing, but schedule those queries through a bounded, configurable pool with queued/active timing diagnostics.
- **Implementation guardrails:** Preserve deterministic candidate attribution/order and no-affected-test behavior. Test the maximum in-flight count, one failing child, and stable output under reordered completion.
- **Expected effect:** Avoids process storms while retaining strict-closure evidence quality.
- **Evidence:** `src/quality/acceptance-matrix.ts` (`discoverCodeGraphCandidates`, `runCodeGraphAffected`).

> Decision: `accept_bounded_codegraph` (user selection).

> Status: accepted — include in consolidated plan.

#### L3-03 — Replace the adversarial brief's repeated pedagogy with a compact operating contract (accepted)
- **Problem / impact:** Each fresh-context adversarial pass receives a long static explanation, examples, and rationale in addition to task-specific evidence. This directly inflates input tokens and distracts from the current delta.
- **Decision:** Retain mandatory independence, evidence-reading, no-duplicate-check, scope, reporting, and result-schema rules in a concise brief. Move rationale and extended examples to a versioned playbook referenced only when needed.
- **Implementation guardrails:** Keep the issued-brief hash binding over the complete compact brief; preserve the structured output contract. Establish baseline/current token size and compare acceptance/finding outcomes before making further reductions.
- **Expected effect:** Lower per-pass token cost without silently relaxing adversarial gate requirements.
- **Evidence:** `src/quality/adversarial.ts` (`renderAdversarialBrief`, issued-brief binding).

> Decision: `accept_ab_measure_then_compact` (user selection).
> Status: accepted — run a controlled quality/token comparison first; compact adoption is conditional on non-inferior findings.

---

## Layer 4 — Task state and durable governance contracts

Files: `src/core/{task,state,relations,recovery,workflow-profile}.ts`, `schemas/*.schema.json`.

### Evidence examined
- `src/core/schema.ts` implements only a subset of declared JSON-Schema keywords, while `schemas/task.schema.json` uses `const: 1` and `uniqueItems: true`.
- `src/core/relations.ts` makes `kata-relations.json` the authoritative graph, but `addKataRelation()` performs unlocked read-modify-write and `writeKataRelations()` writes directly.

### Findings awaiting triage
#### L4-01 — Align runtime validation with the published JSON Schemas
- **Problem / impact:** Unsupported schema keywords are silently ignored. A malformed workflow-profile version or duplicate owned path can pass the reader despite being invalid under the published contract, weakening all downstream trust decisions.
- **Proposed improvement:** Replace the partial matcher with a maintained JSON-Schema validator compatible with the declared draft; compile/cache bundled schemas, preserve artifact/path-oriented diagnostics, and add compatibility fixtures for `const`, `uniqueItems`, existing optional-artifact behavior, and unknown properties.
- **Evidence:** `src/core/schema.ts` (`assertMatches`); `schemas/task.schema.json` (`workflowProfile.version`, `ownedPaths`).
- **Status:** **accepted** — adopt a standard validator rather than expanding an unbounded custom subset. **Severity:** High · **Effort:** M · **Blast radius:** on-disk/cross-module

> Decision: `accept_standard_validator` (user selection).

#### L4-02 — Serialize authoritative relation-graph mutations
- **Problem / impact:** Concurrent `addKataRelation()` calls can each read the same graph and overwrite the other's new edge. Since redirects, dependency state, and terminal relations use this graph as their sole authority, the loss is silent and material.
- **Proposed improvement:** Add a short graph-scoped lock plus atomic replace around read/dedupe/write; retain endpoint validation and deterministic ordering. Test simultaneous additions for different tasks and duplicate retries.
- **Evidence:** `src/core/relations.ts` (`addKataRelation`, `writeKataRelations`, `readTaskRelations`).
- **Status:** **accepted** — add graph-level serialization and atomic persistence. **Severity:** High · **Effort:** M · **Blast radius:** on-disk/cross-module

> Decision: `accept_graph_lock` (user selection).

---

## Layer 5 — Wiki and knowledge closure

Files: `src/wiki/*.ts`.

### Evidence examined
- `src/wiki/store.ts` validates creation, but `updateWikiRecord()` parses, merges, and directly writes without post-merge schema validation or atomic persistence.
- `src/wiki/context.ts` scopes authoritative records to requested refs, yet places every global non-authoritative/invalid record in `excluded` and warnings returned to task handoffs.
- `src/wiki/llmwiki.ts` makes `buildLlmWikiTask()` list all stored raw documentation as `requiredReads`, even when a specific `from` path is supplied for an enrichment request.

### Findings awaiting triage
#### L5-01 — Make Wiki-record updates validated and atomic
- **Problem / impact:** The authoritative-record writer validates only creates. An invalid partial update or interrupted direct write can make a record unreadable; broad handoff reads then repeatedly report it as an invalid global artifact.
- **Proposed improvement:** Read the existing record through the validator, merge, validate the complete result, then atomically replace it under a per-record lock. Add concurrent promotion/drift and invalid-update regression cases.
- **Evidence:** `src/wiki/store.ts` (`writeWikiRecord`, `updateWikiRecord`, `readWikiRecordsWithIssues`).
- **Status:** **accepted** — validate complete records and serialize/atomically persist each update. **Severity:** High · **Effort:** M · **Blast radius:** on-disk/cross-module

> Decision: `accept_validated_atomic_updates` (user selection).

#### L5-02 — Scope handoff Wiki diagnostics to the task's requested references
- **Problem / impact:** Unrelated candidates, stale records, and malformed records are attached to every Context Fabric packet despite only authoritative selection being reference-scoped. Packet size and cognitive load grow with global Wiki history.
- **Proposed improvement:** Include detailed exclusions/warnings only for records relevant to requested refs; add a compact global-health count and point to `kata-cli wiki audit` for repository-wide repair. Never hide a relevant invalid/stale source.
- **Evidence:** `src/wiki/context.ts` (`selectAuthoritativeContext`, `isRelevant`).
- **Status:** **accepted** — task-scoped detail plus a compact global health summary. **Severity:** Med · **Effort:** S · **Blast radius:** public-API

> Decision: `accept_scoped_diagnostics` (user selection).

#### L5-03 — Produce delta-scoped Wiki enrichment packets by default
- **Problem / impact:** Incremental enrichment still requires the agent to read all historical raw documents because existing `raw/docs` takes precedence over the requested source scope. Token cost and latency therefore grow with Wiki size.
- **Proposed improvement:** First compare a content-manifest delta packet against full enrichment output, then emit only added/changed raw documents plus index/schema/log by default; retain explicit full-reconciliation and report the selected mode/input hash.
- **Evidence:** `src/wiki/llmwiki.ts` (`buildLlmWikiTask`, `collectSourceFiles`, `ingestLlmWiki`).
- **Status:** **accepted** — measure equivalence first; adopt delta only with retained explicit full reconciliation. **Severity:** Med · **Effort:** M · **Blast radius:** public-API/on-disk

> Decision: `accept_measure_then_delta` (user selection).

---

## Layer 6 — Infrastructure, repository I/O, hooks, and CodeGraph runtime

Files: `src/process/**`, `src/codegraph/**`, `src/hooks/**`, selected `src/core/*.ts`.
### Evidence examined
- `src/core/repository-identity.ts` materializes every eligible file and its full `Buffer` in an array before `repositoryTreeHash()` begins hashing.
- `src/process/run.ts` appends unbounded asynchronous child stdout/stderr into memory and later serializes it into evidence.
- `src/core/layout.ts` falls back to a synchronous recursive scan of every eligible descendant to resolve a task-owned workspace.

### Findings awaiting triage
#### L6-01 — Stream whole-tree hashing instead of retaining repository contents
- **Problem / impact:** A clean-tree identity hash keeps every file buffer live simultaneously. Large repositories pay avoidable memory pressure and garbage-collection latency on status, drift, and seal paths.
- **Proposed improvement:** Add a deterministic streaming tree-hash traversal that sorts directory entries before hashing each path/content, preserving the present digest byte-for-byte. Keep `walkRepositoryFiles()` only for callers that truly need file materialization.
- **Evidence:** `src/core/repository-identity.ts` (`walkRepositoryFiles`, `repositoryTreeHash`).
- **Status:** **accepted** — stream with byte-for-byte digest equivalence fixtures. **Severity:** High · **Effort:** M · **Blast radius:** internal/cross-module

> Decision: `accept_streaming_hash_equivalence` (user selection).

#### L6-02 — Bound captured subprocess output with an explicit diagnostic contract
- **Problem / impact:** A noisy compiler or test runner can grow `stdout`/`stderr` without limit, consuming host memory and producing oversized evidence artifacts; timeout does not bound output volume.
- **Proposed improvement:** Enforce configurable per-stream capture limits, retain head/tail context and an exact truncation marker/byte count, and expose truncation in `ProcessResult` and evidence. Keep exit status and streamed progress intact; provide an explicit opt-in artifact mode for investigations that require full logs.
- **Evidence:** `src/process/run.ts` (`runProcess`, `ProcessResult`).
- **Status:** **accepted** — bounded default capture plus explicit streaming full-log artifact. **Severity:** Med · **Effort:** M · **Blast radius:** public-API/on-disk

> Decision: `accept_bounded_capture_with_artifact` (user selection).

#### L6-03 — Prefer Git worktree metadata before recursive task-owner discovery
- **Problem / impact:** An explicit task ID outside its owning checkout triggers a synchronous full descendant scan. In a large monorepo this blocks the CLI before it can orient or report ambiguity.
- **Proposed improvement:** Query `git worktree list` and test only declared worktree roots first; retain the current recursive scan as a correctness fallback for non-Git and unmanaged nested worktrees, with timing diagnostics.
- **Evidence:** `src/core/layout.ts` (`resolveWorkspaceRootForTask`, `findDescendantTaskRoots`); `src/core/git.ts` (`gitWorktreeList`).
- **Status:** **accepted** — Git worktree lookup first, conservative recursive fallback retained. **Severity:** Med · **Effort:** M · **Blast radius:** public-API/internal

> Decision: `accept_git_worktree_fast_path` (user selection).

---

## Layer 7 — Evaluation, release control, and build utilities

Files: `src/eval/*.ts`, `scripts/build.mjs`.

### Evidence examined
- `src/eval/runner.ts` runs independent temporary-root fixtures serially; each fixture shares no filesystem state with another.
- The same runner records `tokensUsed` and `costCredits` as `0` while declaring them unmeasured, and stores expected fixture outcomes without comparing them to observations.
- `src/eval/release-gates.ts` evaluates aggregate metrics but has no gate for fixture expectation mismatch or unavailable metrics.

### Findings awaiting triage
#### L7-01 — Represent host-owned evaluation metrics as unavailable, not zero
- **Problem / impact:** Zero token/cost fields are numerically indistinguishable from measured zero and can enter downstream dashboards or release decisions despite the adjacent explanatory list.
- **Proposed improvement:** Use nullable/availability-tagged metric values, exclude unavailable dimensions from numeric aggregates and gates, and render `unavailable (host-owned)` explicitly. Preserve raw host-provided values only when an adapter attests their source.
- **Evidence:** `src/eval/runner.ts` (`unmeasuredMetrics`, `runFixture`); `src/eval/metrics.ts` (`computeMetrics`).
- **Status:** **accepted** — use explicit unavailable/attested metric states; never aggregate zero sentinels. **Severity:** High · **Effort:** M · **Blast radius:** public-API/on-disk

> Decision: `accept_unavailable_metric_contract` (user selection).

#### L7-02 — Gate evaluation quality on fixture expectations, not only aggregate outcomes
- **Problem / impact:** Fixture expectations are persisted but never compared to what ran; escalations are always recorded as zero. A semantically wrong fixture can therefore contribute a plausible aggregate pass rate.
- **Proposed improvement:** Add an explicit per-fixture expectation verdict and make release gating fail on mismatches or unevaluable fixtures; record failures as observations so one bad fixture does not erase the full evaluation report.
- **Evidence:** `src/eval/runner.ts` (`EvaluationFixture`, `runFixture`, `runEvaluation`); `src/eval/release-gates.ts` (`checkReleaseGates`).
- **Status:** **accepted** — mismatch or unevaluable fixture blocks the release gate while preserving a complete report. **Severity:** High · **Effort:** M · **Blast radius:** public-API/on-disk

> Decision: `accept_expectation_gate` (user selection).

#### L7-03 — Schedule independent evaluation fixtures through a bounded pool
- **Problem / impact:** Independent temporary-root fixtures execute serially, extending evaluation wall time linearly while underusing available capacity.
- **Proposed improvement:** Add an opt-in bounded fixture concurrency setting; preserve manifest-order report rows, isolated roots, deterministic aggregate metrics, and serial default for resource-constrained CI.
- **Evidence:** `src/eval/runner.ts` (`runEvaluation`, `runFixture`).
- **Status:** **accepted** — opt-in bounded fixture pool, serial default retained. **Severity:** Med · **Effort:** S · **Blast radius:** public-API/internal

> Decision: `accept_opt_in_fixture_pool` (user selection).

---

## Cross-cutting themes

### T1 — Context and token amplification
- **Sources:** L0-01/L0-04/L0-05/L0-06, L2-01, L3-03, L5-02/L5-03.
- **Rule:** keep default entry/status output and handoff reads proportional to task authority, not repository age. Establish byte/token baselines before changing agent contracts; A/B-test any compression that could affect finding quality.

### T2 — Deterministic identity with lower I/O
- **Sources:** L2-02, L6-01, L1-03.
- **Rule:** coalesce and stream reads only when existing revision/tree/packet identities remain byte-for-byte equivalent and stale reasons remain observable.

### T3 — Quality gates must remain auditable under load
- **Sources:** L3-01/L3-02, L6-02, L7-02/L7-03.
- **Rule:** raw process facts and pass verdicts are distinct; bounded concurrency and diagnostics must preserve ordering, attribution, failure behavior, and an explicit investigation escape hatch.

### T4 — Durable authority cannot be best-effort
- **Sources:** L1-01, L4-01/L4-02, L5-01, L7-01.
- **Rule:** one source of truth, standards-compliant validation, atomic mutations, and explicit unavailable metrics are prerequisites for optimization.

### T5 — User authority and safe acceleration
- **Sources:** L0-07, L6-03.
- **Rule:** accelerate known safe paths only after explicit user consent or an equivalent deterministic repository fact; retain conservative defaults and ambiguity failures.

### Verification note
`docs/changelog/2026-09-17-seal-cost-and-revision-identity.md` describes default concurrent checks, while the current source and E2E fixture describe serial-by-default checks unless `KATA_CHECK_CONCURRENCY` is set. Before implementation/release, reconcile this documentation with the tested contract; this review treats source plus E2E behavior as the current implementation evidence.

---

## Consolidated polish plan

### Phase 0 — Establish baselines and compatibility fixtures
**Findings:** L0-05, L0-06, L3-03, L5-03.  
**Goal:** Measure before reducing agent context or changing enrichment/pass scope.

- Record: rendered Skill bytes/estimated tokens; `status → orient` bytes and wall time; required-read count/bytes per packet; per-node adversarial input/output tokens, tool calls, finding yield; full-versus-delta Wiki outputs; CodeGraph queue timings.
- Freeze representative fixtures for revision/tree hash equivalence, packet required reads, independent adversarial outcomes, and Wiki enrichment output.
- **Success criteria:** all dashboards distinguish unavailable host metrics from zero; no compaction/delta optimization becomes default until its quality comparison is non-inferior.

### Phase 1 — Repair trust and persistence contracts
**Findings:** L1-01, L3-01, L4-01, L4-02, L5-01, L7-01, L7-02.  
**Blast radius:** on-disk/public API/cross-module; complete before performance scheduling changes.

- Replace the partial schema matcher with a maintained draft-compatible validator and preserve actionable artifact-path diagnostics.
- Separate actual command exit from expected/pass outcome, version the evidence schema compatibly, and migrate all aggregate gate predicates.
- Make relation-graph and Wiki-record updates lock-protected, validated, and atomic; derive renderer capabilities from the one platform definition.
- Make evaluation observations availability-aware and fixture expectations executable release conditions.
- **Success criteria:** invalid artifacts fail at ingress; concurrent mutation cannot lose an edge/record update; expected non-zero claims can pass; an evaluation cannot pass with a fixture mismatch or invented zero cost.

### Phase 2 — Preserve identity while reducing I/O and memory
**Findings:** L2-02, L6-01, L6-02.  
**Dependencies:** Phase 1 evidence/result schema decisions.

- Build manifest hash and path digests from one deterministic owned-path snapshot.
- Stream full-tree hashing in sorted path order, retaining exact current digests; bound process capture with explicit truncation and opt-in streaming full-log artifacts.
- **Success criteria:** equivalence fixtures cover missing/ignored/nested/large paths and unchanged revision IDs; memory does not scale with simultaneous whole-tree file buffers; every truncated result is visibly marked.

### Phase 3 — Make workflow context and knowledge task-scoped
**Findings:** L0-01, L0-04, L1-03, L2-01, L5-02, L5-03; conditional L0-06/L3-03.  
**Dependencies:** Phase 0 baselines; L0-04 follows L0-01.

- Make default `status` lightweight, route explicit task IDs directly, and surface stale/reused enrichment materialization.
- Bind design refs and Wiki exclusions to explicit task sources; provide compact global health summaries and audit entry points.
- Adopt Wiki delta enrichment and compact/differentiated adversarial briefs only after Phase 0 equivalence/finding-quality evidence; retain full modes.
- **Success criteria:** required reads are O(task references); global unrelated Wiki/spec history does not inflate handoffs; all context-reduction trials publish before/after quality evidence.

### Phase 4 — Bound and expose independent work
**Findings:** L0-02, L0-03, L0-07, L3-02, L6-03, L7-03.  
**Dependencies:** Phase 1 authority fixes and Phase 0 observability.

- Make refresh conditional on material update reports with `always` escape hatch; migrate command parsing incrementally; expose auditable task-scoped approval reuse.
- Bound CodeGraph affected-path queries with deterministic attribution; resolve known Git worktrees before recursive discovery; offer opt-in bounded evaluation fixtures while retaining serial defaults.
- **Success criteria:** no process storm or hidden full-workspace scan in the normal path; forced refresh, non-Git discovery, no-affected-test, and serial evaluation remain tested.

### Accepted/rejected roll-up
| Status | Count |
|---|---:|
| accepted (including conditional measured trials) | 25 |
| rejected | 1 |
| deferred / open / withdrawn | 0 |

> The rejected L1-02 project-asset coalescing redesign remains intentionally out of scope: per-platform ownership isolation is retained.
