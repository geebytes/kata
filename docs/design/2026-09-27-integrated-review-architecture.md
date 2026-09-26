# 整合：评审体系的重新设计（外部评审结论 + 我方协议设计 + 路线图）

> **本文是三份输入的整合**，并按"一致 / 对我方的修正 / 我方对外部的回应 / 仍需人决策"四类标注。
>
> | 输入 | 是什么 |
> |---|---|
> | `docs/design/2026-09-26-round-certification.md` | 我方对现状的**诊断**（17 条问题 · 12 条需求 · 10 个待反驳问题 · 证据与命令） |
> | `docs/design/2026-09-26-clean-sheet-review-protocols.md` | 我方在 clean sheet 上设计的 **5 套竞争协议** + 对抗场景矩阵（已并入本文） |
> | **`docs/review2.md`（外部评审）** | 外部专家评审结论：**5 个根因 · 3 处对我方的修正 · 目标架构 · Protocol v2 契约 · 路线图 · KPI · 风险矩阵** |
>
> **结论先行**：外部评审**没有推翻方向**（"不可信提案者 + 小型确定性裁判"），但**在三处修正了我方**，其中一处是**我文档里写错的一句话**（见「修正 1」）。
> 整合后的目标形态是一个三层结构：**确定性证据内核（唯一必须平台无关的真源）+ 风险自适应评审网格（买质量）+ 可选 assurance overlay（买过程可信）**。

---

# 第 1 部分 整合后的判断

## 1.1 问题的重新表述

外部评审给的重新表述比"17 条问题"更有解释力，我接受：

> **现有方案的核心问题已不是"如何把某个平台的独立审查会话认证得更可靠"，而是把四种不同性质的问题挤进了同一个"轮次认证"机制**：
> **① 评审质量 · ② 执行过程可信 · ③ 成本治理 · ④ 平台适配。**
> 后果是**任何一项加强都会放大另外几项的成本**：为证独立性而绑定宿主执行过程（④↑）；为保证 revision 一致而让修复立即作废刚完成的审查（③↑）；为追求 finding 清零而形成开放循环（③↑）；为避免漏审又不断加轮次（③↑）。

**这解释了我方诊断里那几条看起来互不相关的现象**（P1 认证被修复作废 · P3 终止条件开集 · P7 档位卡住 · P13 成本不可见）：
它们不是四个缺陷，而是**一个机制承担四件事**的四个症状。**⇒ 修法是把它拆成四件事，而不是把每一件做得更好。**

## 1.2 目标形态（一句话）

> **把稳定、平台无关的评审语义缩成一个很小的确定性 Evidence/Policy Kernel；把 LLM、人、静态分析、变异测试、各平台 agent 都视为可替换的 evidence producer；用风险路由决定何时单评审、何时 quorum、何时人工升级；用 delta certification 复用未变化内容的证据；把执行过程证明、沙箱、签名与外部审计降为独立的 assurance overlay，而不是所有质量判定的硬前置。**

## 1.3 与现状的关系（一张表）

| 现状组件 | 处置 | 理由 |
|---|---|---|
| `pathDigests` / revision 内容寻址 | **留，且升格为 evidence reuse key** | 内容寻址本身是对的（它保住了真实性）；错的是**复用粒度太粗** |
| `lane`（顺序状态） | **升格为 dependency scheduler 的输入** | 顺序需要成为机制，而"状态标签"只是第一步 |
| falsifier ledger（`{before, mutated, after}`） | **留，作为最强的 evidence provider 之一** | 它已经是最接近"确定性裁判"的东西 |
| 7 类 defect coverage + `roundMayClose` | **留，但只承担 protocol closure** | 它**不足以**承担"无遗漏"的隐含保证 |
| `executedInFreshContext` 在质量判据里 | **移出质量判据** | 见「修正 4」：它属于另一条正交的轴 |
| 轮协议（流式 · 能力反驳 · 凭据 · 登记表） | **降级为可选 assurance overlay** | 想留过程级证据的人仍可用它 |
| brief 内数字期限 | **留**（实测唯一有效的成本杠杆：0/4 → 6/6） | 无记录轮次的首要原因是"停止"，不是"通道" |
| 严重度门（已存在但未用） | **立即真正启用** | 外部评审与我方都把它列为**无需新架构即可拿到的低风险收益** |

---

# 第 2 部分 收敛点：三个独立来源得到同一结论

**下表里"两个独立来源一致"的条目，比单一来源的结论更可信**（这也是把外部评审纳入的价值）。

