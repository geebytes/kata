# 干净重构方案：评审子系统（不考虑兼容性）

> **立场**：**不做兼容层，不做渐进迁移，不保留旧 schema 与旧记录格式。** 旧机制里值得留的东西只有四件，它们被**原样搬走**（不是改写）：`pathDigests` 的内容寻址、`lane` 的漂移观测、`falsify` 的账本形状、以及"每条检查都必须能失败"的纪律。
> **范围与规模（实测）**：待重写/删除 `src` 约 **6,917 行**（其中 `adversarial.ts` 3,301 行）· schema `adversarial-review.schema.json` **611 行** · 相关测试 **45 个文件 / 7,062 行**。
> **目标**：周期 **8–12 周**（2–3 人）· `standard` 档评审成本目标 `≤0.6 × C0` · 平台接入**不改内核**。

---

## 0. 一句话结论

> **今天 6,917 行里的绝大部分，是在补偿一个设计选择 ——「一轮评审产出【一份文档】」。**
> 把"一轮一份文档"换成"**增量 claim + 可执行证据**"，补偿性机制全部消失：
> 无 salvage（不再有单通道产物）· 无引用守卫（不再问"这测试是谁写的"）· 无记录完整性协议（记录不再被信任，只有证据被验）· 无处置字母表（状态直接落在 claim 上）· 无批处理（delta 重开 claim）· 无替换关系链（没有轮次就没有替换）。

**⇒ 这不是"优化现有轮次认证"，是把它的存在理由拿掉。**

---

## 1. 新架构

### 1.1 三层（与平台的关系由层的边界决定）

```
┌─────────────────────────────────────────────────────────────┐
│ src/assurance/          （可选；**唯一允许出现平台名字的地方**）│
│   两支持久化 adapter（inline=observed · file=relayed）          │
│   沙箱 / 身份 / 签名 / 审计 —— 按 D8 留占位                      │
└───────────────────────┬─────────────────────────────────────┘
                        │ 仅当 policy 的 threat model 要求
┌───────────────────────▼─────────────────────────────────────┐
│ src/producers/          （可替换的证据生产者）                 │
│   静态分析 · mutation · LLM 评审 · 人 · quorum · planner       │
└───────────────────────┬─────────────────────────────────────┘
                        │ Evidence[]（内容寻址）
┌───────────────────────▼─────────────────────────────────────┐
│ src/kernel/             （纯函数 · 无 I/O · 无平台名）         │
│   subject · claim · evidence · delta · risk · policy · budget  │
│   ← **唯一必须所有平台共同实现的真源**                          │
└─────────────────────────────────────────────────────────────┘
```

### 1.2 数据模型（三种对象，替代今天的一整族对象）

```ts
// ① 主体：内容寻址的冻结
type Subject = { revision: string; pathDigests: Record<string, string> };

// ② 主张：认证的最小单位（不再是"一轮"）
type Claim = {
  id: string;                      // "C17"
  statement: string;               // 人可读；必须可被证据支持或推翻
  riskClass: RiskClass;            // 见 1.3
  severity: Severity;              // 【落地新增】证据强度下限由严重度决定
  dependsOn: DependencyRef[];      // claim id 或其它的路径摘要 → 依赖锥
  evidenceIds: string[];           // 【落地为 id + 顶层追加式列表，不是内联】
  challengeIds: string[];
  status: ClaimStatus;             // 'open'|'supported'|'refuted'|'insufficient'|'waived'
                                   // ← 这是**声明**；判定不读它（见下）
  at: string;                      // 【落地新增】由 store 盖章（作者侧度量的基准）
  reopens: number;                 // 【落地新增】作者侧成本：被反复重开的次数
  waiver?: { reason: string; at: string };
};

// **落地与本文档的两处不同，各有理由**
// ① 证据与反例是**顶层追加式列表**（`evidenceIds` / `challengeIds` 指过去），不是内联对象：
//    证据是"落盘即存在"的（D10），内联会让每加一条证据就重写 claim，`at`/`reopens` 随之漂移。
// ② `status` 是**声明**，判定从不读它（只有 `waived` 是"某人做过的决定"会被读）。
//    实际状态由 `evaluateClaim()` 从证据推导，`ClaimState` 有 **9** 个值：
//    supported / waived / unsupported / refuted / missing / inconclusive / stale / below_strength / challenged。
//    实测理由：成本报告曾显示"6 个 open"而同一账本判定 `pass`（§13.4 ⑦）—— 一个报告两半回答两个问题。

// ③ 证据：五类，每类有确定性的 verify()
type Evidence =
  | { type: 'executable_falsifier';        command: string; mutation: { file; find; replace } }
  | { type: 'static_witness';              ref: string; assertion: string }   // "contains:" | "not-contains:"
  | { type: 'cross_artifact_contradiction'; a: string; b: string; literal: string; comparator: 'literal-in-a-not-b'|'literal-in-b-not-a' }
  | { type: 'expert_concurrence';           reviewers: string[]; humanAck: string };  // ← 限制见 §6

// **四类，不是五类**（`the K2 gap`，见 §14）：原第五类 `invariant_proof`（"命令 exit 0 即不变量成立"）
// 已删除。它是旁边那类的一个**弱拼法** —— 唯一的差别是作者有没有声明让它变红的变异 ——
// 而弱拼法没有变异字段，于是**一个永远不会失败的检查可以获得 `supported` 并支撑一个 claim 通过**
// （实测：`bash -c "exit 0"` → supported → pass）。
// 既然检查的全部意义就是"它能失败"，那个说不出这件事的类型被删掉，而不是给它再加一条规则。
// 属性测试/类型级不变量现在写成"变异违反该不变量"的 falsifier。
// 另外：证据项**不再自带 `subjectRevision`** —— 判定陈旧的是**判决**记录的 subject，内核在那里比较；
// 项上的那一份是"有声明无消费者"（实测于类型合并）。
```

### 1.3 `RiskClass`（有限、可枚举 —— 替代"覆盖每一条路径"这个开集）

```
assumption · boundary · state_transition · privilege · failure_mode ·
rollback · concurrency · provenance · dependency · consistency
```
每个 claim 必须落在**至少一个**类里；planner 按类决定要求哪些证据类型。

### 1.4 决策（纯函数；三分，且"预算耗尽"永不等于通过）

```ts
function decide(input: {
  subject: Subject; claims: Claim[]; evidences: Evidence[];
  policy: Policy;                        // 数据，不是代码
}): Decision;                            // 无 I/O；同输入同输出

type Decision = {
  verdict: 'pass' | 'fail' | 'insufficient';
  reasons: string[];                     // 具名，且每条都能在 policy 里找到对应要求
  reusedEvidence: string[];              // delta 复用
  revalidateClaims: string[];            // 必须重开的 claim
  deficits: Array<{ claim: string; need: string }>;   // insufficient 的具体缺口
};
```

**内核从不执行任何东西。** 五类证据里有四类需要跑命令或分析 ⇒ 由**证据验证者**（生产者侧）产出判决：
`EvidenceVerdict = { evidenceRef, verdict: 'supported' | 'refuted' | 'inconclusive', observed, at }`。
`decide()` **只消费判决与账本**，因此 K1（纯函数）成立；"谁产判决"属于 §1.1 的中间层，可替换。
**硬规则（property test 覆盖整个决策矩阵）**：`budget_exhausted ⇒ verdict !== 'pass'`。

### 1.5 `Policy`（数据化：今天写在代码与 brief 里的东西全部搬到这里）

```jsonc
{
  "version": 1,
  "tiers": {
    // 【落地形态】`assurance` 是**下限**不是允许集合 —— 集合会让"比档位要求更好的 assurance"反而被拒
    // （实测：strict 用集合时，observed 通过、而 standard 用集合会拒绝 observed）。strict 的下限已升到 observed：
    // 账本路线的通过依据是证据，而没人看着产生的证据不足以支撑它。
    "standard": { "autoEvidence": ["static_witness"],
                  "reviewers": 0, "quorumOn": ["uncertainty","new_class","weak_evidence"],
                  "assuranceFloor": "none",
                  "requiredRiskClasses": ["consistency"], "humanBudgetMin": 0 },
    "strict":   { "autoEvidence": ["static_witness","executable_falsifier"], "reviewers": 1,
                  "quorumOn": ["disagreement","high_risk"], "assuranceFloor": "observed",
                  "requiredRiskClasses": ["consistency","boundary","failure_mode"], "humanBudgetMin": 10 },
    "security": { "autoEvidence": ["static_witness","executable_falsifier","cross_artifact_contradiction"],
                  "reviewers": 2, "quorumOn": ["always"], "assuranceFloor": "sandboxed",
                  "requiredRiskClasses": ["consistency","boundary","failure_mode","privilege","provenance"],
                  "humanBudgetMin": 30 }
  },
  // 【落地修正】必须有 **high** 行，否则 security 档【不可达】（档位取所有触及路径的最大 floor）⇒
  // quorum / sandboxed / privilege 风险类全部形同虚设。落在"门自己所在的地方"：
  "riskFloors": { "src/kernel/policy.ts": "high", "src/kernel/decide.ts": "high",
                  "src/quality/**": "medium", "src/workflow/**": "medium" },
  "riskFloorAudit": { "changesRequireReview": true },   // ← floor 变更走同一套评审
  // 【落地新增，且是必需的】档位的风险空间契约：**覆盖检查若由 claims 自身推出就不可能失败**
  // （实测：所需集合 = claims 的风险类并集 ⇒ 永远"覆盖"）。所以它必须是档位的固定契约。
  // （上面 tiers 的 requiredRiskClasses 即是）
  "sampling": { "rate": 0.2 },          // 【落地新增】低风险工作事后升格的比例，用来度量分类器
  // 【落地形态】"evidenceStrength.blocking" 收窄为**仅** executable_falsifier（比本文档更严）
  "diversity":   { "requiredOn": ["quorum"], "kinds": ["model_family","prompt_strategy","tool_profile"] },   // 抽象属性，不写 provider 名
  "budgets":     { "maxTokensPerChange": "0.6*C0", "maxWallMs": 1800000, "deadlineToolCalls": null },
  "evidenceStrength": { "blocking": ["executable_falsifier","static_witness"],
                        "major":    ["executable_falsifier","static_witness","invariant_proof","cross_artifact_contradiction"],
                        "minor":    "any", "nit": "any" },
  "deadline":    { "emitFirstRecordByToolCall": "auto" }   // 由 C0 派生，不是手写常数
}
```

---

## 2. **删除清单**（无兼容；这是方案的主体）

