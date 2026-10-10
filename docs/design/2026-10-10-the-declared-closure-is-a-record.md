# 声明闭包是一份记录，其余队列项一次做完

**日期**：2026-10-10
**来源**：`docs/engineering/2026-10-10-unified-kata-defect-queue.md`（合并了下游 `zenmpai` 的 `OPEN-DEFECTS.md` A/B/C 与本仓 successor 批次）。本文是该队列的**设计文档**：以 D-2 为主干，把队列里剩下的**全部**条目收进**一个 change**，一次实现。
**已定的语义**（维护者，2026-10-10）：**落在声明闭包内的 major/blocking，仍触发返修** —— 边界是**记录**而非**豁免**，门禁强度不动。见队列 §0.1。
**前置**：本设计落地要等在飞的三条收口（`the-review-loop-carries-its-defect-classes` 第 2 轮、`the-identity-is-computed-where-the-change-is` 第 9 轮、`unify-the-remaining-integrity-and-workflow-gaps` 重封 + 第 2 轮）——它们与本文的多数文件重叠（`src/workflow/*`、`src/quality/repair.ts`、`src/quality/review-ladder.ts`），无法并行改码。

---

## 1. 为什么是一个 change

队列里的条目看起来零散，但去掉外壳后只有**两个根因**，各自的实例都要一起修才有意义：

- **根因 I：一个有边界的事实，没有一等公民的位置。** 于是「判不了的不假装能判」无处承载（A-2），`severity` 的出口条件变成复核者的自由选择（A-3），而**跨 revision 的未答问题**在重封时被静默清掉（A-1 余下）。分别只修一处都会留下另一半：只修计数，出口条件仍在复核者手里；只修 `severity` 文本，计数的洞还在（队列 §2 已指出）。
- **根因 II：门禁拒绝或上报的读法，读者无法据以行动。** D-4（移除声明后重封又要求声明回来）、I-1+A-5（共用命令的第二条被静默丢弃而诊断指向别处）、I-2（refuted 不说成因）、I-4（bootstrap 声明了却不应用）、I-5（非法 `--tier` 崩成 TypeError）、I-6（族级 flag 被动词静默丢弃）、I-7（收尾复查被自己写又删的临时文件绊倒）。它们的修法互不相同，但**验收标准是同一条**：拒绝或上报必须点名**它要求什么**，并给出**真能执行的下一步**。

一个 change 一次做完的代价是**一轮审查要覆盖 14 条**（本轮已实测：一轮覆盖一个类的代价是 17–28 分钟、200k–680k tokens）；收益是不必为同一批文件反复封存/重验（今天已为"两个 change 共用 `src/workflow/*`"付过两次重封代价）。

---

## 2. 需要维护者先定的三件事（都是语义决策，不是实现细节）

| 决策 | 选项 | 我的建议与理由 |
|---|---|---|
| **D2-a：未答的上一版 blocking finding，重封后还算不算阻塞？** | ①**携带**：重封不清除它，「已答」定义为**一个绑到更新 revision 的复核轮**（单一派生，不新增词表）——即你不能靠重封逃掉一条 blocking finding；②维持现状：只按当前 revision 的 findings 计（今天就如此，`src/workflow/review-read.ts:226`） | **建议 ①**。它与刚定的"闭包内仍返修"同一取向：门禁不因内容移动而变松。代价：`openProblems` 的计数会包含跨 revision 的未答项，归档门禁因此更严——这是**门禁强度变更**，需要你点头 |
| **D-1（=A-4）：声明了但读不到，两侧用哪种语义？** | ①两侧统一：都记 `kind: removed`；②undeclared 前置检查**不为改名推入原名字**（下游报告的推荐 A）；③放宽账本的拒绝（**不推荐**，它会把"声明后被删"与"故意声明的坏路径"混为一谈） | **建议 ②**，因为改名是「同一份内容换了名字」，不是「声明消失」；账本的拒绝保持不变（那条不对称是 change `a-declared-directory-excludes-its-build-output` 的 C2 **刻意断言**的，不能当作 bug 抹掉） |
| **D-3：`changedOutsideOwnership` 怎么办？** | ①排除门禁自身机器目录（`.kata/evidence|tasks|wiki`）；②给它一个消费者；③删掉这个字段 | **建议 ①**：字段的语义（"声明面之外、但确实变了的内容"）是有价值的，只是现在 100% 被门禁自己的记账占满（实测 322 = 217+104+1，生产代码 0）⇒ 排除后它才对读者有意义；②需要先想出消费者，③会丢掉一个可能有用的事实 |

