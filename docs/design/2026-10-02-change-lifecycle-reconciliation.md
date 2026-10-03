# 长周期 Change 的时态与关系收敛

**日期**：2026-10-02  
**状态**：设计已确认，待受治理任务冻结
**决策**：主动发现过期；提议后由负责人确认从 active projection 剔除；历史永不删除。

---

## 1. 问题

一个主线目标在完成过程中会产生多个新的待开发 change。它们会：

- 推翻主线 design 的前提；
- 修改主线依赖的代码 surface 或 contract；
- 接走某个 finding，却尚未证明其修复适用于主线当前 revision；
- 在主线继续迭代时自身变得无关、被吸收或被另一 change 取代。

当前 Kata 将 task、design、acceptance、review subject 和 finding 的时间关系分散记录。revision-bound evidence 已能识别内容移动，但 design、冻结 AC、finding disposition 及跨 change 关系没有同等的版本绑定。因此：

1. 旧 design 可能在其前提已被新 finding 推翻后仍被采用；
2. finding 可以被“修了相似形状”误写为已解决；
3. 一个长期 task 只能删除并重开才能合法替换冻结 AC；
4. 子 change 完成后，主线没有机械义务吸收其结果；
5. 主线结束时，没有反向检查中间 change 是否已过期或尚未回传影响。

本会话中的 `task-records-outlive-the-worktree`、`record-ownership-single-derivation`、`unique-copies-is-one-model` 与 `one-record-derivation` 是实证：后续 slice 修改同一根因/共享 `layout.ts` 后，早期 design、ledger 与 review 不能自动表达“历史观察仍为真，但对当前方案不再适用”。

## 2. 目标与非目标

### 目标

- 主动、确定性地发现 design、contract、finding 与 slice 的结构性过期；
- 表达主线与中间 change 的因果、阻塞和共享 surface 关系；
- 在子 change 状态变化时，将影响回传到所有关联主线；
- 让主线 closure 包含一次反向全图卫生检查；
- 将过期对象从当前执行视图剔除，但保留完整审计历史；
- 不用“过期”洗掉未解决的 blocking finding。

### 非目标

- 不由 Kata 自动推断语义相关性、自动发明新需求或自动开启 change；
- 不把历史 artefact 删除、重写或伪装为当前 artefact；
- 不让无关 commit 使全部活动任务进入重审；
- 除 `kata-relations` 的稳定 edge id 与 lifecycle metadata 外，不扩展无关的受保护 `.kata` schema。

## 3. 基本分层：Initiative 不等于 ChangeSlice

长期主线目标不能同时是可 build/seal/review 的实施单元。

```text
Initiative（长期目标 / 主线）
 ├─ ChangeSlice A（一个冻结 contract + 一组内容 revision）
 │   └─ finding F → implements-finding → ChangeSlice B
 ├─ ChangeSlice C（独立但 informs A）
 └─ ChangeSlice D（整合 B/C 对主线的影响）
```

- **Initiative**：目标、当前主线 design、关系图和最终 closure owner；本身不以代码 revision 获得测试/审查通过。
- **ChangeSlice**：现有 Kata task 的角色；每个 slice 有冻结的 `ContractRevision`、内容 revision、verify/review/judge/archive 生命周期。
- **DesignRevision**：主线或 slice 的可实施方案，绑定其依据的内容和 contract，而非一篇可自由覆盖的文档。
- **ContractRevision**：不可变 acceptance 集；新 contract 通过 predecessor + delta 取代旧 contract，而不是手改旧 AC。

因此，发现根因超出当前 slice 时，产生的是一个**关联的新 slice 候选**；不是让原 slice 无限修补、重封和改变含义。

## 4. 追加式生命周期记录

保留现有 `task.json` 可读，但关系拓扑扩展在既有 `.kata/relations.json` 上；DesignRevision、ContractRevision、FindingDisposition 与 ImpactPacket 才采用追加式 lifecycle record。

