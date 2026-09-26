# 独立审查的"轮次认证"：方法论与方案（外部评审稿）

> **这份文档要评审什么**：kata 的独立审查机制要求"一轮审查必须真的独立发生过"，而证明方式当前依赖**宿主平台**能启动一个受控进程并交回凭据。
> 本文汇总 2026-09-26 一天的讨论与实测，给出一个**去掉平台耦合、改为 skill + agent 优先**的方法论与五步落地方案，并把**该被攻击的地方**显式列出来。
>
> **阅读者画像**：不需要熟悉 kata 的会话历史；第 1 章给出最小背景，第 6 章给出可复核的命令与输出。
> **证据标注**：**[实测]** = 有命令或文件行号可复核；**[提案]** = 本文主张但尚未落地；**[极限]** = 我们认为是方法论的边界，欢迎反驳。

---

## 1. 背景

### 1.1 系统是什么（最小上下文）

kata 是一个**治理型开发工作流**：一个变更（change）从 open → design → build → **verify** → **review** → judge → archive 逐级推进，每一级有门（gate），门只接受**可机械核验的产物**：

| 级别 | 谁来判 | 判据落在哪 |
|---|---|---|
| `verify` | kata 自己 | 每个验收判据（AC）至少有一条**运行过的测试证据**，且证据绑定到**内容寻址的 revision** |
| `review` | **一个独立会话**（下称"审查轮次"，review round） | 该轮提交的**记录**（JSON）：假设（hypotheses）+ 发现（findings），每条发现带 `falsifier`/`impact`/`classInstances` |
| `judge` / `archive` | kata 自己 | AC 全 PASS、义务（obligation）全处置、无 blocking finding |

关键性质：**revision 由内容决定**（`pathDigests`）。任何一处内容变化 ⇒ 新 revision ⇒ 绑定旧 revision 的审查记录变为 `stale_revision`（**这是必要的**：审查一份已不存在的内容，什么也证明不了）。

### 1.2 问题：为什么"独立审查"这件事本身需要被认证

审查的全部价值来自**独立性**——审查者不继承作者的思路，因此能看到作者的盲点。而在 LLM 会话上，独立性**不是默认成立的**：

- 上下文可以继承（一个 flag）；
- 工具表可以是全权限（提示词说"不要写"不等于不能写）；
- 会话没有账号、没有不可写的外部记录。

于是 kata 要求一轮审查附带一份**凭据**（receipt），说明这一轮是在**受控条件**下跑的。凭据由**kata 启动的宿主进程**写出（"观测路线"，`observed`），而不是由被审查的会话自己写：

```ts
// src/quality/review-execution.ts:189   [实测]
`no execution receipt was recorded, so ${node} cannot be certified:
 a context the agent describes as fresh is not a capability`
```

### 1.3 已经落地的机制（现状）

| 组件 | 作用 | 位置 |
|---|---|---|
| **轮协议** | 宿主只做"启动 + 逐行描述"；kata 发请求、读事件流、自己计数、**反驳能力声称**、推导状态、**自己写凭据**、登记运行 | `src/quality/round-protocol.ts`、`round-runner.ts`、`round-registry.ts`、`schemas/round-events.schema.json` |
| **能力** | `fresh_context`、`read_only_fs`、`bounded_tools`、`budget_enforced`；前两者是 `review` 节点要求，`verify` 节点加后两者 | `src/quality/review-execution.ts` |
| **反驳**（核心） | 适配器**声称**能力，kata 从**同一份流**里反驳：出现写工具调用 ⇒ `read_only_fs` 假；出现白名单外工具（实测含 `powershell`）⇒ `bounded_tools` 假；超限 ⇒ kata **杀掉进程组**（detached + 信号，退出码 124） | `round-runner.ts`、`src/process/run.ts` |
| **只读的替代观测** | kata 自己对比 revision 内容摘要与工作区 ⇒ 报 `drifted` | `kata-cli lane` **[实测]** |
| **伪造账本** | 反例（把缺陷放回去，看检查是否变红）由 kata **自己运行**并记录 `{before, mutated, after}` | `kata-cli falsify` |
| **类覆盖** | 7 个类，每类一条覆盖检查，检查在变异下会红；`roundMayClose` 要求"每个开放的高严重度 finding 所属类都有覆盖检查" | `src/quality/class-coverage.ts`、`tests/unit/class-invariants.test.ts` |
| **来源分级（提案）** | `observed` / `relayed` / `held` | 本文 §3.4 |