---

## 3. 验收项（14 条，各自独立选择器文件）

> 纪律（本仓已三次付学费）：**每条 AC 一个独立选择器文件**（共用文件会被 `dedupeChecks` 折叠，留下没有证据的验收项）；**每个守卫必须真的能红**——变异要真的落上、要红在它声称的理由上、且其**合法等价物**也要红。

### A. 边界作为记录（D-2 主干）

| AC | 缺陷（实测位置） | 属性 | falsifier（单点变异） |
|---|---|---|---|
| **AC-1** | 无位置承载"这条判据关闭哪一段决策域"：全仓无 `declaredBoundary`／`insideDeclaredBoundary`（grep 为空） | claim 可以（并被写者要求）声明 `boundary`；旧记录缺该字段仍可读；空 `boundary` 被具名拒绝（"声明了却什么都没关闭"读起来像关闭） | 写者不再要求 `boundary` ⇒ 具名拒绝的用例红 |
| **AC-2** | finding 无法记录"它落在声明域内"，于是每个越界都被读成缺陷，而"改判据或更新声明"没有表达方式 | finding 记录 `insideDeclaredBoundary`；**域内的 major/blocking 仍进返修轮**（§0.1）；记录与路由**同时给出两个出口** | 把"域内"当成不返修的通行证 ⇒ 返修仍发生的用例红 |
| **AC-3** | `src/workflow/review-read.ts:226`（`record.boundToCurrentRevision ? record.findings : []`）：重封即让上一版 blocking finding 消失 | **决策 D2-a ①**：未答的上一版 blocking finding 被携带（"已答"= 存在一个绑到更新 revision 的复核轮），并具名给出出口 | 去掉携带 ⇒ "重封后仍在阻塞集合里"的用例红 |
| **AC-4** | A-3：`severity` 在复核侧无判据文本（`src/kernel/types.ts:178` 的注释只说明它影响证据强度），出口条件靠复核者自由选择 | 判据文本成为**冻结词表**并**随 `ReviewRequest` 送出**（发出去的事实，不是口头约定）；`mergeBlockingSeveritiesForTier` 与"严格模式按 major 返修"**行为不变** | 请求不再携带判据文本 ⇒ 用例红 |

### B. 拒绝/上报的读法可执行（根因 II 前半）

| AC | 缺陷（实测位置） | 属性 | falsifier |
|---|---|---|---|
| **AC-5** | D-4：`scope change --remove` 成功，随后 `build --seal` 拒绝并要求"声明回来"（候选集 = `changedGitPaths ∪ previousPathDigests`，`src/workflow/seal-preflight.ts:191-199`） | 移除声明是**带理由的受管决定**；候选集改为**内容增量**；重封不再要求恢复刚移除的声明 | 候选集退回"上一版哈希过的路径" ⇒ 用例红 |
| **AC-6** | I-1（A-5）+I-8：`src/quality/check-resolver.ts:260-267` 按 `kind+command+args+cwd` 去重，共用命令的第二条永不执行、无证据文件；`src/quality/project-checks.ts:161-169` 有**另一套**键（`name+command+args`） | 执行列表带 `acceptanceIds: string[]`，一份结果服务多行（或在声明期拒绝并点名两行）；**两套判据合并为一处** | 去掉归属 ⇒ "第二条也有证据"的用例红；两处判据只改一处 ⇒ 另一处用例红 |
| **AC-7** | I-2（A-6）：`src/kernel/types.ts:426` 文案把探测失败说成"缺陷存在"；`src/store/ledger.ts:1696` 只有三态、无成因 | refuted 的 `observed` 报告成因（与 `supported` 路径对称：变异没落上／落上未变红／红在别的属性）；文案按 `evidenceType` 分派 | 去掉成因 ⇒ 用例红 |
| **AC-8** | I-6：`ledger claim restate --evidence` 返回 `ok: true` 而 `evidenceIds` 不变（`--evidence` 在 `ledgerFamilyFlags` 内，未知 flag 拒绝不触发） | 动词不读的族级 flag **具名拒绝**（或动词必须读它） | 恢复静默丢弃 ⇒ 用例红 |

