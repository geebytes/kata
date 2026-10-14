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
| **I-21（本仓新，今日实测，**挡住了一次真实收口**）** | **`--depends-on` 只在 `claim add` 时能设，之后没有任何 verb 能补 ⇒ 该 claim 的 reading set 永远为空 ⇒ `review --approve` 不可达，而拒绝给的补救不可执行** | 实测（a4 收口时）：四条 claim 建时未带 `--depends-on` ⇒ `plan.readingSets` 每条 `paths: []` ⇒ `ledger request-check` 报 `gaps: [{claimId:'C1'…'C4', what:'the stored plan names no reading set for this claim, so the request could not scope it'}]`，`review --approve` 因此失败；而 `claim restate` **只接受 `--statement`/`--boundary`**（无 `--depends-on`），`claim waive` 也不移除（builder 是 `ledger.claims.map(...)`，不过滤 status）。**可走的路**（我实测走通）：`ledger claim add --id <已存在 id> … --depends-on path:…,path:… --evidence <原有全部 id>`——`appendClaim` 对同 id 是**替换**（`claims[existing] = stamped`），于是 reading set 建起来、证据绑定保留 | 修法方向：`claim restate` 接受 `--depends-on`（并把该变更报告为移动问题），或让拒绝点名**这条**可执行的路；文档同时写明"建 claim 时必须带依赖路径" |
| **I-17（本仓新，今日实测并修掉一例）** | **拒绝文案可能点名一条不可执行的路，或断言一句机制已经不再成立的话** | 记录四轮历史结果时，结果路径的拒绝说"restate a claim … **Re-entering review does not clear a recorded round**"——两半都被 a4 的变更推翻（入口现在**会**归档并开新一轮）。已在该 change 内修（改文案 + 新选择器 `a-refusal-names-the-road-that-works` + 正对照"照文案走真的通"），并作为第 5 轮的攻点：**那条链上每一条拒绝**都要问"它点名的路在这个状态下能不能走通、它说的每个关于机制的事实是否仍成立" | 这是一类而不是一例：F7（`review --approve` 要求 gate）、`kata-cli open`（先建目录再校验）、`revision_superseded`（不说比了什么）同属；机械收口方向 = 把"拒绝必须带可执行补救"做成规则/守卫，而不是逐个改文案 |
| **I-18（本仓新，今日实测）** | **`review_gate` 令牌是单次的：记 N 轮 = N 次（verify → gate approve → review）** | 实测：跨门一次后 `gate approve` 回"has already been consumed"，并给出**可执行**补救（跑一次 `verify` 会重建该边界的 gate，再批一次）。verify 很快（**0.98 s**）⇒ 代价不在时间而在**每一步都要一次用户授权**（本轮记第 2–4 轮即为此少记了 2 轮） | ① 文档写明"一次跨门 = 一轮 = 一次授权"；② 或让"记录一轮结果"不必先跨门（结果路径自己归档并开新一轮），从而一次授权可覆盖多轮 |
| **I-19（本仓新，今日实测，**读法陷阱**）** | **`build --seal` 的信封可能报出"封存前"的 revision** | 实测：修复后第一次 `build --seal` 返回 `success: true` 且 `revisionId` 仍是**旧** revision，而盘上的 `current-revision.json` mtime 未变；重跑一次才真正铸新 revision。**权威读法**是 revision 记录本身（`current-revision.json` 的 mtime 与 `pathDigests` 逐条核对），不是信封字段 | 文档警告；或在信封里明确"本次是否铸了新 revision"（`minted: true/false`），避免操作者按旧 revision 继续（我今天就差点按旧 revision 往下走） |
| **I-16（本仓新，今日实测；**已更正**）** | **未提交的内容落在声明面之外就卡住封存，且无 flag** | 实测两次：a4 重封分别被 (a) 另一个 change 的**未提交**设计文档、(b) 我自己**未提交**的队列文档修改拦住，报 `undeclaredChanges`（"the working tree holds …"，补救只有"声明它"或"撤回它"）。**初次归因（已更正）**：我写成"任务 createdAt 之后的**提交**都被算作本 change 的内容"——**这一条没有实测支持**：同一时间窗内确有**新增并提交**的文件在 a4 声明面之外（lane change 的两个新选择器，commit `7b5063b`），而 a4 随后封存**成功**，说明 committed 那一半并没有把"后来者的提交"一概算进来。**实测成立的部分**：工作树里**未提交**且不在声明面内的内容会拦封存 | 顺序纪律（先封存再开下一个 change）+ 文档写明；若要改机制，方向仍是"候选集能说出这是谁的改动" |

