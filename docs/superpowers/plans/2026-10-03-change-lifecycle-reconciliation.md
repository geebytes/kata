# Change Lifecycle Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让长期 Initiative 在关联 slice 的设计、contract、revision、finding 或 relation 变化时主动发现过期对象，并在主线 closure 时反向核对所有中间 slice；过期对象仅经人类确认后从 active projection 退役，历史不删除。

**Architecture:** `.kata/relations.json` 是唯一拓扑。为其 relation 增加稳定 `id` 与 lifecycle metadata，Initiative 以现有 `change:<id>` endpoint 表示、slice 以 `task:<id>` 表示；不能再写第二张关系图。`.kata/initiatives/<id>/` 只保存由该图驱动的 append-only design/contract/finding/impact/retirement 历史与 current projection。纯 reconciliation 只消费已验证的 topology、manifest 和 history，并输出 `fresh | needs_reassessment | invalidated | blocked | undetermined`；命令和 gate 只消费该投影。

**Tech Stack:** TypeScript、Node `fs/promises`、Ajv 2020 schema validation、Vitest、Kata repository/task locks。

**Spec:** `docs/design/2026-10-02-change-lifecycle-reconciliation.md`

## Global Constraints

- `.kata/relations.json` 是唯一关系拓扑；`.kata/initiatives/**` 不得再保存 relations list、edge copy 或由 endpoint 推导的边。
- `KataRelation.id` 由单一 writer 分配且永久稳定；lifecycle history 一律以 `relationId` 引用，不以 `(from,to,type)` fingerprint 绑定。
- 已授权修改 `schemas/kata-relations.schema.json`；新增 lifecycle artefact schema 必须由 `src/core/schema.ts` 注册并通过 reader 实际消费，不能出现“schema 存在而 writer/reader 未接入”。
- 既有 v1 relation graph 保持可读：只有首次受锁 relation 写入才将全部既有 edge 升级为持久 `id` 的 v2；不得在 read path 临时生成 id 或把旧图误报 unreadable。
- 任何读取失败、缺 relation metadata、缺 manifest、JSONL 中间损坏或覆盖范围未知，都产出 `undetermined` / `needs_reassessment`，不能降级成空关联或 `unaffected`。
- 历史是 append-only；current projection 可以被新事件替代，但 retirement 不得删除 design、contract、finding、review、packet 或原始 closure。
- revision identity 继续排除 `.kata/**`：代码 revision 与过程生命周期是两种事实，不能互相使对方 stale。
- 正常事件只走 relation-graph 连通分量与 manifest 交集；只有 Initiative closure 做该 Initiative 的 `O(V + E)` 反向遍历。
- 每个 focused test 必须先 RED，再最小实现 GREEN；每个 consumer 必须以行为测试证明它使用 reconciliation 的输出，而不只测模型函数。
- `dist/` 为 `.gitignore` 中的可再生 bundle；当 CLI surface 变化时，先运行 `npm run build`，再以本地 `kata-cli` smoke 验证注册结果；不把 `dist/` 纳入 scope 或 commit。

---

## File Structure

