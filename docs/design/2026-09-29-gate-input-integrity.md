# 设计：gate 的输入完整性（gate input integrity）

**状态**：设计稿 + 变更契约（本 change 的 bootstrap 来源）
**上游**：`docs/design/2026-09-28-bounded-review-convergence.md` §16、§17、§20、§21，以及三份 follow-up 设计稿
**性质**：把同一族的残余缺口**合并为一个 change** 修完，而不是分三条
**profile**：`isolated_worktree / tdd / strict`

---

## 1. 为什么合并成一个 change

三份设计稿收的是**同一族的三个面**，全都关于 **gate 读到的输入**：

| 面 | 缺口的形状 |
|---|---|
| 读状态（read state） | 同一 artefact 在一次决策内被读多次；"读不出来"没有跟着数据传下去 |
| 声明面（scope surface） | `seal` 的信封面是 `ownedPaths`，`verify` 的事实地平线是工作区，**差额无人拥有** |
| 风险覆盖（risk coverage） | 要求与变更内容无关；拒绝不给可执行的下一步 |

它们在**同一个失败模式**上汇合：**gate 依据的输入与实际状态不一致，而没有任何检查要求二者一致。** 分成三条 change 会让每条都只修自己那一面，而它们的验收标准互相重叠（"拒绝必须可执行"在三条里都出现）。所以合成一条，用一份契约覆盖三个面。

## 2. 实施顺序（**前置约束，不可颠倒**）

改 `src/kernel/**` 会**触及 kernel**，因而触发 `strict.requiredRiskClasses` 的判定——也就是本 change 要修的那条。所以顺序是：

1. **先落地"触及判定"**（AC-6 的机制：`classifyRisk` 推出的 `touchedRiskClasses`）与**拒绝可执行化**（AC-8）；
2. **再改 `requiredRiskClasses` 的解释**（AC-6 的语义：`required ∩ touched ⊆ claimed`）；
3. 之后才动 `policy.ts` 的表本身（那时它已被新判定覆盖）。

**若在第 1 步之前就被 `uncovered_risk_class` 挡住**：按 `bounded-review-convergence` §21 的同样原则处理——**如实报告并请 change 所有者裁定，不硬绕**（不手写 `.kata` 产物，不硬造 claim）。

## 3. 验收标准

### 读状态

- **AC-1**：`openLedgerProblems` 与 `ledgerVerdict` 在**每一种** ledger 状态（无文件 / 有记录无 claims / malformed / policy 被拒 / 有 claims 无 subject / 有 claims 有 subject）上给出**相同的可读性判定**，且两者各自**只读一次** ledger。
  - 实现：抽出纯函数 `ledgerVerdictOf(ledger)`；`ledgerVerdict` 与 `openLedgerProblems` 都先读一次、再委派它。
  - 证据：状态遍历用例 + 插桩证明读次数为 1。
- **AC-2**：`readUpstreamSummary` 把它读到的 `sealedRead` 传给 `readBlockingProblems`／`readReviewRecord`；在"只让第二次读失败"的 double 下，router 报 `repair_unreadable_current_revision`（而不是 `unreadable_review_record`）。
- **AC-3**：`verify`／`judge` 的命令边界**从调用方已取的读取派生 identity**；把实现换回独立 re-read，用例必须变红。
  - 证据：`readFile` double 让第二次读失败 + `runCommand('verify'|'judge')` + 断言**写出的** `verify.json`／`judge.json` 的 `revisionId`。

### 声明面

- **AC-4**：`build --seal` 在封存**开始前**做集合差 `changed \ declared`（排除项与 `isIgnoredRepositoryPath` 同源）；非空即拒绝并**列出差集**。
  - 已知易错点（必须实现）：`git status --porcelain` 前两位是状态码（`XY<space>PATH`）；重命名 `R  old -> new` 需单独解析；未跟踪目录要展开；排除项写错会把漏报换成误报。