| **I-14（本仓新，今日核实）** | **沙箱里 `.gitignore` 的测试素材缺失** | zenmpai 报告 §6：`make test` 在沙箱里 `collected 918 items` 后失败，因为沙箱按 git 内容派生，`tests/assets/`（真实照片）与 `tmp/` 不存在 | 与已记录的"判据沙箱里没有 gitignore 的素材"同形 | 本仓的做法是判据「素材缺失即 skip」；但 `quality.buildChecks` 要求 exit 0 时 skip 不算通过 ⇒ 要么文档写明"依赖 gitignore 素材的判据不要放进 buildChecks"，要么沙箱一并复制这类素材 |
| **I-15（本仓新，今日实测第三次）** | **`open --bootstrap-file` 丢掉 `ownedPaths`** | 今天第三次：新 change 的 5 条声明路径在 `open` 后是 0 条（`wantsAcc 3 accepted` 但 `ownedPaths: null`），靠 `scope change` + `scope apply` 重建 | 与已记录的同项合并 | 要么让 `open` 应用 bootstrap 里的 `ownedPaths`，要么**拒绝**一个它不会完整应用的 bootstrap——后者更小且不会说谎 |
| **I-13（本仓新，今日实测）** | **被同一 (revision, request) 槽取代的一条 review 记录不归档，那一轮的 finding 就消失了** | 十轮独立审查里，**第 4 轮与第 6 轮的受管记录在 `.kata` 里完全不存在**（`R6-F1` 在 task 目录**零命中**；`R4-F1` 只在第 5 轮 R5-F3 的正文里被提到，`R6-F2/F3/F4` 只在第 7 轮 `rl-r7-F1/F2` 的正文里被提到——**引用不是记录**），而第 9 轮只进 `review-history.jsonl`、第 10 轮只进 `review-rounds.jsonl`。每轮我都走了 `review --result-file`，所以这不是"没记"，是**记录被覆盖而没被归档** | 归档时要**先归档被取代的记录**（现在的替换路径只在某些分支写 history）；并且 `review-rounds.jsonl` / `review-history.jsonl` 应各自**无条件追加**一行 | 与 **I-9**（记录的 revision 由 CLI 盖"记录时刻"的值）同族；也是这个 change 自己存在的理由（A-1 抱怨 102 轮只剩 56 条 finding——我这一例是同一形状） |
| **I-12（本仓新，今日实测，第 10 轮）** | **`ledger plan` 的拒绝里也有一个占位符** | `src/cli/ledger.ts:1228` 印 `.kata/tasks/<id>/revisions/`，而 change id 就在手上 | 与 R9-F4 同一规则的最后一个残留实例（先于本 change，故不在本 change 修） | 第 10 轮 F5 指出；属「补救必须可原样执行」这一族 |
| **I-11（本仓新，今日实测）** | **`scope` 忽略 `--root`，且不按名拒绝** | `runScopeCommand` 的签名叫 `root`，但只有 CLI 入口解析 `--root`；直接调用/子进程传 `--root` 时它被**静默忽略**，命令于是作用在 cwd 的仓库上（实测：cwd=/tmp、`--root /tmp/scoperoot` ⇒ 它去读 `/tmp/.kata/tasks/x/task.json`）。与 **I-6**（`run --paths` 被接受但被忽略）同一类 | 与 AC-8 同批：要么读它、要么按名拒绝；并让 `scope` 与其它动词共用同一个 root 解析 | 今天在我给「每条补救都必须真能跑」的守卫里踩到它：守卫对 `scope` 那半实际跑在**仓库根**而不是 fixture，所以它验证了「动词/flag 能解析」，但**没有**验证「作用在正确的 workspace」（我在变更记录里如实标注了这个边界） |
| **I-10（已出设计：`docs/design/2026-10-10-a-repair-revalidates-the-evidence-it-moved.md`）** | **修复会移动 falsifier 的落点，而没有人重新对准** | `ledger evidence verify` 只在被重跑时才发现锚点失效；修复/重封的流程本身不会重跑它，于是盘上的封印 verdict 仍写 `supported` | 让封存（或进入 repair 时）**自动重验受影响的 evidence**，锚点不成立即按名拒绝；或把「锚点仍在唯一匹配」做成封存的前置检查（现在只有人手工核对） | 第 3 轮 blocking 就是它（9 条失配），第 4 轮的修复又产生 3 条（E9/E11/E15）——同一形状两轮各一次 |
| **I-8（本轮新发现）** | 同一件事（两条命令是否同一条检查）在仓库里有**两套去重判据** | `src/quality/check-resolver.ts:260-267`（`kind+command+args+cwd`）vs `src/quality/project-checks.ts:161-169`（`name+command+args`，无 kind/cwd、分隔符不同） | 一处判据、两处消费者——与 A-5 同批做，否则改了矩阵那套、另一套仍会漂 | 本轮核实下游指针文档时实测 |