```ts
interface DesignRevision {
  id: string;
  initiativeId: string;
  basedOn: { contractRevisionId: string; contentRevisionIds: string[] };
  dependencyManifest: Array<{ pathOrSymbol: string; digest: string }>;
  assumptions: Array<{ id: string; statement: string; evidence: string[] }>;
  status: 'active' | 'needs_reassessment' | 'invalidated' | 'superseded' | 'retired';
  predecessor?: string;
}

interface ContractRevision {
  id: string;
  sliceId: string;
  acceptance: AcceptanceCriterion[];
  predecessor?: string;
  delta?: { added: string[]; removed: string[]; changed: string[]; reason: string };
}

interface FindingDisposition {
  findingId: string;
  reportedAgainst: { sliceId: string; contentRevisionId: string; contractRevisionId: string };
  relevance: 'current' | 'needs_recheck' | 'no_longer_applicable';
  outcome: 'open' | 'fixed_and_revalidated' | 'rejected_with_evidence' | 'accepted_risk' | 'transferred';
  successorSliceId?: string;
  evidence?: string[];
}
```

旧 finding 是不可变历史观察；`FindingDisposition` 是对**当前**主线的追加判断。`transferred` 不是 `fixed_and_revalidated`：它必须指向 successor slice，并保留主线回传义务。

## 5. 既有权威关系图与生命周期语义

仓库已经有唯一权威拓扑：`src/core/relations.ts` 的 `.kata/relations.json`（`KataRelationsGraph`）。它已有 `task|change` endpoint，以及 `contains`、`spawned_from`、`implements`、`blocked_by`、`related_to` 等边。

> 因此 Initiative 使用既有 `change:<initiative-id>` endpoint，ChangeSlice 使用 `task:<task-id>` endpoint，且 `contains` 从 Initiative 指向其 slice。不得创建第二张 Initiative relation graph。

初稿曾设想以 sidecar annotation 指向既有 edge；源码否定了这个方案：`KataRelation` 目前没有稳定 edge id，`addKataRelation` 会按 `(from,to,type)` 覆盖同形边。用 fingerprint 绑定 annotation 会在关系更新或中途失败后产生错绑/孤立 metadata，等于再造一份不可靠的关系事实。

> **结论：必须扩展既有 relation schema，而不是并列 sidecar graph。** 每个 edge 获得稳定 `id` 与经 schema 验证的 lifecycle metadata；append-only ImpactPacket 只引用该 id。此项实现会修改受保护的 Kata schema，实施前需要显式授权。

```ts
interface LifecycleRelation {
  id: string; // stable; never inferred from endpoints
  kind: RelationKind;
  type: TaskRelationType;
  from: RelationEndpoint;
  to: RelationEndpoint;
  lifecycle?: {
    initiativeId: string;
    policy: 'blocks' | 'invalidates_design' | 'implements_finding' | 'informs' | 'independent';
    sourceFindingIds?: string[];
    affectedAssumptionIds?: string[];
    requiredReturn: 'revalidation' | 'impact_packet' | 'none';
  };
  createdAt: string;
  createdBy?: string;
}
```

| lifecycle policy | 现有 topology 表达 | 主线效果 |
|---|---|---|
| `blocks` | `blocked_by` | 主线可继续其他工作，但不可关闭该部分或 archive |
| `invalidates_design` | `related_to` + metadata | 目标 design 立即 `needs_reassessment` |
| `implements_finding` | `implements` | 原 finding 保持 `transferred`，直到回传 revalidation |
| `informs` | `related_to` + metadata | 子 slice 终结时必须产生 impact packet |
| `independent` | `related_to` + metadata | 可并行，不参与主线 closure；surface 重叠时拒绝此标记 |

`changes-surface` 不是人工 edge：它由 relation 相连节点的 revision manifest 交集导出。创建 lifecycle relation 时拒绝环；缺 lifecycle metadata、metadata 引用不存在的 edge，或 edge/source 不可读时一律 `undetermined`，绝不能按“无关联”处理。
## 6. 主动发现：Reconciliation

### 6.1 事件

只在以下事件运行，不做每轮全仓库扫描：