**已经端到端成功过一次** **[实测]**：`round-protocol` 这个 change（它本身就是在做这套协议）通过 `kata-cli adversarial execute --executor "node host/pi-adapter.ts"` 跑了一轮真实审查，`gate satisfied: true`，随后 judge PASS（AC-1…AC-6）、obligations 0，**归档**。

### 1.4 卡住的地方（全部实测）

| 现象 | 数据 | 含义 |
|---|---|---|
| **escalated 档（`strict`/`security`）需要凭据** | `src/quality/adversarial.ts:3088` `requiresExecutionReceipt: reviewMode === 'strict' \|\| 'security'` | 无法提供凭据的宿主**根本跑不了这两档** |
| **两个 change 因此长期无法认证** | `adversarial-admissibility`、`review-record-integrity`：判据全部实现、义务全部处置，仍卡住 | 这是**档位与宿主能力不匹配**，不是代码没做完 |
| **子代理路线事实为真却无法认证** | 本线 **74 轮** `kata-reviewer`：确实是新上下文、工具表确实只有 `read/grep/find/ls`，**零凭据** | 独立性对 LLM 是**真问题**，但"无法签收"让它白白作废 |
| **转述路线被契约描述、被代码拒绝** | schema 写了 `receipt.executor` = *"On a subagent round the telemetry is relayed by the calling session"* + `sessionId`/`completionReport`；实测：转述形状的凭据被 `receipt_unwatched` 拒 | **声明比做的多** |
| **子代理的工具调用在本平台不可观测** | 实测 `pi -p --mode json --subagents-workflow-file=…`：流里**有** `tool_execution_start/end` + `toolName`，但**没有任何 agent 归属字段**（逐一查 `agentId`/`sessionId`/`jobId`/`parentId`/`thread`，一个都没有），子事件**也不嵌套**在父工具结果里；平台工具自述 `subagent_inspect` *"without exposing … complete child output … selected tools"* | **"让宿主把子代理的工具调用流式传出"在本平台做不到** |
| **无记录轮次是常态** | 本线 **62 轮中 28 轮**没有交出任何记录；其中一轮转录 139 MB、另一轮 assistant 文本 **0 字符**（全在推理）；同一批内容上连续 **4 次派发未产出可接受记录**（其中 2 次完全没有记录），落地"brief 内数字期限"后下一轮即成 | **失败首先是"停止"问题，不是通道问题** |

---

## 2. 讨论得出的结论

### 2.1 重构：把信任集中到一个**小而具名**的部件

成熟体系都这么做：

| 体系 | 信任谁 | 不信任谁 | 出处 |
|---|---|---|---|
| SLSA provenance | **`builder.id`** —— *"被信任去忠实运行构建并记录 provenance 的实体的**传递闭包**"* | 构建脚本、依赖 | slsa.dev/spec/v1.1/provenance |
| in-toto + Sigstore | **OIDC 身份** + 透明日志 | 工件生产者 | occasio agent-attestation v1 |
| 证明助手（Lean） | **kernel**（几百行、确定性） | **提出证明的模型**（*"untrusted proposal engine"*） | lean-llm-starter |
| **本系统今天** | **跑那一轮的宿主进程**（`--executor "<command>"`）—— 一整个平台形状的部件 | 会话 | 本文 §1.4 |
| **本系统建议** | **判据 + 决定判据的命令**（在 kata 内部） | **谁跑的、怎么启动的、有多独立** | [提案] |

