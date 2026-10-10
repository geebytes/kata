# Kata 缺陷统一队列（合并下游清单 + 本仓 successor 批次）

**日期**：2026-10-10
**用途**：把**下游 `zenmpai` 汇总的队列**（`docs/superpowers/reports/OPEN-DEFECTS.md`，A 未修复 7 / B 未证实 3 / C 已修复 5）与**本仓已记录的 successor 批次**（`tmp/successor-batch-2-design.md` + 今日新记）合并成**一份**逐条可执行的清单。
**权威边界**：kata 侧修复的唯一真相在本仓；下游那份保持为**指针 + 实操要点**，不复制正文（本页亦然：下游视角的两条实操要点仍在 zenmpai 的 `docs/engineering/2026-10-10-kata-defect-queue-pointer.md`）。
**核实方式**：每条的判据位置都在**当前源码**上复核过；「状态」列区分**未修 / 已实现未封存 / 已修复并归档**，不采信任何报告里写的状态行。

---

## 0. 先说三条会改变排期的核对结果

1. **A-7 已经修完并归档**（不再是未修复）。更正后的机制与我实测一致：不是 `evidenceIds` 写回，而是**冻结之后才声明的 claim** ⇒ 读数打**冻结的** subject、投影比**声明的** subject，重跑永远够不到。修复：`evidence verify` / `challenge check` 在「声明 ≠ 冻结」时**具名拒绝**并给出可执行出口（`ledger freeze` → 重跑），`evidence add` 在写入的 claim 移动了问题时当场报告。change `refuse-a-reading-when-the-question-moved` **已归档**（Verify PASS / Review approved / 账本 7/7 supported / Judge PASS）。
2. **A-1 的读出侧已经写好了**，且**不止**是「加一路读数」：`classRecurrence` 按**缺陷类**跨 revision 计数，并把停线信号收窄为「`mechanizable` 且至少一条实例 `origin: repair`」，经新 reason `review_class_recurring` **路由**（优先级 2150+，不改任何门禁要求）。它在本 change `the-review-loop-carries-its-defect-classes` 里，**已封存 `revision-903e6a28ada6abf2`、Verify PASS（AC-1…AC-6）、账本 19/19 supported，正在第 2 轮独立审查**。A-1 剩下的那半（`blockingFindings` 每轮归零）不在这条轨道上——见 §2 的 D-2。
3. **B 组三条都已实现，但都还没封存/审查完**，因此不能标「已修」：
   - B-1（`failingEvidence` 口径）→ `unify-the-remaining-integrity-and-workflow-gaps` 的 **AC-5**（「一次读数是否通过」收敛到单一派生）；
   - B-2（review 相位内容移动不可恢复）→ 同一 change 的 **AC-14**（无 current revision + 历史 seal 时允许重封；准入收窄到「指针消失」那一个真实无出口的状态）；
   - B-3（证据一致却报 superseded）→ change `the-identity-is-computed-where-the-change-is`：身份改为**在变更所在的工作树**计算（沙箱只跑检查），并把 `superseded` 变成**给得出它比较了什么**的判定。
   两条 change 都在等各自的重封/审查轮。

### 0.1 已定的门禁语义决策（2026-10-10，维护者）

**「在声明闭包内的 major/blocking，仍触发返修。」**

- 因此 `boundary` / `insideDeclaredBoundary` 是**记录**，不是**豁免**：声明闭包说明「这条判据覆盖哪一段决策域」，而一条落在这段域里的 major/blocking **照样进返修轮** —— 门禁强度不动。
- 它买到的是**可读性**：记录与路由必须同时给出两个出口（「改判据」或「更新声明」），而不是让作者去猜自己的越界算不算缺陷、也不是让出口条件变成「复核者把一切判为 minor」这一不受约束的人为选择。
- 被这条决策**排除**的做法：把「落在闭包内」当成不返修的通行证（这正是 A-3 描述的病），以及把 `severity` 的自由枚举当作收敛性质的替代品。
- 配套仍要做（A-3）：`severity` 要写下判据文本（blocking = 机制不成立 / major = 行为或验收被违反 / minor = 声明与见证不准确 / note = 无验收影响），而「严格模式下 major 触发返修」这条**行为保持不变** —— 缺的是判据文本，不是这条规则本身。