| 路径 | 责任 |
|---|---|
| `schemas/kata-relations.schema.json` | relation 的稳定 id 与生命周期 metadata 的持久化契约。 |
| `schemas/initiative-lifecycle.schema.json` | initiative projection 与 JSONL event/packet/retirement entries 的持久化契约。 |
| `src/core/schema.ts` | 注册并暴露 `initiative-lifecycle` schema。 |
| `src/core/relations.ts` | relation 唯一 writer/reader；分配 stable id，验证 lifecycle relation，拒绝 cycle 与错误 independent。 |
| `src/core/layout.ts` | `.kata/initiatives/<id>/` 及其 artefact 路径的唯一构造者。 |
| `src/core/initiative-lifecycle.ts` | 在 repository lock 下追加 history、读取并验证 artefact、写 current projection；不扫描 task store。 |
| `src/workflow/lifecycle-reconciliation.ts` | 纯图遍历与 manifest/revision/finding 评估；不直接读写文件。 |
| `src/cli/lifecycle.ts` | `initiative create|attach|reconcile|retire|close` 的参数解析与可操作 JSON 输出。 |
| `src/cli.ts` | 注册 `lifecycle` command family。 |
| `src/cli/workflow.ts` | workflow command whitelist、archive gate 消费与重试语义；为 lifecycle/closure 接入保留既有 trust boundary。 |
| `src/workflow/orchestrator.ts` | 在 seal/finding/archive 等已有边界，把标准化 event 交给 lifecycle coordinator；archive 前消费 closure decision。 |
| `tests/unit/lifecycle-relations.test.ts` | AC-1 / AC-3 的 graph contract、schema、cycle 和 independent 行为。 |
| `tests/unit/lifecycle-store.test.ts` | append-only history、projection、损坏 artefact 的 fail-closed reader。 |
| `tests/unit/lifecycle-reconciliation.test.ts` | AC-2 / AC-4 / AC-8 的纯评估与关联分量隔离。 |
| `tests/unit/lifecycle-retirement.test.ts` | AC-5 的提议/确认/保留历史。 |
| `tests/unit/lifecycle-closure.test.ts` | AC-6 的反向 closure refusal。 |
| `tests/unit/lifecycle-post-closure.test.ts` | AC-7 的 historical closure 与 current projection 分离。 |
| `tests/unit/lifecycle-consumer-wiring.test.ts` | 每个生产 consumer 在替换 reconciliation 输出后必须行为性 RED。 |

## Task 1: Make lifecycle relations an extension of the one authoritative graph

**Files:**
- Modify: `schemas/kata-relations.schema.json`
- Modify: `src/core/schema.ts`
- Modify: `src/core/relations.ts`
- Modify: `tests/unit/relation-store.test.ts`
- Modify: `tests/unit/relation-graph-concurrency.test.ts`
- Create: `tests/unit/lifecycle-relations.test.ts`

**Interfaces:**
- Produces `KataRelation.id: string` and optional `KataRelation.lifecycle`.
- Produces `addLifecycleRelation(input): Promise<KataRelationsGraph>`; it is the only lifecycle-edge writer.
- Consumes existing `withRepositoryArtefactLock(root, 'relations', ...)` and `validate('kata-relations', ...)`.

- [ ] **Step 1: Write RED relation-contract tests.**

```ts
it('allocates a stable lifecycle edge id once and stores lifecycle metadata only in relations.json', async () => {
  const graph = await addLifecycleRelation({
    root,
    from: { type: 'change', id: 'records-initiative' },
    to: { type: 'task', id: 'repair-owner' },
    type: 'contains',
    lifecycle: { initiativeId: 'records-initiative', policy: 'informs', requiredReturn: 'impact_packet' },
  });
  expect(graph.relations[0]).toMatchObject({ id: expect.any(String), lifecycle: { initiativeId: 'records-initiative' } });
  expect(await exists(join(root, '.kata/initiatives/records-initiative/relations.jsonl'))).toBe(false);
});

```ts
it('upgrades a legacy v1 graph only during a locked relation write', async () => {
  await writeLegacyGraphWithoutEdgeIds(root);
  await readTaskRelations(root, 'from-task');
  expect(await readGraphVersion(root)).toBe(1);
  await addLifecycleRelation(lifecycleInput);
  expect(await readGraphVersion(root)).toBe(2);
  expect(await readGraph(root).then((graph) => graph.relations.every((edge) => typeof edge.id === 'string'))).toBe(true);
});
```

it('refuses a lifecycle cycle and an independent edge whose manifests overlap', async () => {
  await expect(addLifecycleRelation(cyclicInput)).rejects.toThrow(/cycle/);
  await expect(addLifecycleRelation(overlappingIndependentInput)).rejects.toThrow(/independent.*overlap/);
});
```

- [ ] **Step 2: Run the focused tests to prove RED.**

Run: `npx vitest run tests/unit/lifecycle-relations.test.ts`

Expected: FAIL because `id` / `lifecycle` and `addLifecycleRelation` do not exist.

- [ ] **Step 3: Extend the schema and writer atomically.**

Add a versioned schema: v1 keeps legacy edges readable without ids; v2 requires `id` on every edge and permits optional `lifecycle` with a closed policy vocabulary, initiative id, source finding ids, affected assumption ids and required return. In `relations.ts`, make the first relation mutation acquire the existing relations lock, upgrade the complete v1 graph to v2 by allocating durable ids for all pre-existing edges, validate the upgraded graph, then append/update the requested edge in that same mutation. Read paths never mint ids. Extend `KataRelation`, validate lifecycle/type compatibility, and reject any graph path from the new edge back to its source. Preserve `addTaskRelation` as the compatibility projection; no per-task relation file may return.

