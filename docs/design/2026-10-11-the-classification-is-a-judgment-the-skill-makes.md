# 分类判定由 skill + agent 做出，机制只负责事实、下界与留痕

**日期**：2026-10-11 ｜ **来源**：用户指令「分类判定应该遵循 skill + agent 优先」
**profile**：待定（见 §6；建议 `current_worktree / tdd / strict`）

---

## 1. 今天是谁在决定（实测）

| 层 | 今天谁决定 | 证据 |
|---|---|---|
| 档案 `reviewMode` | **作者**（`open --review std\|strict\|security`，默认 `std`） | `src/core/workflow-profile.ts:6,27` |
| 产物分类 `classifyRisk` | **路径表**（`riskFloors` 的最高 floor；无 floor 且 ≥25 路径 ⇒ 抬到 medium） | `src/kernel/risk.ts:67-110` |
| 账本档位 `resolveTier` | override 赢，否则 `max(分类, ledgerTierCeiling='strict')` | `risk.ts:62-67` |
| "要不要独立复核轮" | **没有机器判据**：需要有人执行 `/kata-review`；`reviewers` 字段在 `src/` 里**无派发消费者**（只有注释与测试） | grep 实测 |

**分类结果没有被持久化**：`classifyRisk`/`resolveTier` 只在 `producers/planner.ts`、`cli/ledger.ts`、`kernel/decide.ts`、`store/verdict.ts` 里被**当场用掉**（算所需证据、risk classes、账本档位），任务/计划记录里没有它。⇒ 复核者看不到"这个 change 被判成哪一档、为什么"。

**结论**：今天"值得独立严格复核"实际上由**作者在 open 时的一个 flag** 决定，路径表只约束账本档位；而路径表本身**是产物规则**，看不见语义（一行注释落在 `src/workflow/**` 与整个状态机重写同档）。

## 2. 原则（用户指令的落法）

> **判定是判断，不是查表；判断属于 skill + agent；机制负责给出事实、保住下界、把判断留痕并在需要处呈现。**

分工：

| 角色 | 负责 | 不负责 |
|---|---|---|
| **skill**（`phase-guidance.ts` 渲染进 `/kata-open`、`/kata-design`） | 提出**分类问题清单**，并要求 agent **给出分类 + 理由 + risk classes + 该类的机械化可能** | 不写死结论表；不代替 agent 读 diff |
| **agent**（宿主编码代理） | 读改动、回答清单、**做出并被记录为判断方**（`by: 'agent'`） | 不得低于机制下界（见下） |
| **机制（CLI）** | ① 给出**不可伪造的事实**（触碰路径、命中的 floor 与 pattern、广度、上档位的历史）；② **fail-closed 抬升**：agent 的分类低于路径下界 ⇒ 按路径下界执行并**具名说明**；无分类/不可解析 ⇒ 按最严；③ 把分类**留痕**（任务/计划记录 + ReviewRequest 携带）；④ 审计（谁抬过、谁 override 过） | **绝不自称做了模型判断**（本仓原则：kata 不调用、不路由、不记录宿主平台模型）；**绝不把分类当成已验证的事实**——它是一条被记录的判断 |

**不新增宿主/平台适配器**：agent 就是宿主平台自己的编码代理；机制只发确定性事实、只收一条结构化记录（与既有的 `review-finding` / `claim` 记录同形）。

## 3. skill 提出的清单（把路径表想近似的东西变成问题）

1. 这个改动是否改变**门禁语义**（某道门通过/拒绝的条件）？
2. 是否改变**身份/标识**（revision、subject、记录槽位）或**哈希/摘要的派生**？
3. 是否改变**schema**，或一个**已被强制的不变量**的强制方式？
4. 是否改变**信任边界**（谁能写、谁能批准、什么算"独立"）？
5. 是否改变**对外可观察契约**（CLI 输出、记录形状、他人依赖的字段）？
6. 证据能否**机械判定**（生成器/关系/变异可自动成立），还是必须由人判断（意图、语义、边界）？
7. 这是**既有类的又一例**，还是**新类**？（既有类：复用该类已建的仪器，不重买一轮）