### 0.2 第二条已定的门禁语义决策（2026-10-10，维护者）

**「未答的上一版 blocking finding，重封后仍算阻塞。」**（即设计文档 §2 的 D2-a 选 ①）

- 「已答」的定义只用一个既有事实：**存在一个绑到更新 revision 的复核轮**（不新增词表）——因此你**不能靠重封逃掉**一条 blocking finding。
- 代价已披露且被接受：`openProblems` 的计数会纳入跨 revision 的未答项 ⇒ **归档门禁更严**。这**只收紧、不放松**任何门禁。
- 另外两项决策（设计文档 §2）按建议推进、**你仍可否决**：D-1（=A-4）取②「undeclared 不为改名推入原名字」，账本的拒绝保持不变；D-3 取①「`changedOutsideOwnership` 排除门禁自身机器目录」。

---

## 1. 统一清单（按「是否需要先做语义决策」分组）

### 1.1 需要先定语义（定了才动手，否则会把已声明的边界当 bug 修）

| id | 一句话 | 判据位置 | 待定的语义 | 报告 |
|---|---|---|---|---|
| **D-1（=A-4）** | seal 要求声明的路径，正是账本拒绝冻结的路径 | `src/core/git.ts:74-94`（rename/copy **同时 push 新旧两个名字**）；`src/cli/ledger.ts` 的 `currentSubject`（声明路径读不到即整体拒绝，`unreadable[]`） | 「**声明了但读不到**」两侧该用哪种语义：现况是 seal 记 sentinel（kind 标记）、账本按名拒绝，而这条**不对称是刻意且已被断言**的（change `a-declared-directory-excludes-its-build-output` 的 C2：sentinel 分不清「故意声明的坏路径」与「声明后被删」）。可选：①两侧统一记 `kind: removed`；②undeclared 前置检查**不为改名推入原名字**。**不放宽账本拒绝**（这与下游报告的推荐 A 一致） | `2026-10-10-declared-path-that-seal-requires-ledger-refuses.md` |
| **D-2（=A-2+A-3+A-1 余下）** | 有边界却无处声明；计数仍按 revision 清零；`severity` 无 anchor | A-2：全仓无 `declaredBoundary`／`declaredClosure`／`insideDeclaredBoundary`；A-3：`src/kernel/types.ts:178`、`:137`；A-1 余下：`src/workflow/review-read.ts:61/108/151`、`src/quality/repair.ts`（`filter(roundBoundTo(...))`） | 「**判不了的不假装能判**」要在哪儿承载：claim schema 的必填 `boundary` + finding 的 `insideDeclaredBoundary`（本仓已有部分落点：unified change 的 `review-claim.boundary`、本 change 的 plan `defectClasses`），且**闭包内的 major/blocking 仍触发返修**（§0.1，2026-10-10 决策：边界是记录而非豁免） | `2026-10-08-review-loop-never-converges.md`（F1/F2/F3/F5/F6） |
| **D-3（=本仓 #2）** | `changedOutsideOwnership` 是门禁自己的记账，且无人消费 | `src/quality/change-record.ts`；`grep -rn changedOutsideOwnership src/` 只命中它自己 + 一条 eval 语料字符串 | 三选一：**排除**门禁自身机器目录（`.kata/evidence|tasks|wiki`）、**给它一个消费者**、或**删掉**这个字段。实测值 322 = 217 `.kata/evidence` + 104 `.kata/tasks` + 1 `.kata/wiki` + **0 生产代码** | 本批次 §2 |
| **D-4（=本仓 #1）** | `scope change --remove` 没有可执行出口 | `src/quality/undeclared-changes.ts`（候选集 = `changedGitPaths ∪ previousPathDigests`）+ `src/workflow/seal-preflight.ts:191-199` | 「移除一门声明」应当是**带理由的受管决定**，而候选集应是**内容增量**（现在凡是上一版哈希过的路径都是候选 ⇒ 重封也救不了）。定的是「声明的语义」，不是补一个判断 | 本批次 §1 |

