# 独立审查的"轮次认证"：背景、结论、方案与待评审问题

> **本文是一份单一文档。** 它合并并取代了以下四份（均已 tombstone，内容完整保留在本文与 git 历史中）：
>
> | 被合并的文档 | 原有内容在本文的位置 |
> |---|---|
> | `2026-09-26-methodology-review-package.md` | 全文骨架（第 1、2、3、4、5、6 章） |
> | `2026-09-26-platform-decoupled-round-methodology.md` | 第 3 章（结论与不采纳清单）、第 4 章（迁移与限度） |
> | `2026-09-26-decoupled-round-protocol-plan.md` | 第 2.1 节（已落地机制）与第 2.3 节（迁移记录） |
> | `2026-09-26-decoupled-round-protocol-conflicts.md` | 第 2.2 节（审计：哪些声明变成了假话） |
> | `2026-09-26-owned-paths-the-identity-policy-cannot-see.md` | 附录 B |
>
> **仍然独立存在的两份（有意不合并，理由在附录 C）**：
> `2026-09-26-decoupled-round-protocol.md` —— **已落地机制的设计之记录**，被 `src/` 四个文件与 `tests/` 两个文件的注释直接引用，
> 把代码注释指向一份 tombstone 会让"为什么凭据作者权搬走了"这个问题落空；
> `2026-09-21-adversarial-execution-control-optimization.md` —— 判定基础（五条合取式）的原始设计文档。
>
> **阅读者画像**：不需要熟悉本仓库的会话历史。第 1 章给最小背景，第 6 章给可复核的命令与输出。
> **证据标注**：**[实测]** 有命令或文件行号可复核 · **[提案]** 本文主张但未落地 · **[极限]** 我们认为是方法论边界，欢迎反驳。
> **会上 5 分钟对齐**：本文开头的 **「摘要：问题与需求」即为那一页** —— 它可单独阅读与打印（流程一句 · 17 条问题 · 12 条需求 · 现状映射 · 4 个待答问题 · 五条结论与方案）；本页之后的第 0 章是它的展开（完整证据与"怎么测"）。

---

## 摘要：问题与需求（**这一页即可单独打印，会上 5 分钟对齐用**）

> 本文是**单份文档**：本页是执行摘要，后面是展开。每条问题的**完整证据**在第 0.2 节，每条需求的**怎么测**在第 0.3 节，**问题 → 需求 → 落地 → 现状**的映射在 0.4 节，方法论的结论与方案在第 3、4 部分，请评审者反驳的 10 个问题在第 5 部分。

### 流程（一句话）

kata 发 brief → **一个独立会话**审查并交回记录 → kata 判记录 → 通过则 judge/archive；
**有 finding 则修复，而修复产生新 revision ⇒ 刚通过的那一轮作废。**

### 问题（17 条，三层）

**结构性 5 条 —— 最值得争论的，因为都不是实现 bug**

| | 问题 | 实测 |
|---|---|---|
| **P1** | **认证与修复互相摧毁** | 某 change 的 judge **在其审查轮通过后 11 分钟**被兄弟 change 的修复作废；四轮 23 条发现中 **15 条（65%）是关于上一小时的修复** |
| **P2** | **审查的产出不是修复方案**（刻意：否则审查轮成为第二作者） | 每轮 **350–660K tokens** 用于重新推导报告者已理解的东西（brief 只占 3–6%）· **盲点再生**（7 个装饰性检查）· **无影响范围**（一次修复弄坏 11 个 fixture / 6 个文件） |
| **P3** | **终止条件是开集**："处置所有 finding"没有上界 | findings **不下降**：某 change 十轮为 `7,5,5,2,5,9,10,12,14,14` |
| **P4** | **一轮只能认证一个 revision**（独立性的价格） | 必要，但**从未被定价或写下来**；终态只对"最后一步不改内容"的 change 可达 |
| **P5** | **工作顺序不是机制** | **38 个路径被不止一个 change 声明**；九个 change 共享六个中央源文件 |

**机制 9 条**：**P6** 无记录轮次常态（**62 轮中 28 轮零记录**；139 MB 转录里 assistant 文本 **0 字符**）· **P7** 档位与宿主能力不匹配（**三个 change** 因此卡住）· **P8** 契约写了转述路线而代码拒绝它 · **P9** 子代理工具调用不可观测（5 个候选归属字段**全无**）· **P10** 同一事实多处派生（抓过八次，"是否已处置"曾有 **7 个消费方**）· **P11** 能恒真的检查（**≥11 处**，**全靠变异发现**）· **P12** 声明比做的多 · **P13** 成本不可见且被模板教成 0 · **P14** 修复按 finding 计费

**协作与审计 3 条**：**P15** 修复者常是作者本人（另一作者机制**只成功用过一次**）· **P16** 严重度门槛存在却未被使用 · **P17** 审计语义未分级

### 需求（由问题反推，12 条，每条可测）

**R1** 判据只读产物 · **R2** 每条 finding 必须可被反驳（反例，或声明不可复现并挂到有覆盖检查的类）· **R3** 终止条件必须可判（类覆盖闭合，而非 findings 清零）· **R4** 认证范围 = 修复合法的范围
**R5** "没产出记录"必须是可操作状态 · **R6** 顺序必须成为机制 · **R7** 成本必须可见并进入判据 · **R8** 弱证据必须分级并显示
**R9** 同一事实只能有一个派生 · **R10** 门判据的每条条件必须写在 brief 里 · **R11** 每条"会红的检查"必须真的会红 · **R12** 审计需求按档满足

### 现状（映射，避免"看起来都解决了"；详表见 0.4）

| 状态 | 组数 | 内容 |
|---|---|---|
| **已落地** | 5 | 类覆盖闭合（R3）· 具名拒绝 + 转录可救 + brief 内数字期限（R5）· `lane` 三态（R6）· 三条不变量检查（R9 / R10 / R11） |
| **部分** | 3 | 按路径内容绑定（R4，"修本轮 finding 不作废本轮"未做）· 反例账本已有但"必须带反例"未落到门（R2）· 成本字段已有但门尚未读它（R7） |
| **提案** | 3 | 判据只读产物 + 弱证据分级（R1 / R8）· 归属字段 · `provenance` |
| **已建未用** | 1 | 另一作者机制 · 严重度门槛 |