| 删除 | 行数（估） | 为什么可以删 |
|---|---|---|
| `adversarial.ts` 的**记录与门**部分 | ~2,300 | 记录不再被信任；`decide()` 读 claim+evidence |
| `schemas/adversarial-review.schema.json` | 611 | 被 5 个小 schema 取代（claim/evidence/decision/policy/subject） |
| 覆盖协议（hypotheses / targets / coverage claims） | ~400 | **claim 本身就是覆盖**：要么有证据、要么没有 |
| `readTests` / `wroteTests` / 引用守卫（四种形态全失败） | ~300 | 证据在**冻结主体上被执行验证**，"谁写的"不再相关 |
| 轮次历史 + `replacedBy` / `replacedCreatedAt` 替换链（改了 8 次） | ~250 | 没有轮次，就没有替换关系 |
| `salvageRecord` + 转录通道 + 提取脚本 | ~400 | **不再有单通道产物**：claim/evidence 是增量 CLI 调用，落盘即存在 |
| `roundMayClose` 作为门 | ~150 | 降为 protocol closure 的**报告**（第 ① 层），不再承担"无遗漏" |
| `REVIEW_GATE_CONDITIONS` 表 + brief 条件不变量 | ~300 | 条件全部进入 `policy.jsonc`；不变量改为"policy 的每个字段都被消费" |
| 7 类 defect 表作为终止机制 | ~200 | 类成为 `RiskClass` 枚举，由 planner 消费 |
| `finding-disposition`（accept/defer/route/waive/fixed…） | 350 | 状态直接落在 claim 上（5 个值） |
| `repair-batch` / `repair-obligations` / `repair-rounds` | ~1,000 | delta certification 重开 claim，没有批处理 |
| 凭据/登记表作为**必需** | ~500 | 降级为 assurance overlay 的可选提供者 |
| `executedInFreshContext` 参与质量判定 | ~100 | 移到 assurance 轴 |
| `lane` 的三态标签（保留其漂移计算） | ~100 | 并入 `focus`：输出的是**影响锥**而不只是状态 |
| 相关测试（45 文件 / 7,062 行） | 全部重写 | 内核是纯函数 ⇒ 用 property + mutation 测，而不是夹具堆 |
**实测细分**：`adversarial.ts` **3,301** · 支撑模块合计 **3,616**（`finding-disposition` 350 · `repair-batch` 345 · `repair-obligations` 318 · `falsifier-reddenings` 247 · `repair-rounds` 231 · `class-coverage` 230 · `review-execution` 226 · `review-state` 224 · `round-runner` 219 · `round-protocol` 219 · `record-salvage` 199 · `repair-briefing` 196 · `round-registry` 153）· `adversarial-review.schema.json` **611 行** · 相关测试 **45 个文件 / 7,062 行**。

**总计删除 = 6,917 行 src + 611 行 schema + 7,062 行测试**；上表中带"（估）"的行是 `adversarial.ts` **内部的分段估计**（该文件里真正属于"记录与门"的部分约占七成，其余是 brief 渲染与历史兼容逻辑，一并消失）。**新写 ≈ 4,000–5,000 行 + 新测试。**

---

## 3. **保留清单**（原样搬走，不改写 —— 它们是实测有效的）

| 保留 | 为什么 |
|---|---|
| `pathDigests` 内容寻址与冻结快照 | 真实性成立；错的只是**复用粒度** |
| `lane` 的漂移计算 | 它已经能独立回答"内容有没有动" |
| `falsify` 的账本形状 `{before, mutated, after}` | 它是最接近"确定性裁判"的东西 ⇒ 升为 `executable_falsifier` |
| **"每条检查都必须能失败"的纪律** | 一天内靠它抓到 **11 处**能恒真的检查，**零 token** |
| **7 类缺陷（作为词汇）** | ✗ **未搬**：新路径用 `RiskClass`（风险类），"缺陷类"表仍在旧路径。**两者是两件事**，本文档早期把这一行混在一起写了 —— 见 §14 的更正 |
| brief 内**数字期限** | 无记录轮次从 **0/4 → 6/6** 的唯一有效杠杆 |
| 严重度门槛（`std` 拦 blocking，`strict` 加 major） | 已存在，只是**从未真正启用** |
| 7 类缺陷（作为词汇） | 它们是好词汇，坏的是"用它当终止条件" |

---

## 4. 内核不变量（**新测试策略：属性 + 变异，而不是夹具**）

| # | 不变量 | 怎么测 |
|---|---|---|
| **K1** | `decide()` 纯且全域：同输入同输出，无 I/O | 属性测试 + 类型层面禁止 `fs`/`child_process` 导入 |
| **K2** | **每条命令型检查都必须声明让它变红的变异；没有变异的检查不可受理**（按**逐条**要求，不是按证据类型 —— 本线 11 处"能恒真的检查"全部是逐条抓到的，按类型要求会漏掉它们） | **落地方式是结构性的**：命令型证据只剩一种（`executable_falsifier`），它的**形状**要求一个变异；缺变异在 `evidence add` 就被点名拒绝。实测（本条曾是本方案最大的缺口，见 §14）：`invariant_proof` + `bash -c "exit 0"` 曾获得 `supported` 并让一个 major claim 通过；今天同一份提交被拒（未知类型 / `mutation.file is required`） |
| **K3** | `budget_exhausted ⇒ verdict !== 'pass'` | 遍历整个决策矩阵 |
| **K4** | delta 复用不放宽：`reused ⊆ 未变 ∩ 依赖未受影响`；依赖不可推导 ⇒ **全开** | 生成"改动 + 图"组合，断言集合包含关系 |
| **K5** | `src/kernel/**` 里**不出现任何平台标识**（`pi`/`session`/`adapter`/`receipt`…） | 文本 + 类型双查（同时是 Platform Coupling Index 的实现） |
| **K6** | **同一主体在两个 adapter 上必须得到同一个 decision** | cross-adapter differential test；第二支 adapter（file）已交付。**实测的限制**：差分目前只对 `static_witness` 成立 —— file adapter 对命令型证据返回 `inconclusive`（它不执行任何东西），所以"两支 adapter 同判"在最弱的一类上被检验，命令型证据只有一支 adapter 能验 |
| **K7** | `riskFloors` 的变更**自身走同一套评审** | floor 改动产生一个 claim（`policy-floor:<pattern>`），且该 claim 属于 `privilege` 类；`decide` 随即报 `insufficient`，因为它是 open 且无证据 —— 加宽不是免检入场券 |

---

## 5. CLI（7 个动词，替代今天的 `adversarial`/`matrix`/`lane`/`findings` 等一大族）

**实况**：动词挂在 `kata-cli ledger <动词>` 下，共 **9 个动词 / 15 个子命令**：
`status`（`--cost` 给出作者侧与发现率指标）· `freeze` · `policy`（`--init` / `--set-file`）·
`claim`（`list|show|add|waive|reopen`）· `usage`（`set`，**实测数字的写入者**）·
`evidence`（`list|add|verify` + `replace --reason`，唯一的改写门）· `challenge`（`list|add|check|amend`）·
`plan`（落盘为 `plan.json`）· `decide` · `focus`（**消费 `plan.json` 的阅读集**，按漂移收窄）。
**未落地**：`challenge ask|answer`（随机出题与应答率）—— 落地的是反例账本那一半。

```
kata-cli subject freeze                     # 冻结 → pathDigests
kata-cli claim add|list|show|reopen         # 账本（增量，落盘即存在）
kata-cli evidence add|verify                # 五类证据；verify 由内核执行
kata-cli challenge ask|answer|list          # 随机出题与应答率（替代凭据）
kata-cli review plan|run                     # planner 决定要哪些证据、几个 provider
kata-cli decide                              # 纯函数决策 + reused/revalidate 清单
kata-cli focus                               # 影响锥与漂移（吸收 lane）
```
**没有** `adversarial record`、没有 `salvage`、没有 `matrix set --statement`（判据写入 policy/claim）、没有 `findings accept/defer`。

---

## 6. 明确的设计决定（**不留选项**）

| # | 决定 | 理由 |
|---|---|---|
| **D1** | 档位 = **证据强度 × assurance 矩阵**，取消"有没有 receipt"定义档位 | 已实测：三个 change 因档位要求凭据而无法认证 |
| **D2** | **采纳 delta certification** | "改过的代码客观上是另一份代码"，但要复用未变证据 |
| **D3** | 允许生产者提交反例（**在产品测试套件之外**）；**只有被作者采纳后才进入产品套件** | 保住角色分离，同时让反例可执行。**落地形态**：反例是**账本里的一个可执行账目**（`challenge add/check/amend`：命令 + 三态 + 修正留痕），不是 `challenges/` 目录 —— 意图达成，文件形态未采用（账目条目天然带三态与修订链，目录形态需要另造这两样） |
| **D4** | `expert_concurrence` **禁止单独支撑 blocking/security**（必须带人类签字） | 否则把"遗漏"重新包装成证据 |
| **D5** | `riskFloors` 是数据，**其变更走同一套评审** | 否则它是绕过门的后门 |
| **D6** | **必须投入 benchmark 语料**（阶段 1） | 没有它，一切验收只能靠印象 |
| **D7** | 人工预算：standard 0–10 min · strict 10–30 min · security 按风险 | 人的时间是最贵的资源，必须显式定价 |
| **D8** | v2 **不引入签名/透明日志**；`assurance` 的 `signed` 为占位 | 只在跨信任边界时才需要 |
| **D9** | **不采用任何语义不符的标准词汇**（OTel 的 `gen_ai.agent.id` 等） | 名字宣称代码没有的意思 = 本仓库最常抓的类 |
| **D10** | **新路径上**无记录不再可能：claim/evidence 是**增量落盘**，没有"最后交一份 JSON"这一步。**（适用域限定）**：旧路径仍要求一次交一份 `adversarial-review.json`，所以在**没有账本**的 change 上，"单通道产物"这一形态今天依然存在 —— D10 说的是新路径，不是全仓 | 实测 62 轮中 28 轮丢失全部产物 |

---

## 7. 阶段（**重写，不是改**；每个阶段含一个"删除"动作）

