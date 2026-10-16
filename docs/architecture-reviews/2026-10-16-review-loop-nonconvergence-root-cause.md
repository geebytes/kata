# 当前独立审查流程为何无法收敛

**日期：** 2026-10-16  
**对象：** `the-gates-can-be-repaired` 及其 8 轮审查链  
**性质：** 流程级根因分析；不构成第 9 轮审查，也不修改当前实现

**归属说明：** 本报告不在该 change 的 11 条 `ownedPaths` 内，当前保持为未跟踪文档，不静默并入该 change。继续 seal/review 前必须由 owner 选择“单独提交”或“显式纳入新的流程 change”；否则它会成为声明面外的工作区差异。

## 1. 结论

当前循环不是“审查太严格”，也不是“代码总差最后一点”。它是一个**安全性较强、活性失效**的控制系统：

- 安全性方面，当前机制会把 major/blocking finding 留在门内，绑定 revision，要求独立 reviewer，并重跑证据；
- 活性方面，它没有一个跨 repair revision 递减且最终归零的度量，也没有真正终止自动循环的状态；
- 每次局部修复都会扩大代码、测试和 falsifier 的审查面，下一位 cold reviewer 又对扩大后的整体重新做开放式证伪；
- 原本的“无进展终态”只统计**同一 revision**，而 repair 必然产生新 revision，所以计数每轮归零；
- 后加的 recurrence packet 能跨 revision 识别复发，却只是把下一轮改名为 root-cause review，结论为行为、仪器或路由缺陷时又被强制映射回 `repair`；它是**分类器/模式切换器，不是 circuit breaker**。

因此，只要新 reviewer 还能在修复中找到同类相邻实例，流程就会机械地执行：

```text
宽泛性质 + 分散状态机
  → 局部修复 + 局部 falsifier
  → 新 revision + 更大的审查面
  → 同 revision 的停线计数归零
  → recurrence 分析给出 nextAction=repair
  → 对扩大后的整体再做一次 cold 全审查
  → 找到修复里的同类相邻实例
  → 重复
```

这条循环没有 ranking function（良基递减元）。finding 数量、blocking 数量、代码面和仪器面都不保证单调下降，所以“再跑一轮直到没有 finding”不是一个可证明终止的工程过程。

**即时建议：不要启动第 9 轮普通全审查。** 当前 change 应转为一次有边界的 focused follow-up；若同一 defect class 再次出现在该 repair batch 内，则进入真正的人工 escalation，由 owner 在“架构重写 / 风险接受 / 放弃或回退 change”中决策，不能再自动返回普通 repair。

## 2. 证据范围与数据质量

本分析只使用以下可复核材料：

1. `.kata/tasks/the-gates-can-be-repaired/review-rounds.jsonl`
2. `.kata/tasks/the-gates-can-be-repaired/review-history.jsonl`
3. `.kata/tasks/the-gates-can-be-repaired/review.json`
4. `.kata/tasks/the-gates-can-be-repaired/repair.json`
5. 当前 task、设计稿、review skill、recurrence/repair/navigation 源码及测试
6. 当前 working tree 的 `git diff --stat`
7. `tmp/g-review-result7.json`（仍存在，但不属于 recurrence packet 声明的权威记录）
8. 本会话中 round 8 result 两次被 CLI schema 校验拒收的原始运行结果

### 2.1 八轮实测

| 轮次 | findings | strict 下 merge-blocking | 主要复发类 |
|---|---:|---:|---|
| 1 | 10 | 5 | refusal / instrument / contract |
| 2 | 8 | 2 | refusal / instrument |
| 3 | 9 | 3 | refusal / instrument |
| 4 | 8 | 1 | refusal / instrument |
| 5 | 6 | 2 | refusal / instrument / one-fact |
| 6 | 4 | 1 | refusal / instrument |
| 7 | **未测量** | `null` | durable row 写的是 `noFindings` |
| 8 | 8 | 2 | refusal / instrument / one-fact |

汇总：

- 2026-10-12 19:13:44Z 至 2026-10-15 17:57:14Z，约 **70 小时 44 分**；
- 8 条 round 记录，7 条有 finding；
- **53 个 finding**：1 blocking、15 major、16 minor、21 note；
- 51 个带 class 的 finding 中，**50 个（98.0%）同时标为 `origin: repair`**；全部 53 个 finding 中有 51 个标为 repair origin；
- `instrument-unsound` 18 次，`refusal-cannot-be-executed` 13 次，`contract-semantics` 12 次，`one-fact-derived-twice` 7 次；
- 7 条非空 round 中，`instrument-unsound` 与 `refusal-cannot-be-executed` **每轮都出现**；
- strict 阻塞数序列为 `5 → 2 → 3 → 1 → 2 → 1 → null → 2`，不存在单调下降。

当前 review 自己也记录：前 6 个持久化历史轮次中，44 个带 origin 的 finding 有 43 个来自 repair；round 7 findings 的唯一记录是 `tmp/g-review-result7.json`，不在 recurrence packet 声明的三份权威记录内（`.kata/tasks/the-gates-can-be-repaired/review.json:221-227`）。

### 2.2 round 7 是审计链断点

`review-rounds.jsonl:7` 持久化为：

```json
{"blockingIds":[],"blockingCount":null,"noFindings":"the repair was admitted for a superseded revision or ledger deficits, and the record holds no findings"}
```

