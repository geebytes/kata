# 发现的寿命与按比例的复核成本

> 状态：**提案**（2026-09-18，平台级）。
> 适用范围：kata 自身的机制与 CLI 语义，**与任何具体项目无关**。文中的项目细节只作为**证据**
> （一次真实 dogfood 的观测），**不作为设计输入**；设计里不出现「某项目应该改它的配置」这类修补。
> 每个机制主张都给出 `文件:行` 或 commit；每条改动的验证方式见 §9。

## 1. 摘要

门禁的**严重度语义已经是对的**：`blocking`/`major` 挡门，`minor`/`nit` 不挡
（`src/workflow/navigation.ts:154-155` 只统计前两者，`:286`/`:294` 只据它们导航；
`src/quality/adversarial.ts` 的 `blockingAdversarialFindings` 同规则；`src/workflow/distill-gates.ts:67`
只把 `blocking` 视为致命）。**所以「见一条 minor 就修」不是门禁逼出来的。**

缺的是两处**通用**机制：

1. **发现（finding）没有寿命**。`schemas/review.schema.json` 的 findings 项只有
   `[id, taskId, acceptanceId, severity, message, path]`——没有 disposition。
   「已知、决定延后」在平台里**无处可放**：它只能活在作者自己的笔记里，下一轮 pass 会把它当新发现
   重报，收尾时也没人知道它一直没修。
2. **复核成本与改动规模无关**。审查记录与收据都按**整份 owned manifest** 绑定
   （`src/workflow/revision.ts:107` 的 `computeManifestHash` 是**单一滚动摘要**），
   而 `buildAdversarialBrief(root, taskId, node)`（`src/quality/adversarial.ts:255`）**没有 `since`**：
   每次 brief 都要求审查者从头复核全部验收与全部声明，**未变更的内容也被重新验证一遍**。
   ⇒ 一次 2 行修复也要付一整轮独立审查。实测单轮 619s–1331s（§附录 A）。

本提案给出五处改动。**优先级按「能砍掉多少分钟」排序**，并且明确区分
「平台必须提供的通用机制」与「项目自己声明的东西」——后者**不得**成为本提案的交付物（§3）。

## 2. 问题

### 2.1 发现的寿命

| 想表达 | 今天的表达方式 | 后果 |
|---|---|---|
| 这条是 `blocking`，必须修 | `severity: blocking` | ✅ 正确 |
| 这条是 `minor`，**决定延后**，我记着 | **无** | 只写在提交信息/私人文档；下轮重报；收尾时不可见 |
| 这条审查过、判断不成立（误报） | 只能让它消失 | 下次同样的误报再消耗一轮复核 |

`src/quality/adversarial.ts:217` 有 `status: 'waived'`，但那是**整轮豁免**（带 `waivedBy`/`waivedReason`）；
`src/quality/acceptance-matrix.ts` 的 waiver 是**验收→路径**映射的豁免，与发现无关。
**没有第三个落点。** 这不是某个项目的问题：任何跑多轮审查的任务都会遇到它。

### 2.2 复核成本与改动规模无关

- 收据绑 `scope.hash`（owned manifest，`src/workflow/context-fabric.ts:154`）；对抗记录额外允许按
  `manifestHash` 匹配（`evaluateAdversarialGate`）；review 记录同样带 `revisionId` + `manifestHash`。
  这是**正确的原则**（审过什么就判什么），但它在**整仓粒度**上执行。
- `computeManifestHash(root, ownedPaths)` 只有一个滚动摘要 ⇒ 平台**无法回答**
  「相对上一次 pass，哪些文件变了」。这是增量的唯一硬阻塞。

### 2.3 「修一条 → 长两条」的正反馈

一次 dogfood 的 11 轮独立审查里，**≥5 轮**（第 5/6/7/8/10 轮）的发现**指向上一轮修复引入或未覆盖**的
问题。这不是审查者苛刻：**修改变更了被验证的产物**，而复核是整仓的——于是修复本身成了新的风险面，
且流程没有给这份风险定价。**通用结论**：当「改一处 = 重验全部」时，修复的边际成本高于发现的边际收益，
审查轮数不会自然收敛。