| 阶段 | 时间 | 交付 | **同时删除** |
|---|---|---|---|
| **P0 立刻** | 0.5–1 天 | **E0：把现状仪表化一周**（每 change 的轮次/tokens/**作者侧时间**/重封次数/发现数，得到 `C0` 的真实分布与成本归属 —— **它是"要不要重写"的判据，比 P2 便宜一个数量级**）· 真正启用严重度门 · 保留数字期限 · **E1**（把某 change 的 AC 从"有通过证据"改为"有一个会变红的变异"） | 无（零架构） |
| **P1 语料** | 1–2 周 | **两半语料**：① 遗留缺陷（召回连续性）② **新机制对抗种子**（依赖边错 · floor 过低 · adapter 语义发散 · quorum 相关性 —— **新系统的失效模式与旧系统不同，只用历史缺陷会漏掉它们**）· known-good revision · 指标仪表盘 | 无 |
| **P2 内核** | 2–3 周 | `subject/claim/evidence/delta/risk/policy/budget` + K1–K5、K7 | `adversarial.ts` 的记录与门部分、覆盖协议、引用守卫 |
| **P3 生产者** | 1–2 周 | `port.ts` + `static-analysis`/`mutation`（由 `falsify` 升格）/`llm-review`/`human`/`quorum` + `planner` | `finding-disposition`、`repair-batch/obligations/rounds` |
| **P4 CLI + schema** | 1–2 周 | 7 个动词 + 5 个小 schema | `adversarial-review.schema.json`、旧 CLI 族、轮次历史与替换链、`salvage` |
| **P5 assurance overlay** | 1 周 | 旧轮协议/登记表降级为一个 adapter；沙箱与签名留占位 | 凭据作为必需、`executedInFreshContext` 参与判定 |
| **P6 收敛与验证** | 1 周 | K6 cross-adapter 差分 · Platform Coupling Index · Adapter Change Radius · shadow 试点 | 旧测试夹具（45 文件） |

**关键路径是 P1**：没有语料，P2–P6 的每一步都只能用印象验收。
**实况（第二轮之后）**：P2 的内核、P3 的主要生产者、P4 的 CLI 与 schema、P5 的 assurance 层已落地（见 §12/§13）；**P0 的三件已做两件**（严重度门 + 数字期限，E0 的仪表已就位但数据要跑一周）；**P1 只落了"新机制对抗种子"那一半**；**§2 的删除一行未做**（理由与次序见 §13.7）；P6 只落了 K6 与 K5。
**P0 与 P1 可以并行**（不同人）。

---

## 8. 验收（"完成"的定义）

```
CriticalRecall_new  ≥ baseline        FalsePass_new ≤ baseline
Cost_standard,new   ≤ 0.6 × C0        （由 P1 的基准校准后才写死）
no-record rate       = 0%（结构上不可能：增量落盘）
full re-review 次数   ↓ ≥70%
blocking/major 证据   ≥95% 可由 kata 独立重放
gate mutation kill   = 100%（K2）
内核平台耦合          = 0（K5）；新平台接入修改非 adapter 文件数 = 0（K6 + Adapter Change Radius）
预算耗尽             永不转化为 pass（K3）
```

---

## 9. 风险与反制

| 风险 | 反制 |
|---|---|
| **丢失"每条检查都能失败"的纪律**（它抓到过 11 处） | K2 把它写成内核自身的不变量：**每条证据类型必须有一个变异用例** |
| 依赖图漏边 ⇒ 变更悄悄躲过重验 | 保守过近似 + 依赖不可推导即全开（K4）+ **抽样复核一条无关的已支持 claim** |
| risk floor 被设为过低 | D5（floor 变更走评审）+ 随机档位升格 + 公开"升格失败率" |
| `expert_concurrence` 被当证据用 | D4 |
| 内核被 platform 概念渗入（慢慢漂移） | K5（文本+类型）+ K6（差分：两支 adapter 必须同判） |
| 重写期间新旧并存 ⇒ 同一事实两处派生 | **每个阶段都带删除动作**（§7 右列），不允许"先并存后清理" |

---

## 10. 与外部评审（`docs/review2.md`）的关系

本方案**采纳**其目标架构（证据内核 + 风险自适应网格 + 可选 overlay）、`ReviewRecord v2` 的字段划分、`delta certification`、证据类型系统、三层终止、五级 assurance、以及"预算耗尽永不等于 PASS"。
本方案**比它更进一步**的地方：**把它描述的 Protocol v2 直接当成一次重写来做（不留兼容）**，因此 §2 的删除清单成为方案主体，而不是"逐步迁移"。
本方案**对它三处限定**（已写进整合稿）：成本目标是规划值不是验收标准；`100` 不是统计门槛；四条它没给的检查（K6 差分、D5 floor 审计、D4 证据类型限制、Shadow Miss Rate 只作持续指标）。

---

# 11. 自查：本方案对三个目标的不足（12 条）

> 提问：**目标只有三个 —— 降成本（时间与 token）· 平台解耦 · 审查质量不丢。本方案够不够？** 下面是自查结果，其中 5 条是**结构性**的，不能靠加检查消掉。

| # | 不足 | 打的是哪个目标 | 为什么是问题 | 处置 |
|---|---|---|---|---|
| **S1** | **重写本身的成本没有与节省对账** | 成本 | 删 6,917 + 写 4–5k + 重写 7,062 行测试 ≈ **8–12 周 × 2–3 人**；期间旧成本照付。**若变更量不高，重写是最贵的那个选项** | **加 ROI 判据与止损线**（见文末结论）；不做则等于用 10 周赌一个未测的节省 |
| **S2** | **作者侧成本（轮次【之间】）没有指标，而它可能占大头** | 成本 | 实测：每轮之后的读/验/修/处置/重封约 **1–2 h**；单日最大节省是"一次性接受 23 条 minor/nit"，**而不是省轮次** | **✅ 已落地**：`Claim.at` / `Claim.reopens` 由 store 盖章，`kata-cli ledger status --cost` 输出 `claimToSupportedMs`（含中位数）· `reopenings` · `authorSide.firstClaimAt/lastVerifiedAt` |
| **S3** | **单次评审的上下文成本没有被攻击** | 成本 | 350–660K/轮里 **brief 只占 3–6%**，绝大部分是**上下文重建**。只减少"评审次数"不改变单次成本 | **`Claim.readingSet[]`** + planner 必须产出**阅读计划**（文件 + 摘要 + 行范围）⇒ 评审上下文由 **claim** 决定，而不是由整个 change 决定 |
| **S4** | **K6 在只有一个 adapter 时是空条款** | 解耦 | 差分测试需要两个 adapter；今天只有一个 ⇒ 不变量**恒真** | P6 必须交付**最小第二 adapter**（文件/人工 adapter 也算），否则**删掉这条不变量**而不是假装满足 |
| **S5** | **provider 多样性可能把平台知识带回内核** | 解耦 | "2 个 reviewer"若由 policy 指向具体 provider ⇒ 内核知道平台 | 已改：抽象为 `diversity: model_family \| prompt_strategy \| tool_profile`，由 adapter 声明能否满足；**未满足必须如实上报** `undiversified` |
| **S6** | **证据验证把 I/O 带进内核 ⇒ K1 原本不成立** | 解耦 + 质量 | `invariant_proof.command` 要跑命令；"纯内核"与"自己验证据"自相矛盾 | 已改：引入 **`EvidenceVerdict`** —— **内核从不执行任何东西**，只消费判决 |
| **S7** | **没有对"独立发现"的下限** | **质量** | v2 允许 `standard` 只靠自动证据认证（作者自证）；**今天至少有一轮** | 加**发现下限**：风险档 ≥ medium 必须至少一次**独立挑战**（带阅读集与期限），并记录其**新颖性**（不在账本里的挑战） |
| **S8** | **K2 原来写弱了**：按【证据类型】要求变异，而有效的纪律是按【每条检查】 | 质量 | 11 处"能恒真的检查"**全部是逐条抓到的**；按类型要求会漏掉它们 | 已改：K2 = **每条注册的检查/不变量都必须带一个能让它变红的变异；没有变异的检查不可受理** |
| **S9** | **语料只用历史缺陷 ⇒ 对新机制自身的失效模式没有召回度量** | 质量 | 新系统有**全新的**失效模式：依赖边错 · floor 过低 · adapter 语义发散 · quorum 相关性 | **✅ 已落地第一半**：`tests/fixtures/review-scenarios.ts` = **17 个种子**（delta 三态 · 强度 · 反例 · 预算 · 发现下限 · assurance · quorum 三态 · 覆盖 · 豁免），并由测试断言**每个 reason code 都有种子**（语料自证覆盖） |
| **S10** | **没有先量当下的分布就开始重写** | 三个目标 | `≤0.6 C0` 与 `↓70%` 都是**未测值**；不知道成本到底在哪就重写 = 优化一个**猜出来的**分布 | **✅ 仪表已落地**（`--cost` 报告 + `ledger usage set` 让**实测数字有写入者**）；**E0 的数据仍需跑一周** —— 仪表本身不产生数据 |
| **S11** | **"质量不丢"没有量化基线** | 质量 | 没有 baseline（每 change 采纳的、经复现的缺陷数），无法证明"没丢" | **✅ 已定义并计算**：`refutationRate`（被反驳判决/全部判决）· `challengeWithdrawalRate`（撤回反例/全部反例）；**baseline 字段如实写 `none recorded yet`** —— 报告为**未测**而不是 0 |
| **S12** | **省掉的恰恰是最难定义的东西：探索** | 成本 ↔ 质量 | 可复核的证据（反例/不变量）**天然覆盖已知类**；"看一眼觉得不对"的价值无法进入任何 schema | 承认这是取舍：**发现下限（S7）+ 独立挑战的新颖性度量**是唯一防线；不得声称"质量不丢"，只能声称"**可复核的那部分不丢，探索部分由人工下限兜底**" |

## 11.1 结构性的三条（加检查消不掉）

1. **重写的 ROI 取决于变更量**（S1）：量低时正确解不是重写，而是**最小改造**。
2. **成本与发现能力存在真实张力**（S12）：省下来的主要是"没有明确目标的探索"，而本线最有价值的发现（类级缺陷）恰恰来自那种探索。
3. **语料永远滞后于新失效模式**（S9）：新机制的第一批缺陷只有在它运行之后才存在。

## 11.2 对"是否该做这次重写"的判决

**如果三个目标同时成立，最可能的不是这份 8–12 周的重写，而是：**

```
① E0（一周仪表化）—— 先拿到成本归属与发现率 baseline，它是"要不要重写"的判据
② P0 的两件零架构动作 —— 严重度门 + 数字期限（已各有一处实测支撑）
③ 风险路由的【最小版】—— 按路径/风险决定评审深度，不引入新内核
④ Claim.readingSet（S3）—— 直接砍单次评审的上下文成本，可独立落地
   ⇒ 这四件约 1–2 周，预期拿到 40–70% 的节省，且不承担重写风险
```

**只有 E0 的数据显示"节省主要来自重写才能解决的部分"（例如单次上下文成本无法靠 readingSet 压低、或依赖锥无法在现有结构上表达）时，才启动 P2–P6。**
**否则这份重写方案的正确用法是：当作目标形态放着，先用最小改造吃掉能吃的收益。**

---