但 round 8 的 `recurrenceAnalysis` 又称 `tmp/g-review-result7.json` 是 round 7 finding 的“only record”（`review.json:223-224`）。这意味着：

- 先前会话中“round 7 的五条 finding 已记录”的说法不成立；持久化事实是它们**没有进入权威 round/history 链**；
- recurrence、进展计数和后续审查都在一个缺轮的历史上工作；
- 临时文件替代 append-only 记录，使恢复、审计和统计依赖会话现场。

这不是本轮代码缺陷的旁枝，而是当前审查流程本身的可追溯性缺陷。

### 2.3 审查面持续增长

设计稿记录：第一版有 7 个 falsifier，当前为 **26 个 executable instruments**（`docs/design/2026-10-13-the-gates-can-be-repaired.md:154-158`）。当前 7 个 tracked 文件的未提交 diff 为：

```text
824 insertions(+), 165 deletions(-)
```

其中两个主要测试文件新增 549 行。局部修复不只减少缺陷，也持续增加要被下轮审查的生产代码、fixture、命令 harness、源码 mutation 和文档断言。这解释了为何 26/26 falsifier 全红以后，reviewer 仍然能从 falsifier 自身或邻接调用点找到新缺陷：**仪器通过只证明所选 mutation 被检测，不证明性质空间已闭合。**

任务设计只持久化了一次 reviewer 成本样本：约 29 分钟 / 721k tokens；round artifact 不保存 tokens、tool calls 和 elapsed time，所以无法从 durable record 计算总成本或按边际收益触发停线。成本不可测本身使流程无法实施经济型 exit policy。

## 3. 方法论基线

### 3.1 软件工程：correction 不等于 corrective action

重复缺陷的工程闭环应区分：

1. **Correction**：修掉当前实例；
2. **Root-cause analysis**：解释为何一类实例能反复产生；
3. **Corrective action**：修改产生该类缺陷的机制；
4. **Effectiveness verification**：用后续数据证明该类不再复发。

NASA Software Engineering Handbook 的公开指导要求在度量越过阈值时检查潜在根因并选择“prevent further problems”的 corrective action；recurring issue rate 用于判断 action 是真正解决还是只临时缓解。当前流程主要完成第 1 步和局部 mutation 验证，没有把第 3、4 步变成 gate 可以执行的验收契约。

### 3.2 审查方法：follow-up 与 reinspection 是两种活动

ISO/IEC 20246 提供 work-product review 框架；NASA 历史 Formal Inspection Standard（NASA-STD-8739.9，现已取消，但其 inspection 方法仍有参考价值）明确区分：

- **Follow-up**：核对本轮已记录的 defect 是否已修复、修复是否引入回归；
- **Reinspection**：达到预定义条件时，对全部或部分工作产品重新检查，并产生独立记录；
- **Exit criteria**：重大 defect 的处置与验证完成，而不是证明“再也找不到缺陷”。

当前 Kata 的每次 repair 后都购买一次新的 cold 全审查，实际上把 follow-up 永久实现成 reinspection。新 reviewer 并不只验证 RepairBatch，而是再次挑战整个声明和扩大后的实现，因此每轮都可以合法产生一个新 RepairBatch。

### 3.3 Mutation testing：测试敏感度，不是正确性证明

Mutation testing 能说明测试对**选定 mutation operator / 选定 mutation**敏感。它不能证明：

- 规格本身正确且完整；
- 未选择的 fault class 不存在；
- 测试 oracle 没有与实现共享同一错误假设；
- 等价 mutant 或不相关 mutant 可被合理 kill。

本 change 的多轮 finding 正好体现这些限制：source scan 与被审表同源、fixture 未覆盖新的等价类、dist 指向旧 bundle、mutation 以异常或 0 命中“变红”。把 26/26 supported 当作当前 revision 的必要证据是合理的；把它当作下一轮找不到缺陷的充分证据是不合理的。

## 4. 根因树

### RC-1：审查关闭条件被错误定义为“下一位 reviewer 找不到新问题”

项目已有设计其实写对了：

- review 不能声称“已经发现所有缺陷”（`skill-first-independent-review-protocol.md:17-22`）；
- 审查关闭的是有限 merge decision，不是“已证明无缺陷”（`:32-36`）；
- responsibility surface 应有限，不能靠“继续看看”扩大（`:30-36`）。

当前运行却以一次次全量 cold review 作为关闭判据。由于语义状态空间没有枚举边界，“no findings”只是某次抽样结果，不是稳定谓词。新 reviewer、不同搜索顺序或新增 repair code 都可以令它翻转。

**判定：这是首要方法错误。** 不是 reviewer 发现了太多，而是流程把“继续找还能否找到”当成了 exit criterion。

### RC-2：full reinspection 取代了 focused follow-up

同一份目标设计已经规定：一个 revision 的 blocking/major finding 形成一个 RepairBatch；repair revision 应做 focused delta review，只核对 finding 关闭证据、changed paths、dependency cone 和新增/变化 impact edge（`skill-first-independent-review-protocol.md:233-251`）。

实际 skill 只定义“dispatch exactly one subagent with ReviewRequest”，并要求 repair 后再次独立 certification（`.agents/skills/kata-review/SKILL.md:124-127,187-195`），没有 `reviewKind=focused_followup`、RepairBatch scope 或“不得重新打开未变化区域”的执行字段。因此每次所谓复审都是新一轮探索式 inspection。