### 结论（方法论，展开见第 3 部分）

1. **去掉平台耦合 ≠ 找到"所有平台都能实现的宿主契约"**，而是**把执行者降级为不可信的提案者，把信任移进一个只读产物的裁判**（同 SLSA 信 `builder.id`、Sigstore 信 OIDC 身份、证明助手信 kernel 而视模型为 *untrusted proposal engine*）。
2. **判定里只剩一个过程事实**（"存在一份 kata 启动进程写的凭据"）：五条合取式（covered / discharged / grounded / bounded / consistent）**全部落在产物上**，而"只读"kata **自己就能观测**（内容摘要对比）。
3. **真正必要的只有三件**，且不依赖任何标准：**判据读产物** · **一个归属字段** · **弱证据分级并显示**。
4. **明确不采纳**：OTel 的 `gen_ai.agent.id`（语义与需求相反）· Sigstore 签名与哈希链（只在凭证需"旅行"时才必要）· 内核隔离（宿主侧选项）。
5. **残留极限一条**：**省报不可检出** —— 证据能证明"报了的都是真的"，**不能证明"没漏"**。这是"不可信提案者"范式的边界，与平台无关。

### 方案（五步，每步单独提交、单独可回滚、每步都有机器可核验的验收）

① 把 `executedInFreshContext` 移出判据 → ② 每条 finding 必须"可复现"或"声明不可复现 + 类名" → ③ 去掉 `requiresExecutionReceipt` 的硬性要求 → ④ `execute` 降级为可选路线 → ⑤ 基准语料验收。

### 会上只需要回答 4 个问题

1. **L1 那五条结构性问题是否成立？** 尤其 P1：认证被自己的修复作废 —— 这是**必须接受的独立性价格**，还是应当被限制（例如"修复本轮 finding 时不清空本轮"）？
2. **P3 的终止条件够不够？** "每个开放的高严重度 finding 所属类都有覆盖检查"是否足以宣布完成，还是必须引入轮次上限 / 成本预算？
3. **R4 可否落地？** 需要一条绑定："修复的影响范围 = 该 change 声明的路径" ⇒ 只影响被声明路径的修复不作废本轮。这会放松什么？
4. **档位怎么处理？** 把 `strict`/`security` 的要求从"过程级（凭据）"降为"产物级（判据 + 反例 + 类覆盖）"，还是明确宣布本宿主不支持该档、那两个 change 换宿主？

**要完整论证读第 0 章；要反驳我们读第 5 章的 10 个问题；要复核数字读第 6 章的命令与输出。**

---

# 第 0 部分 当前 review 流程的问题与需求

> 本章是全篇要评审的**核心**：先写清流程长什么样，再逐条列出**实测的问题**，最后把问题翻译成**可测的需求**。

## 0.1 当前流程（六步）

```
1. kata 发 brief（文本，含 remit、覆盖要求、要声明的字段、会拒绝记录的条件）
2. 一个独立会话读 brief、读代码、写 hypotheses + findings
3. 该会话把记录（JSON）交回：kata-cli adversarial record --from-file
4. kata 判记录：覆盖（每条判据/路径被某假设 claim）· 收敛（无 inconclusive/abandoned）·
   引用（引用的测试已声明）· 身份（revision + brief 哈希匹配）·
   以及（escalated 档）**凭据存在**（一份 kata 启动的宿主进程写的 receipt）
5. 通过 ⇒ review 批准 ⇒ judge 判 AC ⇒ archive
6. 有 finding ⇒ 修复 ⇒ **内容变化 ⇒ 新 revision** ⇒ 绑定旧 revision 的记录成为 stale_revision
```

## 0.2 问题（分三层，每条带实测）

### L1 结构性问题（流程设计层面；不是实现 bug）

| # | 问题 | 实测证据 | 后果 |
|---|---|---|---|
| **P1** | **认证与修复互相摧毁**：一轮审查认证一个 revision，而任何修复都产生新 revision | `kata-gate-surface` 封印 14:24:15、其记录被接受、review 通过；**14:35:14（11 分钟后）**兄弟 change 的修复改动了共享路径 ⇒ judge 对每条 AC 判 `stale_evidence` | 一轮审查买到的认证**有效期以分钟计**；R1→R4 的 23 条 finding 中 **15 条（65%）是关于我前一小时的修复** |
| **P2** | **审查的产出不是修复方案**（刻意的：设计修复会让审查轮成为第二作者并复制作者的盲点） | finding 只有 `message` + `falsifier`；代价实测：重新推导 350–660K tokens/轮（brief 只占 3–6%）· 盲点再生（7 个装饰性检查）· 实例级而非类级修复 · 无影响范围（`cg-f1` 的修复弄坏 11 个 fixture / 6 个文件）· 无"这是不是最好的修法" | 修复质量取决于修复者的自由发挥；同一件事被重新发明 |
| **P3** | **终止条件是开集**："处置所有 finding"，而"所有"没有上界 | findings 数**不下降**：`closure-gate` 十轮为 `[7,5,5,2,5,9,10,12,14,14]`；一天内 37 个实例只归纳出 4 个类（现 7 个） | 轮次与成本线性增长，且没有"什么时候算完"的回答 |
| **P4** | **一轮只能认证一个 revision，而每一步都改变它**（独立性使然） | 见 P1；这条**必要**但从未被定价或写下来 | 终态只对那些"最后一步不改变内容"的 change 可达 |
| **P5** | **工作顺序不是机制**：多个 change 声明同一批路径 | **38 个路径被不止一个 change 声明**；九个 change 共享六个中央源文件 | 谁先谁后决定成败，而 workflow 不表达它（本线新增 `lane` 才开始表达） |

### L2 机制缺陷（实现层面，全部实测）