| 命题 | 我方诊断（内部） | 外部评审 | 判定 |
|---|---|---|---|
| **认证单位太大** | P1/P4 + claim ledger（单元改为 claim） | **根因一**：最小认证单位是"整篇 × 整轮"，病在**复用粒度**而非内容寻址 | **一致**，外部把病因说得更准（粒度，不是寻址） |
| **终止条件 ≠ 质量条件** | P3（终止条件是开集） | **根因二**：三层定义 —— protocol closure / evidence sufficiency / quality confidence | **一致，且外部更精确**（本文采纳三层） |
| **过程认证应移出质量判据** | 把 `executedInFreshContext` 移出判据 | **根因四**：两条正交轴 `qualityEvidence` ⊥ `executionAssurance`，由 threat model 驱动 | **一致**，外部把"移出"补成"移到另一条轴" |
| **顺序必须成为机制** | P5 + `lane` 三态 | **根因五**：把 change 视为轻量 MVCC/merge-queue（digest 集合相交判并行/串行，上游变化只失效依赖锥） | **一致**，外部更完整 |
| **证据语言不能只有反例** | 我方把它列为"残留极限"（可复现性只覆盖一部分 finding） | **根因三**：升级为**证据类型系统** + 按严重度定最低证明强度 | **我方过窄**，采纳外部方案 |
| **不要采用语义不符的标准词汇** | §3.4 拒绝 OTel `gen_ai.agent.id`（语义相反） | Protocol v2 里"刻意使用自定义 `reviewer.instanceId` …… 标准名称只有在语义真正一致时才值得采用" | **独立得出同一结论**（两侧都拒绝为标准化而标准化） |
| **签名不解决语义质量** | 延后 Sigstore/in-toto 到"凭证需要旅行"时 | 同上 + 附加治理规则："签名有效"**只**推出"某身份针对某 digest 作过声明"，**绝不**推出"结论在语义上正确" | **一致**（外部给出了更锋利的表述） |
| **无人值守 vs 人** | 人已是 `review_gate` 的认证者 | 人工只处理机器难判定且高风险的**剩余集** | **一致** |

> **可验证性备注**：外部评审引用的 NIST AI RMF、SLSA、in-toto、Sigstore、OPA、CloudEvents/AsyncAPI、Google mutation testing、LLM-as-judge 偏差研究等，**我没有逐条独立复核**（SLSA 的 `builder.id` 一项我方此前已自行核对过）。它们在此作为**评审方的依据**，而不是本仓库的实测结论。

---

# 第 3 部分 对我方的修正（**接受，并说明据此改了什么**）

## 修正 1（最重要，因为它推翻了我写错的一句话）：**产物正确 ≠ 执行过程安全**

外部评审给出的反例是致命的：

> 一个 agent 可以**临时把敏感内容发送到外部**，然后把工作区恢复成**完全相同的 digest**。最终内容未漂移**并不能证明"从未发生数据泄漏"**。

**⇒ 我此前写的"写完再改回来是无痕的，但它对下游无影响"（在两处）只支持【内容一致性】，不支持【保密性】。**

**已改**：`2026-09-26-round-certification.md` 的 §3.2 与 Q4 两处已改写 —— 明确"这条观测只能支持内容一致性"，并指出若某档的威胁模型包含保密性，就必须回到 `sandboxed`/`observed` 的 assurance 层。
**新增**：`qualityEvidence` ⊥ `executionAssurance` 两条正交轴（见 §5.5）。

## 修正 2：**R4 改为 delta certification**，不是"修复不作废本轮"

我原来的 R4（"修复本轮 finding 后不作废本轮"）**被外部评审明确否决，我接受**：

> 修改过的代码客观上已经不是被审查的代码。正确做法是 **delta certification**：**未变化的 digest 继续复用已获得的证据；修改的路径及其依赖影响锥重新验证**；依赖无法可靠推导时 **fallback 到 full review**。

**⇒ 保住了"审查只认证真正看过的内容"，同时避免"一个小修复重花 350K–660K tokens"。**
（外部引 Google 的大规模 mutation testing 作类比：只对 changed code 做 mutation，并过滤低价值 mutant。）

## 修正 3：**R2 从"必须有反例"升级为"证据类型系统"**

我原来的 R2（每条 finding 必须带反例，否则声明不可复现并挂类）**过窄**：它会**系统性排斥**架构风险、隐私泄漏设计、威胁模型缺口、跨文件不变量、API 兼容性、可维护性等**难以构造成单一红测**的高价值 finding。