**后果：** 修复一个 finding 不是缩小未决集合，而是重新抽样整个 enlarged surface。

### RC-3：两个“停线器”互相错位，合成后没有任何停线

#### 3.1 revision 内 stop line 被 repair 自动清零

`bounded-review-convergence` 原设计规定：连续 3 轮 blocking 不下降后不再返回 `/kata-build`，而进入自动 review 的终点（`bounded-review-convergence.md:88-96`）。

之后 `review-escalation-revision-binding` 又正确地解决了另一问题：旧 revision 的历史不能阻塞新 revision，因此只用**当前 sealed revision** 的 rounds 计算 escalation（`review-escalation-revision-binding.md:5-20`）。

两个局部正确规则组合后出现活性漏洞：repair 一定 seal 出新 revision，而每个新 revision 通常只有一条 review round，永远积不出 3 条同 revision 无进展记录。当前八轮几乎每轮 revision 都不同，正好实证这个重置。

#### 3.2 cross-revision recurrence 只报告，不拒绝

后来增加的 class recurrence 能跨 revision 看见复发，但源码明确写：

> `stopLineCandidate` is a report; neither this function nor its caller refuses a round

（`src/quality/repair.ts:338-365`）

`recurrencePacket` 的校验又把 `behaviour_defect`、`instrument_unsound`、`workflow_routing_error` **强制映射到 `nextAction: repair`**（`src/quality/recurrence-packet.ts:70-86`）。其决策文档也明确“a later repair still requires normal independent certification”（`review-recurrence-circuit-breaker.md:39-43`）。

所以当前所谓 circuit breaker 的真实行为是：

```text
ordinary review → root-cause-labelled review → repair → ordinary independent review
```

它没有 break，只改变了一轮的 prompt。

#### 3.3 “升级终态”仍指向 reviewer

当前 routing 对 `stalled_current_rounds` 返回：

```text
nextSkill: /kata-review
reason: escalate_review_without_progress
```

（`src/workflow/navigation.ts:681-687`）

测试也将该行为钉死为 `/kata-review`（`tests/unit/a-recurrence-report-does-not-override-the-ladder.test.ts:496-500`）。这与原设计“人工 escalation 是自动 review 的终点”相反。名称叫 escalation，动作仍是 reviewer；它不是 terminal state。

**判定：这是流程不终止的直接控制缺陷。**

### RC-4：RCA 只有标签，没有 class-level corrective-action contract

recurrence result 目前只强制：

- trigger classes 相同；
- conclusion 属于五值词表；
- evidence 非空；
- nextAction 合法。

它不强制输出或验证：

- defect class 的有限状态模型；
- 全部生产者、消费者、写入者、读取者清单；
- 必须删除的重复派生；
- repair 后应满足的 class invariant；
- effectiveness check；
- 再次复发时的 terminal disposition。

因此“class-level repair”只是 reviewer prose。后续 Build 可以继续修一个调用点，并用一个新 mutation 证明该调用点已红；机制不会拒绝这种局部 correction。round 6～8 的“相邻位置”正是该缺口：boundary 分支修后 task-level 分支还旧，writer A 修后 writer B 还旧，reader 修后 reset 路径还旧。

### RC-5：被审对象是分散状态机，但验证方法仍是逐点 example/mutation

`user-choice-gate` 的行为至少跨越这些轴：

- record 层级：boundary / task-level；
- path 形状：absent / regular / symlink / directory / FIFO / socket / hardlink；
- 可读性：usable / unreadable；
- 内容绑定：current / stale / unbound；
- 生命周期：unanswered / answered / consumed；
- 所处 phase 与 boundary；
- 动作：read / approve / reset / create / reuse。

这些轴形成状态乘积。当前代码将它分散在多个 writer、reader、reset、reuse 与 CLI 拒绝分支中；测试则按 reviewer 新发现的 cell 逐个补 example。每补一个 cell，下一轮就能检查邻接 cell。这不是偶然遗漏，而是**模型缺席时的必然枚举漂移**。

正确的类级修法应先建立一个显式 transition table / algebraic state model，再让所有命令消费同一个决定；property-based 或表驱动测试覆盖状态分区。继续加手写分支和 source mutation，只会移动遗漏的位置。

### RC-6：规格与审查目标在 repair 中移动

原始 task 只有四条 acceptance（`.kata/tasks/the-gates-can-be-repaired/task.json:9-25`），主题是：

1. choice 词表；
2. unreadable ≠ absent；
3. remedy 在打印它的 phase 可执行；
4. repaired finding 的关闭语义。

多轮 repair 后，变更又承担了：stale gate reset、missing gate approve、unsealed content identity、task-choice reuse、所有特殊文件形状、多个 writer 的绑定一致性等语义。部分是原 AC 的合理 dependency cone，部分已经是新能力或新政策（例如“缺失记录可直接 approve”）。

每次 restate claim / 修改设计 / 新增语义都会使先前 seal 和证据失效，也使下一位 reviewer 面对一个新的目标。流程允许在同一 repair cycle 同时改 implementation、test oracle 和 contract，因而没有稳定 baseline。

### RC-7：所有等级都被修，非阻塞项也扩大下一轮输入

目标方法明确：minor 默认不触发 repair revision，nit 不阻塞（`skill-first-independent-review-protocol.md:219-225`）。本 change 的每轮实践却把 major、minor、note 全部同批修完。这样做在局部上追求完整，但会：