| # | 问题 | 实测证据 |
|---|---|---|
| **P6** | **无记录轮次是常态**：一轮审查可能什么都不交 | 本线 **62 轮中 28 轮**零记录；`round-protocol` 上 **5 次 kata 启动运行 = 3 completed + 2 无记录**；两次无记录转录 **139 MB / 21.7 MB**，后者 assistant 文本 **0 字符**。**根因是"停止"行为，不是通道** —— 唯一有效杠杆是 **brief 内的数字期限**（0/4 → 6/6） |
| **P7** | **档位与宿主能力不匹配** | `reviewMode` 为 `strict`/`security` 时要求凭据（`adversarial.ts:3088`）⇒ 无此能力的宿主**根本跑不了这两档**；**三个 change** 因此长期停在"判据全实现、义务全处置" |
| **P8** | **契约描述了一条路由，代码拒绝它** | schema 写了 `receipt.executor` = *"On a subagent round the telemetry is relayed by the calling session"* + `sessionId`/`completionReport`；实测转述形状的凭据被 `receipt_unwatched` 拒 |
| **P9** | **平台的子代理工具调用不可观测** | `pi --mode json` 的流里**有** `tool_execution_start/end` + `toolName`，但**没有任何 agent 归属字段**（逐一查 `agentId`/`sessionId`/`jobId`/`parentId`/`thread` 全无），子事件不嵌套；`subagent_inspect` 自述排除 *complete child output … selected tools* |
| **P10** | **同一事实有多处派生**（本线最常抓的类，已八次） | "某个 finding 是否已处置"曾有 **7 个消费方各读一份拷贝**；`answeredBy` 比它的判据弱；`roundMayClose` 曾写成**恒真** |
| **P11** | **能恒真的检查**（跑不出红色的检查等于没检查） | 一天内抓到 **至少 11 处**（7 个装饰性 + 4 处后续发现），**全部靠变异验证发现，没有一处靠读代码发现** |
| **P12** | **声明比做的多**：文档/注释/schema 描述一种行为，代码不做它 | C1–C4（凭据作者权搬走后四处声明成了假话）· `receipt_unwatched` 不在 brief 渲染的 union 里 · "append-only" 的 docstring 与替换行为矛盾 |
| **P13** | **成本不可见，且被模板教错** | `usage` 是自报且可选；模板曾展示全零，**两条记录因此报了 0 tokens**，而 harness 实测 134K / 449K |
| **P14** | **修复本身按 finding 计费**（每个修复都可能铸新 revision） | 我逐条修 minor/nit，直到一次性接受 **23 条**才停止 —— 那是单日最大的一次节省 |

### L3 协作与审计

| # | 问题 | 实测证据 |
|---|---|---|
| **P15** | **修复者常是作者本人**（盲点复制） | 另一作者机制已建（`kata-implementer` + 隔离 worktree），**成功用过一次**，另几次因机制外原因失败 |
| **P16** | **严重度门槛存在却未被使用** | `std` 只拦 `blocking`、`strict` 拦 `blocking`+`major`；我仍逐条修 minor/nit |
| **P17** | **审计语义未分级** | 单机场景"谁审的"可丢弃；对外审计（SOC2/ISO）会要求"谁在何时审了哪个版本" |

## 0.3 需求（由问题反推，每条可测）

| 需求 | 内容 | 由哪个问题驱动 | 怎么测 |
|---|---|---|---|
| **R1** | **判据只读产物**，不读过程 | P7 · P8 | 在没有 `--executor` 的环境上走完 brief → 子代理 → record → judge |
| **R2** | **每条 finding 必须可被反驳**：带反例，或显式声明不可复现并挂到有覆盖检查的类 | P2 · P3 · P6 | 删掉反例 ⇒ 门拒绝；"只报不证"的 finding ⇒ 拒绝 |
| **R3** | **一轮的终止条件必须可判**（类覆盖闭合，而非"findings 清零"） | P3 | `roundMayClose` 因未覆盖的类返回 false（已有用例） |
| **R4** | **认证范围与修复合法的范围一致**：修复本轮 finding 不应作废本轮 | P1 · P4 | 内容绑定按 `pathDigests`（已实现）；补：修复只影响被声明路径时不清空该轮 |
| **R5** | **"没产出记录"必须是一个可操作状态**，不是静默失败 | P6 | 无记录 ⇒ 具名拒绝 + 转录可救（`salvage` 已实现） |
| **R6** | **顺序必须成为机制** | P5 | `lane` 报 `current` / `declaration-moved` / `superseded` 并具名漂移路径（已实现） |
| **R7** | **成本必须可见且进入判据** | P13 · P14 | 记录携带实测 `toolCalls`/时长；不可测的字段记 `null` 而不是 0 |
| **R8** | **弱证据必须分级并显示** | P8 · P17 | `observed` / `relayed` / `held`，门按档位取用，`status` 报出来源 |
| **R9** | **同一事实只能有一个派生** | P10 | 不变量检查：谓词只定义一次、消费者必须问它 |
| **R10** | **门判据的每条条件必须写在 brief 里** | P12 | 不变量检查：union 的每个成员要么有 brief 行、要么有书面排除 |
| **R11** | **每条"会红的检查"必须真的会红** | P11 | 变异验证；类表每类的覆盖检查在变异下变红 |
| **R12** | **审计需求按档满足** | P17 | 需要对外审计时，`observed` + 签名 + "何时审了哪个 revision" |

## 0.4 问题 → 需求 → 落地（映射）