> **一句话**：**去掉平台耦合 ≠ 找到"所有平台都能实现的宿主契约"；= 把执行者降级为不可信的提案者，把信任移进一个只读产物的裁判。**

**这不是新立场**：内部设计文档 `2026-09-21-adversarial-execution-control-optimization.md` §2.2 早已把可采性写成**记录上的五条合取式**（covered / discharged / grounded / bounded / consistent），并写明 *"LLM 提供假设与反例；可采性由确定性代码在可审计产物上判定"*。本文补的是它没做完的一半：**那五条里，今天的判定仍然读了一个"过程事实"。**

### 2.2 那唯一的耦合点，以及它为什么可以移除

| 合取式 | 需要什么 | 谁提供 | 平台耦合 |
|---|---|---|---|
| **covered** 每个判据/路径被某假设 claim | 读记录 | kata | 无 |
| **discharged** 每个假设都收敛且带引用 | 读记录 | kata | 无 |
| **grounded** 每个引用能在该 revision 打开 | 读仓库 + 内容摘要 | kata | 无 |
| **bounded** 没有假设被资源限制放弃 | 读记录的 outcome 字段 | kata | 无 |
| **consistent** 已确认缺陷都在 findings 里 | 读记录 | kata | 无 |
| ~~**receipt 存在**~~（今天的第六条） | **一个 kata 启动的进程** | **宿主** | **有** ← 唯一 |

而"只读"这件事，kata **自己就能观测**（"轮次结束时工作区内容是否漂移"，`kata-cli lane`）——不需要任何流。**"写完再改回来"是无痕的，但它对下游无影响**：内容被撤销了，而 kata 的反例/变异运行发生在**冻结的树上、之后**。

### 2.3 真正必要的三件（**与任何标准无关**）

1. **判据读产物**，不读过程（把 receipt 从判定合取式里移出）。
2. **归属**：某个字段能说明"这次工具调用属于哪个会话"——**名字自定**（见 §2.4 为什么不用标准的名字）。
3. **弱证据分级并显示**（`observed` / `relayed` / `held`）：不是"接受自述"，而是**让弱处可审计**。

### 2.4 明确**不采纳**的（及理由）

| 被提供的 | 决定 | 理由 |
|---|---|---|
| **OTel `gen_ai.agent.id`** | **拒绝（取其形，不取其名）** | 语义**相反**：约定说该字段 SHOULD 是"provider-assigned stable identifier of the agent resource"，且 *"It's NOT RECOMMENDED to record in-memory agent instance ids on this attribute"* —— **而我们需要记录的正是 in-memory instance id（哪个会话）**。照抄名字却实现相反含义 = "名字宣称了代码没有的意思"（本仓库最常抓的缺陷类，已八次）。**值得取的是结构**：工具调用**嵌套**在发出它的 agent 之下。 |
| **Sigstore keyless 签名 + in-toto 外壳** | **延后，触发条件写明** | 签名回答"**谁**签的"，而 §2.3 的结论是"谁"可以丢弃（独立性来自启动参数，不来自身份）。单仓库内，门读自己的库，登记表 + git 历史已提供防篡改。**它只在凭证需要"旅行"（跨机器/跨组织/给外部审计者）时才必要。** |
| **哈希链审计日志** | **延后（同一触发条件）** | 价值在"第三方离线重走"；现在没有第三方。 |
| **`bwrap`/Landlock 内核隔离** | **宿主侧选项，非 kata 改动** | 价值最高的地方是**没有流可反驳**的场景（转述路线）。 |

### 2.5 残留极限（**这是真极限，且与平台无关**）

