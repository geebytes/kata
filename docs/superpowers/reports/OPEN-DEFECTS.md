# Kata 待修复清单（由下游 `zenmpai` 汇总）

**日期**：2026-10-10
**核实基准**：Kata 0.2.0，容器内 `/app/kata`（= 宿主 `/data/work/ahaeureka/k2skills/kata` 的实时 bind），HEAD `480d543`。
**来源**：`docs/superpowers/reports/` 下九份反馈文档；每条的状态都以**当前源码**逐条核对过，不采信报告里写的状态行。
**用途**：这是**工作队列**，不是新报告。每条都给出判据位置与最小修复点，细节与逐字复现见对应报告。

## A. 未修复（7 条）

### A-1 复核轮次与 findings 都按「当前 revision」作用域 ⇒ 门禁每轮自动恢复干净、停滞探测恒空转

* **影响**：**最高**。这是「同一个缺陷类反复出现 N 轮也无法收尾」的机制：`build --seal` 每轮产出新 revision ⇒ 旧 findings 离开阻塞集合（`blockingFindings` 归零 ⇒ 复核通过路由不再触发），而 `reviewLoop` 恒报 `no_current_rounds` ⇒ 停滞探测器一次都不会升级。
* **判据位置**：`src/workflow/review-read.ts:61/108/151`（`boundToCurrentRevision`）、`src/quality/repair.ts:487`（`filter(roundBoundTo(...))`）。
* **最小修复点**：另加一路**跨 revision 的复发读数**（同一 `repairSignature` 在相邻 revision 上重复出现即计数），用它驱动停滞升级；**不要**移除 `boundToCurrentRevision`（「结论不得比内容活得久」这条是对的）。
* **复现**：连做两轮「seal → 独立复核 → 修 → seal」，观察 `reviewFindings` 在封存后归零、`reviewLoop.reason` 恒为 `no_current_rounds`。
* **报告**：`2026-10-08-review-loop-never-converges.md`（F1、F6）。

### A-2 没有「声明闭包」的一等公民位置

* **影响**：高。负向分类器（「这种形状不允许」）诚实判不了的那一半无处安放，于是**每个越界都被读成缺陷**，而正确处置（改判据或更新声明）没有表达方式。项目自己的规范要求「判不了的不假装能判，写进声明边界」，kata 里没有承载它的字段。
* **判据位置**：全仓无 `declaredBoundary` / `declaredClosure` / `insideDeclaredBoundary`（grep 为空）。
* **最小修复点**：claim schema 增一个必填 `boundary`；finding schema 增 `insideDeclaredBoundary`；路由上「在声明闭包内的 major/blocking」记为记录而不触发修复轮，并提示「改判据或更新声明」。
* **报告**：同上（F2，与 F5 是一对）。

### A-3 `severity` 仍是无 anchor 的自由枚举，而严格模式按 `major` 无条件返修

* **影响**：高（与 A-2 同源）。循环的出口条件变成「复核者选择把一切判为 minor」这一不受约束的人为判断，而不是收敛性质。
* **判据位置**：`src/kernel/types.ts:178`（`severity: Severity`）、`src/kernel/types.ts:137`（`isMergeBlockingSeverity`）。
* **最小修复点**：给 `severity` 写下判据定义（blocking=机制不成立 / major=行为或验收被违反 / minor=声明与见证不准确 / note=无验收影响），并把它做成可被复核者引用的文本而不是口头约定。
* **报告**：同上（F5）。

### A-4 `seal` 要求声明的路径，正是账本拒绝冻结的路径（改名的 change 连复核请求都生成不出来）

> **2026-10-10 追加**：同一条判据不止挡住 `freeze` —— `ledger plan` 与 `ledger run` 也从声明取路径，
> 且**没有** `--paths` 逃生口 ⇒ 计划与 ReviewRequest 都生成不出来（实测：本轮人手装配请求才派得出复核）。
> 详见 `2026-10-10-declared-path-that-seal-requires-ledger-refuses.md` 的「追加」一节。

* **影响**：中高。改文件名的 change 无法完成 freeze / run（生成不出 ReviewRequest），能否避开取决于**操作顺序**（先提交改名即可）。
* **判据位置**：`src/core/git.ts:82-91`（rename 时把原路径也 push）、`src/cli/ledger.ts:186-217`（`currentSubject` 从声明取路径、读不到即拒绝）。
* **最小修复点（推荐 A）**：seal 的「未覆盖」读数对 rename/copy 只认新名字（原路径带来源标记，由 `undeclared-changes` 决定排除）。**不建议**放宽账本的拒绝。
* **报告**：`2026-10-10-declared-path-that-seal-requires-ledger-refuses.md`。

### A-5 两条验收项共用命令 ⇒ 后一条被静默丢弃，且诊断指向错误原因

* **影响**：中。三条验收项因此从未执行、没有证据文件，而 verify 报的是「需要 integration/entrypoint 证据」（与成因无关）。
* **判据位置**：`src/quality/check-resolver.ts:256` → `:260-268`（`dedupeChecks` 只按 (kind, command, args, cwd) 去重，不带归属）。
* **最小修复点（推荐 A）**：去重后的执行列表带上 `acceptanceIds: string[]`，让一份结果服务多行；或（B）在声明期拒绝并点名两行。
* **报告**：`2026-10-10-shared-check-command-drops-an-acceptance.md`。

### A-6b `executable_falsifier` 无法表达「创建 / 删除文件」类变异（删除类不变量只得弱见证）