| 问题 | 需求 | 落地 | 状态 |
|---|---|---|---|
| P1 · P4 | R4 | 内容绑定（`pathDigests`）· `stale_revision` 判定 · `lane` | **部分**（按路径绑定已实现；"修本轮的 finding 不作废本轮"未做） |
| P2 · P3 | R2 · R3 | 反例账本（`falsify`）· 类表 + `roundMayClose` | **已实现**；R2 的"必须带反例"**未落到门** |
| P5 | R6 | `kata-cli lane` | **已实现** |
| P6 | R5 | 具名拒绝 + `salvage` + brief 内数字期限 | **已实现** |
| P7 · P8 | R1 · R8 | 第 4 部分 ①③④ | **[提案]** |
| P9 | R8 | 归属字段（名字自定，§3.4 拒绝采用 OTel 的名字） | **[提案]** |
| P10 | R9 | 类不变量检查 | **已实现** |
| P11 | R11 | 变异验证 + 覆盖检查 | **已实现** |
| P12 | R10 | brief 条件不变量 + 今天的扩展 | **已实现** |
| P13 · P14 | R7 | 记录携带实测计数；不可测记 `null` | **部分**（字段已有；门尚未读它） |
| P15 · P16 | — | 另一作者机制 · 严重度门槛 | **已建，未被使用** |
| P17 | R12 | `provenance` 分级 | **[提案]** |

---

# 第 1 部分 背景

## 1.1 系统是什么（最小上下文）

kata 是一个**治理型开发工作流**：一个变更（change）从 open → design → build → **verify** → **review** → judge → archive 逐级推进，每级有门，门只接受**可机械核验的产物**：

| 级别 | 谁来判 | 判据落在哪 |
|---|---|---|
| `verify` | kata 自己 | 每个验收判据（AC）至少有一条**运行过的测试证据**，且证据绑定到**内容寻址的 revision** |
| `review` | **一个独立会话**（下称"审查轮次"） | 该轮提交的**记录**（JSON）：`hypotheses` + `findings`，每条发现带 `falsifier`/`impact`/`classInstances` |
| `judge` / `archive` | kata 自己 | AC 全 PASS、义务全处置、无 blocking finding |

**关键性质**：revision 由内容决定（`pathDigests`）。内容一变 ⇒ 新 revision ⇒ 绑定旧 revision 的审查记录成为 `stale_revision`。**这是必要的**：审查一份已不存在的内容，什么也证明不了。（代价是同一条线上反复出现"修复使刚买到的那一轮作废"，见关联文档。）

## 1.2 为什么"独立性"需要被认证

审查看的全部价值来自**独立性** —— 审查者不继承作者思路，因此能看到作者的盲点。对 LLM 会话，三件事使独立性成为需要**证明**的属性而不是默认属性：

```
① 上下文可以继承（--continue 或 inherit_context，一个 flag）
② 工具表可以全权限（提示词说"不要写"不等于不能写）
③ 会话没有账号、没有不可写的外部记录（人类 reviewer 的"可信"来自组织与可问责性）
```

于是 kata 要求凭据，且规定由 **kata 启动的宿主进程**写（"观测路线"）：

```ts
// src/quality/review-execution.ts:189   [实测]
`no execution receipt was recorded, so ${node} cannot be certified:
 a context the agent describes as fresh is not a capability`
```

## 1.3 术语表

| 术语 | 含义 |
|---|---|
| **revision** | 由内容摘要（`pathDigests`）决定的一次冻结；内容变则 revision 变 |
| **轮次 / round** | 一次独立审查会话，提交一份记录 |
| **记录 / record** | 该轮的 JSON 产物：`hypotheses` + `findings` + 声明（`readTests`/`wroteTests`） |
| **凭据 / receipt** | 说明"这一轮在受控条件下跑过"的产物；今天由 kata 启动的进程产生、由 kata 写出 |
| **观测路线 `observed`** | kata 启动进程、读事件流、计数、反驳、写凭据、登记运行 |
| **转述路线 `relayed`** | 事件由非 kata 的一方产生，带会话标识与平台完成报告原文 |
| **反例 / falsifier** | 把缺陷放回去、观察某个检查是否变红；**由 kata 自己运行**并记录 `{before, mutated, after}` |
| **类 / class** | 一组同句式的缺陷（7 类）；每类必须有一条会红的覆盖检查 |
| **义务 / obligation** | 一条必须被"反例 / 缺席记录 / 类覆盖"之一答复的发现 |

---

# 第 2 部分 现状（全部实测）

## 2.1 已落地的机制

一天之内落地并验证的机制，共 4 个源文件 + 1 个 schema（约 650 行）：

| 组件 | 作用 | 位置 |
|---|---|---|
| **轮协议** | 宿主只做"启动 + 逐行描述"；kata 发请求、读事件流、自己计数、**反驳能力声称**、推导状态、**自己写凭据**、登记运行 | `src/quality/round-protocol.ts` · `round-runner.ts` · `round-registry.ts` · `schemas/round-events.schema.json` |
| **六种事件** | `launched` / `tool_call` / `output` / `telemetry` / `result` / `ended`，一行一个 JSON 对象。协议**只有一个定义**（schema 有唯一 `$id`，注册进 `validate`；解析器逐行送它校验） | 同上 |
| **七步状态推导** | 只有最后一步（`completed`）才写凭据；其余每一步都**什么都不写**并具名拒绝 | `round-runner.ts` |
| **能力反驳**（核心） | 适配器**声称**能力，kata 从**同一份流**里反驳：写工具调用 ⇒ `read_only_fs` 假；白名单外工具（实测含 `powershell`）⇒ `bounded_tools` 假；超限 ⇒ kata **杀掉进程组**（detached + 信号，退出码 124，`src/process/run.ts`） | `round-runner.ts` |
| **登记表（黑板）** | 每次运行一行：`runId` / 请求哈希 / 状态 / 实测计数 / 拒绝列表 / **凭据全文**；`record` 要求凭据的 `runId` 在表里且为 `completed` | `round-registry.ts` |
| **只读的替代观测** | kata 自己对比 revision 内容摘要与工作区 ⇒ 报 `drifted` | `kata-cli lane` **[实测]** |
| **伪造账本** | 反例由 kata 自己运行并记录 `{before, mutated, after}` | `kata-cli falsify` |
| **类覆盖** | 7 个类，每类一条覆盖检查（变异下会红）；`roundMayClose` 要求"每个开放的高严重度 finding 所属类都有覆盖检查" | `src/quality/class-coverage.ts` · `tests/unit/class-invariants.test.ts` |
| **两个程序技能** | `kata-review-round`（审查者半：brief 是全部指令、早写记录再改进）· `kata-host-adapter`（操作者半：只启动与描述，**不写凭据**） | `.agents/skills/`（生成物） |