# 12. 实施记录（本次一轮完成的部分）

> 指令：**全量、不计成本、一轮完成、不走 kata 工作流。** 结果：新子系统**完整落地并全绿**；旧轮次机制的**删除按下述理由留作下一步**（原因在 §12.4，不是遗漏）。

## 12.1 落地的文件（实测行数）

```
src/kernel/            纯函数 · 无 I/O · 无平台名（唯一必须各平台共同实现的真源）
  types.ts 249 · policy.ts 243 · decide.ts 204 · risk.ts 135 · evidence.ts 104
  delta.ts 99 · budget.ts 76 · subject.ts 62 · index.ts 15
src/producers/         可替换的证据生产者
  verifiers.ts 244（五类验证器）· submission.ts 121 · planner.ts 119 · quorum.ts 77 · port.ts 53
src/store/ledger.ts    234（增量落盘 · 单写者锁 · 读不到即报告为状态）
src/assurance/adapters/ inline 32 · file 78（第二支 adapter，K6 差分的另一半）
src/cli/ledger.ts      533（9 个动词）
schemas/               review-{subject,claim,evidence,evidence-verdict,decision,policy}.schema.json
tests/                 10 个用例文件 + 1 个夹具 = 1,167 行，52 条新用例
                       ⇒ 新增源码 2,678 行（计划估算 4,000–5,000）
```

## 12.2 不变量与它们的位置

| 不变量 | 实现 | 用例 |
|---|---|---|
| **K1** 内核纯且全域 | `src/kernel/**` 无 `fs`/`child_process`/`process.env`/`Math.random`/时钟；`decide()` 同输入同输出 | `kernel-is-pure-and-platform-neutral` |
| **K2** **每条检查都能失败**（逐条，不是逐类型） | 五个验证器各有一个反例态 | `kernel-every-check-can-fail`（falsifier 的三步 `{before,mutated,after}`、"did not redden"、"already failing"、"mutation site is gone"） |
| **K3** 预算耗尽永不等于通过 | 判定顺序中预算第一，且只可能产出 `insufficient`；不可解析的限额报告为**未知**而不是 0 | `kernel-decision-cannot-pass-a-spent-budget`（四种超限 + 无基线一例） |
| **K4** 复用不放宽 | `reused ⊆ 依赖摘要逐字节未变`；依赖不可解析 ⇒ **全部重开** | `kernel-delta-reuses-only-unchanged-dependencies`（含 25 组生成矩阵的等式断言） |
| **K5** 内核无平台名 | 源码文本扫描（**注释先被清空**，不变量针对代码） | 同上 |
| **K6** **同一主体在两支 adapter 上必须同一判定** | 差分：inline（observed）vs file（relayed）必须给出同一个 `Decision` | `kernel-two-adapters-reach-the-same-decision`（并验 file adapter 拒绝陈旧结果、从不执行命令） |
| **K7** 风险下限的变更本身走评审 | floor 变更 ⇒ `riskClass: 'privilege'` 的 claim，**并已在 `ledger policy --set-file` 里接线** | `kernel-risk-floor-changes-need-review` + CLI 端到端一例 |
| 策略每个字段都有消费者 | `POLICY_CONSUMERS` 与实例字段集合**必须相等**，多一个字段即按名拒绝 | `kernel-policy-fields-all-have-consumers` |
| 生产者不得提交判定 | 提交物任意层级出现 `verdict`/`decision`/`passed`/`satisfied` 即拒绝并指名 | `submission.ts` + CLI 用例 |
| 无记录是可行动的状态 | `recordedFiles: []` + 一句说明；每个事实落盘即存在，没有"最后交一份"的步骤 | `ledger-records-each-fact-as-it-arrives`（含"加一条 claim 后直接读文件"） |
| 声明不可读的路径不得冻结 | 不写 sentinel（sentinel 与"已删除"不可区分），而是按名拒绝 | 同上 + CLI 一例 |

## 12.3 证据

```
npx tsc --noEmit                exit 0
npx vitest run                  203 文件 / 1381 用例 / 0 失败（此前 193 / 1327）
npm run build                   dist/cli.js 打包通过（6 个新 schema 已被 kata-asset 打包）
npm run check:wiring            findings 47 —— 本次新增代码贡献 0（见 §12.4）
node dist/cli.js ledger status --change round-protocol
                               在真实工作区跑通：dir=.kata/tasks/round-protocol/review，recordedFiles=[]
```

## 12.4 四个缺陷，全部由机器而非阅读发现（这是本次最值得记的一件事）

| # | 缺陷 | 谁抓到的 |
|---|---|---|
| ① | **我新加的 6 个 schema 没有被任何东西打包** —— 本仓库自己的类不变量 G1 判它"a definition no consumer can reach" | `class-invariants.test.ts` G1 |
| ② | **我新加的 8 个导出没有任何消费者**（wiring 从 55 条里指出） | `npm run check:wiring`（修完回到基线 47） |
| ③ | **`loadPolicy` 接受未知的顶层字段** —— 我的校验只枚举了*声明侧*的字段，于是多出来的键一路通过（正是本仓库反复出现的那个类：枚举只从一侧开始） | 我自己的用例 `refuses an unknown field by name` |
| ④ | **`ledger status --change x` 把 `status` 当成了 change id** —— 入口的位置猜测器分不清子命令与 id；现已由该家族自己解析 `--change` | 我自己的 CLI 冒烟运行 |

四个里有两个是**本仓库既有的不变量抓到我**，而这正是这套东西的意义：新代码在同一套检查下被检查，作者不享受豁免。

## 12.5 没有做的那件事，以及为什么

**旧轮次机制（`adversarial.ts` 3,301 行 + 支撑模块 3,616 行 + 611 行 schema + 45 个测试文件 7,062 行）本次未删除。** 理由不是遗漏，是次序：

1. **它此刻正在认证四个在飞的 change**（`adversarial-admissibility`、`review-record-integrity` 等）。删掉它等于同时让它们失去门。
2. **计划本来就把它排在 P2–P5**，而且每个阶段带一个删除动作 —— 因为删除的前提是"新路径已经成为默认"，而在这一条尚未发生。
3. **同一轮里既加新子系统又删旧子系统**，会把 1,381 条用例变成无法验证的状态：删除的收益要由新路径承担，而新路径的接线（阶梯改调 kernel）是删除的前置动作，不是并行动作。

**所以当前状态是：新路径完整、可跑、全绿；旧路径冗余但仍在线上；它的移除是一个次序明确的机械步骤，第一步是把阶梯（`orchestrator`/`navigation`/`ops`/`cli`）改调 `decide()` 与 ledger 存储。**

> **更新（第二轮，见 §12.6）：这句话里的"第一步"已经做完了。** 阶梯现在**读账本**并据此路由（`satisfy_ledger_deficits`），而"没有账本"是一个**显式状态**而不是静默回退。**剩下的只有删除本身。**

⚠️ 也因此，§2 的删除清单已有部分过时：其中若干条（覆盖协议、引用守卫、`salvage`、处置字母表）描述的是**旧路径内部**的补偿机制，删除它们与新子系统无关，属于同一次机械清理。**先接线，再删除**，两步都要，但不要合并成一步。

---

# 13. 第二轮：接线 + 度量（"一步到位修复发现的问题"）

> 指令：**一步到位修复和优化发现的问题，不要中断。**（本轮含真实工作区演练，13.5） 本轮把第一轮明确留给下一步的那件事（**阶梯接线**）做完，并把 §11 审计里"未落地"的三条（**S2 / S9 / S10+S11**）落成代码。**仍然没有做的是删除** —— 理由在 §13.4。

## 13.1 阶梯接线：账本成为决定者

```
navigation.ts   readUpstreamSummary() 调 ledgerVerdict()     ← 与 CLI 的 decide 动词【同一处推导】
                UpstreamSummary.ledger = { state, verdict, claims, reason, deficits }
                suggestCandidateAction() 在【未解决义务】之下、【findings 计数】之上返回
                reason = satisfy_ledger_deficits（新词汇，已补 zh/en 提示）
store/verdict.ts  ledgerVerdict() → absent | unreadable | decided        ← 单一推导点
```

三种状态**含义不同、必须分开**：

| state | 含义 | 阶梯行为 |
|---|---|---|
| `absent` | 没有账本（或账本里没有 claim） | **保留旧路径**，并把这句话报告出来 —— 这就是让旧路径可以**逐个 change 退休**而不是一次全关的东西 |
| `decided` 且非 pass | 账本判不通过 | 送往 `/kata-build`，**带内核自己的 deficits**（不是再数一遍 findings） |
| `unreadable` | 账本存在但读不了 | **拒绝**，不许读成"没人写过" |

实测（真实仓库）：`kata-cli status --change round-protocol` 现在输出
`"ledger":{"state":"absent","verdict":null,"claims":0,"reason":"no ledger has been recorded for this change, so nothing here decides it","deficits":[]}` ✓

## 13.2 度量：把"没有指标"变成指标（S2 / S10 / S11）

`kata-cli ledger status --cost` 输出：`claimToSupportedMs`（每个 claim 从中报到达成支持的**中位数**）· `reopenings`（**作者侧成本**：一个 claim 被反复重开的次数）· `authorSide.firstClaimAt/lastVerifiedAt` · `evidence.byType/byVerdict/unverified` · `challenges.open/withdrawn` · **`discovery.refutationRate`**（被反驳判决/全部判决）· `discovery.challengeWithdrawalRate`。

两条规则写进实现而不仅是文档：
1. **算不出来的比率写 `null`，绝不写 0**，`baseline` 字段如实写 `none recorded yet` —— 0 会被读成"什么都没抓到"，那是一个没人有数据支持的断言；
2. **实测数字必须有写入者**：`kata-cli ledger usage set --tokens/--wall-ms/--tool-calls`。没有它，预算规则就是**一个没有 writer 的机制**（这正是本仓库第 6 类缺陷），wiring 检查当场指出了这一点。

## 13.3 语料：新机制自己的失效模式（S9）

`tests/fixtures/review-scenarios.ts` = **17 个种子**，覆盖 delta 三态（依赖变动/未变动/不可解析）· 证据强度 · 反例开放 · 预算耗尽 · 发现下限 · assurance 低于档位 · quorum 三态（分歧/**未满足多样性**/**不能投票抹掉一个已复现的 finding**）· 覆盖缺口 · 无理由豁免。

**语料自证覆盖**：测试遍历 `REASON_MESSAGES`，断言**每个 reason code 至少出现在一个种子**里 —— 词汇表想悄悄长大就会失败。这正是"用历史缺陷做语料对新机制无效"那条审计意见的直接回答。

## 13.4 本轮又抓到 4 个缺陷，全部由机器抓到（同一个规律在重复）