* **影响**：中高。重构（移动模块、拆包、改名）产生的不变量多是「某模块不再住在那里」，而它们的自然变异
  是**创建/删除文件** —— 变异的固定形状是 `{file, find, replace}`，表达不了 ⇒ 由 kata 判 `inconclusive`，
  只能用**声明式**的 `static_witness` 见证（强度低于 kata 亲自执行+还原的 `executable_falsifier`）。
* **判据位置**：`src/kernel/types.ts:224`（`mutation: { file, find, replace }`）。
* **最小修复点（推荐 A）**：变异扩成带 `op` 的联合（`edit` / `create` / `delete`），执行器按 op 施加并无条件还原。
* **报告**：`2026-10-10-executable-falsifier-cannot-express-file-creation.md`。

### A-6 `executable_falsifier` 判 refuted 时不说成因，且文案把探测失败说成「缺陷存在」

* **影响**：中。作者必须自己手工施加变异去猜三种成因（变异没落上 / 落上了但没变红 / 红在别的属性上）；`evidence_refuted` 的文案会让作者去改产品代码，而真实含义是「这条检查没探测到」。
* **判据位置**：`src/kernel/types.ts:426`（文案）、`src/store/ledger.ts:1696`（只有三态，无成因字段）；`review/verdicts.json` 只在 supported 时记 `before/mutated/after`。
* **最小修复点（推荐 A）**：把成因写进 refuted 的 `observed`，与成功路径对称；并让文案按 `evidenceType` 分派。
* **报告**：`2026-10-10-refuted-falsifier-does-not-name-its-failure-mode.md`。

### A-7 `ledger evidence add` 之后 challenge 的解析被投影排除

* **状态**：维护者已改成 **Confirmed** 并**更正了触发机制** —— 不是 `evidenceIds` 写回，而是**冻结之后才声明的 claim**。
* **判据位置**：`src/cli/ledger.ts`（evidence 提交路径）、`src/kernel/subject.ts`（question 身份）。
* **最小修复点**：按更正后的机制处理 —— 冻结之后新增 claim 时，必须让当前 subject 明确失效并给出「按新声明重冻」的单一出口（现在 `challenges.json` 与 `decide` 的读数互相矛盾）。
* **报告**：`2026-10-08-ledger-evidence-add-invalidates-challenge.md`。


## B. 未证实（3 条 —— 需要复现实验才能判定，别当成已修）

| 条目 | 现状与需要的确认 |
|---|---|
| **`failingEvidence` 忽略 `expect.exitCode` / `passed`** | `src/workflow/navigation.ts:285` 的读取类型已含 `expectExitCode` 与 `passed` ⇒ 读数层看似已扩；但下游 verify 未再走到那条判据。**需要**：一个「预期非零退出」的验收命令被 verify 判为通过的回归用例。 |
| **review 相位「内容移动」不可恢复** | `authorizeReviewRepair` 已改为单次快照读取并传入 `readBlockingProblems`。**需要**：复现原始四方向互斥（`build --seal` / `verify` / `ledger run` / `review` 各自拒绝并互相指路），确认已不可复现。 |
| **verify 在证据一致时报 superseded** | 维护者更正根因（revision 身份在执行沙箱算、verify 在作者工作树算；`.llmwiki` 原在「永不是内容」表内）。`.llmwiki` 现已进 `repository-identity.ts:24/37`。**需要**：一个「声明里含 `.llmwiki` 且工作树有未提交改动」的用例，确认不再判 superseded（避免继续依赖「先提交受声明路径」这一人工绕行）。 |

## C. 已修复（5 条 —— 勿重复处理）

| 条目 | 证据 |
|---|---|
| review 收尾阶梯第二步要求已消耗的 gate（F7） | `src/cli/workflow.ts:70-78` 的 `recordsAConclusion(argv)`；下游 `review --approve` 实测一次通过 |
| claim 文本进入冻结身份摘要（F3） | `src/kernel/subject.ts:36-44` 的 `questionOf` 只含 id / statement / dependsOn + planDigest |
| claim-less change 不能声明「空覆盖」 | `src/workflow/orchestrator.ts:1700` 的文案已带条件 `…when the ledger holds claims` |
| 目录展开卷入 `__pycache__`（不含此前写的「两份排除表」残余风险） | `src/core/repository-identity.ts:42` 已列 `__pycache__`；且目录展开走的是**同一模块**的 `declaredContentPaths`（`:391`，由 `src/store/ledger.ts:1173` 调用）并读它返回的 `neverContent`（`ledger.ts:1257`）⇒ **不存在两份排除表**（我先前的「残余风险」经本次核对**不成立**，已从 A 组移除）。修复 change `a-declared-directory-excludes-its-build-output` 已封存 `revision-a3d29df0bf19c121`、Verify PASS，等它自己的独立审查轮 |

## 排序建议（按「一次改动的影响面 / 成本」）

1. **A-1 + A-2 + A-3 一起做**：它们是同一个根因（有边界却无处声明、计数却按 revision 清零）。只修 A-1 会让停滞探测器能看见停滞，而 `blockingFindings` 仍每轮归零；只修 A-2/A-3 则计数的那个洞还在。
2. **A-4、A-5**：各自独立、改动局部，且都能用一条回归锁住。
3. **A-6、A-7**：改善可诊断性与一致性，风险低。
4. **B 组**：需要先写复现实验，再决定是否要改代码。