**端到端成功过一次** **[实测]**：`round-protocol` 这个 change（它本身在做这套协议）经
`kata-cli adversarial execute --executor "node pi-adapter"` 跑了一轮真实审查，`gate satisfied: true`，随后 judge PASS（AC-1…AC-6）、obligations 0、**归档**。

**两条实现纪律**（由独立审查轮次发现并修复）：
- **能力必须能被流反驳**，而不是被声明：曾出现适配器为**从未启动**的进程返回"四项能力齐备 + `completed`"（`aad-r7-f4`，blocking），因此"没有 `result` ⇒ 不写凭据"成了硬规则。
- **`schema` 是唯一定义**：解析器曾是手写守卫，与 schema **只在 `kind` 上一致**；一次被守卫接受的流可以产出 `record` 下一命令就拒的凭据。现在逐行走注册 schema。

## 2.2 审计：哪些已落地的声明变成了假话 **[实测]**

重构把三项职责从执行者搬到 kata（**计数 / 执法 / 写凭据**），而上一版设计**有意**把其中两项放在对面并写了理由。审计结论：**没有任何验收判据冲突**（两个 strict change 的 11 条 AC 里没有一条提到"谁写凭据"），但以下**声明**冲突，必须改：

| # | 位置 | 变成假话的句子 | 处理 |
|---|---|---|---|
| C1 | `schemas/adversarial-review.schema.json:254` | "Host-authored, measured and bound: it arrives on its own channel (`--receipt-file`)" | schema 是每个读者信任的定义 ⇒ 必须改写的**首位** |
| C2 | `src/quality/review-execution.ts:119` | "The executor's report. Authored by the host, never by the reviewer." | 已改：现为"由 kata 从它观测到的流写出" |
| C3 | `src/quality/review-execution.ts:13`（模块注释） | 同上 | 已改 |
| C4 | `src/cli/ops.ts:467` | "kata runs a declared command and validates the receipt it writes. **Kata does not decide how a session is isolated — the command does**" | 前句已假，后句半真：kata 现在决定白名单与预算 |

**四处测试前提需要迁移而不是修补**：`host-executor.test.ts`（12 例，假设 `runRound` 产出凭据）· `review-execution-receipt.test.ts:141`（假设状态来自凭据 ⇒ 改为"宿主声称完成但 kata 数出超预算，仍判 `budget_exhausted`"）· 同文件 `:331`（凭据仍走自己的通道，但作者变了）· `pi-adapter-refuses-what-it-cannot-run.test.ts`（失败方式上移一层：不再"不产凭据"，而是"不产可解析的 `result`"）。

**我自己的计划里有两处错**，已修正并记入计划文档：
- **G1**：计划写"`--receipt-file` 将被拒绝" —— **错旗标**。`--receipt-file` 属于 `adversarial record`（操作者把凭据交给 kata），`execute` 用的是 `--receipt-out`。照计划实现会**打断它自己描述的管线**。真正的变化是：宿主不再拿到 `KATA_REVIEW_RECEIPT`，`--receipt-out` 变成"kata 写到哪"。
- **G2（真缺口）**：计划没说 `record` 如何区分"kata 写的凭据"与"手写的" ⇒ 修法是**运行登记表**：`record` 要求 `runId` 在表里且为 `completed`；手写的凭据背后没有执行过的运行。

**以及最强反论，保留为一节而不是埋在注脚**：上一版设计**有意**把执法放在 kata 之外，理由是 *"Kata does not decide how a session is isolated — the command does — and that is what keeps a change to kata from loosening the envelope it certifies"*。**新设计与它相反** ⇒ 一类改 kata 就能放松它自己认证的包络。三条回应，第三条决定性：① 包络的数值本来就属于 kata（由 `MEASURED_REVIEW_PASS_COST × REVIEW_HEADROOM` 派生，执行者只是服从）；② "放在外面"的前提是 **kata 无法观测**，而流式化正好改变这一点；③ **防放松的机械控制已经存在且有用例**（`tests/unit/review-budget-envelope.test.ts`："sets every limit above the cost the recorded passes actually incurred"）—— **想把包络放松，就必须把某个上限压到一次实测成本之下，而那条用例会拒绝它**。

## 2.3 卡住的地方（全部实测）

| 现象 | 数据 | 含义 |
|---|---|---|
| **escalated 档需要凭据** | `src/quality/adversarial.ts:3088` `requiresExecutionReceipt: reviewMode === 'strict' \|\| 'security'` | 无法提供凭据的宿主**根本跑不了这两档** |
| **三个 change 因此长期无法认证** | `adversarial-admissibility`、`review-record-integrity`、`repair-by-another-author`：判据全部实现、义务全部处置，仍卡住 | **档位与宿主能力不匹配**，不是代码没做完 |
| **子代理路线事实为真却无法认证** | 本线 **74 轮** `kata-reviewer`：确实是新上下文、工具表确实只有 `read/grep/find/ls`，**零凭据** | 独立性对 LLM 是真问题；"无法签收"让它白白作废 |
| **转述路线被契约描述、被代码拒绝** | schema 写了 `receipt.executor` = *"On a subagent round the telemetry is relayed by the calling session"* + `sessionId`/`completionReport`；**[实测]** 转述形状的凭据被 `receipt_unwatched` 拒 | **声明比做的多**（本仓库最常抓的类） |
| **子代理的工具调用在本平台不可观测** | **[实测]** `pi -p --mode json --subagents-workflow-file=…`：流里**有** `tool_execution_start/end` + `toolName`，但**没有任何 agent 归属字段**（逐一查 `agentId`/`sessionId`/`jobId`/`parentId`/`thread`，一个都没有），子事件**也不嵌套**在父工具结果里；平台自述 `subagent_inspect` *"without exposing … complete child output … selected tools"* | **"让宿主把子代理的工具调用流式传出"在本平台做不到** |
| **无记录轮次是常态** | 本线 **62 轮中 28 轮**未交出任何记录；`round-protocol` 的 **5 次 kata 启动运行** = 3 `completed` + 2 `executor_unavailable`（工具 107/41，输出 874 KB/534 KB），另 1 次记录因 `undeclared_test_path` 被拒；两次无记录的转录 **139 MB / 21.7 MB**，后者 assistant 文本 **0 字符** | **失败首先是"停止"问题，不是通道问题** |
| **数字期限是唯一有效杠杆** | 落地"by tool call 71 of this round's 215"（数字由包络常量派生）后，下一轮 **168 次调用 / 1.19 MB / 记录被接受** | 对照实验：无数期限 0/4；有数字期限 6/6 |