- 增加 diff 与 dependency cone；
- 增加新 falsifier、fixture 和注释；
- 给下一轮制造更多可审对象；
- 让“阻塞项下降”与“总变更面增长”同时发生。

这不是要求忽略已知问题，而是要求分 disposition：blocking/major 进入当前 RepairBatch；minor/note 记录为 follow-up，除非它们是 major 修复的必要组成。

### RC-8：review-result 生产协议和审计记录不够坚固

本轮链还出现两类流程故障：

1. round 8 result 因非法 recurrence enum 和错误 `reproduction` 形状被 CLI 整份拒收，需要人工规范化后重交；说明 reviewer 没有 schema-driven output / preflight；
2. round 7 finding 只留在 `tmp/`，权威 round 行写成 `noFindings`，说明“review result → durable history”的提交不是原子且不完整。

这些故障会让 recurrence 统计、repair batch 和后续 reviewer 输入失真。一个“根因分析”若建立在缺轮历史上，结论本身就不是可靠的 effectiveness evidence。

## 5. 哪些机制是对的，为什么仍然组合失败

| 机制 | 局部评价 | 组合后的问题 |
|---|---|---|
| cold independent reviewer | 正确；减少作者盲点 | 每次都做 full reinspection，探索面不封闭 |
| revision-bound evidence | 正确；旧证据不能证明新内容 | 同 revision stop counter 被每次 repair 清零 |
| strict 模式阻塞 major | 正确；不静默放过重大缺陷 | 没有 bounded disposition 时，任何新 major 都重启全环 |
| executable falsifier | 正确；证明 selector 对指定 mutation 有敏感度 | mutation/operator/anchor 自身进入审查面，不能证明规格完备 |
| recurrence packet | 正确识别跨 revision class recurrence | 只分类，行为/仪器/路由结论强制回到 repair |
| review gate 人工确认 | 正确保留人的授权 | 只确认模型路由，不要求选择 closure / reinspection / escalation |

所以问题不是删除这些安全机制，而是补上它们没有负责的 **liveness / convergence contract**。

## 6. 推荐的当前 change 收口方法

### 6.1 立即停止第 9 轮普通全审查

当前已满足“同类 corrective action 多次复发”的升级条件。继续普通 round 的预期收益不可界定，成本也没有上界。

### 6.2 建立一次性的 Closure Charter

由 owner 固定以下内容：

1. **冻结 acceptance/claim 文本**；本 RepairBatch 内不再改 contract；
2. 把 round 8 的 F1～F8 逐条 disposition；
3. 将所有 blocking/major 映射到一个有限 invariant 表；
4. 指定 changed paths、direct consumers、state partitions 和必须重放的 evidence；
5. minor/note 只在它们是 major closure 的必要条件时纳入；否则记录 follow-up；
6. 明确 residual risks 与未覆盖状态，不把它们写成 PASS。

### 6.3 只允许一次 focused follow-up

reviewer 的职责限定为：

- 重放 round 8 的 F1～F8；
- 检查本 RepairBatch 的 changed paths 与直接 dependency cone；
- 判断 class invariant 是否被一个共同机制满足；
- 不重新搜索未变化模块或扩张新的等价类；
- 若发现**当前 revision 上可复现、落在冻结 AC 内、且为 blocking/major**的新问题，记录它；其它新主题移交独立 change。

这不是弱化 review，而是把 follow-up 与 reinspection 分开，恢复已有设计的有限责任面。

### 6.4 一次 focused follow-up 后的终态

- 全部 blocking/major `repaired_and_reverified` / `rejected_with_evidence` / owner-waived → 进入 Judge；
- 同一 mechanizable class 再出现于 RepairBatch → `escalation_required`，**不得再返回 `/kata-build` 或 `/kata-review`**；
- escalation 只有三个出口：
  1. 放弃局部修补，开显式状态机/协议重写 change；
  2. 具名 owner 接受残余风险并记录期限；
  3. 回退或放弃本 change。

## 7. 长期机制修复

建议另开一个流程 change，不塞进当前 gates change：

### P1. 用 repair lineage 而不是 revision 作为收敛单位

新增 `repairLineageId` / `batchId`。revision 继续约束证据新鲜度；lineage 跨 revision 统计同一修复链。两者回答不同问题：

- revision：这份证据证明哪一版内容；
- lineage：同一 corrective action 是否真的减少了问题。

### P2. 三种 review kind 必须进入协议

```text
certification      # 首次有限审查
focused_followup   # 验证 RepairBatch 与 dependency cone
root_cause         # 形成 corrective-action contract，不做普通 certification
```

每种 kind 有不同 scope、输入、输出和 exit criteria；不能只靠 prompt 中一句“这不是普通轮次”。

### P3. recurrence 必须产生可执行 closure obligation

将自由文本 `recurrenceAnalysis` 升级为至少包含：

- state model / equivalence partitions；
- source-of-truth symbol；
- producer/consumer inventory；
- invariant；
- repair surface；
- effectiveness test；
- repeated-again terminal action。

若下一次 repair 没有满足该 obligation，Build 应拒绝 seal，而不是再让 reviewer 发现它仍是局部修复。

### P4. 真正的 terminal state