> **省报（omission）不可检出**：证据能证明"报了的都是真的"，**不能证明"没漏"**。
> 缓解：① 覆盖要求（每条判据/路径必须被某假设 claim）；② 类覆盖检查（回归会随时间暴露）；③ 可选 quorum。
> **但它绝不保证**：一个诚实声称"我查过 AC-1..AC-6，没发现问题"的会话，其**诚实**无法被验证。**这是"不可信提案者"范式的边界，不是平台缺陷。**

---

## 3. 方案：五步迁移 [提案]

> 原则：**每一步单独提交、单独可回滚**；**每一步都不放松任何反驳规则**；每一步都有验收（见 §3.6）。

| # | 步骤 | 落地内容 | 解锁什么 |
|---|---|---|---|
| **1** | **把 `executedInFreshContext` 移出判据** | 降为记录元数据（质量指标：显示，不拦） | 立刻解锁两个卡住的 change；不改变任何反驳规则 |
| **2** | **每条 finding 必须"可复现"或"声明不可复现 + 类名"** | schema + brief + 门；反例由 kata 自己跑并记录 `{before, mutated, after}`（机制**已存在**） | 产物自我反驳 ⇒ **伪造的记录产不出会红的检查** |
| **3** | **去掉 `requiresExecutionReceipt` 对 escalated 档的硬性要求** | "只读"改由 kata 自观内容漂移 + 引用声明守卫承担；`provenance` 分级引入并显示 | 任何平台都能跑完整流程 |
| **4** | **`execute` 降级为可选路线** | `observed` 等级仍可用于 CI 或想要更强证据的档位；不再是必经 | 去掉子进程编排、凭据、登记表的必要性 |
| **5** | **基准语料验收** | 内部设计文档 §4 Phase 0 的语料（历史缺陷、种子缺陷、变异、已知良好 revision）+ 指标 `criticalRecall`/`falsePassRate`/`reproducibility` | 让 1–4 都可被证伪 |

### 3.6 每一步的验收（可机械核验）

| 步骤 | 验收 |
|---|---|
| 1 | 两个卡住的 change 通过 review（记录 `satisfied: true`），**且**它们的 findings 仍受反例/类覆盖约束 |
| 2 | 一条"只报不证"的 finding 被拒（用例）；一条真正的缺陷 + 反例被接受（用例）；变异：删掉反例 ⇒ 门拒绝 |
| 3 | 在没有 `--executor` 的环境上跑完整流程（brief → agent 子代理 → record → verify → judge → archive） |
| 4 | 语料上 `observed` 与 `result-observed` 两条路线的 `criticalRecall` 差异被**测量**（而不是假设） |
| 5 | 每一步报 delta；无 delta 不落地 |

### 3.7 skill + agent-first 的流程（去掉 execute / receipt / registry 后的目标形态）

```
1. kata adversarial brief --emit-request packet.json      ← kata 产包（纯文本）
2. agent 加载 /kata-review-round（skill）
     └─ agent 用【自己平台的子代理机制】spawn 审查子代理（工具表由平台限制）
        └─ 子代理读 brief → 写记录（每条 finding 带反例，或"不可复现 + 类名"）→ 写文件
3. kata adversarial record --from-file record.json        ← kata 判 §2.2 五条 + 内容未漂移
4. kata verify / judge / archive                          ← 不变
```

---

## 4. 请评审者攻击的问题（**这部分是本文的重点**）