## 3. 目标、非目标，以及「谁该做什么」

### 目标
- **G1** 任何一条发现都能表达「已知、延后、由谁决定」，并在 **review / verify / archive 三处可见**。
- **G2** 一次小修复的复核成本与其**变更面**成比例，且**不削弱**任何已验证结论。
- **G3** 「修一条可能长出两条」在流程里**被度量**，而不是靠人自觉。
- **G4** 全部改动**项目无关**：任何项目在**不改自己的配置、不写项目专用分支**的前提下受益。

### 非目标
- 不放松门禁：`blocking`/`major` 永远硬停（§5 I1）。
- 不引入自动修复/自动合并。
- 不改变 `manifestHash` 的推导（那会让所有历史绑定失效，§7）。
- **不为某个项目定制**：任何形如「项目 X 应该把它的某个检查标成 Y」的方案**都不是本提案的交付物**。

### 平台 vs 项目：边界表（本提案的核心约束）

| 事项 | 归属 | 理由 |
|---|---|---|
| 发现的寿命（字段、命令、三处可见性） | **平台** | 与项目语言/语言栈/测试框架无关；任何任务都需要 |
| 「哪些文件变了」的逐路径摘要 | **平台** | 平台已经在算 owned manifest，只是粒度太粗 |
| delta brief 的生成与判定 | **平台** | 复核范围是流程概念，不是项目知识 |
| 「这次 seal 该跑哪些检查」的**默认策略** | **平台**（按验收矩阵 + 变更面推导，§5 F4） | 平台手上有验收矩阵与变更面，可以通用地推导 |
| 具体某条检查命令、超时、覆盖关系 | **项目**（已在 `buildChecks`/`coveredBy` 声明） | 只有项目知道命令与成本 |
| 「某个项目多贵」这类事实 | **证据**，不是设计输入 | 只写进附录 A（观测），不进入任何需求或默认行为 |

> **要避免的形态（case-by-case）**：让每个项目自己去把它的昂贵检查手工分档、手工写"内循环该跑哪些"。
> 那会把通用问题变成 N 份项目配置，且每个新项目都会踩一遍。平台应能**默认推导**（F4），
> 项目只在**例外**时才需要声明。

## 4. 先承认既有原语（不要重复造）

| 既有能力 | 位置 | 本提案如何使用 |
|---|---|---|
| check 的运行档位与覆盖声明 | `src/quality/evidence.ts` 的 `tier: 'seal' \| 'frozen'`、`coveredBy`、`includeFrozen` | F4 的**执行底座**（不新造调度机制） |
| 冻结点强制 | `missingFrozenTierEvidence`；`docs/changelog/2026-09-18-frozen-tier-at-the-freeze-point.md` | F4 用它保证「昂贵检查在冻结点必须跑过」 |
| 验收 → 实现/测试路径的矩阵 | `src/quality/acceptance-matrix.ts`（含 `waivedCandidates`） | **F4 的推导输入**：给定变更面 ⇒ 相关验收 ⇒ 相关检查 |
| 内容绑定的复核记录 | `evaluateAdversarialGate`（`manifestHash`）、收据 `scope.hash` | F1/F2 的**不变量基础**（I3/I4），只扩展粒度 |

⇒ 结论：**F4 不需要新的调度机制**，需要的是一个**通用推导规则**（§5 F4）。

## 5. 设计

### 不变量（不可让）

- **I1** `blocking`/`major` 永远挡门；**不可 defer、不可 accept**。
- **I2** defer 必须**显式**（带 `reason`/`by`/`at`），且 review / verify / archive 三处都打印。
  「静默消失」比「不 defer」更糟。