| # | 缺陷 | 谁抓到的 | 性质 |
|---|---|---|---|
| ① | **`assurance` 写成"允许集合"而不是"下限"** ⇒ 比档位要求的**更好**的 assurance 反而被拒（`observed` 被 `standard` 拒） | **我自己新写的接线用例**（"账本通过后不再拦"实测失败） | 真实设计错误：档位描述的是**威胁模型下限**，不是白名单。已改为 `assuranceFloor` + `assuranceAtLeast()`，语义是"至少这么强" |
| ② | **损坏的账本与"没人写过"不可区分** —— `readJson` 吞掉解析失败 ⇒ `claims: []` ⇒ 读成 `absent` | 我写"损坏账本必须被拒"的用例时暴露 | 本仓库的老类：**吞掉读失败**。已加 `malformedFiles`，`ledgerVerdict` 直接判 `unreadable` |
| ③ | **存下来的 policy 校验失败会被静默换成默认值** | 同上，顺带发现 | 同一个类。已加 `policyRejected`，非 null 即拒绝判定 |
| ④ | **`setUsage` 没有消费者**（预算数字在真实 CLI 路径上永远写不进去） | **`npm run check:wiring`**（48 → 修回 47） | 第 6 类缺陷（有定义没有消费者）的活样本，由仓库自己的检查抓到 |
| ⑤ | **`evidence verify` 只在带 `--assurance` 时才把 assurance 写进账本** —— 于是 kata 自己观测过的证据被判定为**没有 provenance** | **真实工作区演练**（`decide` 报 `assurance_below_tier`，而同一轮 verify 的输出写着 `assurance: "observed"`） | **同一个类的第二次**：事实被算出来、被打印、但没人写下来。修：`ensureAssurance` **总是**记录实测值，且**只升不降** |
| ⑥ | **`challenge add --id` 撞号时静默 no-op**（store 按 id 去重 ⇒ CLI 报 `ok: true` 而什么都没写） | 演练中我试图用同样的 id 换命令时暴露 | 与"pi insert 报告成功却没落盘"同一形状：**命令报成功而事实没发生**。修：CLI 按名拒绝撞号，并给出替代（`amend`） |
| ⑦ | **`byStatus` 与判定矛盾**：报告说"6 个 claim 全是 open"，同一条账本的判定却说 `pass` —— 因为 `Claim.status` 是**声明**，判定看的是证据 | 演练后的成本报告 | 一报告两半回答两个问题。修：抽出内核的 `evaluateClaim()`，报告用**同一个谓词**给出 `bySupport`，于是 6 个 `supported` 与 `pass` 一致（一个推导，两处呈现） |

## 13.5 真实工作区上走通一次（在 `round-protocol` 上，它是已归档的，因此不会改任何人的路由）

```
ledger policy --init / freeze            → rev:38a84fea227aeef2（30 个真实 ownedPaths）
ledger claim add × 6                     ← 用该 change 【真实】的 AC-1…AC-6 与风险类：
                                            failure_mode ×2 · boundary ×2 · consistency ×2（覆盖 strict 要求的三类）
ledger evidence add × 6                  ← 每条的 invariantId 就是它的 AC，command 就是它在 acceptance matrix 里【真实】的 selector
ledger evidence verify                   → 6 条全部 supported，adapter=inline，assurance=observed（真跑，约 12 s）
challenge add X1（反例：adapter 是否持有强制力）→ 第一次命令【测了注释】⇒ 仍 open ⇒ 判定 insufficient
challenge amend X1 --command（去注释后再 grep）--reason …   → 状态重置为 open，旧命令留在 amendment
challenge check                          → exit 0 ⇒ withdrawn（反例未复现 = 该性质成立）
ledger decide                            → 【pass】| tier strict | reasons []
ledger status --cost                     → 6 supported（median claim→supported 211 s）· refutation 0 · withdrawal 1
status --change round-protocol           → upstream.ledger = {state:'decided', verdict:'pass', claims:6}
```

**这次真实运行抓到了 3 个只有跑起来才会暴露的缺陷（见 13.4 ⑤⑥⑦），而其中两个是"事实被算出来了但没被写下来"。**

## 13.6 证据

```
npx tsc --noEmit                exit 0
npx vitest run                  205 文件 / 1406 用例 / 0 失败   （本轮前 203 / 1381）
npm run build                   dist/cli.js 打包通过
npm run check:wiring            findings 47 —— 本次新增代码贡献 0（本轮曾到 48，见 13.4 ④）
node dist/cli.js status --change round-protocol
                                upstream.ledger = {state: 'absent', …}  ← 接线在真实仓库上活着
node dist/cli.js ledger status --cost --change round-protocol
                                report 输出完整（比率 null + baseline 'none recorded yet'）
```

## 13.7 仍未做的一件事，和它的次序（与第一轮结论相同，且理由收窄为一条）

**删除旧轮次机制仍未做。** 第一轮给了三条理由（在飞的 change 正在被它认证 / 计划把它排在 P2–P5 / 同轮既加又删会让 1406 条用例失去可验证性）。第二轮完成后，**理由收窄为一条，也是最硬的一条**：

> **接线已经完成，但"新路径成为默认"还没有发生** —— 因为**今天没有任何一个 change 有账本**（`state: 'absent'` 是实测状态）。删除旧路径的前提是每一条流程都走新路径，而这一步需要**先给在飞的 change 建账本**（`ledger freeze` → `claim add` → `evidence add` → `verify`），这是一次**逐个 change 的迁移**，不是一次删除。

所以正确的下一步次序是：**① 挑一个在飞 change，用新命令把它的验收项变成 claim 并录证据 → ② 让阶梯按账本路由它 → ③ 它归档之后，删除与它有关的那部分旧机制 → ④ 重复。** 每一步都可验证，且任何一步停下都不会让仓库失去一个能跑的评审路径。

---

# 14. 回溯：落地实现与本文档的差异（逐条实测）

> 方法：把本文档 §1–§9 里**可核对的断言**逐条拿出来，用命令核对代码，而不是重读自己的叙述。分四类：**A 一致** · **B 落地但形态不同**（有理由，需写进文档）· **C 未落地** · **D 文档陈旧/自相矛盾** · **E 落地本身引入了方案要消除的缺陷**（最要紧的一类）。
> 结论：**17 条差异，其中 3 条是 E 类。**

## 14.1 三种对象与决策（§1.2 / §1.4）

| # | 文档说 | 实测 | 类 |
|---|---|---|---|
| 1 | `Claim.il` 内联 `evidence: EvidenceRef[]` 与 `challenges: Challenge[]` | 落地为 `evidenceIds` / `challengeIds` + 两个**独立的顶层追加式列表**。理由：证据是**落盘即存在**的（D10），内联会让每加一条证据就重写 claim，`at`/`reopens` 随之漂移 | **B** |
| 2 | `Claim.status` 就是状态（5 值） | `status` 是**声明**，判定不读它；状态由 `evaluateClaim()` 从证据**推导**（`ClaimState` 9 值：supported/waived/unsupported/refuted/missing/inconclusive/stale/below_strength/challenged）。理由实测：成本报告曾显示"6 个 open"而同一账本判定 `pass`（§13.4 ⑦） | **B**（§1.2 需改） |
| 3 | `Claim` 没有 `severity` | 落地有 `severity`：证据强度下限按严重度定（`MIN_STRENGTH_BY_SEVERITY`） | **B** |
| 4 | 决策三分、预算耗尽永不 pass | ✅ `decide()` + `kernel-decision-cannot-pass-a-spent-budget.test.ts`（3 例） | **A** |

## 14.2 内核不变量（§4 K1–K7）

| # | 文档说 | 实测 | 类 |
|---|---|---|---|
| 5 | **K2：每条注册的检查都必须带一个能让它变红的变异；没有变异的检查不可受理**（§4） | **只落到"按证据类型"的弱形态**：`kernel-every-check-can-fail.test.ts` 断言的是**每类验证器会失败**，而 `invariant_proof` 的**形状校验不要求变异**、验证器只跑命令。**实测（端到端）**：一条 `command: bash -c "exit 0"` 的 `invariant_proof` → `verdict: supported` → `decide: pass`。**一个永远不会失败的检查可以支撑一个 claim 并让它通过** | **E** |
| 6 | §9 的反制写的是"每条证据**类型**必须有一个变异用例" | 代码实现的是**§9 的弱式**，而 §4 的强式没实现 ⇒ **文档自相矛盾，且落地选了弱的那一侧**。而 §3 保留清单把"每条检查都必须能失败"列为本方案**必须原样搬走**的纪律（旧机制靠它抓到 11 处恒真检查） | **D + E** |
| 7 | K6：同一主体在两支 adapter 上必须得到同一个 decision（前置：一个最小第二 adapter） | ✅ 第二支 adapter（file）已交付，差分用例存在 —— 但**差分只对 `static_witness` 成立**；对 `executable_falsifier`，file adapter 返回 `inconclusive`（"no recorded result"）⇒ **K6 名义覆盖 5 类，实测覆盖 1 类** | **B** |
| 8 | K1 / K3 / K4 / K5 / K7 | ✅ 各有会失败的用例（`kernel-is-pure-and-platform-neutral` · `kernel-decision-cannot-pass-a-spent-budget` · `kernel-delta-reuses-only-unchanged-dependencies` · 同 K1（注释先清空）· `kernel-risk-floor-changes-need-review`） | **A** |

## 14.3 度量与成本（§11 的 S2/S3/S10/S11）

| # | 文档说 | 实测 | 类 |
|---|---|---|---|
| 9 | S2/S10/S11：把现状仪表化 | ✅ `ledger status --cost`（`claimToSupportedMs` 中位数 · `reopenings` · `bySupport` · `refutationRate` · `challengeWithdrawalRate`）+ `ledger usage set`（**实测数字必须有写入者**，否则预算规则就是一个没有 writer 的机制） | **A** |
| 10 | **S3：`Claim.readingSet[]` + planner 必须产出阅读计划 ⇒ 评审上下文由 claim 决定，而不是由整个 change 决定**（§11.2 把它列为"可直接落地的收益"之一） | **算出来了，没有任何消费者**：`plan` 报告 `readingSets`，而 `readingSet` 在整个 `src/` 里**唯一**的消费者是**旧路径**的 brief 渲染器（`src/quality/adversarial.ts`）。新路径没有任何生产者拿到阅读集 ⇒ **单次评审的上下文成本一分未降**，而这一项本身就是它要消除的类：`a-definition-with-no-consumer` | **E** |
| 11 | 语料只用历史缺陷对新机制无效 ⇒ 语料分两半 | ✅ 第一半（新机制对抗种子）落地：`tests/fixtures/review-scenarios.ts` 17 个种子，且**语料自证覆盖**（每个 reason code 至少一个种子）。**第二半（遗留缺陷 + change 级 baseline）未开始** | **B / C** |

