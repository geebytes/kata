# 审查循环优化：代码—方案对齐审查

**日期：** 2026-10-16  
**审查对象：** 当前未提交的 review-loop 优化实现  
**基线方案：** `docs/architecture-reviews/2026-10-16-review-loop-nonconvergence-root-cause.md`，重点为 §6、§7、§8bis  
**审查性质：** 普通代码审查；不推进 Kata phase，不修改实现

## Findings

### [HIGH] 第一次 root-cause 结论会被立即判为“返修已失败”，承诺的返修根本没有机会发生

**文件：** `src/quality/repair-declarations.ts:48-89`、`src/workflow/navigation.ts:849-860`、`tests/unit/a-declared-repair-that-did-not-hold-is-terminal.test.ts:41-53,116-167`

**问题：** `classesWhoseExitIsDue()` 只做两个静态条件的合取：历史聚合仍把该类标为 `stopLineCandidate`，且最新 declaration 的 conclusion 属于 repair conclusions。它没有判断 recurrence 是否发生在 declaration **之后**，也没有要求其间出现过 repair revision / focused follow-up。

root-cause round 的 declaration 本来就是对已有 recurrence 做出的结论；因此 declaration 一写入，原来的两轮历史仍然是 `stopLineCandidate`，函数便立即返回 `reviewExitDue`。现有路由测试正是用产生 declaration 的同两条 round，随后断言 terminal route。这不是“再次复发”，而是把触发 RCA 的旧复发重新计算了一次。

**影响：** 第一次合法的 `root_cause → repair` 不能进入 Build。流程会在 closure obligation 刚产生时直接进入 terminal escalation，优化方案要求的“给 class-level corrective action 一次机会，然后只做一次 focused follow-up”不可达。

**修复方向：** declaration 必须绑定产生它的 round/sequence、reviewed revision 和后续 repair batch。只有在：

1. declaration 之后 seal 出一个 repair revision；
2. 该 repair revision 的 focused follow-up 中；
3. 同一 class 再次作为 repair-origin stop-line candidate 出现；

三者同时成立时，`ifRecursAgain` 才到期。当前活动 `review.json` 中刚写入的 declaration 绝不能自己触发到期。

---

### [HIGH] `closureObligation` 仍是标签：Build/Seal 没有消费它，也不会拒绝未满足的返修

**文件：** `src/quality/recurrence-packet.ts:92-198`、`src/quality/repair-declarations.ts:148-180`、`src/adapters/phase-guidance.ts:623-632`

**方案要求：** 根因分析 §7/P3 明确写道：“若下一次 repair 没有满足该 obligation，Build 应拒绝 seal”。

**问题：** 仓库级源码搜索显示，`closureObligation` 的运行时消费者只有：

- review result 录入时检查字段非空；
- declaration reader 取出 `ifRecursAgain`。

Build entry、repair record、seal reads、revision seal 均不读取 obligation。`states`、`sourceOfTruth`、`inventory`、`invariant`、`repairSurface`、`effectivenessTest` 只需是非空字符串/数组；它们不与 diff、声明面、执行证据或测试结果比较。

**影响：** 任意七个非空占位值都能通过，下一次 Build 仍可只改一个 call site 并 seal。RC-4“RCA 只有标签，没有 class-level corrective-action contract”没有被修复；只是把标签从 4 个字段扩成了 11 个字段。

**修复方向：** 将 obligation 持久化为 repair batch 的输入并由 Build/Seal 消费。最低要求：

- repair revision 绑定 obligation id/hash；
- delta 覆盖 `repairSurface` 且不得越出允许 dependency cone；
- inventory 有可验证的 producer/consumer 清单或生成规则；
- `effectivenessTest` 作为 revision-bound evidence 实际执行且通过；
- 未满足 obligation 时 seal 拒绝，而不是留给下一位 reviewer 发现。

---

### [HIGH] `reviewKind` 没有生命周期：`root_cause` 与 `focused_followup` 都会永久粘住

**文件：** `src/quality/repair-lineage.ts:129-169`、`src/quality/recurrence-packet.ts:213-232`