```ts
export type LifecyclePolicy = 'blocks' | 'invalidates_design' | 'implements_finding' | 'informs' | 'independent';
export type LifecycleMetadata = {
  initiativeId: string;
  policy: LifecyclePolicy;
  sourceFindingIds?: string[];
  affectedAssumptionIds?: string[];
  requiredReturn: 'revalidation' | 'impact_packet' | 'none';
};
```

- [ ] **Step 4: Prove GREEN and compatibility.**

Run: `npx vitest run tests/unit/lifecycle-relations.test.ts tests/unit/relation-store.test.ts tests/unit/relation-graph-concurrency.test.ts`

Expected: PASS; a read of v1 leaves it byte-for-byte v1, its first locked writer upgrades all edges once to v2, concurrent writers retain/refuse edges without a lost update, legacy task projections still omit lifecycle-only fields, and a malformed lifecycle object is rejected by the schema reader.

- [ ] **Step 5: Commit the relation boundary.**

```bash
git add schemas/kata-relations.schema.json src/core/schema.ts src/core/relations.ts tests/unit/relation-store.test.ts tests/unit/relation-graph-concurrency.test.ts tests/unit/lifecycle-relations.test.ts
git commit -m "feat: model lifecycle relations in authoritative graph"
```

## Task 2: Persist initiative history and current projection without another graph

**Files:**
- Create: `schemas/initiative-lifecycle.schema.json`
- Modify: `src/core/schema.ts`
- Modify: `src/core/layout.ts`
- Create: `src/core/initiative-lifecycle.ts`
- Create: `tests/unit/lifecycle-store.test.ts`

**Interfaces:**
- Produces `initiativeDir`, `initiativeProjectionPath`, `impactPacketsPath`, `retirementProposalsPath`.
- Produces `readInitiativeLifecycle(root, initiativeId)` and `appendLifecycleEvent(root, initiativeId, event)`.
- Consumes relation ids; it never accepts endpoint pairs as a replacement identity.

- [ ] **Step 1: Write RED store tests.**

```ts
it('projects append-only events while retaining every historical packet', async () => {
  await appendLifecycleEvent(root, initiative, designNeedsReassessment);
  await appendLifecycleEvent(root, initiative, designRebased);
  const state = await readInitiativeLifecycle(root, initiative);
  expect(state.current.designs['design-1'].status).toBe('active');
  expect(state.history).toHaveLength(2);
});

it('reports malformed JSONL as undetermined instead of an empty history', async () => {
  await writeFile(impactPacketsPath(root, initiative), '{broken}\n');
  expect((await readInitiativeLifecycle(root, initiative)).readState).toBe('unreadable');
});
```

- [ ] **Step 2: Run RED.**

Run: `npx vitest run tests/unit/lifecycle-store.test.ts`

Expected: FAIL because no lifecycle layout/accessor/store exists.

- [ ] **Step 3: Implement validated append-only history and projection.**

Add the lifecycle schema to `schemaText`; its entries carry event id, timestamp, `relationId` where applicable, immutable payload and optional supersession reference. Add layout accessors under `.kata/initiatives/<initiative-id>/`; do not add a `relationsPath` there. Use one repository artefact lock named `initiative-<id>` to load the projection, validate/append event history, write the new projection atomically, then append the JSONL audit line. Treat a missing initiative as `absent`; malformed JSON/schema/read failures as `unreadable`.

```ts
export type InitiativeReadState = 'absent' | 'usable' | 'unreadable';
export type InitiativeLifecycle = {
  readState: InitiativeReadState;
  current: InitiativeProjection;
  history: LifecycleEvent[];
};
```

- [ ] **Step 4: Run GREEN and schema regression tests.**

Run: `npx vitest run tests/unit/lifecycle-store.test.ts tests/unit/schema-validation.test.ts`

Expected: PASS; all lifecycle history references an existing relation id or the read fails closed.

- [ ] **Step 5: Commit the lifecycle store.**