---

# 第 3 部分 讨论结论

## 3.1 重构：把信任集中到一个**小而具名**的部件

| 体系 | 信任谁 | 不信任谁 | 出处 |
|---|---|---|---|
| SLSA provenance | **`builder.id`** —— *"被信任去忠实运行构建并记录 provenance 的实体的传递闭包"* | 构建脚本、依赖 | slsa.dev/spec/v1.1/provenance |
| in-toto + Sigstore | **OIDC 身份** + 透明日志 | 工件生产者 | occasio agent-attestation v1 |
| 证明助手（Lean） | **kernel**（几百行、确定性） | **提出证明的模型**（*"untrusted proposal engine"*） | lean-llm-starter |
| **本系统今天** | **跑那一轮的宿主进程**（`--executor "<command>"`）—— 一整个平台形状的部件 | 会话 | 本文 §2.1 |
| **本系统建议** | **判据 + 决定判据的命令**（在 kata 内部） | **谁跑的、怎么启动的、有多独立** | [提案] |

> **一句话**：**去掉平台耦合 ≠ 找到"所有平台都能实现的宿主契约"；= 把执行者降级为不可信的提案者，把信任移进一个只读产物的裁判。**

**这不是新立场**：`2026-09-21-adversarial-execution-control-optimization.md` §2.2 早已把可采性写成**记录上的五条合取式**，并写明 *"LLM 提供假设与反例；可采性由确定性代码在可审计产物上判定"*。**本文补的是它没做完的一半**：那五条里，今天的判定仍读了一个**过程事实**。

## 3.2 唯一的耦合点，以及它为什么可以移除

| 合取式 | 需要什么 | 谁提供 | 平台耦合 |
|---|---|---|---|
| **covered** 每个判据/路径被某假设 claim | 读记录 | kata | 无 |
| **discharged** 每个假设都收敛且带引用 | 读记录 | kata | 无 |
| **grounded** 每个引用能在该 revision 打开 | 读仓库 + 内容摘要 | kata | 无 |
| **bounded** 没有假设被资源限制放弃 | 读记录的 outcome 字段 | kata | 无 |
| **consistent** 已确认缺陷都在 findings 里 | 读记录 | kata | 无 |
| ~~**receipt 存在**~~（今天的第六条） | **一个 kata 启动的进程** | **宿主** | **有 ← 唯一** |

**而"只读"kata 自己就能观测**（"轮次结束时工作区内容是否漂移"）——不需要任何流：
**"写完再改回来"是无痕的，但它对下游无影响**：内容已被撤销，而 kata 的反例/变异运行发生在**冻结的树上、之后**。

## 3.3 真正必要的三件（与任何标准无关）

1. **判据读产物**，不读过程（把 receipt 从判定合取式里移出）。
2. **归属**：某个字段说明"这次工具调用属于哪个会话"——**名字自定**（§3.4 说明为何不用标准的名字）。
3. **弱证据分级并显示**（`observed` / `relayed` / `held`）：不是"接受自述"，而是**让弱处可审计**。

## 3.4 明确**不采纳**的（及理由）

| 被提供的 | 决定 | 理由 |
|---|---|---|
| **OTel `gen_ai.agent.id`** | **拒绝（取其形，不取其名）** | 语义**相反**：约定说该字段 SHOULD 是 "provider-assigned stable identifier of the agent resource"，且 *"It's NOT RECOMMENDED to record in-memory agent instance ids on this attribute"* —— **而我们需要记录的正是 in-memory instance id**。照抄名字却实现相反含义 = "名字宣称了代码没有的意思"（本仓库最常抓的类，已八次）。**值得取的是结构**：工具调用**嵌套**在发出它的 agent 之下。 |
| **Sigstore keyless 签名 + in-toto 外壳** | **延后，触发条件写明** | 签名回答"**谁**签的"，而 §3.3 的结论是"谁"可以丢弃（独立性来自启动参数，不来自身份）。单仓库内，门读自己的库，登记表 + git 历史已提供防篡改。**只在凭证需要"旅行"（跨机器/跨组织/给外部审计者）时才必要。** |
| **哈希链审计日志** | **延后（同一触发条件）** | 价值在"第三方离线重走"；现在没有第三方。 |
| **`bwrap`/Landlock 内核隔离** | **宿主侧选项，非 kata 改动** | 价值最高的地方是**没有流可反驳**的场景（转述路线）。 |
| **occasio 的弱证据分级** | **采纳（唯一改变我们做法的一条）** | `policy.source: inferred` 证明"**标注更弱的证据并显示出来**是常规做法"，Verifiers SHOULD 视其为更弱 —— 这正是 §3.3 第 3 条。 |

**采用一个我们没实现的词汇 = 造"两名一实"**：OTel 的标识符是给"注册型 agent 资源"用的，我们记录的是"这次调用的会话实例"；贴上它的名字就在 schema 里制造同一概念的第二条派生。**两个"说了什么就是什么"的本地事件名，比一个"说了别的意思"的标准名更便宜。**

## 3.5 残留极限（**真极限，且与平台无关**）

> **省报（omission）不可检出**：证据能证明"报了的都是真的"，**不能证明"没漏"**。
> 缓解：① 覆盖要求（每条判据/路径必须被某假设 claim）；② 类覆盖检查（回归会随时间暴露）；③ 可选 quorum。
> **但它绝不保证**：一个诚实声称"我查过 AC-1..AC-6，没发现问题"的会话，其**诚实**无法被验证。**这是"不可信提案者"范式的边界，不是平台缺陷。**