### 1.2 语义已定、可直接实现（各自独立，一条回归即可锁死）

| id | 一句话 | 判据位置 | 修法 | 报告 |
|---|---|---|---|---|
| **I-1（=A-5）** | 两条验收项共用命令 ⇒ 后一条被静默丢弃，诊断还指向错误原因 | `src/quality/check-resolver.ts:256,260-267`（键 = `kind+command+args.join('\0')+cwd`） | 执行列表带 `acceptanceIds: string[]`，一份结果服务多行；或声明期拒绝并点名两行 | `2026-10-10-shared-check-command-drops-an-acceptance.md` |
| **I-2（=A-6）** | `executable_falsifier` 判 refuted 不说成因；文案把探测失败说成「缺陷存在」 | `src/kernel/types.ts:426`（文案）、`src/store/ledger.ts:1696`（三态无成因字段） | 成因写进 refuted 的 `observed`（与成功路径对称），文案按 `evidenceType` 分派 | `2026-10-10-refuted-falsifier-does-not-name-its-failure-mode.md` |
| **I-3（本仓 #3）** | 路径→摘要映射仍用普通对象（根级 `__proto__` 文件被静默丢弃） | `src/quality/context-fabric.ts:87`、`src/wiki/provenance.ts:211`、`src/wiki/drift.ts:116`；`src/quality/revision-delta.ts:122` 用 `in`（走原型链） | 一处 null-prototype 构造 + 一条「新出现普通映射即红」的类级守卫（不再逐实例补） | 独立审查 R2-F5 |
| **I-4（本仓新）** | `open --bootstrap-file` 写矩阵却不写 `ownedPaths` | `src/core/task.ts` 的 open/bootstrap 路径 | 要么照 `ownedPaths` 执行，要么**拒绝一个它不会应用的 bootstrap**（静默丢弃是三种结局里最坏的）。**今日实测两次**（unified change 与本 change） | 本批次「Confirmed again」 |
| **I-5（本仓新）** | 非法 `--tier` 崩成 TypeError 而非具名拒绝 | `src/cli/ledger.ts`（`--tier` 直入 `policy.tiers` 索引） | 拒绝并点名合法取值；与 `usage set` 的 `fail()` 不终止同族 | 本批次「Found while landing AC-3」 |
| **I-6（本仓新）** | 族级 flag 被动词静默丢弃 | `ledger claim restate --evidence`：`ok: true` 而 `evidenceIds` 不变（`--evidence` 在 `ledgerFamilyFlags` 内，故未知 flag 拒绝不触发） | 词表在**族**、读取在**动词**：动词不读的 flag 应具名拒绝，或动词必须读它 | 本批次「Found while repairing round 1」 |
| **I-7（本仓新）** | 「封存期间仓库移动」复查会被**检查自己写又删的临时文件**绊倒 | 封存收尾复查（对比声明面内外内容） | 复查应比较**前后集合**而非采样窗口（写/删之间的时刻被采到），或让在仓库内写临时文件的检查改写到 `tmp/` | 本批次「Found while re-sealing」 |
| **I-9（本仓新，今日实测）** | 「这一轮审的是哪个 revision」记录的**不是它测量的东西** | `src/workflow/orchestrator.ts:1806`：`reviewedRevisionId` 取自 review 入口写下的 **placeholder** 的 revision；CLI 只有 `--reviewed-path`，**没有** `--reviewed-revision` | 让轮次自己声明它读的 revision（轮次的输入里带着封存 revision），或在记录时校验 placeholder revision 与真正被读的一致 | 第 2 轮实际审 `revision-903e6a28ada6abf2`，记录写的是 `reviewedRevisionId: revision-8295c30cf2691ac6`（我重封之后才记录）；这正是 `unify-…` 的 AC-9 想修的那条，而它的实现目前仍取 placeholder |
| **I-12（本仓新，今日实测，第 10 轮）** | **`ledger plan` 的拒绝里也有一个占位符** | `src/cli/ledger.ts:1228` 印 `.kata/tasks/<id>/revisions/`，而 change id 就在手上 | 与 R9-F4 同一规则的最后一个残留实例（先于本 change，故不在本 change 修） | 第 10 轮 F5 指出；属「补救必须可原样执行」这一族 |
| **I-11（本仓新，今日实测）** | **`scope` 忽略 `--root`，且不按名拒绝** | `runScopeCommand` 的签名叫 `root`，但只有 CLI 入口解析 `--root`；直接调用/子进程传 `--root` 时它被**静默忽略**，命令于是作用在 cwd 的仓库上（实测：cwd=/tmp、`--root /tmp/scoperoot` ⇒ 它去读 `/tmp/.kata/tasks/x/task.json`）。与 **I-6**（`run --paths` 被接受但被忽略）同一类 | 与 AC-8 同批：要么读它、要么按名拒绝；并让 `scope` 与其它动词共用同一个 root 解析 | 今天在我给「每条补救都必须真能跑」的守卫里踩到它：守卫对 `scope` 那半实际跑在**仓库根**而不是 fixture，所以它验证了「动词/flag 能解析」，但**没有**验证「作用在正确的 workspace」（我在变更记录里如实标注了这个边界） |
| **I-10（已出设计：`docs/design/2026-10-10-a-repair-revalidates-the-evidence-it-moved.md`）** | **修复会移动 falsifier 的落点，而没有人重新对准** | `ledger evidence verify` 只在被重跑时才发现锚点失效；修复/重封的流程本身不会重跑它，于是盘上的封印 verdict 仍写 `supported` | 让封存（或进入 repair 时）**自动重验受影响的 evidence**，锚点不成立即按名拒绝；或把「锚点仍在唯一匹配」做成封存的前置检查（现在只有人手工核对） | 第 3 轮 blocking 就是它（9 条失配），第 4 轮的修复又产生 3 条（E9/E11/E15）——同一形状两轮各一次 |
| **I-8（本轮新发现）** | 同一件事（两条命令是否同一条检查）在仓库里有**两套去重判据** | `src/quality/check-resolver.ts:260-267`（`kind+command+args+cwd`）vs `src/quality/project-checks.ts:161-169`（`name+command+args`，无 kind/cwd、分隔符不同） | 一处判据、两处消费者——与 A-5 同批做，否则改了矩阵那套、另一套仍会漂 | 本轮核实下游指针文档时实测 |