- **AC-5**：**每条 `reason → command` 路由在一个构造状态下可执行**：派发到该命令后返回结构化结果，而不是抛错。
  - 当前反例：`repair_unreadable_current_revision` → `/kata-build`，而 `build` 在同一状态下抛错。
  - 更根本的修法（本 change 采取）：CLI 命令**不以异常作为拒绝方式**。

### 风险覆盖

- **AC-6**：`requiredRiskClasses` 解释为"**若被本次变更触及**则必须有 claim"；`decide` 的覆盖检查为 `required ∩ touched ⊆ claimed`。
  - `touched` 由 `classifyRisk` 已算出的 `matched` 模式集 + 一张"模式 → 风险类"映射机械推出。
  - 证据：只触及 `src/quality/**` 的变更**无** `failure_mode` claim 时通过；同变更加一条触及 `failure_mode` 模式的路径后**被拒绝并指名**该类。
- **AC-7**：**"模式 → 风险类"映射表的任何增删改都产生一条 `privilege` claim**，与既有 `policyFloorChangeClaims`（floor 表守卫）同形；变异：改表 → 用例红。

### 可执行性（横跨三面）

- **AC-8**：**任何拒绝必须给出可执行的下一步**——要么 `deficits` 非空，要么拒绝文本指名"哪个路径/模式推出了这个结论，因此需要什么"。
  - `deficits: []` 而 `reasons` 非空是**不允许的状态**。
  - 现状反例三处：`uncovered_risk_class` 的 `deficits: []`；`gate not bound` 不给重建路径；`evidence_below_strength` 在 stale verdict 存在时以**强度**措辞报告（真实原因是判定过期）。

## 4. 明示不覆盖（留给将来）

1. **证据强度语义**（`MIN_STRENGTH_BY_SEVERITY`、`autoEvidence`）：本轮无争议，不动。
2. **delta 复用判定**（`reusedEvidence`）：与读状态相邻，但它是"哪些证据可跨 subject 复用"的独立语义。
3. **平台无关的 reviewer skill 路线**（父设计里那条）：与本 change 的输入完整性无关。
4. **`.llmwiki` 的知识收口**：按本 change 的 profile 仍需一次 closure 决定，但不在验收面内。

## 5. 已知风险

1. **自指**：见 §2。这是本 change 唯一可能卡住自己的地方，已定好顺序与处置。
2. **规模**：`ownedPaths` 预计 20+ 条，跨 `kernel`／`store`／`workflow`／`quality`／`cli`。前一条 change 的经验是 12 轮对抗审查，每轮都带出新缺口；本 change 的 8 条 AC 里有 3 条是**命令级会红用例**（AC-2、AC-3、AC-5），这是比上一条更好的起点。
3. **AC-4 的排除项**：写错会让**正常封存**失败（把漏报换成误报）。实现时必须先有用例覆盖 `.kata/**`、`tmp/**`、已忽略路径三类。
4. **AC-6 的映射表完备性**：它不完备时只是"漏判"而非误判，但输出必须**如实说明"本判定基于模式表"**（不能假装完备）。

## 6. 交付判据

- 15 条 AC 各有会红的用例（§3 的 8 条 + 上一轮结束时登记的 7 条残余）；AC-1／AC-2／AC-3／AC-6／AC-7／AC-11 另有**变异验证**（把机制短路后必须变红，实测记录见各测试文件的 docblock）。
- 本 change 结束后：`ledger decide` 对**本 change 自己**给出 pass（这是 §2 顺序落地后的自证）。
- 三份 follow-up 设计稿在归档时标注为**已被本 change 覆盖**（或保留各自未覆盖的条目）。

**实施结果**：15 条 AC 全部落地，187 文件 / 1180 用例通过，`tsc --noEmit` 干净；封存为 `revision-4d9e2c9a9657d9da`（17 项证据）。§2 的自指顺序成立——AC-6 的机制先落地、再改 `src/kernel/**`，全程未被自己要修的那条判定挡住。