- slice seal 或新内容 revision；
- design/contract revision 创建或替换；
- review finding、finding disposition、relation 状态变化；
- initiative 进入或恢复、以及请求 closure；
- 超过可配置闲置窗口后重新进入 initiative。

### 6.2 算法

```text
事件 → 产生 changed surface / contract delta / relation delta
     → 图上找关联连通分量
     → 与每个 DesignRevision.dependencyManifest 求交
     → fresh | needs_reassessment | invalidated | blocked
     → 写 append-only ImpactPacket，附带 next action
```

- `fresh`：没有结构性影响；
- `needs_reassessment`：相交或前提来源移动；不可继续依赖旧 design build；
- `invalidated`：明确 `supersedes-design`、contract 变化或 finding 反证前提；从 active execution queue 移除；
- `blocked`：存在未关闭 `blocks` 或 transferred finding 尚未 revalidate；
- `retired`：已确认被替代、吸收或不再相关；仅从 current projection 移除。

路径/符号交集仅是机械预筛。系统遇到语义相关性不确定时输出 `needs_relationship_decision`，不能把未知写成无影响。

### 6.3 ImpactPacket

每次关联 slice 终结或 revision 变化都写一个 packet：

```ts
interface ImpactPacket {
  sourceSliceId: string;
  sourceRevisionId: string;
  targetInitiativeId: string;
  affectedDesignRevisions: string[];
  affectedContracts: string[];
  changedSurface: string[];
  transferredFindings: string[];
  result: 'unaffected' | 'needs_reassessment' | 'invalidated' | 'blocked';
  consumedBy?: { designRevisionId: string; at: string; decision: string };
}
```

主线 design 只有在它消费了所有非独立入边的最新 packet 后，才可称为当前。

## 7. 主线 closure 的反向回溯

Initiative archive 前执行一次从叶子到根的图遍历：

1. 每个 `blocks` 边均已满足或有明确人类 waiver；
2. 每个 `implements-finding` 有当前 revision 上的 revalidation，不能只标 transferred；
3. 每个 `changes-surface` / `supersedes-design` 影响的 design 已 rebase、supersede 或进入 retirement 提议；
4. 每个未完成中间 slice 都被分类为仍相关、转为新主线、或 retirement candidate；
5. 每个关联 child 的最新 ImpactPacket 已被主线 current design 消费；
6. 若任一结果为 `unknown`、`needs_reassessment` 或 `blocked`，Initiative 不能 archive。

这一步不是重新执行所有测试：它是图与 manifest 的 bounded reconciliation。代码验证仍由各 slice 的 normal verify/review/judge 承担。


### 7.1 Closure 后的后续影响

`archive` 保存的是当时 closure 的历史，不会被后来事件改写；但 Initiative 仍保留关系图索引。任何新 relation、successor finding 或关联 child revision 指向已 closure 的 Initiative 时，reconciliation 写 `post_closure_impact`：

1. 原 closure 保持历史事实，不伪造为仍 current；
2. Initiative 的 current projection 进入 `needs_reconciliation`，并生成一个 reconciliation slice candidate；
3. 负责人决定新事件是否只是后续独立工作，或必须启动 successor Initiative / reconciliation slice；
4. 未作出该决定前，不得把原 closure 当作覆盖该新影响的结论。

因此，结束不是停止观察，而是将“当时已完成”的声明与“后来出现的新影响”严格分开。
## 8. 主动剔除，但不自动删除

采用 **propose-then-confirm**：

1. reconciliation 自动生成 `RetirementProposal`，说明 candidate、原因、被谁 supersede/absorb、未决 finding、以及关联主线的影响；
2. 负责人确认后写追加的 `retired` transition；
3. 被 retired 的 design/change 从 active projection 和待办队列移除，但历史、finding、review 和原始 contract 都保留可查询；
4. 若存在 blocking finding、未消费 impact packet 或 `blocks` 边，系统拒绝生成可确认的 retirement proposal。

可接受的原因仅为：`superseded`、`absorbed`、`invalidated`、`out_of_scope_transferred`、`abandoned_with_human_waiver`。`stale` 本身不是结束状态，只是必须处理的信号。