### 1.3 未证实（先做复现实验，再决定改不改）

| id | 现状 | 需要什么 |
|---|---|---|
| **U-1（=B-1）** | 已在 unified change 的 AC-5 实现（单一派生），**未封存** | 一个「预期非零退出的验收命令被 verify 判通过」的回归用例，落在封存后的 revision 上 |
| **U-2（=B-2）** | 已在 unified change 的 AC-14 实现（准入收窄到「指针消失 + 历史 seal 被 supersede」），**未封存** | 复现原始四方向互斥（`build --seal` / `verify` / `ledger run` / `review` 各自拒绝并互相指路），确认不可复现 |
| **U-3（=B-3）** | 已由 change `the-identity-is-computed-where-the-change-is` 改掉根因（身份在作者树算），**在审查轮** | 一个「声明含 `.llmwiki` 且工作树有未提交改动」的用例，确认不再判 superseded（否则仍要靠「先提交受声明路径」这条人工绕行） |

---

## 2. 建议顺序与成本

| 顺序 | 内容 | 为什么这个顺序 | 成本（估） |
|---|---|---|---|
| 1 | **先关掉在飞的三条**：本 change（第 2 轮）→ `the-identity-…`（第 9 轮）→ `unify-…`（重封 + 第 2 轮） | U-1/U-2/U-3 与 A-1 读出侧都在它们里面；不关掉就会重复排期，且它们共用 `src/workflow/*`、`src/quality/repair.ts`，无法并行改码 | 各自 1 轮 + 记录 + judge/archive |
| 2 | **D-2（A-1 余下 + A-2 + A-3）** | 同一个根因；只修 A-1 则 `blockingFindings` 仍每轮归零；只修 A-2/A-3 则计数洞仍在。**门禁语义已定**（§0.1：闭包内的 major/blocking 仍触发返修） | 1 change / 3–4 AC / 1 设计 + 1 封存 + 1–2 轮 |
| 3 | **D-4 + I-1 + I-2 + I-6 + I-8** | 全是「拒绝/上报的读法不可执行」同族，且都局部；I-8 与 I-1 必须同批 | 1 change / 4–5 AC / 1 轮 |
| 4 | **D-1（A-4 语义）+ I-4 + I-5 + I-7** | D-1 定完语义后是局部改动；I-4/I-5/I-7 是今天实测到的三处「静默/崩溃/竞态」 | 1 change / 4 AC / 1 轮 |
| 5 | **D-3 + I-3 + U-* 的复现实验** | D-3 是三选一的决定（排除/消费/删除），I-3 是类级清扫；U-* 只需实验与记录 | 1 change / 2–3 AC |