- **I3** 复核结论必须绑定**被复核的内容**；增量只能建立在「未变更部分此前已被独立验证」这一事实上。
- **I4** 任何绑定/摘要的**推导方式**不得改变，否则历史绑定集体失效。
- **I5** 平台不得因为「作者说这条不重要」而降低证据强度：defer 只影响**顺序**，不影响**是否必须被看见**。
- **I6** 通用性：每条改动都必须在**零项目配置**下对任意项目生效；例外只能由项目**额外**声明，
  且缺省行为必须是安全的（宁可多跑，不可漏跑）。

### F1 发现获得寿命（核心）

**F1.1 schema**（`schemas/review.schema.json` 与对抗记录的同形字段）
findings 项增加**可选**字段：

```
disposition?: 'open' | 'fixed' | 'deferred' | 'accepted'   // 缺省 = 'open'
dispositionReason?: string      // defer / accept 必填
dispositionBy?: string
dispositionAt?: string          // ISO 8601
```

**F1.2 命令**

```
kata-cli findings defer  --change <task> --id <finding-id> --reason "<why not now>"
kata-cli findings accept --change <task> --id <finding-id> --reason "<why this is not a defect>"
kata-cli findings list   --change <task> [--disposition open|deferred|accepted]
```

**F1.3 规则**
- `blocking`/`major`：`defer` 与 `accept` 都**拒绝**（非 0 退出，消息指向必须修）。
- `minor`/`nit`：两者都允许；`deferred` 需要 `reason`。
- 同一 id 二次处置**幂等**。

**F1.4 接线（三处都必须打印，否则违反 I2）**
- **brief**：文本新增 *Known and deferred* 段（id + severity + reason），并写明
  「不要当新发现重报；若你认为该处置是错的，报出来并说明理由」。
- **verify**：诊断输出 `deferredFindings`；门禁**不因此失败**（严重度语义不变）。
- **archive**：打印全部未修发现（`open` + `deferred`）；存在 `open` 的 `blocking`/`major` ⇒ 拒（现状）；
  存在 `deferred` ⇒ 要求**显式结转**（`kata-cli findings carry --change <task> --to <task-or-ticket>`），
  让「带着已知问题收尾」是一个**有签名**的动作。

**F1.5 为什么不把 `minor` 也设成挡门**
那会放大 §2.3 的正反馈（每条 minor 值一次 seal + 一轮全量复核）。严重度语义保持现状是本提案的前提。

### F2 按变更面复核（收益最大）

**F2.1 逐路径摘要（并存，不改既有推导）**

```
kata-cli revision digests            // 列出当前 revision 的逐 path 摘要
```

实现：`computePathDigests(root, ownedPaths): Record<path, sha256>`，按路径排序序列化；
`manifestHash` 的推导**一行不改**（`revision.ts:107`），逐路径表作为**新增字段** `pathDigests`
写入 revision 记录与 `current-revision.json`。
历史 revision 没有该字段 ⇒ 对它们**如实报 `delta_unavailable`**，绝不猜一个 diff。

**F2.2 delta brief**

```
kata-cli adversarial brief --change <task> --node verify [--since <pass-id|manifestHash>]
```

产出**增量 brief** = 全量 brief 的公共部分 + 三样专有内容：

1. `changedPaths`：`pathDigests` 差异（新增/修改/删除，逐条列出）；
2. 上一次 pass 的 `attempts`（假设/方法/结论）——供**复检**而非重跑；
3. 上一次 pass 的 `findings` 及其 `disposition`。

写入文本的指令口径：**只对变更处构造反例；对触及变更文件的旧假设，复检其结论是否仍成立；
未变更且已被证伪的假设不必重跑——但如果你有理由怀疑它，报出来。**

**F2.3 记录与判定**
pass 记录新增 `scope: { kind: 'full' } | { kind: 'delta', from: <hash>, changedPaths: [...] }`
与 `baseManifestHash`。门禁接受 delta pass 的**唯一**条件：
**`changedPaths` 覆盖了自 `baseManifestHash` 以来的全部差异**；否则报 `delta_stale`，
要求扩大范围或重跑全量。记录**照旧**带 `manifestHash`：它仍是「这条 pass 关于哪份内容」的答案。