---

# 第 4 部分 方案 [提案]

> 原则：**每步单独提交、单独可回滚**；**每步都不放松任何反驳规则**；每步都有机器可核验的验收。

| # | 步骤 | 落地内容 | 解锁什么 |
|---|---|---|---|
| **1** | **把 `executedInFreshContext` 移出判据** | 降为记录元数据（质量指标：显示，不拦） | 立刻解锁卡住的 change；不改变任何反驳规则 |
| **2** | **每条 finding 必须"可复现"或"声明不可复现 + 类名"** | schema + brief + 门；反例由 kata 自己跑并记录（机制**已存在**） | 产物自我反驳 ⇒ **伪造的记录产不出会红的检查** |
| **3** | **去掉 `requiresExecutionReceipt` 对 escalated 档的硬性要求** | "只读"改由 kata 自观内容漂移 + 引用声明守卫承担；`provenance` 分级引入并显示 | 任何平台都能跑完整流程 |
| **4** | **`execute` 降级为可选路线** | `observed` 等级仍可用于 CI 或想要更强证据的档位 | 去掉子进程编排、凭据、登记表的**必要性** |
| **5** | **基准语料验收** | 内部设计 §4 Phase 0 的语料（历史缺陷、种子缺陷、变异、已知良好 revision）+ 指标 `criticalRecall` / `falsePassRate` / `reproducibility` | 让 1–4 都可被证伪 |

### 4.1 每一步的验收（可机械核验）

| 步骤 | 验收 |
|---|---|
| 1 | 卡住的 change 通过 review（记录 `satisfied: true`），**且**其 findings 仍受反例/类覆盖约束 |
| 2 | 一条"只报不证"的 finding 被拒（用例）；一条真缺陷 + 反例被接受（用例）；变异：删掉反例 ⇒ 门拒绝 |
| 3 | 在没有 `--executor` 的环境上跑完整流程（brief → agent 子代理 → record → verify → judge → archive） |
| 4 | 语料上 `observed` 与 `result-observed` 两条路线的 `criticalRecall` 差异被**测量**（而不是假设） |
| 5 | 每步报 delta；无 delta 不落地 |

### 4.2 目标形态（skill + agent 优先）

```
1. kata adversarial brief --emit-request packet.json      ← kata 产包（纯文本，平台无关）
2. agent 加载 /kata-review-round（skill）
     └─ agent 用【自己平台的子代理机制】spawn 审查子代理（工具表由平台限制）
        └─ 子代理读 brief → 写记录（每条 finding 带反例，或"不可复现 + 类名"）→ 写文件
3. kata adversarial record --from-file record.json        ← kata 判 §3.2 五条 + 内容未漂移
4. kata verify / judge / archive                          ← 不变
```

**残留（不可移除，已定性）**：① 技能安装到平台自己的目录 = **打包耦合**，与方法论无关；② "执法"（超预算当场杀掉）降级为**成本项**；③ 省报（§3.5）= **范式极限**。

---

# 第 5 部分 请评审者攻击的问题（本文重点）

| # | 问题 | 我们的立场 | 需要的反驳 |
|---|---|---|---|
| **Q1** | 把 `executedInFreshContext` 移出判据，是否让 `strict` 档名不副实？ | 判据读产物；一轮"敷衍但覆盖完整、反例齐全"的审查，其**结论仍被验证**。过程不可观测的代价是**无法区分认真与敷衍**，只能靠覆盖 + 反例 | 是否存在"敷衍也能满足五条合取式"的构造？若有请给出 |
| **Q2** | "每条 finding 必须可复现"是否会**收窄一轮能报什么**（散文级发现被迫进类表）？ | 是真实约束，我们接受；类表是它的出口 | 类表是否够用？哪些发现无法表达为"类 + 可红检查"？ |
| **Q3** | 省报不可检出（§3.5），对 `strict` 档是否可接受？ | 接受并显式化；quorum 是可选缓解 | 是否有**非 quorum** 的检测手段？（例如同一 revision 两轮做**假设集合差异分析**） |
| **Q4** | "工作区内容未漂移"能否替代 `read_only_fs`？ | 能覆盖"留下的改动"与"修好再报无缺陷"；**无痕写入不影响下游**（反例运行在之后、冻结树上） | 是否存在"无痕写入影响了下游"的构造？ |
| **Q5** | `provenance` 分级会不会导致**逐底竞争**（弱等级成为默认）？ | 门按档位决定接受哪一级；`held` 永不接受 | 分级是否应**带成本**（例如弱等级要求 quorum）？ |
| **Q6** | 判据从"过程"移到"产物"后，**审计语义是否仍成立**（SOC2/ISO 要求"谁在何时审了哪个版本"）？ | 我们保留"**何时审了哪个 revision**"（凭据非必需）；"谁"在单机场景可丢弃 | 若需对外审计，是否必须回到 `observed` + 签名？代价多大？ |
| **Q7** | 若**仓库本身不可运行**（无测试/无构建），"反例可复现"退化，方案是否崩塌？ | 退化到"类覆盖 + 覆盖要求"，强度下降 | 这类项目应使用哪一档？是否需要显式降档路径？ |
| **Q8** | 五条合取式里有多少是**真正可判**的？（§3.2 是我们自评） | — | 请逐条核对我们的自评，指出哪几条实际不可判 |
| **Q9** | 合并前的旧文档中，**测试前提**（T1–T4）是"迁移"而非"修补" —— 这种迁移是否会掩盖真实回归？ | 迁移的判据是"新形态能表达同一性质"（如"宿主声称完成但 kata 数出超预算"） | 请指出哪一处迁移实际丢失了被验证的性质 |
| **Q10** | 上一版设计**有意**把执法放在 kata 之外（防"改 kata 放松自己认证的包络"），新设计相反。我们的控制是那条包络用例 | 控制是机械的：想放松就必须把上限压到一次实测成本之下 | 这条控制够吗？还缺什么？ |