**实施中的两个自身缺陷**（记录以免重复）：

1. **AC-13 的守卫自己有行号 bug**：`codeOnly` 删块注释时一并删掉了其中的换行，于是 `slice(index-14, index+4)` 取到的是**十八行之外**的区域——一个就在写入行上的截断 payload 因此没被识别。改为"置空注释内容但保留换行"。
2. **AC-4 的检查当场抓住了作者**：26 个改动文件未声明，正是该 AC 描述的缺陷类；详见 §7.1 的用法修正。

## 7. 工具语义只在源码里（实施记录）

本轮实现中撞上三处**只存在于源码、任何输出都没有说明**的工具语义。它们不是缺陷报告，而是"下一个操作者会重复踩"的事实，因此记在这里而不是留在会话里。

### 7.1 `scope apply` 只应用**最后一条**记录

`kata-cli scope change --add <one>` 每次写一条记录，而 `kata-cli scope apply`（不带 `--id`）**只应用最后一条**该记录的 `scope`。而每条记录的 `scope` 是**记录时刻**的 `task.ownedPaths ∪ additions`——所以逐条 add、逐条 apply 时，每条记录的 scope 都是"旧的 34 + 这 1 条 = 35"，最后 apply 只让声明面从 34 涨到 35。

**实测**：连续 26 次 `scope change --add <单个路径>` 全部成功（exit 0），`scope-changes.json` 里 26 条记录各自的 `scope` 都是 35，最终 `ownedPaths` 仍是 35。

**正确用法**：**一条记录里重复 `--add`**（`valuesAfter(rest, '--add')` 收集所有出现），再一次 `scope apply`。实测一条记录带 25 个 `--add` 后，`ownedPaths` 从 35 涨到 60。

### 7.2 `--add` 不按逗号拆分，且会产生**无法被应用**的记录

`--add "a.ts,b.ts"` 被当作**一个**路径字符串记录（`added: ['a.ts,b.ts']`，`scope` 为空数组）。这条记录**不会**造成损害：`normalizeScopePaths([])` 以 `A scope change must leave at least one owned path: the task schema requires one, and a task with none cannot be read by any command, including the one that would add it back.` **构造性拒绝**——空 scope 记录在结构上无法被应用。

但记录本身留在 `scope-changes.json` 里（write-once），所以它是一段**只有读了源码才知道是惰性的**历史：`applied: false` 不会出现，因为没有人会去 apply 它。

### 7.3 声明面变化会**令 handoff 收据失效**，而封存**自己**也会改任务

`build --seal` 在有 handoff 收据的前提下被拒绝：`Cannot use invalid handoff packet: branch_mismatch`。原因是**上一次失败的 seal 本身改动了任务**（写入了 `change-record-*.json` 与 revision），而收据描述的是任务**当时**的样子，于是它被自己的封存动作作废。

**实测序列**：`scope apply`（改任务）→ `handoff create`+`acknowledge` → `build --seal`（失败，改任务）→ 再 seal 时收据已失效 → 重新 `handoff create`+`acknowledge` → seal 成功。

也就是说：**"改任务 → 重新签收据 → 封存"是一个必须紧邻的三步**，中间不能插入任何会写 `.kata/` 的命令，包括一次失败的 seal。

### 7.4 由本节引出的结论

这三处都不影响 gate 的正确性（没有任何一条让"应通过"变成"不通过"，也没有让"不通过"变成"通过"），但它们符合本 change 一直在修的那个形状：**一个事实只有一个可见入口**。§7.1 与 §7.3 都是"工具知道、操作者只能靠经验知道"的语义；§7.2 是"存在一条惰性记录，没有任何输出指出它"。

因此它们**不进入本 change 的验收面**（AC 文本在 `open` 时冻结，且这属于 CLI 表面而非 gate 输入完整性），而是作为**下一轮候选**记录在此。