```bash
git add schemas/initiative-lifecycle.schema.json src/core/schema.ts src/core/layout.ts src/core/initiative-lifecycle.ts tests/unit/lifecycle-store.test.ts tests/unit/schema-validation.test.ts
git commit -m "feat: persist initiative lifecycle history"
```

## Task 3: Evaluate impact from the graph component, manifests and lifecycle projection

**Files:**
- Create: `src/workflow/lifecycle-reconciliation.ts`
- Create: `tests/unit/lifecycle-reconciliation.test.ts`

**Interfaces:**
- Produces pure `reconcileInitiative(input): ReconciliationResult` and `evaluateInitiativeClosure(input): InitiativeClosureDecision`.
- Consumes `KataRelationsGraph`, `InitiativeProjection`, immutable revision manifests and normalised finding/revalidation facts.
- Does not import `node:fs`, CLI modules, or `orchestrator.ts`.

- [ ] **Step 1: Write RED behavioural cases.**

```ts
it('marks only the related design needs_reassessment when a child manifest intersects its dependency manifest', () => {
  const result = reconcileInitiative(relatedChildRevision);
  expect(result.statusByDesign['parent-design']).toBe('needs_reassessment');
  expect(result.statusByDesign['unrelated-design']).toBe('fresh');
  expect(result.impactPackets).toContainEqual(expect.objectContaining({ result: 'needs_reassessment' }));
});

it('returns undetermined when an incoming relation lacks lifecycle metadata', () => {
  expect(reconcileInitiative(missingLifecycleMetadata).overall).toBe('undetermined');
});

it('keeps a transferred finding unresolved until current revalidation and packet consumption both exist', () => {
  expect(reconcileInitiative(transferredWithoutReturn).unresolvedFindings).toEqual(['F-1']);
});
```

- [ ] **Step 2: Run RED.**

Run: `npx vitest run tests/unit/lifecycle-reconciliation.test.ts`

Expected: FAIL because the pure evaluator does not exist.

- [ ] **Step 3: Implement the bounded evaluator.**

Traverse only the Initiative’s connected component; intersect sorted manifest path/symbol maps; derive `fresh`, `needs_reassessment`, `invalidated`, `blocked` or `undetermined`. `independent` may short-circuit only after the already-validated non-overlap invariant; it never converts unreadable input into fresh. Emit packets keyed by source revision and relation id, deduplicating an identical event without erasing prior packet history.

- [ ] **Step 4: Run GREEN, including legacy isolation.**

Run: `npx vitest run tests/unit/lifecycle-reconciliation.test.ts`

Expected: PASS; a first-linked legacy slice is `needs_reassessment`, while a revision outside the component changes neither result nor packet set.

- [ ] **Step 5: Commit the deterministic evaluator.**

```bash
git add src/workflow/lifecycle-reconciliation.ts tests/unit/lifecycle-reconciliation.test.ts
git commit -m "feat: reconcile lifecycle impact by relation component"
```

## Task 4: Expose governed lifecycle operations and trigger reconciliation at existing workflow boundaries

**Files:**
- Create: `src/cli/lifecycle.ts`
- Modify: `src/cli.ts`
- Modify: `src/cli/workflow.ts`
- Modify: `src/workflow/orchestrator.ts`
- Modify: `tests/unit/lifecycle-reconciliation.test.ts`
- Create: `tests/unit/lifecycle-consumer-wiring.test.ts`

**Interfaces:**
- Produces CLI family: `kata-cli lifecycle create|attach|reconcile|status`.
- Produces `recordLifecycleTrigger(event)` as the only workflow-to-lifecycle bridge.
- Consumes `reconcileInitiative` and `appendLifecycleEvent`; consumers must not rescan relations/manifests directly.

- [ ] **Step 1: Write RED command and wiring tests.**

```ts
it('reconciles a related Initiative after a seal and writes an impact packet', async () => {
  await invokeCli(['lifecycle', 'attach', '--initiative', 'root-change', '--task', 'child']);
  await sealChildRevision('child', changedPath);
  expect(await lifecycleStatus('root-change')).toMatchObject({ status: 'needs_reassessment' });
});

it('fails when the archive/closure consumer is replaced with a constant fresh decision', async () => {
  await expect(runClosureWithForcedFreshDecision(blockedInitiative)).rejects.toThrow(/unconsumed impact packet/);
});
```