**采纳证据类型系统 + 按严重度定最低证明强度**：

| `evidence.type` | 说明 | 典型适用 | 自动可重放 |
|---|---|---|---|
| `executable_falsifier` | 去掉/注入缺陷后某检查变红 | 逻辑回归、门规则、测试完整性 | **是** |
| `static_witness` | 位置、调用链、数据流或 AST 事实直接证明 | 权限绕过、未校验输入、死代码 | 是（重跑分析） |
| `invariant_proof` | 违反一个明确、机器可计算的不变量 | 同一事实多派生、schema/实现不一致 | 是 |
| `cross_artifact_contradiction` | 文档/schema/代码/测试之间相互矛盾 | 本线 P12 类（"声明比做的多"） | 是 |
| `expert_concurrence` | 难以机器化的架构/威胁建模判断，由独立评审者共识支撑 | 架构风险、隐私、可维护性 | **否** ← 见 §4.3 对其加的限制 |

**改写后的 R2**：**每个 finding 必须有适合其类型与严重度的、可质疑、可复核的证据**；blocking/security 要求最强证据，minor/nit **不值得**为制造一个 falsifier 再花一整轮成本。

## 修正 4：终止条件拆成**三层**，不再混为一谈

| 层 | 定义 | 能否证明 |
|---|---|---|
| **① Protocol closure** | 本轮所有 obligation 都有合法状态，无悬挂项 | **可确定性证明**（现有 `roundMayClose` 只做到这一层） |
| **② Evidence sufficiency** | 重大 finding 达到要求的证据强度 | **可机械验证**（按严重度查证据类型） |
| **③ Quality confidence** | benchmark / shadow / quorum **统计上**达到该档风险容忍度 | **只能通过持续测量获得置信度** |

**⇒ 系统不再声称解决了逻辑上无法证明的"无遗漏"**；`roundMayClose` 只负责第 ① 层。

## 修正 5：`provenance` 从三级扩为**五级 assurance**，且**由 threat model 驱动**

| 级别 | 含义 |
|---|---|
| `none` | 无任何过程证据 |
| `relayed` | 事件由非 kata 一方产生，带会话标识与完成报告原文 |
| `observed` | kata 启动进程、读流、计数、反驳、写凭据 |
| `sandboxed` | 有内核/容器级隔离（含出网控制），可支持保密性主张 |
| `signed` | 跨信任边界的身份绑定签名 + 透明日志 |

**档位策略**（不是"strict 永远需要 receipt"，也不是"strict 永远不需要"）：`standard` 接受 `none/relayed`；`strict` 由 threat model 选 `relayed/observed`；`security` 在涉及秘密、恶意代码、供应链攻击时可要求 `sandboxed`；跨组织再要 `signed`。

---

# 第 4 部分 我方对外部评审的回应（**同意 / 限定 / 补充**）

## 4.1 同意（无保留）

- **Ports & Adapters 是必选基础**：domain 只定义 Review/Evidence/Decision ports，各平台实现 adapter。**新增平台不改 kernel** —— 这正是"平台解耦"的可测形式。
- **不要先上事件总线、不要先拆微服务**：瓶颈是信任语义与重复工作，不是某个服务要独立扩容。`CloudEvents`/`AsyncAPI` 只在**多平台多团队、需要重放与跨团队治理**时引入，且**业务 schema 仍是真源，传输 schema 不支配 domain**。
- **in-toto/Sigstore 只在跨边界时引入**；**区块链不应成为默认**（单组织已有明确信任根时，多方共识不解决新的质量问题）。
- **众包/市场化不能作为企业源码评审的默认后端**（IP/商业秘密风险 + 投票可被策略性操纵）。
- **成本口径改用 `C0`**（相对量级，不绑定某供应商价格），且外部对这个数的算法**是对的**：`350K–660K / 0.548 ≈ 0.64M–1.20M tokens per non-zero record`（保守下界）。
- **"预算耗尽永不等于 PASS"** —— 必须返回 `deferred` / `needs_more_evidence` / `escalate`。否则"成本进入正确性谓词"会制造危险激励：越少看越容易满足成本条件。**这一条应写进 kernel，而不是留在文档里。**

## 4.2 限定（同意方向，但不能这样写进验收）