前 5 问的任一"是" ⇒ 至少 `strict`（并且**给出理由**，理由进记录）；第 6 问决定"独立人力花在哪"；第 7 问接 I-10 与类台账。

## 4. 记录形状（机制侧）

```
classification: {
  tier: 'standard' | 'strict' | 'security',
  by: 'agent' | 'floor',              // 谁定的；floor 表示被机制抬升过
  reasons: string[],                  // agent 的理由（skill 清单里的第几问）
  riskClasses: RiskClass[],           // 与 floor 同一张表派生，防止"抬了 floor 不说它关于什么"
  facts: { paths, matchedFloors: [{pattern, path, floor}], breadth, previousTier? },
  raisedBy?: 'floor' | 'override',    // 被抬升/被 override 时具名
}
```

- **`by: 'floor'` 的场合**：agent 给的档位低于路径下界 ⇒ 机制**抬升**并写明（这是 fail-closed 的既有方向，不改强度）。
- **`override`**（今天 `resolveTier` 里"命名的档位赢"）：保留，但**必须留痕**（谁、为什么），因为它是今天唯一能低于分类的出口。
- **ReviewRequest 携带它**：复核者因此可以**审这条判断本身**（"判低了/判高了"是可评的），而不是只审代码。

## 5. 验收项（各配独立选择器文件 + 单点变异）

| AC | 属性 | 选择器 |
|---|---|---|
| **AC-1** | skill 层真的提出清单：`phase-guidance` 渲染出的 `/kata-open`、`/kata-design` 文本包含这 7 问与"给理由"的要求 | `tests/unit/the-classification-questions-are-asked.test.ts` |
| **AC-2** | agent 的分类**被记录**（tier / by / reasons / riskClasses / facts），并且**低于路径下界时被抬升且具名** | `tests/unit/a-classification-below-its-floor-is-raised.test.ts` |
| **AC-3** | 分类**进 ReviewRequest**（复核者能审这条判断） | `tests/unit/the-review-request-carries-the-classification.test.ts` |
| **AC-4** | **不得新增模型调用/适配器**：分类只由"事实 + 一条记录 + 抬升规则"构成；渲染文本里没有平台名 | `tests/unit/the-classification-needs-no-model.test.ts` |

**单点变异**：① 去掉抬升 ⇒ AC-2 红；② 记录不留 reasons ⇒ AC-2 红；③ 不把分类放进请求 ⇒ AC-3 红；④ 在渲染文本里写死"默认 strict"（回到查表） ⇒ AC-1 红。

## 6. 范围、代价与顺序（明确说）

- **落地面**：`src/adapters/phase-guidance.ts`（skill 文本的唯一渲染源，改后 `npm run build` + `kata-cli update` 重新生成 skill）、`src/workflow/orchestrator.ts` 或 `src/store/*`（记录与携带）、选择器；**刻意不动 `src/kernel/risk.ts`**——它 floor 是 `high` ⇒ 会把整个 change 抬到 `security` 档（2 个复核者 + always quorum），代价与收益不成比例；需要动它时另立 change。
- **代价**：实现 3–4 h（一处渲染源 + 一处记录 + 一处携带 + 4 个选择器 + 4 个变异）+ 封存/Verify/账本 ≈12 min + **一轮独立复核 ≈20 min / ≈250k tokens**。
- **顺序约束**：本 change 与在飞的 `a-replaced-round-is-archived` **共用 `src/workflow/orchestrator.ts`** ⇒ 不能并行；必须在 a4 归档后开。

## 7. 边界（写下来，不假装做到）

- **判断被记录 ≠ 判断被验证**：kata 无法验证 agent 是否真的读懂了 diff。这条不对称是**刻意的**：判高了花的是钱（实测 20 min/轮），判低了由路径下界挡住。机制只能守一侧，另一侧靠 skill 的问题清单。
- **第 7 问（既有类 vs 新类）依赖类台账**：台账在 `the-review-loop-carries-its-defect-classes` 里已经落地（9 类 + oracle 字段），但"复用已建仪器"要等 **I-10**（封存时重验锚点）才闭环。
- **skill 文本会被复制**：它是渲染源，但宿主里可能已有旧副本 ⇒ 落地必须包含"重新生成 skill + 校验磁盘等于渲染输出"（本仓已有守卫的形态）。