- [ ] **Step 2: Run RED.**

Run: `npx vitest run tests/unit/lifecycle-reconciliation.test.ts tests/unit/lifecycle-consumer-wiring.test.ts`

Expected: FAIL because lifecycle commands and workflow trigger are absent.

- [ ] **Step 3: Implement the command boundary and single trigger.**

Register `lifecycle` in `src/cli.ts` and its command whitelist/dispatch integration in `src/cli/workflow.ts`. In `src/cli/lifecycle.ts`, parse every value with the existing flag parser, call the relation writer for topology mutations, and return structured records naming `initiativeId`, `relationId`, `status`, `packetIds` and `nextAction`. In `orchestrator.ts`, invoke `recordLifecycleTrigger` immediately after the existing durable seal/finding state is written, never before; the trigger resolves Initiatives through the relation graph and delegates all evaluation to Task 3.
- [ ] **Step 4: Run GREEN and prove the consumer really consumes.**

Run: `npm run build && kata-cli --help | grep -F lifecycle && npx vitest run tests/unit/lifecycle-reconciliation.test.ts tests/unit/lifecycle-consumer-wiring.test.ts`

Expected: the rebuilt local bundle lists `lifecycle`, then all tests PASS; mutating the consumer to bypass `recordLifecycleTrigger` or to return `fresh` makes the specified consumer test fail.

- [ ] **Step 5: Commit trigger wiring.**

```bash
git add src/cli/lifecycle.ts src/cli.ts src/cli/workflow.ts src/workflow/orchestrator.ts tests/unit/lifecycle-reconciliation.test.ts tests/unit/lifecycle-consumer-wiring.test.ts
git commit -m "feat: trigger lifecycle reconciliation from workflow events"
```

## Task 5: Make retirement a proposal-confirmation transition, never a deletion

**Files:**
- Modify: `src/core/initiative-lifecycle.ts`
- Modify: `src/cli/lifecycle.ts`
- Create: `tests/unit/lifecycle-retirement.test.ts`

**Interfaces:**
- Produces `proposeRetirement(input): RetirementProposal` and `confirmRetirement(input): InitiativeProjection`.
- Consumes the current reconciliation result, open finding facts, latest packets and `blocks` relation state.

- [ ] **Step 1: Write RED retirement tests.**

```ts
it.each(['blocking finding', 'unconsumed packet', 'open blocks edge'])('refuses a retirement proposal with a %s', async (blocker) => {
  await expect(proposeRetirement(fixtureWith(blocker))).rejects.toThrow(/cannot retire/);
});

it('confirms an eligible proposal by hiding only the active projection while history stays readable', async () => {
  const proposal = await proposeRetirement(eligibleFixture);
  await confirmRetirement({ initiativeId, proposalId: proposal.id, confirmedBy: 'operator' });
  expect((await readInitiativeLifecycle(root, initiativeId)).current.retired).toContain('obsolete-slice');
  expect((await readInitiativeLifecycle(root, initiativeId)).history).toContainEqual(expect.objectContaining({ type: 'retirement_confirmed' }));
});
```

- [ ] **Step 2: Run RED.**

Run: `npx vitest run tests/unit/lifecycle-retirement.test.ts`

Expected: FAIL because retirement is not modelled.

- [ ] **Step 3: Implement proposal then explicit confirmation.**

Permit only `superseded`, `absorbed`, `invalidated`, `out_of_scope_transferred`, `abandoned_with_human_waiver`. Store a proposal with its exact blockers and latest packet ids. `confirm` must re-read/reconcile under the initiative lock and reject if those facts changed; it appends a `retired` event and updates active projection only. No filesystem removal is permitted.

- [ ] **Step 4: Run GREEN.**

Run: `npx vitest run tests/unit/lifecycle-retirement.test.ts`

Expected: PASS; an approval against an out-of-date proposal is rejected rather than retiring a now-blocked slice.

- [ ] **Step 5: Commit retirement semantics.**

```bash
git add src/core/initiative-lifecycle.ts src/cli/lifecycle.ts tests/unit/lifecycle-retirement.test.ts
git commit -m "feat: retire lifecycle slices by confirmed proposal"
```