| 外部结论 | 我的限定 |
|---|---|
| standard 目标 `0.30–0.60 C0`、strict `0.60–1.00`、security `0.90–1.50` | 外部自己也标了"**尚待实测验证**" ⇒ 这些是**规划值**。**不应写进验收标准当承诺**（写成承诺就会变成下一个"看起来解决了"）。验收应先要求"基准可测"，再由基准给出目标 |
| ≥100 个 shadow decision 才切生产 | 同意方法（避免用 0/4→6/6 这种小样本承担方法论结论），但**100 不是统计门槛**，外部的措辞也谨慎。建议改为"**每个风险档至少 N 个样本，且覆盖三类样本组**" |
| 6–8 周试点 / 12–18 周生产化 | 这是工程估算，且**依赖"基准语料"这一前置是否存在**。若语料本身要 2 周，则其它阶段才可能并行 |

## 4.3 补充：**外部评审没给、但我认为必要的四条新检查**

外部评审把模式摆对了位置，但它的 KPI 与缓解措施里**有四处会漏**（都是本仓库反复出现的那个类：**一个声明宣称的比它度量的多**）：

| # | 缺口 | 我要加的东西 |
|---|---|---|
| **①** | **Platform Coupling Index**（核心模块里平台专属类型/分支的数量 → 目标 0）**测不到语义漂移**：adapter 可以"类型上合格、语义上不同" | **加一条 cross-adapter differential test**：**同一 artifact 在两个 adapter 上必须得到同一个 decision**（否则"内核平台无关"只是类型层面的声明） |
| **②** | **risk scorer 的"不可学习的最低 risk floor"** 很好，但**没规定 floor 本身怎么被审计** | **floor 的变更也必须走同一套评审**（否则它就是绕过门的后门）；floor 与 scorer 的改动进入 `classInstances` 与变更记录 |
| **③** | `expert_concurrence` 是**最弱的证据类型**（它把"两个评审者都这么说"变成证据） | **禁止它单独支撑 blocking/security**：要么必须带人类签字，要么只能用于非阻断结论。否则 S3（遗漏）会被**重新包装成证据** |
| **④** | `Shadow Miss Rate`（已 PASS 的 change 被随机二审发现新重大问题的比例） | **它是持续指标，不是上线门槛** —— 一旦写成门槛，就会为了达标而减少二审，指标反而失真 |

---

# 第 5 部分 目标架构

## 5.1 三层

```
┌──────────────────────────────────────────────┐
│ Assurance Overlay（可选，按风险开启）          │  沙箱 / 身份 / 签名 / 审计 / 外部 provenance
└───────────────────┬──────────────────────────┘
                    │ 仅当 threat model 要求
┌───────────────────▼──────────────────────────┐
│ Adaptive Review Mesh                          │  静态分析 · LLM · quorum · 人
│ 风险路由 / 成本预算 / 证据生产者可替换          │
└───────────────────┬──────────────────────────┘
                    │ evidence
┌───────────────────▼──────────────────────────┐
│ Deterministic Evidence Kernel                 │  subject / evidence / policy
│ delta reuse / decision                        │  ← **唯一必须所有平台共同实现的真源**
└──────────────────────────────────────────────┘
```

## 5.2 `ReviewRecord v2`（契约；**core 里不出现任何平台概念**）

```jsonc
{
  "apiVersion": "review.kata.dev/v2",
  "kind": "ReviewRecord",
  "subject":  { "revision": "rev:8f2…", "pathDigests": { "src/…": "sha256:…" } },
  "reviewer": { "instanceId": "review-run-01J…",   // 自定义：就是一个临时运行标识
                "adapter": "platform-a",
                "executionAssurance": "relayed" }, // none|relayed|observed|sandboxed|signed
  "coverage": { "criteria": ["AC-1","AC-2"], "paths": ["src/…"] },
  "findings": [{ "id": "F-17", "severity": "major", "class": "single-source-of-truth",
                 "impact": ["AC-2"],
                 "evidence": { "type": "invariant_proof", "ref": "evidence:sha256:…" } }],
  "usage":    { "toolCalls": 168, "durationMs": 412000, "tokens": null }   // 不可测记 null
}
```
**刻意保留的边界**：`reviewer.instanceId` **自定义**，不映射到语义不同的标准字段；平台专属字段进 adapter extension，**不进 core schema**。

## 5.3 决策输出必须区分"不通过"与"信息不足"

```jsonc
{ "decision": "escalate",
  "reasons": ["high_risk_change", "reviewer_disagreement"],
  "reusedEvidence": ["evidence:sha256:old-unchanged-1"],
  "revalidatePaths": ["src/quality/adversarial.ts", "src/quality/class-coverage.ts"] }
```
**三分**：`pass` / `fail` / `insufficient`（后两者**永不**等价；预算耗尽只能落进 `insufficient` 或 `escalate`）。