**F2.4 为什么这不会削弱审查**
未变更的内容**此前已被独立验证**，且判定是**机械的**（差异必须被完全覆盖，缺一即拒）。
这是「复用已有证据」，不是「跳过验证」——与收据按内容绑定（`bcfe671`）是同一原则的粒度细化。

### F3 给「修复」定价（小改动，防 §2.3）

- brief 返回体加 `reverificationCost: { supersedesReceipt: boolean, passScope: 'delta' | 'full' }`，
  文本里点明「修这条会触发 <delta/full> 复核」。
- pass 记录加**可选**字段 `findingOrigins?: { causedByPreviousRepair: number }`，由审查者如实填写。
- 目的：让「修复的边际成本」与「发现的严重度」在**同一条账**上被讨论。今天这个数字是隐形的。

### F4 按变更面推导「该跑哪些检查」（**通用推导，不是项目分档**）

**问题**：今天一个 seal 跑哪些检查，取决于项目**如何声明**（`buildChecks` 的 `tier`）。
于是「内循环太贵」这件事只能靠**每个项目手工分档**解决——这正是要避免的 case-by-case。

**通用规则（平台默认行为）**：

1. 平台已有变更面（F2.1 的 `pathDigests` 差异）与验收矩阵（`acceptance-matrix.ts`：验收 → 实现/测试路径）。
2. 由变更面反查**受影响的验收**，再取这些验收所引用的**检查**（矩阵里的 `testSelector`/证据命令），
   得到 `relevantChecks`。
3. seal 语义分两档，**由平台按阶段决定**，项目无需声明：
   - **内循环 seal**（实现期反复封存）：跑 `relevantChecks ∪ 廉价检查`；**其余检查不执行但被列出**
     （复用 `coveredBy` 的呈现语义：**"声明了但本次未跑"必须可见**）。
   - **冻结点 / review / judge 前**：必须跑**全部**检查；由既有的冻结点强制机制拒绝缺失
     （`missingFrozenTierEvidence` 的同形扩展）。
4. **缺省安全（I6）**：变更面无法映射到任何验收、或矩阵对该路径无覆盖时，**回退到全量**——宁可多跑。
5. 项目**仍然可以**显式声明（`tier`、`coveredBy`、超时），但那是**例外覆盖**，不是使用本机制的前提。

**与既有原语的关系**：不新增调度器；把「哪些检查与本次变更相关」这件事从**项目知识**变成
**平台推导**，并复用既有的两档呈现与冻结点强制。

**残留风险（如实写）**：矩阵若覆盖不全，可能漏掉「没有映射到任何验收的检查」——
因此规则 4 的**回退到全量**是硬要求，不是优化；并且内循环 seal 的报告必须**显式列出未跑的检查**，
让「便宜」永远不等于「隐形」。

### F5 复核绑定按范围（**低置信度，先讨论**）

review 记录今天绑 `revisionId` + `manifestHash`（整仓）。可选：记录 `reviewedPaths`，
修复若未触及这些路径则 review 不失效；或提供 `kata-cli review --delta`（只审「修复 diff 对 findings 的回应」），
而 **judge 仍绑最终产物**。

**不建议在 F1–F3 之前做**：它最容易削弱「审过什么就判什么」。必须回答的问题：
若修复改了 review **未读过**的文件，而缺陷恰在那里，谁负责发现？——这也是把它排在最后的原因。

## 6. 兼容与迁移

- **schema**：新字段**全部可选**。老记录照常可读——同形做法已在真实项目验证过：
  给一个聚合对象增加可选 `aliases` 字段后，读入**没有该字段**的旧记录得到空集合而不是报错。
- **门禁**：F1 只影响**呈现与收尾要求**，不等价于放宽任何既有拒绝；F2 的 delta 仅在
  `pathDigests` 存在时可用；F4 的推导**缺省回退全量**，所以老项目行为不变。