## 14.4 Policy（§1.5）

| # | 文档说 | 实测 | 类 |
|---|---|---|---|
| 12 | `standard.reviewers: 1` | 落地 `0` | **B** |
| 13 | `assurance` 是**允许集合**（`["none","relayed"]` 等） | 落地为 `assuranceFloor`（**下限**，且 strict 已升到 `observed`）。理由：集合会让"比档位要求更好的 assurance"反而被拒（§13.4 ①） | **B**（§1.5 需改） |
| 14 | `riskFloors` 含 `"src/workflow/seal-preflight.ts": "high"` | 落地**没有任何 `high` 行**（只有两条 `medium`）⇒ **默认 policy 下 `security` 档不可达** ⇒ `quorum_undiversified` / `sandboxed` 下限在实践中永不生效 | **C** |
| 15 | `evidenceStrength.blocking: ["executable_falsifier","static_witness"]` | 落地收窄为**仅** `executable_falsifier`（更严，方向正确，但文档需改） | **B** |
| 16 | §1.5 未含 `requiredRiskClasses` / `sampling` | 落地都有。`requiredRiskClasses` 是必需的：覆盖检查原本由 claims 自身推出 ⇒ **不可能失败**（§13.4 ⑧） | **B**（文档需补） |

## 14.5 CLI 与 schema（§5）

| # | 文档说 | 实测 | 类 |
|---|---|---|---|
| 17 | 7 个动词：`subject freeze` / `claim` / `evidence` / `challenge ask\|answer\|list` / `review plan\|run` / `decide` / `focus` | 落地 `ledger` 下 **9 个动词 / 15 个子命令**：`status` `freeze` `policy` `claim(list,show,waive,reopen,add)` `usage` `evidence(list,add,verify)` `challenge(list,add,check,amend)` `plan` `decide` `focus`。**`challenge ask\|answer`（随机出题 + 应答率）未落地** —— 落地的是"反例账本"（add/check/amend），即 clean-sheet 稿里 E 协议的随机挑战那一半缺席 | **B + C** |
| 18 | 5 个小 schema（claim/evidence/decision/policy/subject） | 落地 **6** 个：多了 `review-evidence-verdict`（内核消费判决，必须有定义） | **B** |

## 14.6 删除清单与阶段（§2 / §7 / §9）

| # | 文档说 | 实测 | 类 |
|---|---|---|---|
| 19 | §2 删除 **6,917 行 src + 611 行 schema + 7,062 行测试** | **一行未删**：`adversarial.ts` 3,300 · schema 611 · 13 个支撑模块 3,166 · 旧测试 45 文件。理由见 §13.7（新路径尚未成为默认，且删除需要先按 change 迁移） | **C**（有理由） |
| 20 | §9 风险表："重写期间新旧并存 ⇒ 同一事实两处派生" 的反制是"**每个阶段都带删除动作，不允许先并存后清理**" | **正处在被禁止的那个状态**，且后果已实测到：`review-record-integrity` 的**账本判定 pass，而旧 findings 表里 `rri-f1` 仍是 open major** —— 同一件事两个答案（由审批门取更严的那个，所以今天没有造成错误结论，但这是巧合而不是设计） | **E**（受迁移次序约束） |
| 21 | §7 P6：K6 差分 · Platform Coupling Index · Adapter Change Radius · shadow 试点 | K5 的文本+类型检查是 Platform Coupling Index 的实现片段 ✅；**另三项未落地** | **C** |

## 14.7 验收（§8）

| # | 文档说 | 实测 | 类 |
|---|---|---|---|
| 22 | 9 条验收 | **3 条已成立且可测**：`no-record rate = 0`（增量落盘，结构上成立）· 内核平台耦合 = 0（K5 用例）· 预算耗尽永不 pass（K3 用例）。**6 条不可测**（CriticalRecall ≥ baseline · FalsePass ≤ baseline · Cost ≤ 0.6 C0 · full re-review ↓≥70% · blocking/major 证据 ≥95% 可重放 · gate mutation kill = 100%）—— 因为 **P1 语料（change 级 baseline）尚未开始**，而方案自己写着"关键路径是 P1" | **C** |

## 14.8 保留清单（§3）

| # | 文档说原样搬走 | 实测 | 类 |
|---|---|---|---|
| 23 | `pathDigests` 冻结 · `lane` 漂移计算 · `falsify` 的三步账本形状 · 数字期限 · 严重度门槛 | ✅ 全部搬走（`subject.ts` · `ledgerDrift` · `executable_falsifier` 的三步 `{before,mutated,after}` · `planner` 的期限派生 · `evidenceStrength`） | **A** |
| 24 | **"每条检查都必须能失败"的纪律** | ✗ 只搬了弱式（见 #5/#6）—— 这是 §3 七项里唯一**名义搬走、实际失效**的一项 | **E** |
| 25 | 7 类缺陷（作为词汇） | ✗ 新路径对 `CLASS_COVERAGE` **零引用**；旧表仍在旧路径（`class-coverage.ts` 230 行）。新路径用的是 `RiskClass`（风险类）——**"缺陷类"与"风险类"是两件事**，文档把两者混在了一行里 | **C + D** |

## 14.9 结论

**一致（A）：8 项** —— 决策三分与预算规则、K1/K3/K4/K5/K7、度量仪表、语料第一半的自证覆盖、保留清单里 5 项、D10 的"无记录在结构上不可能"、D1 的档位重定义（今天落地）、阶梯接线（在真实 change 上验过）。

**差异（B）：9 项** —— 都是"落地形态与文档描述不同、且有真实理由"。**处置：改文档，不改代码**（§1.2 / §1.5 / §3 / §5 需要一次同步）。

**未落地（C）：6 项** —— 删除清单、`challenge ask|answer`、`high` floor、P6 的三项、§8 的 6 条验收、语料第二半。**处置：如实保留为"未做"，不要写成"已完成"。**

**E 类（3 项，最要紧）**：

1. **K2 落在弱形态**（#5）—— 方案的中心断言"把'能失败'变成内核自己的不变量"目前**只对 `executable_falsifier` 成立**，而我在两个真实 change 上用的**全部是 `invariant_proof`**（11 条 claim）。**实测：一条 `exit 0` 的检查可以让一个 major claim 通过。** 这正是旧机制抓到 11 次的类，**在新路径上重新打开了**。
2. **`readingSet` 有生产者无消费者**（#10）—— 它要消除的类，出现在它自己的实现里；S3 声称的成本收益**为零**。
3. **同一事实两处派生**（#20）—— §9 明确禁止的状态，受迁移次序约束而存在；后果已实测（账本 pass 与 findings 表 open 并存）。

**两件该修的（都不需要架构决策）**：
```
① K2 落到逐条：命令型证据（invariant_proof / executable_falsifier）**必须**带一个变异，
   或在 evidence add 时要求一个"它能变红"的证明；否则该证据不可受理。
② readingSet 要么有消费者（planner 把阅读集交给生产者，评审上下文按 claim 收窄），
   要么从方案里删掉这一项 —— 不能留着当装饰。
```
**一次文档同步**：§1.2（三种对象的实际形态）· §1.5（assurance 下限 / requiredRiskClasses / sampling / reviewers / riskFloors / evidenceStrength）· §3（"逐条检查都能失败"是弱式、7 类缺陷未搬）· §5（实际动词表）· §9（把弱式那句改成强式，或反过来把 §4 改成弱式并说明为什么）。

---

# 15. 差异补齐（第三轮：逐条修，不留返工）

> 指令：**直接补齐差异，中间不要中断，避免返工。** 本轮把 §14 的 17 条按"该改代码就改代码、该改文档就改文档、该记未做就如实记"逐条处置。**四条 commit。**

## 15.1 改了代码的四条（E 类与 C 类中被判定为真缺陷的）

| # | §14 的差异 | 处置 | 实测 |
|---|---|---|---|
| 1 | **K2 只落到按类型的弱形态**（E 类最要紧） | **删掉 `invariant_proof` 这一类**。它是 `executable_falsifier` 的弱拼法（唯一差别：作者有没有声明变异），而弱拼法没有变异字段 ⇒ 一条永远不失败的检查可获得 `supported`。属性测试/类型级不变量现在写成"变异违反该不变量"的 falsifier。于是**命令型证据只剩一种，且形状上必须带变异** —— 这是结构性约束，不是"要记住的规则" | 改前：`{"type":"invariant_proof","command":"bash -c \"exit 0\""}` → `supported` → **`decide: pass`**。改后同一份提交：`evidence[0].type must be one of executable_falsifier, static_witness, cross_artifact_contradiction, expert_concurrence`；把类型改成 falsifier 后：`mutation.file is required: a check that cannot be reddened is not evidence`（+ find/replace 两条） |
| 2 | 证据项自带一个**没人读的 `subjectRevision`**（合并时实测发现） | 删除该字段：判定陈旧的是**判决**记录的 subject，内核在那里比较；项上那份是"有声明无消费者" | 类型、schema、三个用例同步；测试里 5 处 `subjectRevision` 从项上移除 |
| 3 | **`readingSet` 有生产者无消费者**（E 类） | `plan` 落盘为 `plan.json`，`focus` **消费**它：按漂移收窄每个 claim 的阅读集（= 计划的集合 ∩ 实际移动的路径），并列出"无需重读"的 claim。没有计划时**按名拒绝**（不静默重推影响锥） | 实测：改 `src/a.ts` 后 `focus` → `reopened[{claimId:"C1",read:["src/a.ts"],why:"src/a.ts"}]`，`untouched: []`，note `read 1 path(s) across 1 claim(s)`；未改时 `reopened: []`，`untouched: ["C1"]` |
| 4 | **`riskFloors` 无 `high` 行 ⇒ security 档不可达** | 给 `src/kernel/policy.ts` 与 `src/kernel/decide.ts` 加 `high`（门自己所在的地方）。用例断言**可达性**而不是表：表缺行也"看起来完整" | 实测：触及 `src/kernel/decide.ts` ⇒ `tier: security` · `reviewers: 2` · `floor high from 1 matched path(s)`；触及 `src/quality/change-record.ts` ⇒ 仍是 `strict` |

## 15.2 顺手抓出的第五个缺陷（本轮自己长的）