---

# 第 6 部分 证据附录（可复核）

## A.1 判定里唯一的过程事实

```bash
$ grep -n "requiresExecutionReceipt" src/quality/adversarial.ts
3088:        requiresExecutionReceipt: task?.workflowProfile?.reviewMode === 'strict' || … === 'security',

$ grep -n "describes as fresh is not a capability" src/quality/review-execution.ts
189:  detail: `no execution receipt was recorded, so ${request.node} cannot be certified:
        a context the agent describes as fresh is not a capability`,
```

## A.2 只读可由 kata 自观（不需要流）

```bash
$ kata-cli lane --change round-protocol --json
{ "revisionStatus": "superseded", "driftedPaths": ["docs/design/2026-09-25-why-review-does-not-converge.md"], … }
# 漂移由 kata 对比「revision 的内容摘要」与「工作区内容」得出
```

## A.3 转述路线：契约描述它，`record` 拒绝它

```bash
$ kata-cli adversarial record --change <id> --node review \
      --from-file <record.json> --receipt-file <relay-shaped-receipt.json>
{ "recorded": false, "reason": "receipt_unwatched",
  "error": "no run with id relayed-subagent-1 was executed by this repository —
            a receipt is evidence of a round kata watched, and a receipt with no run behind it is a file." }
```

## A.4 平台不提供子代理的工具调用归属

```bash
$ pi -p --mode json --no-session --subagents-workflow-file=/tmp/wf-probe2.js "run the workflow" > stream.jsonl
# 统计 tool_execution_start 的 toolName，并检查是否存在任何 agent 归属字段
tool 调用（全部混在一起）: {'bash': 17, 'read': 5, 'ctx_search': 1, 'fffind': 1, 'ask_user': 1}
能区分 agent 的字段: 【一个都没有】   # 逐一查 agentId / sessionId / jobId / parentId / thread
子代理事件是否嵌套在父工具结果里: 0 条
```

## A.5 观测路线确实能端到端跑通（反例的反面）

```bash
$ kata-cli adversarial execute --change round-protocol --node review \
      --packet tmp/rp8-packet.json --executor "node host/pi-adapter.ts" --receipt-out tmp/rp8.receipt.json
{ "status": "executed", "receiptStatus": "completed",
  "capabilities": ["fresh_context","read_only_fs","bounded_tools","budget_enforced"],
  "telemetry": { "toolCalls": 168, "outputBytes": 1217449, "tokens": null, "truncations": null } }
# 随后：gate satisfied:true → review 批准 → judge PASS（AC-1…AC-6）→ archive
```

## A.6 无记录轮次与期限杠杆

- 本线累计 **62 轮中 28 轮**未交出记录（有工具调用的每一轮都计入）。
- `round-protocol` 的登记表：**5 次运行 = 3 `completed` + 2 `executor_unavailable`**（工具 107 / 41，输出 874 KB / 534 KB）。
- 两次无记录的转录 **139 MB** 与 **21.7 MB**，后者 assistant 文本 **0 字符**。
- 落地 brief 内数字期限（`by tool call 71 of this round's 215`，数字由 `MEASURED_REVIEW_PASS_COST × REVIEW_HEADROOM ÷ 3` 派生）后，下一轮 **168 次调用 / 1.19 MB / 记录被接受**。
- 对照实验：无数期限 **0/4**，有数字期限 **6/6**。

## A.7 环境与规模

```
193 个测试文件 / 1327 个测试 / 0 失败  ·  worktree clean
类表 7 条，每条有具名覆盖检查，全部变异验证会红
```

---

# 附录 B 顺带发现的一个缺陷（原 `owned-paths-the-identity-policy-cannot-see.md`）

**声明一个"身份政策看不见的路径"是一份无法兑现的声明** **[实测]**：给 change 的 `ownedPaths` 加上 `.llmwiki/**` 后，seal 通过、revision 铸出，随后**每个检查都报漂移**，而 `git status` 干净、re-seal 也不改变任何东西。

- **测量**：revision 里两个 `.llmwiki` 路径共享同一个摘要（`.llmwiki/concepts/the-round-protocol.md` 与 `.llmwiki/index.md` 都是 `8ba1b5d99a4b2c21…`），而 `sha256(b'[missing]') = 8ba1b5d99a4b2c21…` **正是那个值**。
- **根因**：摘要在**冻结内容快照**上计算，而 `.llmwiki` 位于 `ignoredDirectoryNames` ⇒ 快照从不携带它 ⇒ `feedOwnedTree` 落入 `else` 分支写 `hashContent('[missing]')` —— **这个哨兵与"文件已删除"共用**。于是失败**静默、永久、与真实删除无法区分、且原地不可修复**。
- **已知的两条修法**：(a) 在 `open` 时拒绝此类声明；(b) 让摘要区分"看不见"与"已删除"。
- **已记录为项目规则**：不要把被忽略目录下的路径声明进 `ownedPaths`。

---

# 附录 C 关联文档（有意保持独立的）

| 文档 | 内容 | 为何不合并 |
|---|---|---|
| `docs/design/2026-09-26-decoupled-round-protocol.md` | **已落地机制的设计之记录**：宿主只启动+描述、kata 判并写凭据、六事件、能力可反驳、技能分工、迁移与"本设计不修复什么" | **被 `src/` 四个文件与 `tests/` 两个文件的注释直接引用**；合并后代码注释会指向 tombstone |
| `docs/design/2026-09-21-adversarial-execution-control-optimization.md` | 判定基础（五条合取式）与优化路线 | 本文引用了它的 §2.2 与 §4 Phase 0；它是那条判据的原始出处 |
| `docs/design/2026-09-25-why-review-does-not-converge.md` | 为什么审查不收敛（六层、三个结构问题、九处缺陷） | 与"认证"相关但主题不同（收敛性），且被多处引用 |
| `docs/design/2026-09-24-the-fifth-class.md` | 缺陷类表（7 类）与"类 vs 实例"的分界 | 类表本身的记录 |