| # | 问题 | 我们的立场 | 需要的反驳 |
|---|---|---|---|
| **Q1** | 把 `executedInFreshContext` 移出判据，是否让 `strict` 档名不副实？ | 判据读产物；一轮"敷衍但覆盖完整、反例齐全"的审查，其**结论仍被验证**。过程不可观测的代价是**无法区分认真与敷衍**，只能靠覆盖 + 反例 | 是否存在"敷衍也能满足五条合取式"的构造？若有，请给出 |
| **Q2** | "每条 finding 必须可复现"是否会**收窄一轮能报什么**（散文级发现被迫进类表）？ | 是真实约束，我们接受；类表是它的出口 | 类表是否够用？哪些类型的发现无法表达为"类 + 可红检查"？ |
| **Q3** | 省报不可检出（§2.5），对 `strict` 档是否可接受？ | 接受，并显式化；quorum 是可选缓解 | 是否有**非 quorum** 的检测手段？（例如对同一 revision 的两轮做假设集合差异分析） |
| **Q4** | "工作区内容未漂移"是否能替代 `read_only_fs`？ | 能覆盖"留下的改动"与"修好再报无缺陷"两类；**无痕写入不影响下游**（反例运行发生在之后、冻结树上） | 是否存在"无痕写入影响了下游"的构造？ |
| **Q5** | `provenance` 分级会不会导致**逐底竞争**（弱等级成为默认）？ | 门按档位决定接受哪一级；`held` 永不接受 | 分级是否应带**成本**（例如弱等级要求 quorum）？ |
| **Q6** | 判据从"过程"移到"产物"后，**审计语义是否仍成立**（SOC2/ISO 类审计要求"谁在何时审了哪个版本"）？ | 我们保留"**什么时候审了哪个 revision**"（凭据非必需）；"谁"在单机场景可丢弃 | 若需要对外审计，是否必须回到 `observed` + 签名？代价多大？ |
| **Q7** | 如果**仓库本身不可运行**（无测试/无构建），"反例可复现"退化，方案是否崩塌？ | 退化到"类覆盖 + 覆盖要求"，强度下降 | 这类项目应使用哪一档？是否需要显式降档路径？ |
| **Q8** | `grounded`（引用必须能在该 revision 打开）今天部分只是命名规则；五条合取式里有多少是**真正可判**的？ | 本文 §2.2 的判定表是我们的自评 | 请逐条核对我们的自评，指出哪几条实际不可判 |

---

## 5. 关联文档

| 文档 | 内容 |
|---|---|
| `docs/design/2026-09-26-platform-decoupled-round-methodology.md` | 本方法论的设计稿（含迁移细节与限度） |
| `docs/design/2026-09-26-decoupled-round-protocol.md` / `-plan.md` | 轮协议本身（宿主只启动+描述，kata 判并写凭据） |
| `docs/design/2026-09-25-why-review-does-not-converge.md` | 为什么审查不收敛（六层、三个结构问题、九处缺陷） |
| `docs/design/2026-09-25-record-production-experiment.md` | 无记录轮次的对照实验（有/无数字期限） |
| `docs/design/2026-09-21-adversarial-execution-control-optimization.md` | 判定基础（五条合取式）与优化路线 |
| `docs/design/2026-09-24-the-fifth-class.md` | 缺陷类表（7 类）与"类 vs 实例"的分界 |

---

## 6. 证据附录（可复核）

### 6.1 判定里唯一的过程事实

```bash
$ grep -n "requiresExecutionReceipt" src/quality/adversarial.ts
3088:        requiresExecutionReceipt: task?.workflowProfile?.reviewMode === 'strict' || … === 'security',

$ grep -n "describes as fresh is not a capability" src/quality/review-execution.ts
189:  detail: `no execution receipt was recorded, so ${request.node} cannot be certified:
        a context the agent describes as fresh is not a capability`,
```

### 6.2 只读可由 kata 自观（不需要流）

```bash
$ kata-cli lane --change round-protocol --json
{ "revisionStatus": "superseded", "driftedPaths": ["docs/design/2026-09-25-why-review-does-not-converge.md"], … }
# 漂移是 kata 对比"revision 的内容摘要"与"工作区内容"得出的
```

### 6.3 转述路线：契约描述它，`record` 拒绝它

```bash
$ kata-cli adversarial record --change <id> --node review \
      --from-file <record.json> --receipt-file <relay-shaped-receipt.json>
{ "recorded": false, "reason": "receipt_unwatched",
  "error": "no run with id relayed-subagent-1 was executed by this repository —
            a receipt is evidence of a round kata watched, and a receipt with no run behind it is a file." }
```