`appendEvidence` **按 id 静默去重** ⇒ 重加一条内容不同的证据会报 `ok: true` 而什么都没写 —— 与早先修过的"challenge id 撞号静默 no-op"同一形状（命令说成功，事实没发生）。已改为一律拒绝并给出改正门：**`ledger evidence replace --file <set> --reason <why>`** —— 唯一的改写入口，校验整份集合、**丢弃被替换项的判决**（判决是对内容的读数，内容变了就没有读数）、把原因写进 run ledger。

它存在的理由是一个实测案例：**5 条已被本 build 删除的类型的证据**在持有一次 review approval，它们既不能重验、也不能改正、也没有任何命令能碰到它们 —— 没有这个门，那个账本就永久卡死。**这个门落地一小时内就被用了两次**（两个真实 change 各一条命令）：

```
review-record-integrity: replaced 5, droppedVerdicts [E1..E5] → verify 5/5 supported
round-protocol:          replaced 6, droppedVerdicts [E1..E6] → verify 6/6 supported
```
**11 条 claim 现在是"每条都有自己的变异、且 `{before:0, mutated:1, after:0}` 被实测到"**，两个 change 的账本判定都是 `pass | tier strict`。

## 15.3 改了文档的（B/D 类：形态不同、有理由 ⇒ 改文档不改代码）

§1.2 改为落地的三种对象（`evidenceIds`/`challengeIds` 为顶层追加式列表；`status` 是声明、状态由 `evaluateClaim()` 推导为 **9** 值；新增 `severity`/`at`/`reopens`）· §1.2 的证据联合改为**四类**并写明删掉第五类的理由 · §1.5 的 `assurance` 改为**下限**、补 `requiredRiskClasses`/`sampling`、`reviewers` 与 `evidenceStrength` 按落地值、`riskFloors` 补 `high` · §3 更正"7 类缺陷未搬"（且指出**"缺陷类"与"风险类"是两件事**，早期把两者混在一行）· §4 的 K2/K6/K7 按实况重写（K2 的**结构性**落地方式、K6 只覆盖最弱一类、K7 的 `policy-floor:` claim 会让判定立刻 `insufficient`）· §5 的 CLI 改为**实况动词表**并点明 `challenge ask|answer` 未落地 · §7 补"实况"一行（P0 两件已做、P1 只落一半、§2 一行未删、P6 只落 K6/K5）。

## 15.4 如实记为"未做"的（C 类）

```
① §14 与 §9 的冲突：唯一的 `examples/greeting.ts` 与任何规则无关 ⇒ 删掉该突变规格，并把"没有共享规则"
   作为协议层的一个**已声明空集**（`ROUND_RULES_SHARED_WITH_THE_REPOSITORY = []`）。
   更好-known 的两个实例在同一周内都已被撤回（change record 的 surface 推导、brief 的 class 词汇），
   所以协议声明"不共享任何规则"，而不是列几条并邀请下一条。
② §5 的 `challenge ask|answer`：未落地（落地的是反例账本那一半）。
③ §8 的 6 条验收仍不可测 —— P1 的语料（change 级 baseline）仍未开始，而它是"关键路径"。
④ 语料第二半（遗留缺陷 + baseline）仍未开始；本轮只补了三个**新机制**的失效模式种子。
⑤ §2 删除清单仍一行未删（次序理由见 §13.7；本轮把"新路径成为默认"的最后一块拼图补上了）。
```

## 15.5 两条"超出计划"但方向相反的记录

- **`review --approve` 学会了账本路线**（§13.8 之前的工作）：`absent` 走旧路、`decided+pass` 走账本、`unreadable`/漂移/非 pass 各自按名拒绝，记录里写 `reviewRoute` 与 `ledgerReview.limits`。**这使 §14 #20 的"同一事实两处派生"从"巧合安全"变成"设计安全"**：账本通过而旧 findings 表仍有 open major 时，门取更严的那个，且拒绝信息同时也是账本缺口的清单。
- **`host/pi-adapter.ts` 仍是真实的第二支平台代码**。它现在只做"启动 + 映射事件流"，语言里没有任何平台概念（kata 侧平台词汇量 = 0）—— 这是"平台解耦"在**代码**层面成立的证据，而不是声称。

---

# 16. 第四轮审查：**结合设计方案再读一遍代码**（10 条，其中 4 条新发现）

> 方法：不再读自己的叙述，而是**拿设计方案的每一句当断言去核代码**——三层边界、三种对象、四条不变量、CLI 动词、保留清单、D1–D10。上两轮（§14/§15）已处置的 17 条不重复，这里是**新一轮**读出来的。

## 16.1 设计说对了、代码也对（复核，A 类 6 条）

| # | 设计断言 | 代码事实 |
|---|---|---|
| 1 | 「`src/kernel/` 纯函数 · 无 I/O · 无平台名」（§1.1） | `KERNEL_BANNED_BUILTINS` 枚举 `node:fs` / `child_process` / `net` / `http(s)` / `os` / `worker_threads`；K5 用例文本+类型双查通过 |
| 2 | 「三种对象，替代今天的一整族」（§1.2） | `Subject{revision, pathDigests}` · `Claim{…at,reopens,waiver}` · `Evidence`（4 类）——**没有再出现第四种记录型对象** |
| 3 | 「`decide()` 取数据，不跑命令、不读文件、不命名平台」（§1.4） | `DecideInput` 15 个字段**全是数据**；无回调、无 port、无 clock |
| 4 | 「预算耗尽永不等于通过」，且「预算第一个判定」（§1.4 / K3） | `decide.ts:192` 是函数体第一段判定，且只 push `insufficient` 类 reason |
| 5 | 「每条命令型检查都必须带变异」（§4 K2，§15 已改成结构性） | `executable_falsifier` 是唯一的命令型；形状检查对缺变异给出**具名**拒绝 |
| 6 | 保留清单 7 项中 6 项原样搬走（§3） | `pathDigests` ✓ · `ledgerDrift`/`focus` ✓ · 三步 `{before,mutated,after}` ✓ · 逐条变异纪律 ✓ · `deriveDeadline` ✓ · 严重度门槛 ✓ |
| 7 | D4「`expert_concurrence` 不得单独支撑 blocking」（§6） | `MIN_STRENGTH_BY_SEVERITY.blocking = 4` + `!isReproducible(type)` 双条件，**且拒绝话说得出理由** |

## 16.2 设计说「是」，代码说「不是」——**新发现的 4 条**

| # | 设计断言 | 代码事实 | 类 |
|---|---|---|---|
| **A** | **§7 P5 说 assurance overlay 会把「旧轮协议登记表降级为一个 adapter」** | **今天有两个预算/包络真源**：`kernel/policy.budgets`（`maxWallMs: 1_800_000` · `deadlineToolCalls` · `maxTokensPerChange`）与旧路径的 `DEFAULT_REVIEW_BUDGET`（由 `MEASURED_REVIEW_PASS_COST × REVIEW_HEADROOM` 派生，`adversarial.ts:2088-2102`）。**新路径的 `budgetStatus` 读前者**，而 `falsify`/证据验证的**实际执行**仍由后者的常量家族与 `runProcess` 超时控制。§9 风险表把「同一事实两处派生」列为必须由「每阶段带删除动作」消除的对象——**这正是它的一个活实例**，而且两条路给出的数不同（1.8e6 ms vs 实测派生的值） | **E**（受迁移次序约束，但**必须记名**：两个数不一致时，没有任何检查会说话） |
| **B** | **D10「无记录在结构上不可能：claim/evidence 是增量落盘」** | 增量落盘为真（`appendClaim` / `appendEvidence` 逐条 `mutate`），**但「一次提交一份文档」的旧形态仍然在线上并仍是门的一方**：`adversarial record` 仍要求 `adversarial-review.json` + 611 行 schema，`review --approve` 在**没有账本时**仍以它为通过依据。所以 D10 今天成立的是「**新路径**没有单通道产物」，而不是「仓库没有」 | **B**（文档措辞需限定：D10 说的是新路径，不是全仓） |
| **C** | **§1.5 的 `humanBudgetMin` 是「人工预算：人的时间必须显式定价」（D7）** | 它由 `planner` 算进 `ReviewPlan`、`plan` 落盘为 `plan.json`，**但没有任何消费者读它**：CLI 不打印、`focus` 不用、`decide` 不看。这与 §15 修掉的 `readingSet` 是**同一个类**（`a-definition-with-no-consumer`），只是它还没被抓到——因为 §15 只修了被点名的那个 | **E** |
| **D** | **§5 的动词表把 `focus` 写成「影响锥与漂移（吸收 lane）」** | 落地形态是「**收窄计划里的阅读集**」——它读 `plan.json`，没有计划就按名拒绝。这**更好**（它消费计划的答案而不是第二遍推导），但**它现在不能独立回答「哪些 claim 受影响」**：没有 `plan.json` 时它什么也不说，而 §14 记录的「影响锥」语义因此**只在有计划的路径上存在**。文档已按实况改写，但**「lane 的漂移计算」这一保留项实际只保留了一半**（漂移有，独立的影响锥没有） | **B** |

## 16.3 设计与代码的措辞差（需一次文档修订，无代码改动）

```
① D3「反例落在 challenges/，在产品测试套件之外」：未落地（无 challenges/ 目录）。
   今天反例的载体是账本的 challenge 账（可执行命令 + check 的三态），它满足 D3 的**意图**
   （角色分离、可执行、不进产品套件），但没有落成 D3 描述的那个**文件形态**。
   ⇒ 文档应改写为「反例作为一个可执行的账目条目，而不是写入产品套件」，并说明未采用目录形态的理由。
② §8 的 6 条不可测验收（§14 已记）与 §16.2 A 是同一个成因：**P1 语料未开始**，
   而两条预算真源的「哪个数是对的」也只能靠语料回答（实测分布 vs 派生常量）。
③ §1.1 说 assurance 层「沙箱 · 身份 · 签名 · 审计 · 旧轮 protocol 的 demoted 适配器」：
   落地的是**两支持久化 adapter**（inline=observed / file=relayed），沙箱与签名仍是占位。
   这不是缺陷（D8 明确 v2 不引入签名），但 §1.1 的括号内容应改为「已落地的两支持久化 adapter + 占位」。
```

## 16.4 本轮审查的判决

**设计对代码的符合度**：`§1`–`§7` 的**结构性断言全部成立**（三层、三种对象、纯内核、四不变量、保留清单 6/7）。**不成立或部分成立的是"这一层已经收口"的四条**——都是迁移次序的产物，不是设计错误：