## 5.4 风险路由与 **delta revalidation**（把 change 当轻量 MVCC）

```
A ∩ B = ∅                → 可并行
A ∩ B ≠ ∅（只读）        → 可并行评审，合并时 revalidate
A ∩ B ≠ ∅（写）          → 建立先后依赖 / lease
上游变化                  → 只失效 dependency cone 内 evidence
依赖无法可靠推导           → fallback 到 full review
```
`ReusableEvidence = Evidence_old ∩ UnchangedDigests ∩ UnchangedDependencies`

## 5.5 两条正交轴（修正 1 的落地）

| 轴 | 回答什么 | 字段 |
|---|---|---|
| `qualityEvidence` | finding 是否成立、coverage 是否闭合、决策是否合理 | findings / evidence / coverage / subject digests |
| `executionAssurance` | 谁/什么环境运行、能否写、有无网络、可否审计 | `none / relayed / observed / sandboxed / signed` |

## 5.6 quorum 规则（含一条不可被投票抹掉的规则）

```
低风险：1 reviewer + 确定性证据
中风险：1 reviewer，出现 uncertainty / 新类 / 弱证据 → 第 2 个
高风险：默认 2 个；finding 或 coverage 分歧 → 第 3 个；critical/security 分歧仍在 → 人
**任何可复现的 blocking/security finding 不能被简单多数票静默抹掉**
```
多 reviewer 必须形成**错误多样性**（不同 model/provider/提示策略，或一个偏静态不变量、一个偏对抗行为），否则只是**付两倍钱得到高度相关的错误**。

## 5.7 自动化边界

**机器**：静态检查 · coverage closure · subject identity · severity policy · finding evidence schema · mutation replay · 重复 finding 聚类 · delta invalidation · 预算调度。
**人**：威胁模型 · 架构风险 · 隐私 finding · 无法执行的高严重度证据 · 多 judge 冲突。

---

# 第 6 部分 与现有代码的映射

| 现有 | 处置 | 具体动作 |
|---|---|---|
| `src/quality/revision*` · `pathDigests` | 留 + 升格 | 成为 evidence reuse key；新增 `UnchangedDependencies` 判定 |
| `src/cli/lane.ts` | 留 + 扩 | 从"三态标签"扩为 dependency scheduler 的输入（MVCC 规则） |
| `kata-cli falsify`（账本） | 留 + 强 | 作为 `executable_falsifier` 类型；**补两侧**（`fails_on` / `passes_on`） |
| `src/quality/class-coverage.ts` · `roundMayClose` | 留，**收窄语义** | 只承担 **protocol closure**（第 ① 层）；文档与输出不得宣称"无遗漏" |
| `src/quality/adversarial.ts`（gate） | 改 | `requiresExecutionReceipt` 从质量判据移出；改为查 `executionAssurance` 是否满足该档 threat model |
| 轮协议（`round-protocol/runner/registry`） | 降级 | 成为 assurance overlay 的一个 provider，不再是必经 |
| `review.json` schema | **换版** | `ReviewRecord v2`（证据类型系统 + 三分决策 + usage 记 null） |
| **新增** | risk scorer + 抽样升格 | 含 **floor 变更须走同一套评审** |
| **新增** | 证据类型校验器 | 按严重度检查最低证明强度（第 ② 层） |
| **新增** | cross-adapter differential test | 同一 artifact 在两个 adapter 上必须同一 decision（§4.3 ①） |
| **新增** | benchmark 语料 + 指标仪表盘 | 一切比较的前置（无它则所有目标只能靠印象） |

---

# 第 7 部分 路线图与验收

## 7.1 顺序（外部评审的 P0–P4 与我方最小实验合并）

| 阶段 | 内容 | 为什么在这个位置 |
|---|---|---|
| **0. 立刻可做（零新架构）** | **真正启用严重度门**（minor/nit 不再驱动 repair/revision）· 保留 brief 内数字期限 · **E1：把某个 change 的 AC 从"有通过的证据"改为"有一个会变红的变异"** | 这三件**不需要任何架构决策**，且 E1 直接给出"证书模型是否更好"的第一手数据（检查器 `falsify` 已存在） |
| **1. 基线与语料** | 历史 review corpus · seed 缺陷 · known-good revision · 定义 `C0` · 指标仪表盘 | **没有它，后面每一步都无法验收** |
| **2. Evidence Kernel + Protocol v2** | 证据类型系统 · quality/assurance 两轴分离 · 纯函数 gate · 旧记录转换器 | 这是"真源"的替换 |
| **3. 风险路由 + delta revalidation** | risk scorer（含 floor 审计）· 严重度策略 · dependency cone · evidence reuse · 成本调度 | 成本主引擎 |
| **4. Adaptive Quorum + 人工升级** | 分歧度量 · 第二/三 reviewer · 人工队列 | 质量保险层 |
| **5. 多平台与审计扩展（可选）** | 第二/三个 adapter · 可选 CloudEvents/AsyncAPI · in-toto/Sigstore overlay | 只在规模或边界要求时 |