### C. 静默/崩溃/竞态（根因 II 后半）

| AC | 缺陷 | 属性 | falsifier |
|---|---|---|---|
| **AC-9** | I-4：`open --bootstrap-file` 写矩阵却**不写** `ownedPaths`（今日两处 change 实测，封存报 "Owned path coverage incomplete"） | 要么应用 `ownedPaths`，要么**拒绝它不会应用的 bootstrap**（静默丢弃是最坏结局） | 恢复静默丢弃 ⇒ 用例红 |
| **AC-10** | I-5：非法 `--tier` 抛 `Cannot read properties of undefined (reading 'reviewers')`；同族：`ledger usage set` 的 `numeric()` 调 `fail()` 后**不终止**，磁盘已写且打印两份互相矛盾的 JSON | 非法取值具名拒绝并给出词表；`fail()` 真正终止（两处同批） | 恢复不终止/崩溃 ⇒ 各自用例红 |
| **AC-11** | I-7：封存收尾复查（"检查期间仓库移动"）会被**检查自己写入又删除**的临时文件绊倒（实测 `docs/superpowers/reports/__probe-visibility.txt`，事后已不存在） | 复查比较**前后集合**而非采样窗口；或让在仓库内写临时文件的检查改写到 `tmp/` | 恢复采样式比较 ⇒ 用例红（写入即删的检查不再触发拒绝） |

### D. 一个事实一处派生

| AC | 缺陷 | 属性 | falsifier |
|---|---|---|---|
| **AC-12** | I-3：`context-fabric.ts:87`、`wiki/provenance.ts:211`、`wiki/drift.ts:116` 仍用普通对象做路径→摘要映射（根级 `__proto__` 文件被静默丢弃）；`revision-delta.ts:122` 用 `in`（走原型链） | 一处 null-prototype 构造 + 一条"新出现普通映射即红"的**类级**守卫 | 新加一个普通映射 ⇒ 类级守卫红 |
| **AC-13** | D-3：`changedOutsideOwnership` 无消费者且被门禁自身记账占满（实测 322 / 生产代码 0） | **决策 D-3** 落定后的形态（建议①排除 `.kata/**`） | 恢复包含门禁记账 ⇒ 用例红 |

### E. 未证实项的复现实验（产出「修复证据」或「记录的边界」，二者都算完成）

| AC | 现状 | 实验 |
|---|---|---|
| **AC-14** | U-1/U-2/U-3 三条已在在飞的三个 change 里实现，**未封存** | 各自写一个用例：①"预期非零退出"的验收命令被判通过；②原始四方向互斥不可复现；③声明含 `.llmwiki` 且工作树有未提交改动时不再判 superseded。**若某条复现失败（即仍不可证伪），就把它写成声明的边界并说明威胁模型**，不算未完成 |

---

## 4. 不在本 change 里的东西

- **U-1/U-2/U-3 的修复（不是复现）**：它们已在在飞的 change 里，本文只做它们的复现锁定（AC-14）。
- **C 组已修复项**（队列 C：F7、claim 文本进身份、空覆盖、目录展开）：已归档或已封存等审查，不重复处理。
- **D-1/A-4 的组合决定**：若你选②（不为改名推入原名字），它落在 AC-5 之外的 `undeclared-changes` 读数上，会作为 AC-5 的一个用例（同一处判据）。

## 5. 成本

| 项 | 估计 |
|---|---|
| 设计（本文件） | 已完成 |
| 实现（14 AC，TDD） | 6–9 h（含四个决策点落地后的返工余量） |
| 全套回归 + tsc + dist 重建 | 每次 6–8 min（325 files / 1900+ tests） |
| 一次封存 + Verify + 账本 | ~10 min（含若干前置检查的重试：本项目实测一次封存平均踩 1–2 次前置拒绝） |
| 独立审查轮 | 17–40 min / 200k–680k tokens（14 条 AC 属"大"端） |
| **合计** | 约 1 个工作日 + 1 轮审查；若第一轮 FAIL，按类修复 + 重封 + 再一轮（本项目历史中位数：2 轮） |

**执行顺序**：先关在飞三条 → 本 change 按 A→B→C→D→E 顺序实现（A 主干先落地，因为 B/C/D 大量复用同一批文件）→ 一次封存 → Verify → 账本 → 一轮独立审查 → judge_gate（停下等你确认模型）→ archive。