**问题 A — root-cause 粘滞：** `deriveReviewKind()` 只要收到 `recurrencePacketFired=true` 就返回 `root_cause`。packet 又从全部历史 rounds 的 `classRecurrence()` 派生；历史 finding 不会因为 `not_same_class`、repair 或 focused follow-up 被移除。因此 packet 一旦触发，后续 request 仍会一直是 `root_cause`。`not_same_class → resume_certification` 在路由语义上写得出来，在请求派生上却不可达。

**问题 B — follow-up 粘滞：** 没有 packet 时，只要 lineage 内任意较早 revision 曾有 finding，`hasBatch` 永远为真。即使后来的 focused follow-up 已经 clean，旧 finding 仍在历史中，下一轮仍被标为 `focused_followup`。现有测试只分别检查“一个旧 finding”和“只有一个 clean round”，没有检查 `[旧 finding, 后续 clean follow-up]`。

**影响：** 三种 kind 只是历史标签，没有各自的 exit criteria；P2 要求的 `certification → root_cause → repair → focused_followup → certification/Judge` 状态转换没有实现。

**修复方向：** 派生依据必须是“最新未关闭 RepairBatch / RCA disposition”，不是“历史上是否曾存在 finding/packet”。引入稳定 batch id（或等价的派生 identity）、batch status 与 declaration round identity；clean follow-up 明确关闭 batch，`not_same_class` 明确关闭 recurrence question。

---

### [HIGH] `focused_followup` 只有名字，没有 RepairBatch scope，无法阻止再次 full reinspection

**文件：** `src/store/review-request.ts:61-115,339-386`、`src/adapters/phase-guidance.ts:607-613`

**方案要求：** focused follow-up 应只核对 previous findings、changed paths、dependency cone、新增/变化 impact edge 与 closure evidence。

**问题：** `ReviewRequest` 新增的只有：

- `reviewKind`；
- lineage 的 revisions/round counts。

它不携带 previous round id、finding ids、finding disposition、changed paths、dependency cone、closure obligation、effectiveness evidence 或 residual risks。请求仍把 ledger 中的全部 claims 及其原 reading sets、完整 review package 交给 reviewer。源码中没有 `RepairBatch` 请求结构。

**影响：** reviewer 看见 `focused_followup` 这个词，却没有确定性数据回答“follow up 哪一批、哪些路径、哪些 finding、何时算关闭”。因此只能自己重建范围，最安全的行为仍是审查全部 reading sets；RC-2“full reinspection 取代 focused follow-up”并未被机制消除。

**修复方向：** ReviewRequest 必须携带可校验的 `repairBatch`：前序 round identity、blocking/major finding ids 与 dispositions、repair delta、direct dependency cone、closure obligation/evidence、明确 excluded/unmodified surface。review result 也必须对该 batch 给出逐项 closure，不能只回声 kind。

---

### [HIGH] 新 terminal reason 没有设置 `requiresUserConfirmation`，代码声称停线但协议布尔值允许继续

**文件：** `src/workflow/navigation.ts:1068-1105`

**问题：** `escalate_declared_repair_did_not_hold` 会生成三种 `escalationExits` 和“不会自动进入任何步骤”的 pause 文案，但 `requiresUserConfirmation` 的条件只包含：

- `escalate_review_without_progress`；
- `review_loop_unmeasurable`；
- gate / wiki closure。

没有包含 `escalate_declared_repair_did_not_hold`。同一代码块的注释甚至声称“`requiresUserConfirmation` is true for this reason”，与实际表达式矛盾。

**影响：** host 若按机器字段而非自然语言决定是否自动继续，这个最需要人工决策的 terminal route 会被标记为无需确认。它直接违反方案的人工 escalation 与用户对 rewrite/waive/abandon 的保留权。

**修复方向：** 两种 escalation reason 使用一个共享 predicate，统一派生 `requiresUserConfirmation`、`escalationExits`、pause 文案与无自动 next step；新增针对最终 `NextAction`（不是只测 candidate route）的断言。

---