- **摘要稳定性（I4）**：`manifestHash` 推导不动 ⇒ 现存 revision / 收据 / 记录**全部继续有效**。
- **老任务**：`findings list` 把没有 disposition 的发现视为 `open`。

## 7. 失败模式（设计如何安全失败）

| 失败 | 结果 |
|---|---|
| 试图 defer/accept 一条 `blocking`/`major` | 命令拒绝，非 0 退出（I1） |
| delta brief 的 `changedPaths` 覆盖不全 | 门禁报 `delta_stale`，要求扩大范围或重跑（F2.3） |
| 历史 revision 无 `pathDigests` | `delta_unavailable`，退回全量 pass（不猜） |
| 变更面无法映射到验收 / 矩阵无覆盖 | **回退全量**（F4 规则 4），绝不静默少跑 |
| 内循环 seal 少跑了检查而无人知道 | 报告**显式列出未跑的检查**（复用 `coveredBy` 的呈现语义） |
| deferred 的发现被遗忘 | brief 每轮列出、verify 诊断列出、archive 要求显式结转（I2） |
| 用 `accept` 掩盖真缺陷 | `blocking`/`major` 拒绝 accept；`minor`/`nit` 的 accept 需 reason 且**永久留在记录里** |
| `pathDigests` 的实现改变了 `manifestHash` | 测试锁定「同内容、加字段前后 `manifestHash` 逐字节相同」（§9） |

## 8. 非功能要求

- **项目无关**：任一改动在**零项目配置**下生效（I6）。
- **可离线复算**：所有绑定/摘要都能从仓库内容重算（无隐藏状态）。
- **记录可读**：新增字段都是自解释的，旧 reader 忽略之不会误判（可选字段）。
- **不引入新的必跑成本**：F1/F3 纯记录；F2 只在下一次 pass 时体现；F4 减少而不是增加默认开销。
- **可回退**：每步独立可发布（§9），任一步回退不影响其余。

## 9. 测试策略（每条守卫都必须**能红**）

- **F1**：`blocking` defer → 拒绝；`minor` defer → 记入且 verify 诊断可见；archive 在存在 `open`
  阻塞项时拒绝、在只有 `deferred` 时要求结转；brief 文本含 known/deferred 段；**老记录**（无字段）读入视为 `open`。
- **F2**：`pathDigests` 内容稳定；**`manifestHash` 与加字段前逐字节相同**（回归锁）；delta 覆盖不全
  ⇒ 门禁拒绝；`--since` 指向不存在/更早的 pass ⇒ 如实报错；无 `pathDigests` 的 revision ⇒ `delta_unavailable`。
- **F3**：`reverificationCost` 在「会/不会改 owned 内容」两种情形取值正确。
- **F4**：变更面映射到部分验收时，只有相关检查执行、其余**被列出而未跑**；映射不到任何验收时
  **回退全量**；冻结点缺全量证据时 verify 拒绝（已有 `missingFrozenTierEvidence` 的形状，补一条
  「推导集合 ≠ 全量 ⇒ 冻结点仍要求全量」的断言）。
- **F5**（若做）：修复未触及 `reviewedPaths` ⇒ review 仍有效；触及 ⇒ 失效。

## 10. 已考虑并否决的替代方案