### 1.3 未证实（先做复现实验，再决定改不改）

| id | 现状 | 需要什么 |
|---|---|---|
| **U-1（=B-1）** | 已在 unified change 的 AC-5 实现（单一派生），**未封存** | 一个「预期非零退出的验收命令被 verify 判通过」的回归用例，落在封存后的 revision 上 |
| **U-2（=B-2）** | 已在 unified change 的 AC-14 实现（准入收窄到「指针消失 + 历史 seal 被 supersede」），**未封存** | 复现原始四方向互斥（`build --seal` / `verify` / `ledger run` / `review` 各自拒绝并互相指路），确认不可复现 |
| **I-37**（2026-10-12 实测，与 I-36 同一次归档尝试） | **被消费的门禁只能由"创建它的命令"重建，而那个命令在当前相位被拒**：`judge_gate` 由 `review --approve` 创建，`review --approve` 要求相位是 `review`，而 `judge` 成功后任务已在 `judge` 相位 ⇒ `judge` 报"需要显式用户选择"、`gate approve --boundary judge_gate` 报"已被消费"、`review --approve` 报"requires review phase; current phase is judge" ⇒ 三条路互锁，而 `archive` 又因 I-36 的坏记录被拒 ⇒ **任务在 `judge` 上完全锁死**。根因：`GATE_CREATED_BY`（`src/workflow/user-choice-gate.ts:32`）把"谁创建门禁"与"创建者能在哪些相位运行"分开陈述，而补救文案只印前半句 | 让补救**可执行**：要么允许在后续相位重建（把 `review --approve` 的相位前置条件收窄到"记录未批准"而不是"相位必须是 review"），要么给一条受管的 `gate reset/recreate`；并加一条检查：`GATE_CREATED_BY` 的每个创建者在它被引用的相位里都必须真的能跑 |
| **I-36**（2026-10-12 实测，就在本 change 归档时） | **`gate approve` 接受一个它自己 schema 拒绝的 `--choice`，并把任务永久卡在门禁上**：`kata-cli gate approve --boundary archive_gate --choice archive` 返回 `approved: true` 并写出 `user-choice-archive_gate.json`，而 `schemas/user-choice-gate.schema.json` 只接受 `continue_current\|switched\|delegated` ⇒ **此后每一次** `gate approve` 都在 `readGate` 处因 schema 不符被拒（"does not match its schema"），`archive` 则报"requires an explicit user choice"，而 CLI **没有任何命令可以删除或修复这条记录** ⇒ 该任务在该门禁上死锁。写入侧没有校验（`approveUserChoiceGate` 直接写），读取侧校验，于是"错误的输入被记录，然后连修复的路都没有" | ① 写入侧按 schema 校验 `--choice`（按名拒绝并列出词表）；② 提供一条受管的修复路（例如 `gate reset --task <id> --boundary <b>`，或在写入前校验后允许重写） |
| **I-40**（2026-10-13 实测，清点在飞 change 时） | **声明面越宽，认证越短命**：`security-tier-platform-boundary` 声明了 **73 条路径**（`.agents/skills/**`、`schemas/**`、`src/cli/**`、`src/kernel/**`…，几乎整个工具），于是**它自己没动，37 条路径也被别人的提交挪走了** ⇒ 封存失效、`verify` 全 FAIL（AC-1…AC-6）、approve/judge 作废、必须重封 + 再买一轮。同类：`the-identity-…` 14 条中 2 条漂移、`review-reentry-…` 10 条中 3 条、`enrich-packet-…` 9 条中 5 条。**这四个"只差一步"的 change 实际各需 25–60 min 复核**，不是因为它们有缺陷，而是因为**声明面被别人的提交移动**（I-16 的结构性税） | 让"我改了什么"与"我声明了什么"分开：`codeManifestHash`/C2 那条路已经存在，需要的是**按路径记录"本 change 是否作者"**并在认证里只用作者面；或在 `open`/`scope` 时**按内容推导**声明面（只声明本 change 真正改过的路径），使"声明面被他人移动"不再可能 |
| **I-41**（2026-10-13 实测，`a-recurrence-report-does-not-override-the-ladder` 第 2–5 轮） | **claim 写成「在某个状态下 router 会答什么」时，每一轮都能在它之上再找到一个分支**：这个 change 的 C2/C3/C8 主体是 router 的**输出**，而 router 的 `suggestCandidateAction` 有约三十个分支 ⇒ 第 3 轮找到 ledger 分支（我把它写反了）、第 4 轮找到不变量表里的 `repair_failed_verify`（我完全没提）、第 5 轮还在跑。**分裂才是根因：证据一直钉在分支守卫上（每条 falsifier 都是守卫的单点变异，从未被证伪），而散文漂到了 router 的输出上**。五个轮次里有四轮是为四次修复付的账（I-35：已记录的 finding 只能由更新的轮次记录取代，没有 `findings dispose`），而类复发信号（I-38）给出的处置恰好是「再买一轮」⇒ 循环无法自停。 | 把 claim 形态写成机制层规范：**claim 的主体只能是分支、派生或分支内的发布值，不得陈述 router 在某个状态下的输出**（状态级断言只能作为验收标准的用例存在，不进 claim）；并在 `kata-cli` 侧给一条检查：claim 文本不得以「With a current revision / 在…状态下」这类状态前缀开头而不指明被守卫的分支。这条规范比再补一个用例重要，因为**状态级 claim 的对象（整条 ladder 的先后）无法被枚举干净** |
| **I-39**（2026-10-12 实测，`unique-copies-is-one-model` 第 4 轮） | **类级修复只落在"要紧的那一个调用点"**：第 3 轮把记录规则收成 `recordsHeldBySync` 并给它**全仓 id 词表**，但只有 `uniqueCopies` 传词表，其余投影（`recordFilesOfSync` → `hasTaskDir` → `recordOwner`、以及导出的 `tasksWithRecords`）都按默认空词表问它 ⇒ 同一个仓库上两个答案；同轮"失败继续传播"的收集也只写在 `findOwningCheckout` 一步里，`recordOwner` 另两步裸调谓词，第一个不可读候选就中断推导。另外**保守归属的兜底接受任何名字**（`.DS_Store`、`notes.txt`、`writeFileAtomic` 的 `.tmp` 残片都被当成任务 id），以及归档"无法确定"分支仍报一个**按任务名猜的 `kept` 路径**（该路径实测不存在；第 3 轮的提交信息声称"F4 docstring 已改"，只改了文档没改它——**又一次提交信息比改动宽**） | 让"一处派生"成为**签名上的事实**：词表/传播这类上下文不许有默认值（缺省即编译错误），或把词表放进派生的**返回值**里由调用者带回；兜底只接受产品自己的文件命名形状（其余按"无法归属"具名上报）；归档的 `kept` 改成模型给的位置或直接不报路径 |
| **I-38**（2026-10-12 实测，`unique-copies-is-one-model` 第 3 轮后） | **"不收敛的升级"落到的是造成不收敛的那个动作**：`reviewLoop` 的 `stalled_current_rounds` 分支（`src/quality/loop-replay.ts` 派生、`src/workflow/navigation.ts:681-687`）返回 `{ nextSkill: '/kata-review', role: 'reviewer', reason: 'escalate_review_without_progress' }` ⇒ 检测到"轮次没有进展"之后，系统建议的下一步是**再买一轮复核**——正是让计数停不下来的那个动作。实测：本会话两个 change 共 11 轮复核、≈4.5M tokens，`stopLineCandidate` 每轮都为真而路由始终指向 `/kata-review` | 让终局升级**指向能改变结果的动作**：要么指向"先给这个类写仪器"（生成器/关系，然后才允许下一轮），要么指向"停线，交回用户"，而不是指向同一轮复核。这需要一次门禁语义决定（当前是"只上报、不改路由"） |
| **I-31**（2026-10-12 实测，第 7 轮） | **走查只在"文件事实也动了"时才报两半不一致** ⇒ `hashed-not-declared` 方向在"未声明的那个文件仍与记录相符"时被读成 `intact`，而闭包门禁接受这样的记录（实测：`a-stale-wiki-record-can-be-re-derived` 第 7 轮 F1；同类在该 change 里已出现两轮） | 让"两半是否一致"独立于文件事实：走查先问 `sourceHalvesAgreement`，不一致即按自己的因报告（无论文件是否变化）；闭包门禁对"两半不一致"的记录另给一个读数，而不是当成已捕获的知识。约 2 AC |
| **I-32**（2026-10-12 实测，第 7 轮） | **拒绝句里的路没有带前提，且其中一条在可达状态下以未处理的 FS 错误退 1**：`decisionRoads` 点 `wiki rebuild` 而不说"需要已初始化的 wiki"（无页面时 append `.llmwiki/log.md` 失败） | 让 `decisionRoads` 的每一条路**带上它的前提**（与 store 拒绝文里已有的写法统一），或在无页面的状态下不列该路 |
| **I-33**（2026-10-12 实测，第 7 轮） | **两条生命周期仪器没绑到任何 claim** ⇒ C-3 的"因→动作"那一半**没有任何被点名的仪器支撑**（26 条 falsifier 中 24 条被 claim 点名） | 让"每条声明都能被 challenge"成为写入侧的约束（`ledger` 接受 claim 时校验它点名的 evidence 存在且**每条 evidence 至少被一个 claim 点名**）；修完后把这两条挂到 C-3 |
| **I-34**（2026-10-12 实测，第 7 轮） | **冻结的设计文档与封存面不一致**：第 5 节标题写"13 条路径"而声明是 14（漏了第 6 轮新增的 `tests/unit/wiki-lifecycle.test.ts`）；边界①仍写"走查的因有三种"而代码是四种 | 表格与边界行改由**记录与代码**派生（或至少加一条"文档面与声明面一致"的检查），避免每次扩面后文档落后一轮 |
| **I-35**（2026-10-12 实测，本 change 全程） | **没有任何受支持命令能处置一条已记录的 finding**：`schemas/review-finding.schema.json` 文档了 `findings defer\|accept\|rout`，而调度器没有该命令（`kata-cli findings` → `Unknown command`），且 `src/` 里**无人写 `disposition: 'fixed'`**，而 `isOpenFinding` 只认 `fixed`。后果：一条已修好的 major 仍读作"未处置"，approve 只能靠**再买一轮绑到更新 revision 的复核**——本 change 为此花掉 3 轮 | 补齐写入侧（一个真的 `findings dispose` 命令，或让修复提交自动带上 disposition 并校验它指向的 diff），并把"approve 需要一轮更新 revision 的复核"写成文档化的机制语义而不是副作用。**这是门禁机制缺陷，不是某个 change 的缺陷** |
| **I-29**（2026-10-12 实测） | **"store 读不到"这一事实只传给了一个消费者**：`readWikiRecordsWithIssues` 现在把不可读的目录经 `invalid` 上报，闭包据此答 `unevaluatable_records` ✓，但 `wiki candidate`、`wiki verify`、`wiki audit`/`lifecycle` 之外的路径（以及 bulk 走查）仍把同一状态读成**空 store**（实测：`.kata/wiki` 被换成文件 ⇒ `wiki candidate` 返回 `candidates: []`，`wiki verify` 返回 `checked:0`） | 让"读不到"沿同一个读数传播：任何以 `records` 作答的消费者要么拒绝、要么在答复里带上"store 不可读"这一位；实现上只需给 `readWikiRecordsWithIssues` 的 `invalid` 加一处谓词并在 CLI 汇总处消费。约 2–3 AC |
| **I-30**（2026-10-12 实测） | **记录文件名的派生仍有两处**：`wikiRecordFileName`（名字）与 `updateWikiRecord` 的 `normalizeId` + `layoutWikiRecordPath`（路径），以及闭包自己反解 id 的一处；文档曾把这些称作"同一处派生"，实测不是（第 5 轮 F4） | 让路径由名字派生一次（`join(wikiDir, wikiRecordFileName(id))`），闭包的反解也走同一函数；单点变异即可证明 |
| **I-28**（2026-10-12 实测） | **自定义 wiki 根有两个含义**：`wiki init --from <path> [--wiki <path>]` 读页面时用 `wikiRoot = resolve(root, wikiPath)`，而 `register`/`ingest` 写进记录的 `sourceRefs` 用的是 `.llmwiki/`（常量）⇒ 非默认 `--wiki` 下，"这一页在哪里"与"记录说它在哪里"指向不同目录，漂移走查/`isWikiPageRef`/闭包各自按不同答案工作。实测来源：`a-stale-wiki-record-can-be-re-derived` 第 4 轮 F3（`src/wiki/llmwiki.ts:346-347,367-370` 对 `src/wiki/record.ts:99`） | 先回答一个语义问题再改：自定义 wiki 根是**同一个 checkout 内的另一个目录**（那 ref 必须跟随它，`isWikiPageRef` 要问"实际用过的根"），还是**只作为导入来源**（那 `--wiki` 不该改变写入位置，就应在 CLI 层拒绝）。本 change 只把 `.llmwiki/` 字面量收成常量，没有替用户决定这件事 |
| **I-27**（2026-10-12 实测；**初版诊断已更正**；**已由 change `a-stale-wiki-record-can-be-re-derived` 实现**：4 AC / 5 falsifier / seal `revision-7d81b23ba8a30b05`，待审查） | **两个面向读者的表面各自说谎，把一条存在的路说成不存在**：① `kata-cli wiki --help` 的 `commands:` 清单（`src/cli/wiki.ts:41`）**漏掉 `revalidate`**，而调度器（`src/cli/wiki.ts:97-112`）**接受它**——我按帮助文本枚举命令，于是得出「没有任何受支持的命令把 `stale` 变回可用」这个**错误结论**（实测：`kata-cli wiki revalidate --record llmwiki-concepts-a-test-that-never-reaches-the-code` 立刻返回 `{status: candidate, refreshed: [.llmwiki/…md]}`，页面 hash 从 `ca56868f…` 刷新为 `2b9d295a…`）；② 闭包门禁给的补救（`src/wiki/closure.ts:64`）说「用 `kata-cli wiki list` 列出候选」——**该命令不存在**（只有 `wiki candidate`），且**不点名真正的路**（`wiki revalidate --record <id>`） | 两条一起修：让**帮助清单与调度器由同一处派生**（不是手工同步两张表），并让每条补救点名的命令**真的能被 CLI 接受**（照抄本仓既有的「补救必须可执行」守卫）。**附带的三个 fail-open 行为**（同一函数，单独记）：`revalidateWikiRecord` 只重算 `sourceHashes`**不重算 `statement`**；它**无条件**把记录置为 `candidate`（于是 `verified` 记录被**静默降级**）；来源文件**已消失**时它保留旧 hash 仍返回 `candidate`（于是闭包会接受一条来源已不存在的记录）。**实测后果**：`unique-copies-is-one-model` 的 Verify 从 `candidate_missing` 变成「repair evidence or blocking findings」（wiki 轴已解除，剩下的是它的 revision 被后续提交 superseded ⇒ 需重封） |
| **I-25**（新，2026-10-12 第 8 轮实测） | **「这份声明覆盖什么」的四个读者里，报告面那个不解析符号链接**：`declaredContentPaths`、`undeclaredChanges.isCovered`、tier resolver 都会**解析**已声明的链接（`link -> src/quality` 记成 `src/quality/a.ts`），而 `ownedCovers`（`src/quality/change-record.ts:214`）对原始声明做**纯词法**判断 ⇒ `buildChangeRecord` 把**声明确实覆盖**的路径写进 `changedOutsideOwnership`。修 `declaredContentPaths` 解析链接的那次修复（`9eccca0`）没有同时改这个读者。**影响面**：该字段**无行为消费者**（见 I-16），所以这是**报告的准确性**问题，不是门禁；但它正是本 change 要消灭的那一类 | 两条一起做才有意义：① 让 `ownedCovers` 与 walk 用同一个解析；② 删掉/改掉 `src/quality/undeclared-changes.ts:123` 那句「与 `ownedCovers`、`digestKeysFor` 一致」的注释——它**在链接轴上不成立**，且它点名的 `digestKeysFor` **已无调用者**（其唯一调用方 `surfaceDigest` 无调用方）。两者都是 `the-identity-…` 那类「同一声明面多处派生」的清扫项 |
| **I-26**（新，2026-10-12 实测） | **注释点名一个已无调用者的读者**：`digestKeysFor`（`src/quality/code-surface.ts:109`）唯一调用方是私有的 `surfaceDigest`，而它**没有调用方** ⇒ 该读者不可达，注释里把它当作活读者列出属于陈述失真 | 与 I-25 ② 同批：要么恢复调用方，要么删掉这个读者与提及（本仓库既有「删掉死代码」的先例） |
| **I-22**（新，2026-10-12 实测两次） | **一轮独立复核的 finding 可以不留痕迹地消失**：轮次返回后必须**跨门**才能填该轮的槽位；若作者先去返修，跨门时归档的是**空占位符**，这一轮的 finding **从未被写过**。而 `review.json` 里 `findings: []` 读起来正好像「这一轮干净通过」——CLI 全程无信号。本 change 第 5、6 两轮各中一次（作者流程错误），补记时记录的 `reviewedRevisionId` 已不是该轮实际读的 revision | 机制上二选一：① 跨门前要求该轮结果已落盘；② 把派发事实（`round-runs.json` 里的 runId/结论）也写进 history，使「空槽」与「干净轮」不再同形。任选其一都可，**但必须能区分这两者** |
| **I-10 的新面**（2026-10-12） | 本 change 七轮里**每轮（第 3～7 轮）都留下至少一条 falsifier 锚点失配**，靠手工重瞄（≥12 次）；另外两类仪器缺陷也在同一族：**变异文本不可解析仍记为红**（R4-F2：E13 的 `find` 只覆盖多行调用的首行 ⇒ 文件语法错误 ⇒ 测试加载失败变红，却被记 `supported`）、**selector 指向不存在的文件**（我自己复审时踩到：vitest 以「找不到文件」退 1，看着像红，与命名的性质无关） | 封存时的机械检查应一起覆盖三件事：锚点**恰好匹配一次**、变异文本**可解析**、selector**存在且真的运行**。设计文档已在 `docs/design/2026-10-10-a-repair-revalidates-the-evidence-it-moved.md` |
| **I-42**（新，2026-10-13 实测） | **带 claim clause 的验收项仍无法更正**：`kata-cli tasks amend-acceptance`（`src/quality/acceptance-amendment.ts`，本次新增的受控更正入口）**按名拒绝**声明了 `claims` 的验收项——`ClaimDeclaration` 刻意把「一句话」和「必须让这句话成立的检查」绑在一起，只改句子会留下断言旧措辞的检查。该拒绝是对的，但**由此这半条路仍然不存在**：本次实测的 `the-workflow-layer-checks-what-it-claims` 的 AC-3 恰好没有 clause（所以能更正），而任何带 clause 的验收项一旦失真，仍然只能手改 `task.json` | 让 amendment 一次带走**整项**（句子 + 各 clause 的 statement），并对 clause 的 `check` 保持不变做断言；或反过来：把 clause 的 statement 从「自由文本」改成「由 criterion 句子派生」，使二者不可能漂移。前者是较小的改动（约 2 AC），后者更接近本仓库「一处派生」的取向但要先决定 clause 的语义 |

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

## 已修缺陷的实测效果（真实工作流，非用例）

| 日期 | 缺陷 | 实测 |
|---|---|---|
| 2026-10-13 | recurrence 路由指向不可达的 `/kata-build`（`a-recurrence-report-does-not-override-the-ladder` 修复后 judge PASS） | **修复前**：`a-repair-revalidates-the-evidence-it-moved` 的路由答 `/kata-build` `reason: review_class_recurring`，而 `kata-cli build` 以「Build cannot run from review without a problem the strict ladder blocks on」拒绝 ⇒ 该任务既不能修也不能审。**修复后**（同一任务、同一命令）：`nextAction.nextSkill: /kata-review`、`reason: complete_review_conclusion`，`kata-cli review` 正常进入并要求门禁选择（不再指向 Build）。这条是「先在真实流程里复现原故障、再接受修复」的实测记录：原故障已不再出现。 |