### [HIGH] result 并未被要求 echo 派发时的 `reviewKind`，而且比较的是提交时重新派生的值

**文件：** `schemas/review.schema.json:6-9,55-66`、`src/workflow/orchestrator.ts:1687-1708,1966-1989`、`tests/unit/review-cli-io.test.ts:340-391`

**问题：** 文档和 skill 都写“result 必须 echo request.reviewKind”，但：

- schema 的 required 只有 `findings`、`status`；
- orchestrator 只在 `declaredReviewKind !== undefined` 时比较；
- result 省略 kind 会被接受，然后写入**提交时重新派生**的 `expectedKind`，并标记 `reviewKindUndeclared`；
- 现有 root-cause CLI 测试提交的 payload 就省略 `reviewKind` 并期待成功。

此外，比较目标不是 reviewer 收到的那份 ReviewRequest，而是 result 到达时从可变 round history / recurrence state 重新派生的 kind。审查运行期间状态一旦移动，正确 echo 原 request 的结果会被拒；省略 kind 的结果反而会被盖章为新状态的 kind。

**影响：** “派发了什么活动”和“结果回答什么活动”没有请求身份绑定，P2 的协议保证可被省略或 TOCTOU 状态变化绕过。

**修复方向：** 派发时持久化 request id/hash、reviewKind、subject/revision 与 batch identity；新 result 必须提交 request id 与 reviewKind，并与原 request 比较。历史 `review.json` 的兼容读取可以保留 optional，但新写入路径不应接受省略。

---

### [MEDIUM] repair lineage 在缺失父记录或 filename/body 不一致时 fail-open，可能把长链报告为短链

**文件：** `src/quality/repair-lineage.ts:50-94,116-126`

**问题：**

- `change-record-<filename-id>.json` 的 body 若声明另一个 `revisionId`，reader 以 body 为 key，不拒绝二者不一致；
- current revision 或某个显式 `baseRevisionId` 找不到记录时，walker 合成 `{revisionId}` 并把这里当 root，返回 `usable`；
- 无 revisionId 的 legacy round 被加入每一条 lineage。

**影响：** 损坏/缺失记录可以截短链并抑制 stalled 判定；legacy round 又可能被重复计入不相干链并造成误升级。两种方向都与“不可读必须具名、不能折成无历史”的项目原则不符。

**修复方向：** 校验 filename revision 与 body revision 一致；显式父 id 缺记录、当前 sealed revision 缺记录、cycle 均返回具名 `incomplete/unreadable`；legacy unbound rounds 单独报告为 unmeasured，不归入任一可证明 lineage。

---

### [MEDIUM] declaration reader 未做 schema 校验、未限定当前 lineage，既可能漏停也可能误停

**文件：** `src/quality/repair-declarations.ts:92-180`

**问题：** reader 只保证 JSON 可解析。unknown conclusion、错误 triggerClasses/obligation shape 会静默变为 `[]` 或被忽略，而不是 unreadable；同时它读取 task 的全部 history，不按当前 repair lineage 过滤。

**影响：** 损坏 declaration 可以绕过 terminal；旧 lineage 的 declaration 也可能让一个新 lineage 的同名 class 直接 terminal。F1 的“缺少 declaration 后顺序”之外，这里还缺 scope 与记录完整性。

**修复方向：** 通过 review schema / typed historical-row schema 读取；declaration 必须有 round identity、revision/batch identity 并按当前 lineage 过滤；无法证明顺序或归属时报告 unmeasured/unreadable，不能猜。

## 修复结果（2026-10-16，同一次会话内完成）

八条全部修复，每条都改了机制并配了"旧实现必红"的仪器；三个源文件在五次变异测量后 `sha256sum -c` 逐字节校验通过。