`escalate_review_without_progress` 不能再返回 `/kata-review`。它应返回无自动 nextSkill 的 trust boundary，由 owner 选择 rewrite / waive / abandon。现有 `bounded-review-convergence` 的 D4 与 `skill-first-independent-review-protocol` §8.6 已经给出设计依据，只需消除后来 revision-binding 与 recurrence-report 组合出的旁路。

### P5. review result 在 dispatch 前 schema 驱动

- 由 schema 生成 result skeleton；
- subagent 提交前执行本地 validate；
- validator 一次返回全部字段错误，而不是只报第一条；
- durable append 与 `review.json` 写入原子化；
- 禁止以 `tmp/` 作为某一 round finding 的唯一记录。

### P6. 记录收敛与成本指标

每轮持久化：elapsed、tokens、tool calls、review kind、reviewed lines/paths、new blocker count、closed blocker count、new class count、repair-origin count。至少计算：

```text
closure_rate = closed_blockers / prior_blockers
recurrence_rate = repair_origin_findings / classified_findings
surface_growth = changed_LOC + new_instruments
marginal_yield = new_blockers / reviewer_cost
```

当前 98.0% 的 classified repair-origin rate 已足以触发 process escalation，但现有 router 不消费这个信号。

## 8. 决策建议

> **2026-10-16 更新：本节的三条路线没有被采纳。** 维护者指示**直接实施机制层修复、不走 kata 流程**，落地的内容见 §8bis：修的是根因树里的 RC-2/RC-3/RC-4（链级停线、终局升级、closure obligation、reviewKind），而不是为当前 change 打一个 bounded closure。下面保留原建议作为当时的判断记录：A 的"先收口当前 change"仍未做，`the-gates-can-be-repaired` 依旧停在 `review_gate`，第 9 轮仍未派发。

### A — 推荐：bounded closure

- 不跑第 9 轮普通全审查；
- 为当前 revision 建 Closure Charter；
- 只做一次 focused follow-up；
- 同类复发即 terminal escalation；
- 当前 change 收口后，再独立修 review-lineage / terminal-state 机制。

**代价：** 需要一次方法转换和一次 focused reviewer；保留当前实现投资。  
**风险：** 不再用“无限新 reviewer”追求不存在的完美；残余风险必须显式记录。  
**长期维护：** 最低，符合项目已有 design，而不是新增平行流程。

### B — 架构重写后再审

- 暂停当前 change；
- 将 user-choice gate 重写为显式状态机/transition table；
- 再以新 change 重新 certification。

**代价：** 高；当前 8 轮 repair 大量失去直接价值。  
**风险：** 新实现仍需审查，但状态空间首次可以有限枚举。  
**适用：** focused follow-up 再次发现同类 adjacent-site defect 时。

### C — 继续当前 full-review loop

**不推荐。** 观测基线已经是 8 轮、70.7 小时、53 findings、+824/-165 行，且 blocking count 不单调。当前机制没有终止证明，也没有成本上限；再跑一轮只能得到另一次抽样，不能回答“何时结束”。

## 8bis. 实施结果（2026-10-16，直接落地）

用户指示直接实施、不走 kata 流程。P1–P4 里能在不引入新字段的前提下做的三条已实现；P5 的 schema 驱动做了一半；P6（成本度量）未做。

| 根因 | 落地机制 | 仪器（能红） |
|---|---|---|
| **RC-3.1** revision 级停线被返修清零 | `src/quality/repair-lineage.ts`：修复链由 change record 的 `revisionId`/`baseRevisionId` **派生**（无新字段可漏写），进度用同一个 `reviewProgress` 在链上算；`status.reviewLineage` 发布；链不可读 ⇒ `lineageUnreadable`，单 revision 链不发布 | `tests/unit/a-repair-chain-is-the-unit-of-convergence.test.ts`；变异「忽略 `baseRevisionId`」→ **5 条红**，恢复后字节一致 |
| **RC-3.3** 升级指向审查者 | `stalled_current_rounds` 与链级停线都返回 `/kata`（只读 status），`NextAction.escalationExits` 枚举 `rewrite_mechanism`/`waive_with_owner`/`abandon_change`；词表与 `closureObligation.ifRecursAgain` 同源（`ESCALATION_EXITS`） | `review-loop-routing-contract.test.ts`（钉住 `/kata` + 三出口 + 不含 repair）；`a-recurrence-report-does-not-override-the-ladder.test.ts` 同步 |
| **RC-4** RCA 只有标签没有契约 | `validateRecurrenceAnalysis` 要求 `nextAction: repair` 必须带 `closureObligation`（7 个字段），非 repair 带它也被拒 | `a-recurrence-packet-requires-analysis.test.ts` +3 条 |
| **RC-2** full reinspection 取代 focused follow-up | `ReviewRequest.reviewKind` 派生（`certification`/`focused_followup`/`root_cause`），结果必须回声，不同即拒并打印两名；轮次行写 `kind`，`loopReplay.roundsByKind` 计数（无 kind 记 `undeclared`） | `review-cli-io.test.ts` 两条 CLI 用例；链测试两条；变异「无 kind 算 certification」→ 1 条红 |
| **RC-8** 生产协议不坚固 | `violationsOf()` 一次列出**每条** finding 的**每个** schema 违规（原来只报第一条，实测两轮各丢一整轮 8 条 finding）；recurrence 校验器同样一次列全 | `review-cli-io.test.ts`「names every contract violation at once」（`$[0].taskId is required` + `$[1].invented is not allowed` + `2 problem(s)`） |
| **RC-6** 规格在返修中移动 | 协议文本（`phase-guidance.ts` → `kata-review`/`kata-verify` skill、`manifest.ts` → reviewer agent）已同步，生成物 `kata-cli update --platform pi` 重渲染 | `generated-assets-are-current` / `agent-definitions-carry-no-protocol` 两条既有守卫 |

