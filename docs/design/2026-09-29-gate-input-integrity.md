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

- 8 条 AC 各有会红的用例；AC-1／AC-3／AC-4／AC-6／AC-7 另需**变异验证**（把机制短路后必须变红）。
- 本 change 结束后：`ledger decide` 对**本 change 自己**给出 pass（这是 §2 顺序落地后的自证）。
- 三份 follow-up 设计稿在归档时标注为**已被本 change 覆盖**（或保留各自未覆盖的条目）。