## 9. Gate 规则

- Build：slice 的 active design / contract 任一非 current 时拒绝；
- Verify / Review：仍绑定具体 content revision + contract revision；
- Finding closure：只接受当前 revision 的 revalidation、明确否定证据、风险 waiver 或已消费 successor packet；
- Initiative closure：执行第 7 节反向回溯；
- Archive：不删除历史 sidecar，且不允许由 retirement 绕过 verify/review/judge。

## 10. Legacy 与存储边界

关系 edge 的 `id` 与 `lifecycle` metadata 必须扩展受保护的 `kata-relations` schema；这是维护唯一权威拓扑所必需的 schema 修改，实施前需要显式授权。其余 lifecycle history 保持在 `.kata/initiatives/` 的追加式记录中：

```text
.kata/initiatives/<initiative-id>/
  initiative.json
  design-revisions.jsonl
  contract-revisions.jsonl
  impact-packets.jsonl
  retirement-proposals.jsonl
```

它们必须继续排除在内容 revision identity 之外：revision identity 回答“代码变了什么”，lifecycle record 回答“过程如何演进”。两者不能互相使对方失效。

Legacy task 没有 dependency manifest 时，首次被关联或恢复即标记 `needs_reassessment`；不会假装历史 design 可由新机制自动证明。

## 11. 成本与边界

- 常规事件：`O(关联边 × manifest 交集)`，不扫全历史；
- Initiative closure：`O(V + E)`，其中 `V/E` 限于该 initiative；
- 闲置检查：只在进入或 closure 时运行；
- 语义判断：由设计者/负责人消费 packet，不由 Kata 假装理解；
- 存储：追加式，允许压缩投影，但不删除原记录。

## 12. 已实现的边界与实测

| 事实 | 位置 | 说明 |
|---|---|---|
| 唯一拓扑 | `src/core/relations.ts` | `addLifecycleRelation` 是 lifecycle 边的唯一 writer；`id` 由 writer 分配并被同形重写继承，reader 从不铸造。 |
| v1 可读 | `schemas/kata-relations.schema.json` | v1 边允许无 `id`；首次受锁写入一次性补齐全部既有边的 id 并升为 v2。 |
| 追加式历史 | `src/core/initiative-lifecycle.ts` | 事件是记录，`current.json` 是投影；读失败/JSONL 损坏一律 `unreadable`，不当作空历史。 |
| 绑定校验 | 同上 | 事件引用不存在的 relation id 时拒写，避免指向已消失边的“静默失效”记录。 |
| 有界评估 | `src/workflow/lifecycle-reconciliation.ts` | 只遍历该 Initiative 的连通分量；`visitedEndpoints` 让“有界”可观测。 |
| 未知即未定 | 同上 | 无 lifecycle metadata / 未声明依赖面 / 无 id 的 lifecycle 边 → `undetermined`，绝不降级为 `fresh`。 |
| 唯一触发桥 | 同上 | `recordLifecycleTrigger` 是 workflow → lifecycle 的唯一入口；已 closed 的 Initiative 只移动投影并生成 candidate，不改写历史 closure。 |
| 退役 | `src/core/initiative-lifecycle.ts` | 提议与确认两段；确认时按当前事实重查，仅从 active projection 移除，历史保留。 |

后续（本次未实现，已在设计中标明为独立问题）：AC 文案层面的“closure 提示语”润色、以及 IDE 侧展示。

## 12. 实施前验收草案

1. 一个 child 改动 parent dependency 时，parent design 自动进入 `needs_reassessment`；
2. child 接走 finding 后，parent archive 被拒直到 successor revalidation 与 impact packet 被消费；
3. 关系图拒绝环和错误标为 `independent` 的 surface overlap；
4. `RetirementProposal` 不能在有 blocker 时确认，确认后历史仍可读但 active projection 不再展示该对象；
5. Initiative closure 反向找出未消费 packet、stale design 与仍相关的未完成 child；
6. 旧 task 首次进入图时不会默认 fresh；
7. 同一次无关 revision 不触发无关 initiative 的 rebase。