| **RC-4 的第二半**：`ifRecursAgain` 写进记录却无人读 | 新增 `src/quality/repair-declarations.ts`：从 change 自己的 review 记录（`review-history.jsonl` 归档轮 + 活动 `review.json`）读出**已声明过返修**的缺陷类；某类的**最新**结论是返修类（`behaviour_defect`/`instrument_unsound`/`workflow_routing_error`）且它在本 revision 上仍是停线候选 ⇒ `reviewExitDue` 发布，路由 `escalate_declared_repair_did_not_hold`（`/kata`，与停线同级、优先于「再修这个类」的 `review_class_recurring`）。`not_same_class` **清除**该类而不是花掉它；`claim_scope_error` 从不承诺返修，因此不算已花。历史不可读是 `declarationsUnreadable`，不与「从未声明」同形 | `tests/unit/a-declared-repair-that-did-not-hold-is-terminal.test.ts`（7 条）。变异实测：去掉「仍在复发」合取 → 红；把不可读历史折进「无声明」→ 红；两者恢复后字节一致 |

**没有做**：P5 的「schema 生成 result skeleton / 提交前本地 validate」（现在只是把**报错**从第一条改为全部）；P6 的每轮成本与边际收益（记为新缺陷 I-44）；`review-history` 那一轮的补录（第 7 轮仍只在 `tmp/g-review-result7.json`，属 I-22 的另一个面）；**minor/note 仍全部返修**（`skill-first-independent-review-protocol.md` §219–225 已规定 minor 默认不触发返修轮，未实现，仍是下一轮 diff 增长的原因）。

**在真实 change 上实测（`the-gates-can-be-repaired`，只读 `status`）**：新读数已经活在这一条上——`reviewLineage` = 6 个 revision / 4 轮 / `noProgressRounds: 1` / `stalled: false`；`reviewExitDue` = `instrument-unsound`、`refusal-cannot-be-executed`（两项的已声明结论都是 `behaviour_defect`，来自加 closure obligation **之前**的轮次，所以没有 `declaredExit`）；`roundsByKind` = `{certification: 0, focused_followup: 0, root_cause: 0, undeclared: 8}`（八轮全部早于该字段）。

**这次实测同时纠正了我自己的一个说法**：我先前预期「链级停线会立刻让这个 change 停线」——**不对**。链上 4 轮的阻塞数确实到过新低，所以按"N 轮无进展"的判据它**不** stalled；真正指认这条循环的是**类复发**（`repairOriginShare: 0.9804` + 三个 `stopLineCandidate` 类），而它的处置现在是 `reviewExitDue` 的终局路由。也就是说：停线有两条判据，只有一条在这条 change 上成立，我先前把两者混为一谈。记录在此以免下一轮把"不该停"读成"漏停"。

**记录的 phase 是 `hardVerify`**，所以 `status` 现在仍答 `/kata-review`（先进入 review 是合法且已推荐的下一步）；进入 review 后同一状态才会给出终局路由。我没有为了看到那条路由而推进任务状态——那要动 change 的相位，属于需要授权的动作。

**过程中的两次自我修正**（记录以免重犯）：① 新模块里的局部变量名 `cursor` 命中本仓「平台名按文件计量」的守卫（`platform-coupling-is-measured`），修法是**改名**而不是加允许项；② 往 `manifest.ts` 的单引号字符串里插入文本时误用真实换行，把字符串截断成语法错误，靠 `npm run typecheck` 暴露，改为 `\n` 转义后并由重渲染守卫确认。

**验证结果**：`npx vitest run` = **362 文件 / 2206 用例全绿**；`npm run typecheck` 干净；`npm run check:wiring` 只剩 11 条既有 finding（无一指向本轮新符号）；两个变异各自红在该性质上并字节还原。

## 8bis-2. 第二批：审查发现的 8 条与修法（2026-10-16 同日）

对 8bis 那批实现做了一次独立审查（`2026-10-16-review-loop-optimization-code-alignment.md`），8 条全部修复；逐条机制、仪器与变异实测记在缺陷队列 §4bis。与本文件的根因树对应的三处**实质**修正：

- **RC-3.3 的修正**：`escalate_declared_repair_did_not_hold` 当时没有进 `requiresUserConfirmation` —— "最需要人来决策的那条路由"在机器字段上允许自动继续。现在确认位、出口清单与提示文案由**一处集合**（`ESCALATION_REASONS`）派生。
- **RC-4 的修正（两半）**：`ifRecursAgain` 原来写进记录却无人读；现在它是一条规则，而且**有序**——只有在结论记录**之后**、在链上**更晚的 revision** 上再次出现该类，才判"已声明返修没有成立"。修复中又发现被拒的 seal 会先铸 revision，所以"义务范围"从"本次要取代的 revision"改为"本 task 自己的声明"，"是否碰过表面"改为相对**结论所针对的 revision** 比较 —— 否则第二次尝试就能绕过义务（这条是被仪器先逼出来的，不是推理出来的）。
- **RC-2 的修正**：`focused_followup` 从"一个词"变成"一份带范围的委托"——brief 带前序 finding 清单、链 scope 与 `unmodifiedPaths`；结果必须**逐条**回答 `closed`/`open`。`certification` / `root_cause` 也各自有了出口（clean follow-up 关闭 batch；已答类不再提问；本 batch revision 已有结论则不再问）。