### 6.4 平台不提供子代理的工具调用归属

```bash
$ pi -p --mode json --no-session --subagents-workflow-file=/tmp/wf-probe2.js "run the workflow" > stream.jsonl
$ python3 - <<'PY'
# 统计 tool_execution_start 的 toolName，并检查是否存在任何 agent 归属字段
PY
tool 调用（全部混在一起）: {'bash': 17, 'read': 5, 'ctx_search': 1, 'fffind': 1, 'ask_user': 1}
能区分 agent 的字段: 【一个都没有】   # 逐一查 agentId / sessionId / jobId / parentId / thread
子代理事件是否嵌套在父工具结果里: 0 条
```

平台对子代理的机器可读视图（工具自述）：`subagent_inspect` *"returns one privacy-filtered snapshot of retained rounds
**without exposing task text, complete child output, prompts, selected tools, context, credentials, or broker messages**"*。

### 6.5 观测路线确实能端到端跑通（反例的反面）

```bash
$ kata-cli adversarial execute --change round-protocol --node review \
      --packet tmp/rp8-packet.json --executor "node host/pi-adapter.ts" --receipt-out tmp/rp8.receipt.json
{ "status": "executed", "receiptStatus": "completed",
  "capabilities": ["fresh_context","read_only_fs","bounded_tools","budget_enforced"],
  "telemetry": { "toolCalls": 168, "outputBytes": 1217449, "tokens": null, "truncations": null } }
# 随后：gate satisfied:true → review 批准 → judge PASS（AC-1…AC-6）→ archive
```

### 6.6 无记录轮次
- 在 `round-protocol` 上，kata 启动的 **5 次运行**的登记表实测为：**3 次 `completed`、2 次 `executor_unavailable`**（即 2 次没有产出记录，工具调用数 107 / 41，输出 874 KB / 534 KB），另有 1 次的记录因 `undeclared_test_path`（引用了未声明的测试）被门拒。**此前同一批内容上连续 4 次派发未产出可接受记录。**
- 其中两次无记录的转录分别 **139 MB** 与 **21.7 MB**，而后者的转录里 **assistant 文本为 0 字符**（全部时间在推理）。
- 本线累计 **62 轮中 28 轮**未交出记录。
- 在 **brief 内写入数字期限**（"by tool call 71 of this round's 215"，数字由包络常量派生）之后，下一轮 **168 次工具调用、1.19 MB 输出、记录被接受**。
- **74 轮** `kata-reviewer` 子代理：新上下文与只读工具表**均为真**，**零凭据**。

### 6.7 环境与规模

```
193 个测试文件 / 1327 个测试 / 0 失败  ·  worktree clean
类表 7 条，每条有具名覆盖检查，全部变异验证会红
```

---

## 7. 术语表（供外部评审者）

| 术语 | 含义 |
|---|---|
| **revision** | 由内容摘要（`pathDigests`）决定的一次冻结；内容变则 revision 变 |
| **轮次 / round** | 一次独立审查会话，提交一份记录 |
| **记录 / record** | 该轮的 JSON 产物：`hypotheses` + `findings` + 声明（`readTests`/`wroteTests`） |
| **凭据 / receipt** | 说明"这一轮在受控条件下跑过"的产物；今天由 kata 启动的进程产生，由 kata 写出 |
| **观测路线 `observed`** | kata 启动进程、读流、计数、反驳、写凭据 |
| **转述路线 `relayed`** | 事件由非 kata 的一方产生，带会话标识与平台完成报告原文 |
| **反例 / falsifier** | 把缺陷放回去，观察某个检查是否变红；由 kata 自己运行 |
| **类 / class** | 一组同句式的缺陷（7 类）；每类必须有一条会红的覆盖检查 |
| **义务 / obligation** | 一条必须被"反例 / 缺席记录 / 类覆盖"之一答复的发现 |