## Task 6: Gate Initiative closure and preserve post-closure history

**Files:**
- Modify: `src/workflow/lifecycle-reconciliation.ts`
- Modify: `src/core/initiative-lifecycle.ts`
- Modify: `src/cli/lifecycle.ts`
- Modify: `src/workflow/orchestrator.ts`
- Modify: `src/cli/workflow.ts`
- Create: `tests/unit/lifecycle-closure.test.ts`
- Create: `tests/unit/lifecycle-post-closure.test.ts`
- Modify: `tests/unit/lifecycle-consumer-wiring.test.ts`

**Interfaces:**
- Produces `InitiativeClosureDecision = { allowed: boolean; blockers: ClosureBlocker[] }`.
- Produces `post_closure_impact` lifecycle events and reconciliation-slice candidates.
- Consumes the current result from Task 3; no closure branch repeats graph traversal itself.

- [ ] **Step 1: Write RED closure and post-closure tests.**

```ts
it('refuses Initiative closure and names every unconsumed packet, stale design, relevant open slice and unresolved return', () => {
  const decision = evaluateInitiativeClosure(unhealthyInitiative);
  expect(decision).toMatchObject({ allowed: false, blockers: expect.arrayContaining([
    expect.objectContaining({ kind: 'unconsumed_packet' }),
    expect.objectContaining({ kind: 'needs_reassessment' }),
  ]) });
});

it('does not rewrite historical closure after a later related revision', async () => {
  await closeInitiative(closedFixture);
  await recordLifecycleTrigger(laterRelatedRevision);
  const lifecycle = await readInitiativeLifecycle(root, initiativeId);
  expect(lifecycle.history).toContainEqual(expect.objectContaining({ type: 'initiative_closed' }));
  expect(lifecycle.current.status).toBe('needs_reconciliation');
  expect(lifecycle.current.candidates).toContainEqual(expect.objectContaining({ kind: 'reconciliation_slice' }));
});
```

- [ ] **Step 2: Run RED.**

Run: `npx vitest run tests/unit/lifecycle-closure.test.ts tests/unit/lifecycle-post-closure.test.ts`

Expected: FAIL because closure checks and post-closure projection do not exist.

- [ ] **Step 3: Implement bounded reverse closure and post-closure handling.**

Build closure blockers from Task 3’s component result: unsatisfied `blocks`, transferred findings without current revalidation and consumed packet, designs needing reassessment, unreadable input, and relevant unfinished slices. In `cmdArchive`, preserve the existing archive user-choice, review approval, judge/distill, waived-claim and Wiki closure gates unchanged; after they pass but before its final `transition(..., 'archive')`, consume `InitiativeClosureDecision` and refuse when `allowed` is false so the already-consumed gate remains a retryable record rather than a bypass. For an already-closed Initiative, append `post_closure_impact`; retain the old closure event untouched and change only current projection to `needs_reconciliation` with a candidate, never auto-open it.

- [ ] **Step 4: Run GREEN plus archive regressions.**

Run: `npx vitest run tests/unit/lifecycle-closure.test.ts tests/unit/lifecycle-post-closure.test.ts tests/unit/lifecycle-consumer-wiring.test.ts tests/unit/archive-never-removes-the-only-copy.test.ts`

Expected: PASS; an Initiative closure refusal does not weaken existing task archive safety.

- [ ] **Step 5: Commit closure behaviour.**

```bash
git add src/workflow/lifecycle-reconciliation.ts src/core/initiative-lifecycle.ts src/cli/lifecycle.ts src/cli/workflow.ts src/workflow/orchestrator.ts tests/unit/lifecycle-closure.test.ts tests/unit/lifecycle-post-closure.test.ts tests/unit/lifecycle-consumer-wiring.test.ts
git commit -m "feat: reconcile initiative closure and post-closure impact"
```

## Task 7: Prove legacy admission and bounded non-impact

**Files:**
- Modify: `tests/unit/lifecycle-reconciliation.test.ts`
- Modify: `tests/unit/lifecycle-consumer-wiring.test.ts`
- Modify: `docs/design/2026-10-02-change-lifecycle-reconciliation.md`

**Interfaces:**
- Consumes the public Task 1–6 interfaces only.
- Produces no new source API; this task closes AC-8 and documents measured complexity.