| 替代 | 为什么否决 |
|---|---|
| 把 `minor`/`nit` 也设成挡门 | 放大 §2.3 的正反馈：每条 minor 值一次 seal + 一轮全量复核 |
| **让每个项目手工给自己的检查分档**（case-by-case） | 把通用问题变成 N 份项目配置；新项目必踩；且「该跑哪些」本可由矩阵 + 变更面推导（F4） |
| 为某个项目定制分支/开关 | 明确排除：本提案的每条改动必须项目无关（I6/G4） |
| 让「修复」不触发重封存 | 破坏 I3（judge 必须绑最终产物），证据与产物脱钩 |
| 按 revision 号做增量 | revision 每次 seal 都换号，即使内容未变（`d24b620` 已修）；**号不是内容** |
| 用 git diff 做 delta 范围 | git 历史 ≠ 「任务拥有的内容」；ownedPaths + 内容摘要才是判定依据 |
| 自动修复 `minor` 发现 | 修改变更被验证产物（§2.3），自动化只会加速正反馈 |
| 取消独立对抗审查 | 一次 dogfood 就抓出 2 条 blocking 与多条 major；问题是**成本与范围**，不是存在与否 |

## 11. 未验证 / 已知边界

- **F2 的实际节省未实测**：预期把 2 行修复的 pass 从 10–22 分钟压到 2–3 分钟，
  但**没有跑过**（需先有 F2.1）。这是本提案最大的未验证假设。
- **F4 的推导准确率未实测**：矩阵对「路径 → 验收」的覆盖率决定了它会不会过于频繁地回退全量；
  未在一个真实项目上测量回退率。（这也意味着：**回退到全量必须是常态而非异常**，否则机制无收益。）
- **F4 与 `tier`/`coveredBy` 的交互未验证**：项目显式声明与平台推导同时存在时，
  哪个优先、如何呈现，需要一次实现后再定。
- `pathDigests` 对**目录型** owned path 的展开成本未测：逐文件记账会放大记录体积（估计 10³ 量级条目）。
- **F5 未验证**：`reviewedPaths` 依赖评审者如实登记读过的路径，**平台无法核实**——这也是它排最后的原因。

## 附录 A：一次 dogfood 的观测（证据，不是设计输入）

| 项 | 数值 | 来源 |
|---|---|---|
| 独立对抗 pass | 11 轮，单轮 **619s / 773s / 1035s / 1240s / 1331s** | 派发记录 |
| 其中「由上一轮修复引入」 | **≥5 轮**（第 5/6/7/8/10 轮） | 各轮 findings |
| revision（≈seal 次数） | **16 个** | 该任务的 `revisions/` 目录计数 |
| 心跳上线后的 `seal_complete` | **11 次** | `seal-progress.jsonl` |
| handoff 包 / 收据 | **40 / 18**（实现者角色重建 13 次） | `docs/2026-09-17-kata-workflow-optimization-notes.md` §1 |
| evidence | **7.5 MB / 1013 文件** | `du -sh` + `find | wc -l` |
| 分支提交 | **81 个** | `git log` |

## 附录 B：证据索引（机制）

| 事实 | 出处 |
|---|---|
| 门禁只按 blocking/major 导航 | `src/workflow/navigation.ts:154-155, 286, 294`；`src/workflow/distill-gates.ts:67`；`src/quality/adversarial.ts`（`blockingAdversarialFindings`） |
| findings 无 disposition | `schemas/review.schema.json`（findings 项属性与 severity 枚举） |
| 只有整轮豁免 | `src/quality/adversarial.ts:217, 241` |
| brief 无 `since` | `src/quality/adversarial.ts:255` |
| 单一滚动 manifest 摘要 | `src/workflow/revision.ts:107-127`（调用点 `:41, :101`）；`src/workflow/context-fabric.ts:154` |
| check 的档位/覆盖声明与冻结点强制 | `src/quality/evidence.ts`（`tier`、`coveredBy`、`includeFrozen`）；`docs/changelog/2026-09-18-frozen-tier-at-the-freeze-point.md` |
| 验收矩阵（F4 的推导输入） | `src/quality/acceptance-matrix.ts`（含 `waivedCandidates`） |
| 内容绑定已落地的两个先例 | `bcfe671`（收据绑 owned 内容）、`d24b620`（pass 按 `manifestHash` 匹配） |
| 本日已修的 kata 缺陷清单（含上面的先例） | `docs/2026-09-17-kata-workflow-optimization-notes.md` §6 与 §6.1（独立复核） |