剩下的边界仍然是 8bis 列出的三条：每轮成本不可测（I-44）、第 7 轮 finding 只在 `tmp/`、minor/note 仍全部返修。

## 9. 业界采纳与讨论现状

### 9.1 总判断

**组成部分大多已被采用；这套端到端组合不是现成行业标准。** 更准确地说，方案把四条成熟脉络组合到一个可执行协议里：

1. 现代 lightweight code review 的“小 change、快速迭代、非完美主义”；
2. formal inspection 的 rework / follow-up / reinspection / exit criteria；
3. 缺陷治理的 root cause / corrective action / effectiveness check；
4. 项目治理的 action-item closure、风险接受与人工 escalation。

`repairLineageId`、三种 `reviewKind`、以及“同类再次复发即 terminal escalation”是针对 Kata 当前故障的**本地协议化设计**；未发现某个通用标准以完全相同的数据结构和状态机规定它们。

### 9.2 逐项采纳度

| 新方案组成 | 业界状态 | 证据与边界 |
|---|---|---|
| **bounded merge decision，而非追求完美** | **广泛采用** | Google 的 reviewer 标准明确要求：当 CL 明确改善整体 code health 时应倾向批准，即使并不完美；不重要的 polish 用 `Nit:`，不能无限阻塞进展。 |
| **小而自包含的 change** | **广泛采用** | Google 明确指出 small CL 更快、更彻底地被审查，更少引入 bug；Google 的 900 万次 review 研究也把现代审查描述为 lightweight、快速迭代、小 change。 |
| **patch/revision lineage** | **工具层广泛采用** | Gerrit 以稳定 `Change-Id` 把多次修改绑定为同一 change 的 patch sets，只提交最新 patch set；GitHub PR 也在同一 branch/PR 中追踪修订、conversation 与重新请求 review。 |
| **focused delta review** | **工具与实践支持，效果边界仍有讨论** | Gerrit 原生支持“latest patch set vs previous patch set”；研究也直接分析 patch-set 之间的 review changes。但没有充分证据证明“只看 delta”与全量 reinspection 等效，因此本方案保留 changed paths 的 dependency cone、未决 finding 和变化的 impact edge，而不是盲目 delta-only。 |
| **major 必修、minor/nit 可处置而不阻塞** | **广泛采用** | Google 要求显式区分 required / Nit / Optional / FYI；NASA inspection rework 要求 major defect 必须移除，minor/trivial 由作者按成本和时间裁量。 |
| **follow-up 与 reinspection 分开** | **正式 inspection 的成熟做法** | NASA handbook 把 follow-up 定义为验证 major defect 已修、修复未引入新 defect、open issue 已 disposition；是否 reinspection 由项目预先定义的 criteria 决定。ISO/IEC 20246 提供 work-product review 的通用框架。 |
| **明确 completion / exit criteria** | **高保证项目的标准治理** | NASA SWE-088 要求 readiness/completion criteria、action item 跟踪到完成、项目定义是否 reinspection，并记录 metrics；生命周期 gate 要求前序 finding 按约定处置。 |
| **root cause → corrective action → effectiveness** | **成熟的过程改进方法** | NASA measurement guidance 和 CMMI 的 Causal Analysis and Resolution 都把 root cause、实施 action、评价效果分开；这正对应“不能只修当前实例”。 |
| **重复轮次进入 escalation** | **原则成熟，阈值项目化** | formal inspection 要求项目自己定义 reinspection 与 exit criteria；反复 PR 修订已有实证研究，通常为 1～5 轮，且不可避免的长尾与修复引入的新 defect 已被讨论。但没有通用标准规定“第 3 轮”或“第 2 次同类复发”必须停止，阈值必须由风险与成本数据校准。 |
| **`repairLineageId` 作为收敛单位** | **概念有先例，判定用途是本项目创新** | Gerrit `Change-Id` / patch sets 已证明“多 revision 属于同一 change lineage”是常规做法；用 lineage 而不是 revision 计算复发与 stop line，是对现有身份机制的合理扩展，但不是 Gerrit/GitHub 自带的质量判定。 |
| **`certification / focused_followup / root_cause` 三种 review kind** | **活动类型成熟，显式协议字段是本项目实现** | inspection 方法本来就区分 initial inspection、follow-up、reinspection 与 causal analysis；把它们编码进 ReviewRequest/Result，防止只靠 prompt，是 Kata 特有的工程化。 |
| **显式状态机 + property/model-based test** | **技术方法成熟，普通 PR 中非默认** | 对协议、工作流和安全关键状态转换使用 model-based/property-based testing 很成熟；但要求所有普通 code review 都这样做并不经济，只适合当前这种多轴状态乘积和重复 adjacent-site defect。 |

### 9.3 反复 review 本身已有专门研究

Li 等人的 2022 实证研究 *Opportunities and Challenges in Repeated Revisions to Pull-Requests* 专门研究重复 PR 修订：受访者通常经历 1～5 轮；可避免的重复来自不清楚的反馈、review policy、提交前问题，以及**修复上一轮反馈时引入的新问题**。这与本 change 的 `origin: repair` 比率高度同构。

