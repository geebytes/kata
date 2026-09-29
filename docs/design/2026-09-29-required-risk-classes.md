# 设计：风险覆盖要求（required risk classes）

**状态**：设计稿，待开 governed change 实施
**上游**：`docs/design/2026-09-28-bounded-review-convergence.md` §20（现象与诊断）
**位置**：`src/kernel/policy.ts` 的 `tiers.*.requiredRiskClasses` 与 `src/kernel/decide.ts` 的覆盖检查——**gate 强度所在的位置**，所以它是一条独立的 change

---

## 1. 现象（实测，不是推断）

`bounded-review-convergence` 在收口时被 ledger 拒绝，理由只有一条：

```json
{"ok": false, "verdict": "insufficient",
 "reasons": [{"code":"uncovered_risk_class","claim":null,
              "detail":"no claim covers: failure_mode",
              "message":"The change touches a risk class that no claim covers."}],
 "deficits": []}
```

链条：

1. 变更触及 `src/quality/**`、`src/workflow/**` → `policy.riskFloors` 命中 `medium`；
2. `FLOOR_TIER.medium = 'strict'`（`kernel/risk.ts:11`）；
3. `strict.requiredRiskClasses = ['consistency', 'boundary', 'failure_mode']`（`kernel/policy.ts:121`）；
4. `verdict.ts:228` 把**档位的固定风险空间**作为覆盖要求传给 `decide`；
5. 四条 claim 覆盖 `consistency / boundary / state_transition`，无 `failure_mode` → 拒绝。

## 2. 为什么这是机制问题

**`failure_mode` 是任何 `strict` 变更都被强制要求的风险类，与变更内容无关。** 三个后果：

1. **纯粹的修复也会被要求硬造一条 `failure_mode` claim。** 本次变更是一条一致性修复（一个严重度阶梯、一个阻塞问题读者、一个循环终态），它没有引入失败路径，却必须声明 `failure_mode` 才能通过。
2. **补 claim 不增加真实覆盖。** claim 是**声明**而非证据——补它只是让覆盖检查通过。这正是本项目最反对的形状：**gate 可以被文字满足**。`verdict.ts:226-227` 的注释已经在防"用 claims 反推要求"（那会让覆盖检查永不失败），但没防"要求与变更无关"这一侧。
3. **系统自相矛盾**：`deficits: []` —— 没有可补的缺项，却仍拒绝。一个只报 `reasons` 而不报 `deficits` 的拒绝，操作者无法从中得知"该做什么"。

### 附带的措辞问题（同一个诊断里发现）

- `evidence_below_strength` 在 **stale subject** 场景下报 `need: "evidence of strength >= 3"`，而强度根本不缺（`executable_falsifier` 强度为 4）；缺的是"在新 subject 上的判定"。本次变更里我按这条措辞理解，**方向完全错了**（去补更强的证据，而实际只需 `ledger evidence verify` 重判）。
- `replay` 只报告不写盘（模块注释自己写明），因此"重放确认一致"与"判定已更新"是两件事，而输出里没有区分。

## 3. 根本解法：A（推荐）

**把 `requiredRiskClasses` 解释为"这些类**若被本次变更触及**，则必须有 claim"，"触及"由既有信息机械判定。**

- 判定链已存在：`classifyRisk`（`kernel/risk.ts:62`）已经算出 `matched`（命中的 floor 模式）与路径集；`policy.riskFloors` 已是"模式 → floor"表。
- 需要补一张 **"模式 → 风险类"** 表（或把 `riskFloors` 的值从 `Floor` 扩成 `{floor, riskClasses}`），例如：触及 `src/kernel/**` → `consistency`；触及对外边界/协议 → `boundary`；触及重试、超时、恢复路径 → `failure_mode`；触及权限/凭据 → `privilege`；触及证据/引用的来源 → `provenance`。
- `decide` 的覆盖检查变成：`requiredRiskClasses ∩ touchedRiskClasses ⊆ claimedRiskClasses`。
- **仍不可被文字满足**：`touchedRiskClasses` 由路径与模式表机械推出，作者改 claim 不能改变它；而模式表本身的变更已经有守卫（`policyFloorChangeClaims`：floor 表每个增删改都变成一条 `privilege` claim，`kernel/risk.ts:96-118`）——同一守卫应覆盖风险类映射。

### 验收标准（拟）

- **AC-1**：一个只触及 `src/quality/**`（模式表判为 `{consistency}`）的变更，在无 `failure_mode` claim 时**通过**覆盖检查；同变更加一条触及 `failure_mode` 模式的路径后**被拒绝**，并指名该类。
- **AC-2**：模式表的任何增删改都产生 `privilege` claim（与既有 floor 守卫同形），并有会红的用例。
- **AC-3**：`uncovered_risk_class` 的拒绝**必须同时给出可执行信息**——要么 `deficits` 非空，要么 `detail` 里指名"哪个路径/模式推出了这个类，因此需要什么 claim"。**`deficits: []` 而 `reasons` 非空**是不允许的状态。
- **AC-4**：`evidence_below_strength` 在 stale verdict 存在时**不得**以强度措辞报告；改为 `evidence_stale_subject`（该 code 已存在），或把 `need` 文本改成陈述真实缺项。

## 4. 备选 B（更彻底，代价更大）

引入**声明式风险覆盖**：作者在 plan 阶段声明本次变更的 `riskClasses`（带理由），`decide` 校验"声明的类都被 claim 覆盖" + "未声明的类必须给出不适用理由"，并要求**评审者**确认（而不是作者自证）。

- 优点：覆盖要求显式、可审计，不依赖模式表的完备性。
- 缺点：新增一个人工声明面与一条评审动作；模式表不完备时它只是把"漏判"换成"漏声明的理由"。
- 判断：**A 先做**。A 的机械性更强，且与既有的 floor 守卫同构；B 可以作为 A 之上的一层（当模式表无法覆盖某个类时，允许用声明面补齐并记录理由）。

## 5. 非目标

1. 不改 `MIN_STRENGTH_BY_SEVERITY` 与 `autoEvidence`（证据强度语义本轮无争议）。
2. 不改 `reusedEvidence` / delta 复用的判定（那是"读状态语义"与 delta 的题目）。
3. 不为本 change 破例：**本 change 按人工裁定收口，不在此处改 kernel。**

## 6. 未决问题

1. "模式 → 风险类"用单独一张表，还是把 `riskFloors` 的值扩成对象？后者改动既有 schema（`riskFloors: Record<string, Floor>`），前者多一张需要同步的表——两张表会不会又变成"同一事实两个来源"？（本 change 反复踩过的那个坑。）
2. 触及判定用 `matched` 模式集，还是用路径集？模式集更稳（路径可能新增），但模式表不完备时会漏判——需要在输出里如实说明"本判定基于模式表"。
3. 若某个 `requiredRiskClasses` 类**无论如何都有意义**（例如 `privilege` 对任何写 `.kata` 的变更），是否应该有"无条件类"与"条件类"之分？