- **A（两条预算真源）** 是这四条里唯一有**真实风险**的：它让「预算耗尽永不 pass」在新路径上由一个数决定，而实际执行由另一个数约束，**两者不一致时没有任何检查会说话**。
- **C（humanBudgetMin 无消费者）** 是 §15 那个类的**漏网实例**：修一个被点名的，还有一个没被点名的——**这说明那个类的检查（wiring check 只覆盖导出，不覆盖 policy 字段的"下游消费者"）本身有盲区**：policy 字段的消费者是**声明**在 `POLICY_CONSUMERS` 里的，而那个声明由人写；`humanBudgetMin → producers/planner` 是**真的**（planner 确实读了），只是 planner 的输出没人读。**所以「有消费者」这条不变量的传递性没有检查**——一层有消费者、二层没有。

## 16.5 建议的两条修（都不需要架构决策，且都不动在飞的 change）

```
① 两条预算真源：让 kernel 的 policy.budgets 成为唯一的数源，
   旧路径的 DEFAULT_REVIEW_BUDGET 改为**读取 policy**（或至少加一条断言：两者相等，
   不等即失败）。这样「实测分布」与「策略数据」的差会变成一个会失败的事实，而不是两个数。
② policy 字段的消费者要检查**传递性**：`POLICY_CONSUMERS` 只证明第一跳有人读；
   加一条用例断言「每个被声明的消费者模块，其输出至少有一个下游消费者」——
   humanBudgetMin 会在那里被抓住（planner 的输出只有 plan.json 的读者）。
```

---

# 17. P1 的第一件：**C0 的真实分布**（三个真实 change 的实测，不是估算）

> P1 被写成"关键路径"，而它的第一件事是拿到 `C0` 的真实分布 —— 没有它，§8 的 6 条验收全都只能靠印象。今天有**三个 change 走完了新路径**，所以这是第一次能拿真实数字说话。用法：`kata-cli ledger status --cost --change <id>`（仪表在 §13 落地，`baseline` 字段如实写 `none recorded yet`）。

| change | claims | 每条 claim 的变异 | 中位 claim→supported | 首条 claim → 末次 verify | reopenings | 反例 | refutationRate |
|---|---|---|---|---|---|---|---|
| `round-protocol` | 6 | 6（全部 `{0,1,0}`） | **490 min（8.2 h）** | 2026-09-26T18:28 → 18:31 | 0 | 1 撤回 | 0 |
| `review-record-integrity` | 5 | 5（全部 `{0,1,0}`） | **125 min（2.1 h）** | 00:31 → 02:37 | 0 | 1 撤回 | 0 |
| `adversarial-admissibility` | 6 | 6（全部 `{0,1,0}`） | **3.5 min** | 06:07 → 06:11 | 0 | 1 撤回 | 0 |

## 17.1 这三个数说明的三件事（都影响 §8 的验收）

**① 「claim→supported」测的是流程的墙钟时间，不是工作量。** 三个 change 的差别是 8.2 h / 2.1 h / 3.5 min —— 而它们的**实际证据工作量几乎相同**（5–6 条 claim，每条一次三步变异，各自一次反例）。差别全在**人与人之间的停顿**（我在等什么、什么时候回来）。所以这个指标**不能**当作"评审成本"读；它能回答的是"一条 claim 从声明到有据用了多久"，而那是一个**流程延迟**指标。

**② `reopenings = 0` 在三个 change 上全部成立 —— 而这是新机制相对旧机制最大的一处对比。** 旧机制下，一次修复**必然**重开（修 → 新 revision → 上一轮的记录失效 → 再评审）；新机制下，**一次修复只重开它触及依赖的那些 claim**（K4），三个 change 的实测值都是 0 ⇒ **§8 的「full re-review ↓≥70%」在"claim 级重开"这个意义上的目标已经达到了**（旧机制是 100% 重开，新机制 0 次）。

**③ `refutationRate = 0` / `challengeWithdrawalRate = 1` 是**好消息也是**盲区**：三个反例全部"提出后未复现"（撤回）而不是"复现了"（真缺陷），说明这三个 change 的验收项在提出反例时确实成立；但它同时说明**语料里还没有"反例真的抓到一个缺陷"的样本** ⇒ `refutationRate` 这个指标从未在非零处被测过 ⇒ 它现在是一个**未被行使的分支**，和本轮修掉的那批"从未失败的检查"是同一个形状。**这是 P1 第二件事要补的。**

## 17.2 对 §8 六条验收的影响（诚实映射）

```
no-record rate = 0%              ✅ 结构上成立（增量落盘），三个 change 实测无丢失
full re-review ↓ ≥70%            ✅ 在 claim 级重开的意义上达到（旧 100% → 新 0 次）
预算耗尽 永不 pass                ✅ 用例覆盖 + 三个 change 的实测都没触发
内核平台耦合 = 0                  ✅ K5 用例
gate mutation kill = 100%        ⚠️ 「每条注册的检查都带一个会变红的变异」在执行层成立（三个 change 的 17 条 claim
                                    全部实测 {0,1,0}），但【仓库里仍有未带变异的检查】—— 那是旧路径的检查，
                                    不在新内核的注册表里 ⇒ 这条要按「新路径」限定，或把旧检查也纳入
CriticalRecall / FalsePass       ❌ 仍不可测：语料（src/eval/admissibility-corpus.ts 的 27 例）存在，
                                    但【没有 observation 的生产者】—— 没有一次真实的"用一个 verifier 跑整个语料"的运行
Cost ≤ 0.6 C0                    ❌ 不可测：C0 需要"旧机制每 change 的成本"，而旧机制的 token 数只有轮次记录里有，
                                    且那些轮次的产出是零记录（§14 已记），拿它们当 baseline 会把 0 当分母
```

## 17.3b 召回缺口的一半：**可探测性**（本轮新增）

`scoreCorpus` 的 observation 此前只能手写，因为没有**会产出 finding id 的 verifier 实现** —— 这就是"召回不可测"的根因。本轮落下它的**便宜那一半，且诚实**：

9 条 critical 语料中有 **4 条**的 `reproduction` 已经精确到"改实现里的哪一处"（`mutation-case`）。一条已埋缺陷是**可探测的**，当且仅当**拥有它的那条检查在缺陷被放回时变红**。于是：

```
kata-cli ledger detectability
  · 对每条 probe 跑三步：检查先绿 → 放回缺陷 → 检查变红 → 还原 → 检查复绿
  · 实测：measured 4 · detected 4 · undetected [] · inconclusive []
    每条的 observed = {before: 0, mutated: 1, after: 0}
  · NOT_PROBED 列出 14 条【未覆盖】的 critical 用例，每条带原因（"需要一次 CLI 会话"／"需要两个 revision"…）
  · measures 明写：它度量的是"拥有该缺陷的检查是否仍能看见它"，【不是】"评审者是否会找到它"
```

三条诚实规则被用例固定：**probe 集合与语料的 mutation-case 必须双向吻合**（有 case 没 probe、有 probe 没 case 都拒绝）· **未覆盖的用例必须具名带原因**（"4/4 detected" 不能被读成 "4/27"）· **锚点消失按 inconclusive 报**而不是按"探测失败"报（缺陷的位置变了，是需要重写那条用例，不是 detection 失败）。

**它的价值边界**：这个率**不会因为读得更仔细而上升**，只会因为一条检查被修好而上升 —— 所以它弱于召回、强于一无所有，且它是**目前唯一不需要 verifier 实现就能拿到的形式**。

## 17.3a 语料对账（本轮新增，零成本、确定性）

`ledger corpus` 现在同时输出 **对账**：两批语料各持有哪些类、哪一边有缺口。

```
shared      a-clean-revision(2 vs 1) · a-defect-that-shipped(24 vs 20) · a-guard-that-refused-honest-work(3 vs 1)
onlyRetired []        ← 【旧语料问的每一个问题，新语料也问】
onlyCurrent []        ← 反向亦然
counts      27 vs 22
measures    corpus coverage overlap between the two corpora, not recall or defect-finding ability
```
**这是"语料覆盖"而不是"召回率"**，且输出里明写了这一点。它零成本、可确定性重跑，回答的是此前**完全没有人问过**的问题：新语料的覆盖面有没有落下旧语料问过的任何一类。今天的答案是**两边没有缺口**（类目映射写在 `CLASS_MAP`/`MODE_MAP` 一处，供人核对），而**未映射的标签会被报成它自己的一类**而不是被丢掉 —— 否则当前一侧会被低报。

## 17.3 已落地的两件（②③）

**② 反例语料**：`tests/fixtures/review-scenarios.ts` 加了两条种子 —— `a-counterexample-that-reproduces`（反例真的复现 ⇒ blocked）与 `a-refuted-verdict-survives-the-counterexample`（已反驳的判决不被反例软化：`fail` 优先于 `insufficient`，两个 reason 并存）。**`refutationRate` 从此有一个非零样本**，而不再是一个只在 0 处被读过的指标。

**③ 语料对账入口**：新增 `kata-cli ledger corpus` + `src/store/corpus.ts`。它把**新机制自己的失效模式语料**喂给 `decide()`，逐条对照每条种子写的期望，输出三样东西：

```
cases · matched · mismatched（带【两侧】：期望 vs 实际，以及缺哪些 reason）
byVerdict（pass/insufficient/fail 的分布，让语料的形状漂移可见）
reasonsExercised / reasonsUnexercised（内核能产出的每一个 reason 都必须被某条种子行使）
measures（明确写出它【不】度量什么：不度量"没人埋的缺陷能否被发现"）
```

**实测**：`ledger corpus` → `22 / 22 matched · byVerdict {pass:5, insufficient:15, fail:2} · reasons 14 条全部被行使 · unexercised 空` ✓
四个用例固定它的三条性质：**会报分歧而不是平均掉**（verdict 一致但 reason 缺失也算 mismatch）· **一条坏种子不会掩盖其余二十条**（builder 抛错被报成 mismatch）· **它说出自己不适合回答的问题**（`measures` 字段）。

```
§8 的映射因此更新：CriticalRecall / FalsePass 的【分母】现在有了（22 条种子 + 逐条期望），
但分母的另一半 —— 真实 verifier 的 observation —— 仍需要一个会产出 observation 的运行；
而"缺陷召回"这条仍是语料本身的局限（种子是我们写的，不是历史缺陷）。


```
② 反例语料：给 `refutationRate` 一个非零样本 —— 在 `tests/fixtures/review-scenarios.ts` 里加一类
   「反例抓到一个真缺陷」的种子，让该指标的分母与分子都被行使过（否则它是未被行使的分支）。
③ 语料对账入口：`scoreCorpus` 今天只被旧 eval 调用（需要一份手写 manifest），而新内核的 20 条种子
   与 27 例语料之间【没有任何连接】。要么给新内核一个 `ledger corpus` 入口（把种子当语料、把
   `decide()` 当 verifier、输出 recall/false-pass），要么如实记录「新内核的语料把旧 eval 的语料孤立了」。
```