| 发现 | 落地的机制 | 变异实测（红） |
|---|---|---|
| F1 HIGH 顺序缺失 ⇒ 结论自己触发自己 | `orderOf` 三态（`after`/`before`/`unplaceable`）+ 写入方盖章 `recordedAt`；`after` 需时间**且**链位置都晚于结论 | 把 `orderOf` 改回无条件 `after` ⇒ `a-declared-repair-that-did-not-hold-is-terminal` **2 条红** |
| F2 HIGH obligation 无人消费 | 新增 `src/quality/obligation-check.ts`，seal 逐条比对四项可检查事实，不满足即 `closure_obligation_unmet`；满足则发布四项读数 | 让 seal 不读义务 ⇒ `a-seal-satisfies-the-closure-contract` **3 条红** |
| F3 HIGH kind 无生命周期 | `readLoopState()` 一次给出 kind/batch/chain/clearedClasses/packet；判据改为"**上一轮**"而非"任一更早轮次"；packet 按已答类过滤；本 batch revision 已有结论则不再问 | 判据改回"任一更早轮次有 finding" ⇒ `a-round-kind-has-an-exit` **1 条红** |
| F4 HIGH follow-up 无 batch scope | `ReviewRequest.repairBatch`（findings + scope + `unmodifiedPaths`）+ 结果侧 `batchClosure` 逐条闭环（缺一条即拒，verdict 闭集） | batch 清单读成空数组 ⇒ `a-brief-is-checked-against-the-question-it-asked` **1 条红** |
| F5 HIGH 确认位漏了新 reason | `ESCALATION_REASONS` 一处集合派生 `requiresUserConfirmation` / `escalationExits` / pause 文案 | 断言最终 `NextAction`（不只是 candidate route） |
| F6 HIGH echo 可省略 + TOCTOU | `requestId` + `ledger run` 持久化 brief；结果与**该文件**比较并写入记录 | 比较退化为"只要求字符串" ⇒ 同一测试 **1 条红** |
| F7 MEDIUM 链 fail-open | `lineageUnreadable` 具名 + `repairBatch.scope` 可区分"空链"与"单 revision" + `declarationsUnattributable` 计数 | `a-round-kind-has-an-exit` 的不可读链用例 |
| F8 MEDIUM 声明读取不严 | `declarationsOfRecord` 判别式返回，损坏即具名 `unreadable`；链内过滤 + 不可归属计数 | 同 F1 的测试文件（三种损坏声明 + 越链计数） |

**修复过程中暴露并一并修掉的两个真实缺口**（都被仪器先逼出来，而不是推理出来的）：

1. **被拒的 seal 会先铸出 revision**，所以"义务范围 = 本次要取代的 revision"这一过滤器是一条绕过路径：第一次被拒后，第二次的 base revision 变了，匹配不到声明，义务被跳过。改为**本 task 自己的声明**（不加链过滤），且"是否碰过表面"改为相对**结论所针对的 revision** 比较。用例「被拒后再试一次仍被拒」先红过一次才有这两处修改。
2. **`ledger run` 上 brief 的 kind/链是从 `undefined` 派生的**：`buildReviewRequest` 只在调用方传 `sealedRead` 时才知道 revision，而 `ledger run` 不传，于是 `repairBatch.scope` 为空。改为指针**读一次**（`sealedForRequest`）供 kind、链、冻结检查共用；`review-decision-snapshot-inventory` 守卫要求 cmdReview 走快照工厂，故该处用 `readReviewDecisionSnapshot`。

**验证**：`npx vitest run tests/unit` = **347 文件全绿**；`npm run typecheck` 干净；`check:wiring` 仍是既有 11 条（新符号无一落入"无人引用"）；`generated-assets-are-current` 等 36 条守卫通过。

**残留（未修，已记录）**：被拒的 seal 铸出 revision 却不写 change record ⇒ 链上留缺口（既有结构，本次只保证它不能绕过义务）；`states`/`sourceOfTruth`/`invariant` 仍是散文，模块注释明确写出**不**假装校验；P6 成本度量与"第 7 轮 finding 只在 `tmp/`"依旧。

## Open Questions