另一类 patch-set 研究指出，review 期间发生的变化并不都直接由 reviewer comment 触发，而且初始 patch 大小、增加的 LOC 与 review changes 数量有关。这支持两个结论：

- 小 change 和 RepairBatch 有现实收益；
- focused follow-up 不能退化为“只看几行 diff”，还必须覆盖受影响语义和 dependency cone。

### 9.4 本项目不是没有讨论，而是“设计过、部分实现、组合失效”

项目在 2026-09-28 的 `skill-first-independent-review-protocol.md` 已经写出：有限责任面、bounded merge decision、RepairBatch、focused delta review、finding disposition 和 `escalation_required` 终态。`bounded-review-convergence.md` 又写出 N=3 无进展升级。

随后实际机制只采纳了部分：

- 已采纳：cold independent reviewer、revision-bound evidence、strict severity ladder、executable falsifier、跨 revision recurrence report；
- 未采纳：RepairBatch-bound follow-up、显式 review kind、repair lineage 的 stop line、真正无自动 nextSkill 的 escalation terminal；
- 后续 revision binding 还让原有同 revision N=3 计数在每次 repair 后归零；recurrence packet 虽看见跨 revision 复发，却又固定返回 `repair`。

所以当前建议不是凭空引入一套新方法，而是：**恢复项目已接受的 finite-review 设计，并补上实现时遗漏的 lineage 与 terminal semantics。** 真正的新内容主要是把这些语义做成可验证协议字段和跨 revision 收敛度量。

## 10. 外部参考

- ISO/IEC 20246:2017, *Software and systems engineering — Work product reviews*（2022 reconfirmed）：<https://www.iso.org/standard/67407.html>
- NASA-STD-8739.9, *Software Formal Inspections Standard*（历史方法参考；该标准已于 2023 取消）：<https://standards.nasa.gov/sites/default/files/standards/NASA/Baseline/1/nasa-std-87399_with_change_1.pdf>
- NASA Software Engineering Handbook, SWE-093 / SWE-204（root cause、corrective action 与 effectiveness）：<https://swehb.nasa.gov/spaces/SWEHBVC/pages/50888952/SWE-093%2B-%2BAnalysis%2Bof%2BMeasurement%2BData>
- DeMillo, Lipton, Sayward, “Hints on Test Data Selection: Help for the Practicing Programmer” / mutation testing foundations：<https://doi.org/10.1109/C-M.1978.218136>
- Budd、DeMillo、Lipton、Sayward mutation/correctness 研究入口：<https://doi.org/10.1145/567446.567468>
- Google Engineering Practices, *The Standard of Code Review*：<https://google.github.io/eng-practices/review/reviewer/standard.html>
- Google Engineering Practices, *How to write code review comments*：<https://google.github.io/eng-practices/review/reviewer/comments.html>
- Google Engineering Practices, *Small CLs*：<https://google.github.io/eng-practices/review/developer/small-cls.html>
- Sadowski et al., *Modern Code Review: A Case Study at Google*：<https://research.google/pubs/modern-code-review-a-case-study-at-google/>
- Gerrit, *Patch Sets*：<https://gerrit-review.googlesource.com/Documentation/concept-patch-sets.html>
- GitHub, *Resolving reviews*：<https://docs.github.com/en/pull-requests/concepts/resolving-reviews>
- GitHub, *Requesting a pull request review*：<https://docs.github.com/en/pull-requests/how-tos/create-pull-requests/requesting-a-pull-request-review>
- NASA SWE-088, *Software Peer Reviews and Inspections — Checklist Criteria and Tracking*：<https://swehb.nasa.gov/spaces/SWEHBVC/pages/50888944/SWE-088%2B-%2BSoftware%2BPeer%2BReviews%2Band%2BInspections%2B-%2BChecklist%2BCriteria%2Band%2BTracking>
- NASA Handbook §7.10, *Peer Review and Inspections Including Checklists*：<https://swehb.nasa.gov/spaces/7150/pages/16449965/7.10%2B-%2BPeer%2BReview%2Band%2BInspections%2BIncluding%2BChecklists>
- CMMI Institute, CMMI practice-area domain chart（含 Peer Reviews 与 Causal Analysis and Resolution）：<https://cmmiinstitute.com/getattachment/4addb5b3-12ee-4f05-8aee-1d61e2b45e50/ISACA-CMMI-Domain-Chart_fnl.pdf>
- Li et al., *Opportunities and Challenges in Repeated Revisions to Pull-Requests: An Empirical Study*：<https://doi.org/10.1145/3555208>
- Fregnan et al., *The evolution of the code during review: an investigation on review changes*：<https://doi.org/10.1007/s10664-022-10205-7>

## 11. 最短结论

> 当前流程能阻止错误通过，却不能保证工作完成。  
> 它把每次 repair 变成新 revision，从而清零 revision-scoped stop line；又把 cross-revision recurrence 只做成“必须再 repair”的报告。与此同时，它用 full reinspection 代替 focused follow-up，并让修复和 falsifier 一起扩张审查面。  
> 所以循环不是偶然，它是当前控制规则的合成结果。终止它需要 bounded merge decision、repair lineage 和真正的 escalation terminal，而不是第 9 位 reviewer。