- [ ] **Step 1: Write RED legacy and isolation tests.**

```ts
it('admits a legacy linked task as needs_reassessment, never as silently fresh', () => {
  expect(reconcileInitiative(legacyTaskWithoutManifest).statusByDesign['legacy-design']).toBe('needs_reassessment');
});

it('does not read or rebase an Initiative outside the changed relation component', () => {
  const result = reconcileInitiative(unrelatedRevision);
  expect(result.impactPackets).toEqual([]);
  expect(result.visitedEndpoints).toEqual(['change:affected-initiative', 'task:affected-child']);
});
```

- [ ] **Step 2: Run RED.**

Run: `npx vitest run tests/unit/lifecycle-reconciliation.test.ts tests/unit/lifecycle-consumer-wiring.test.ts`

Expected: FAIL if a legacy record defaults to `fresh` or traversal includes the disconnected Initiative.

- [ ] **Step 3: Implement only the missing admission/isolation branch.**

Keep the evaluator’s input canonicalisation in Task 3; add no second graph scan. Classify missing dependency manifest as `needs_reassessment`; retain the traversal’s visited endpoint ids in diagnostic output so the bounded-work assertion is observable.

- [ ] **Step 4: Run GREEN and the full declared suite.**

Run: `npx vitest run tests/unit/lifecycle-relations.test.ts tests/unit/lifecycle-store.test.ts tests/unit/lifecycle-reconciliation.test.ts tests/unit/lifecycle-retirement.test.ts tests/unit/lifecycle-closure.test.ts tests/unit/lifecycle-post-closure.test.ts tests/unit/lifecycle-consumer-wiring.test.ts && npm run typecheck`

Expected: PASS; no focused lifecycle suite succeeds if the graph, store, evaluator or consumer wiring is bypassed.

- [ ] **Step 5: Commit final documentation and evidence surface.**

```bash
git add docs/design/2026-10-02-change-lifecycle-reconciliation.md tests/unit/lifecycle-reconciliation.test.ts tests/unit/lifecycle-consumer-wiring.test.ts
git commit -m "test: prove lifecycle reconciliation isolation"
```

## Implementation Verification

1. Run every AC selector in `task.json` after its task turns GREEN.
2. Mutation-check every consumer test by bypassing its `reconcileInitiative` / `recordLifecycleTrigger` result; the consumer test must RED, then restore before proceeding.
3. Run `npm run typecheck` and the full lifecycle focused suite after Task 7.
4. Before seal, declare every actual source/test/schema/doc path through the governed scope command; do not hand-edit `task.json`.
5. Capture measured event work (`visitedEndpoints`, manifest intersections) in the design doc; reject an implementation that silently falls back to repository-wide scanning.

## Review repair note (2026-10-03)

Independent review refuted five originally passing assumptions. The repair is intentionally class-level:
- A v2 relation graph requires an id on **every** edge; v1 remains readable and is migrated only on a locked write.
- Missing revision manifests and absent/unreadable design declarations are `undetermined`, never an empty unaffected set.
- A `finding_revalidated` event is admitted only when its `{ findingId, relationId, revisionId, packetId }` binds the relation's latest consumed packet. Older incomplete events remain readable but cannot resolve a finding.
- `initiative_closed` is not an ordinary appendable event: `closeInitiative` evaluates the sole closure decision and owns the only closure write.
- Every repair has a RED counterexample and a mutation that reddens its consumer-level selector.

## Self-Review

- **Spec coverage:** AC-1 → Task 1; AC-2 → Tasks 2–4; AC-3 → Task 1; AC-4 → Task 3; AC-5 → Task 5; AC-6 → Task 6; AC-7 → Task 6; AC-8 → Task 7.
- **No parallel derivation:** Task 1 makes relation metadata part of the existing graph, Task 2 deliberately omits a sidecar relation list, and Tasks 3–6 consume the same evaluator.
- **Failure semantics:** Tasks 1–3 classify malformed/missing input as refusal or `undetermined`; Tasks 5–6 prevent retirement/closure from treating it as absence.
- **Placeholder scan:** The plan has no TBD/TODO markers. All code paths, new interfaces, RED commands and expected outcomes are named.