1. `ifRecursAgain` 究竟是 reviewer 选择的**单一出口**，还是 owner 到时从三个出口中选择？当前 schema 要求 reviewer 写一个值，但 terminal route 忽略该值并向 owner展示全部三个。二者必须统一。建议 reviewer 只声明“再次复发则升级”，具体 rewrite/waive/abandon 永远由 owner 决定。
2. 优化方案 §6 的一次性 Closure Charter 尚未编码；当前实现是否准备把它作为 `RepairBatch` 的 durable contract？如果不做，focused follow-up 仍没有冻结的 acceptance/disposition 边界。
3. P5/P6 在实施报告中已明确标为未完成：schema skeleton/提交前校验/原子 durable append，以及 tokens/tool calls/elapsed/边际收益度量。这些是已知缺口，不应把当前实现描述为 P1–P6 完成。

## Alignment Matrix

| 方案项 | 当前状态 | 判断 |
|---|---|---|
| P1 repair lineage | 有派生链与跨 revision 进度；链不可读具名，且 `repairBatch.scope` 让"空链"与"单 revision"可区分 | **对齐**（审查当时为部分对齐） |
| P2 三种 review kind | kind 有生命周期（clean follow-up 关闭 batch、已答类不再提问、本 batch revision 已有结论不再问）、brief 带 RepairBatch scope、echo 由持久化的 brief 校验 | **对齐**（审查当时为未实质对齐） |
| P3 executable closure obligation | seal 逐条比对四项可检查事实并拒绝未满足者；`states`/`sourceOfTruth`/`invariant` 明示为散文、不假装校验 | **对齐（边界已声明）** |
| P4 terminal state | 两个 escalation reason 由一处集合派生确认位与出口；被拒的 seal 不再是绕过义务的路径 | **对齐** |
| P5 schema-driven result | findings/recurrence 能一次列多错；无 skeleton、无 dispatch 前 validate、无 request binding、无原子 append | **部分对齐（文档已承认）** |
| P6 cost/convergence metrics | 仅 roundsByKind/lineage progress；无 elapsed/tokens/tool calls/marginal yield | **未实现（文档已承认）** |

## Verification Evidence

执行：

```text
npx vitest run \
  tests/unit/a-repair-chain-is-the-unit-of-convergence.test.ts \
  tests/unit/a-declared-repair-that-did-not-hold-is-terminal.test.ts \
  tests/unit/a-recurrence-packet-requires-analysis.test.ts \
  tests/unit/review-cli-io.test.ts \
  tests/unit/review-loop-routing-contract.test.ts
```

结果：5 files / 22 tests passed。

执行：`npm run typecheck`，结果：PASS。

这证明当前实现内部自洽，但不证明与方案一致；其中 `a-declared-repair-that-did-not-hold-is-terminal` 明确把“declaration 与旧 recurrence 同时存在即可 terminal”固化成预期，正是本审查的首要 finding。

## Summary

**结论（2026-10-16 审查当时）：当前实现不能判定为与优化方案对齐。** 它完成了词表、报告、部分路由和可观测性，但关键控制闭环仍缺失：obligation 不约束 Build、follow-up 没有 batch、kind 没有生命周期、terminal declaration 没有"之后再次复发"的时间关系。**上述八条已全部修复并各自配有变异实测的仪器，见上一节；本节的判断保留为当时的记录。**

当时的建议是按 Finding 1 → 2 → 3/4 → 5/6 → 7/8 一次性修复，并为每个 finding 增加"旧实现必红"的行为测试——这正是随后执行的顺序，八个仪器都真的能红（见"修复结果"）。

## Test Gaps & Residual Risk

- 没有测试“root-cause declaration 写入后、repair 尚未发生”必须仍路由 Build。
- 没有测试“旧 finding + 后续 clean focused-followup”关闭 batch 并退出 follow-up kind。
- 没有测试 `not_same_class` 后下一 request 恢复 certification。
- 没有测试 Build/Seal 缺失 obligation evidence 时拒绝。
- 没有测试 final `NextAction.requiresUserConfirmation` 对两种 escalation reason 都为 true。
- 没有 request identity race 测试：dispatch 后 history/subject 移动，再提交旧 result。
- 没有 parent change-record 缺失、filename/body revision 不一致、lineage cycle 测试。