**贯穿全批的两条纪律**（本轮已三次付学费）：① 每个 AC 用**独立选择器文件**（共用文件会被 `dedupeChecks` 折叠，留下没有证据的验收项）；② 每个守卫必须**真的能红**——变异要真的落上、要红在它声称的理由上、其**合法等价物**也要红。

---

## 3. 与下游那页的关系

- 下游页保留：**指针**（指向本仓 `OPEN-DEFECTS.md` 与本页）+ 两条**实操要点**（改名先提交；矩阵每行唯一命令）。
- 本页新增对其队列的三处**状态更正**（§0）：A-7 已修归档；A-1 读出侧已完成（在审）；B 组三条已实现未封存。
- 下游 A-5 的最小修复点（执行列表带 `acceptanceIds`）与本页 I-8 是**同一处的两个面**，合并进同一条 change。


---

## D. `the-review-loop-carries-its-defect-classes` 的收口（2026-10-10/11，10 轮独立审查）

**结论**：第 7 轮起无 blocking/major；第 8–10 轮共 12 条全部落在**一类**——「守卫弱于它声称的性质」——加上第 10 轮**审查者自己声明为边界**的两条。用户选定路线 **甲**：**记录 + 写明边界 → approve → judge → archive**，不再逐例修复；把这类掐断的机械修法（I-10）另行落地。

被认证的 revision：`revision-5aa5d88be5a48355`（27 条声明路径，含本轮新增的 `tests/unit/every-refusal-names-a-command-the-cli-accepts.test.ts`）。

### 写下来的边界（不假装做到）

| # | 边界 | 来源 |
|---|---|---|
| B1 | 补救守卫断言的是**CLI 接受**这条命令，**不**断言它**能清掉**该补救伴随的状态；它的用法拒绝词表就是它列出的那些（第 10 轮指出缺 `unknown action`），因此「动词存在、子动作不存在」这类命令会漏过 | R10-F1、R10-F4（审查者自述为边界） |
| B2 | 守卫只抽取**反引号内**的 `kata-cli …`；写在正文里的、或用 `;` 与第一条拼在同一个反引号内的第二条命令不会被执行 | R10-F3 |
| B3 | 守卫的 fixture 覆盖它列出的拒绝种类；「这条拒绝不给命令」的那一种由**另一个**选择器断言（第 10 轮同时指出该用例注释把「目标在工作区内的链接」写成了「工作区外」） | R10-F2 |
| B4 | 声明面内仍有一个占位符实例：`src/cli/ledger.ts:1228` 的 `.kata/tasks/<id>/revisions/`（先于本 change，故不在此修，已记为 I-12） | R10-F5 |
| B5 | 本 change 的 19 条 falsifier 锚点在 10 轮里**漂移过 10 次**（第 3 轮 9 条、第 4 轮 3 条、第 5/7/8 轮各 1 条），每次都靠人手工重瞄；机械修法见 I-10（设计已就绪，未实现） | R3-F1 起，逐轮累积 |
| B6 | 补救守卫里 `scope` 那一半**跑在仓库根**而不是 fixture（因为 `scope` 忽略 `--root`，见 I-11）⇒ 它证明了动词与 flag 能解析，**没有**证明命令作用在正确的 workspace | 今日自测时发现 |
