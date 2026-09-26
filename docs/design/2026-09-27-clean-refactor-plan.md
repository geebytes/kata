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
│   沙箱 · 身份 · 签名 · 审计 · 旧轮协议的 demoted 适配器        │
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
  dependsOn: string[];             // claim id 或其它的路径摘要 → 依赖锥
  evidence: EvidenceRef[];         // 见 1.4
  challenges: Challenge[];         // 针对它的反例/挑战（可执行，失败即未解决）
  status: 'open' | 'supported' | 'refuted' | 'insufficient' | 'waived';
  waivedReason?: string;
};

// ③ 证据：五类，每类有确定性的 verify()
type Evidence =
  | { type: 'executable_falsifier';      command: string; subjectRevision: string; expect: 'red' }
  | { type: 'static_witness';            ref: string; assertion: string }
  | { type: 'invariant_proof';           invariantId: string; command: string }
  | { type: 'cross_artifact_contradiction'; a: string; b: string; comparator: string }
  | { type: 'expert_concurrence';         reviewers: string[]; humanAck: string };  // ← 限制见 §6
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
**硬规则（property test 覆盖整个决策矩阵）**：`budget_exhausted ⇒ verdict !== 'pass'`。

### 1.5 `Policy`（数据化：今天写在代码与 brief 里的东西全部搬到这里）

```jsonc
{
  "version": 1,
  "tiers": {
    "standard": { "autoEvidence": ["static_witness","invariant_proof"],
                  "reviewers": 1, "quorumOn": ["uncertainty","new_class","weak_evidence"],
                  "assurance": ["none","relayed"], "humanBudgetMin": 0 },
    "strict":   { "autoEvidence": "+executable_falsifier", "reviewers": 1,
                  "quorumOn": ["disagreement","high_risk"], "assurance": ["relayed","observed"],
                  "humanBudgetMin": 10 },
    "security": { "autoEvidence": "+security_checks", "reviewers": 2,
                  "quorumOn": ["always"], "assurance": ["sandboxed","signed"],
                  "humanBudgetMin": 30 }
  },
  "riskFloors": { "src/workflow/seal-preflight.ts": "high", "src/quality/**": "medium" },
  "riskFloorAudit": { "changesRequireReview": true },   // ← floor 变更走同一套评审
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
| brief 内**数字期限** | 无记录轮次从 **0/4 → 6/6** 的唯一有效杠杆 |
| 严重度门槛（`std` 拦 blocking，`strict` 加 major） | 已存在，只是**从未真正启用** |
| 7 类缺陷（作为词汇） | 它们是好词汇，坏的是"用它当终止条件" |

---

## 4. 内核不变量（**新测试策略：属性 + 变异，而不是夹具**）

| # | 不变量 | 怎么测 |
|---|---|---|
| **K1** | `decide()` 纯且全域：同输入同输出，无 I/O | 属性测试 + 类型层面禁止 `fs`/`child_process` 导入 |
| **K2** | 每条被接受的证据都满足其类型检查，且该检查**在变异下变红** | 每类证据一个变异用例（本线已有 11 次成功先例） |
| **K3** | `budget_exhausted ⇒ verdict !== 'pass'` | 遍历整个决策矩阵 |
| **K4** | delta 复用不放宽：`reused ⊆ 未变 ∩ 依赖未受影响`；依赖不可推导 ⇒ **全开** | 生成"改动 + 图"组合，断言集合包含关系 |
| **K5** | `src/kernel/**` 里**不出现任何平台标识**（`pi`/`session`/`adapter`/`receipt`…） | 文本 + 类型双查（同时是 Platform Coupling Index 的实现） |
| **K6** | **同一主体在两个 adapter 上必须得到同一个 decision** | cross-adapter differential test（这是"内核平台无关"的唯一实质证据，比数类型出现的次数强） |
| **K7** | `riskFloors` 的变更**自身走同一套评审** | floor 改动产生一个 claim，且该 claim 属于 `privilege` 类 |

---

## 5. CLI（7 个动词，替代今天的 `adversarial`/`matrix`/`lane`/`findings` 等一大族）

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
| **D3** | 允许生产者写 `challenges/`（**在产品测试套件之外**）；**只有被作者采纳后才进入产品套件** | 保住角色分离，同时让反例可执行 |
| **D4** | `expert_concurrence` **禁止单独支撑 blocking/security**（必须带人类签字） | 否则把"遗漏"重新包装成证据 |
| **D5** | `riskFloors` 是数据，**其变更走同一套评审** | 否则它是绕过门的后门 |
| **D6** | **必须投入 benchmark 语料**（阶段 1） | 没有它，一切验收只能靠印象 |
| **D7** | 人工预算：standard 0–10 min · strict 10–30 min · security 按风险 | 人的时间是最贵的资源，必须显式定价 |
| **D8** | v2 **不引入签名/透明日志**；`assurance` 的 `signed` 为占位 | 只在跨信任边界时才需要 |
| **D9** | **不采用任何语义不符的标准词汇**（OTel 的 `gen_ai.agent.id` 等） | 名字宣称代码没有的意思 = 本仓库最常抓的类 |
| **D10** | 无记录不再可能：claim/evidence 是**增量落盘**，没有"最后交一份 JSON"这一步 | 实测 62 轮中 28 轮丢失全部产物 |

---

## 7. 阶段（**重写，不是改**；每个阶段含一个"删除"动作）

| 阶段 | 时间 | 交付 | **同时删除** |
|---|---|---|---|
| **P0 立刻** | 0.5–1 天 | 真正启用严重度门 · 保留数字期限 · **E1**（把某 change 的 AC 从"有通过证据"改为"有一个会变红的变异"） | 无（零架构） |
| **P1 语料** | 1–2 周 | 历史 corpus · seed 缺陷 · known-good revision · `C0` · 指标仪表盘 | 无 |
| **P2 内核** | 2–3 周 | `subject/claim/evidence/delta/risk/policy/budget` + K1–K5、K7 | `adversarial.ts` 的记录与门部分、覆盖协议、引用守卫 |
| **P3 生产者** | 1–2 周 | `port.ts` + `static-analysis`/`mutation`（由 `falsify` 升格）/`llm-review`/`human`/`quorum` + `planner` | `finding-disposition`、`repair-batch/obligations/rounds` |
| **P4 CLI + schema** | 1–2 周 | 7 个动词 + 5 个小 schema | `adversarial-review.schema.json`、旧 CLI 族、轮次历史与替换链、`salvage` |
| **P5 assurance overlay** | 1 周 | 旧轮协议/登记表降级为一个 adapter；沙箱与签名留占位 | 凭据作为必需、`executedInFreshContext` 参与判定 |
| **P6 收敛与验证** | 1 周 | K6 cross-adapter 差分 · Platform Coupling Index · Adapter Change Radius · shadow 试点 | 旧测试夹具（45 文件） |

**关键路径是 P1**：没有语料，P2–P6 的每一步都只能用印象验收。
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