## 7.2 验收（非劣性 + 成本，**不要求与旧系统完全一致**）

```
CriticalRecall_new  ≥ CriticalRecall_baseline
FalsePass_new       ≤ FalsePass_baseline
Cost_standard,new   ≤ 0.6 × C0          ← 待 benchmark 校准后才可写死
no-record rate       < 2%
full stale re-review ↓ ≥70%
blocking/major evidence ≥95% 可重放
gate mutation kill   = 100%
新平台接入            不修改 Policy Kernel
预算耗尽              永不转化为 PASS
```
**试点必须覆盖三类样本**：低风险（docs/小逻辑）· 中风险（跨文件 feature，会改测试）· **高风险（review gate / auth / schema / 共享核心文件）** —— 只测 happy path 证明不了什么。

---

# 第 8 部分 仍需**人**决策的分叉

| # | 分叉 | 选项 |
|---|---|---|
| **D1** | 档位定义 | (a) 改为"证据强度 + assurance 矩阵"（外部与我方推荐）；(b) 保留 receipt 硬依赖（则无宿主能力的平台永远跑不了） |
| **D2** | 是否采纳 **delta certification** | (a) 采纳（保内容一致性，复用未变证据）；(b) 维持"任何修复作废全轮"（成本线性） |
| **D3** | 审查者是否可以写 `challenges/` | (a) 允许（在两个 adapter 上做差分验证时才能证明它不是弱测试）；(b) 维持"Review 不得编写测试"（则反例只能以"配方"形式给出） |
| **D4** | `expert_concurrence` 能否支撑 blocking/security | (a) 禁止（我方建议，除非带人类签字）；(b) 允许（会把遗漏重新包装成证据） |
| **D5** | risk floor 的维护者与变更审计 | 必须有明确所有者，且 floor 变更走同一套评审 |
| **D6** | 是否投入 benchmark 语料 | (a) 投入（一切验收的前置）；(b) 不投入（则所有目标只能靠印象，包括我方的 E1–E5） |
| **D7** | 人工预算是否可接受 | standard 0–10 min · strict 10–30 min · security 按风险（外部建议值） |
| **D8** | 是否需要对外审计 | 需要则引入 `signed` + 透明日志（并遵守"签名 ≠ 语义正确"的治理规则） |

---

# 第 9 部分 修正记录（本文对既有文档做了什么）

| 被改的 | 原来 | 现在 | 依据 |
|---|---|---|---|
| `2026-09-26-round-certification.md` §3.2 与 Q4 | "写完再改回来是无痕的，但它对下游无影响" | "**只能支持内容一致性，不能支持保密性**"；保密性需 `sandboxed`/`observed` assurance | 外部评审的**修正 1**（数据外泄后可恢复同一 digest） |
| 需求 R4 | "修复本轮 finding 不作废本轮" | **delta certification**：复用未变证据 + 只重审影响锥；依赖不可推导则 full review | 外部评审的**修正 2**（改过的代码客观上是另一份代码） |
| 需求 R2 | "每条 finding 必须可复现或声明不可复现" | **证据类型系统**（5 类）+ 按严重度定最低证明强度 | 外部评审的**修正 3**（原表述系统性排斥架构/隐私/威胁模型类 finding） |
| 终止条件 | `roundMayClose`（单一判据） | **三层**：protocol closure / evidence sufficiency / quality confidence | 外部评审的**修正 2**（终止条件 ≠ 质量条件） |
| `provenance` | 三级 `observed/relayed/held` | **五级 assurance**（+`none`/`sandboxed`/`signed`），由 threat model 驱动 | 外部评审的**根因四** |
| `2026-09-26-clean-sheet-review-protocols.md` | 5 套协议 + 场景矩阵 | **并入本文**（协议 A/B 成为证据内核与 evidence provider，C/D/E 成为 mesh 的组成部分） | 本次整合 |
