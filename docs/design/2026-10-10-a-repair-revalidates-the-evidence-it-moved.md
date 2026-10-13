# 一次修复要重验它移动过的证据

**日期**：2026-10-10
**来源**：本队列 **I-10**（`docs/engineering/2026-10-10-unified-kata-defect-queue.md`），证据来自 `the-review-loop-carries-its-defect-classes` 的第 3、4、5 轮独立审查。
**状态**：设计（2026-10-13 按实测收窄）。**两条 AC 已落地**，本 change 只做剩下的三条。

> **2026-10-13 实测（先测量再实现）**：本文的 **AC-1 与 AC-2 已经实现**，随合并 change
> `the-workflow-layer-checks-what-it-claims` 的 AC-4 一起提交（commit `aa39e8c`）：
> - `src/quality/falsifier-anchors.ts` —— `locateAnchor` 三态（`unique | absent | ambiguous`）与 `anchorRefusal`（分别写出"匹配 0 次"与"匹配 N 次"，并带上锚点原文）；
> - `src/workflow/seal-preflight.ts:327-336` —— blocker `falsifierAnchorUnusable`，封存按名拒绝且**不写 revision**；上游 321 行还有 `falsifierAnchorsUnreadable`（账本读不出时拒绝，而不是跳过检查）；
> - 选择器 `tests/unit/a-falsifier-anchor-is-checked-at-seal-time.test.ts`（**13 条用例**）与 `a-stale-anchor-is-not-a-supported-falsifier.test.ts`（4 条）；
> - **只读性质**在代码里写明并成立：`seal-preflight.ts:314-317` —— "a string match, no test run, no verdict"。
>
> **我自己在本会话被它拒过两次**（"E2 matches 2 times…"、"E10/E11 anchor matches 0 times…"），所以这不是纸面结论。
> 因此本 change **不重复实现** AC-1/AC-2，只做实测缺失的三条（下表 AC-1/AC-2/AC-3 = 原 AC-3 与两处新增），
> 并把"已落地"作为 R-1 的 `outOfScopeReason` 写进 `upstreamCoverage`。

**新增的实测依据（本会话，2026-10-13）**：
1. **修复挪行 ⇒ 锚点漂移**：手工重瞄锚点 **≥20 次**（一次修复通常移动 2–4 条），每次都是"inconclusive ⇒ 重瞄 ⇒ 重冻 ⇒ 重验"；
2. **同一规则两处实现会互相遮蔽仪器**：`the-gates-can-be-repaired` 的 `ledger evidence verify` 同时报 **E10 与 E20 `refuted`**——形状检查写在读取器与 reset 两处，去掉任一处都不改变读数；收成一处后 19/21 supported；
3. **封存印出的补救会丢证据**：`seal-preflight.ts:331-336` 让操作者用 `ledger evidence replace --file <整集>` 重瞄**一条**，而 `src/cli/ledger.ts:784-787` 要求 `--file`（整集替换）⇒ **拒绝印出的路会丢掉其余证据**（本会话两次因此差点丢证据，靠手工提交全集救回）。这正是本仓最贵的缺陷类，且它就在封存自己的拒绝文案里。

---

## 1. 实测的问题

一条声明的 `executable_falsifier` 由三样东西绑定：**文件 + 锚点（`find`）+ 替换（`replace`）**，以及一次真实运行留下的 verdict。**锚点是位置性的**，而修复会移动位置：

| 轮次 | 失配的仪器数 | 发现方式 |
|---|---|---|
| 第 3 轮（blocking） | **9**（E3/E4/E9/E10/E11/E15/E16/E18/E19） | 独立审查逐条核对 `find` 是否仍匹配 |
| 第 4 轮修复之后 | **3**（E9/E11/E15） | 我自己在提交后复算 |
| 第 5 轮修复之后 | **1**（E15） | 同上 |

**后果比「少一条证据」更坏**：盘上的 verdict 仍写 `supported`——因为它**早于那次修复**。于是

- 账本可以对一条**其变异再也落不上**的证据宣布 `supported`；
- 把变异应用到别处（或什么都不做）会让检查**在未注入缺陷的情况下通过**，读作"该检查在缺陷下会红"；
- 这正是本仓库自己的 `instrument-unsound` 类，而它**只能靠人手工核**（今天的做法就是人手工重瞄，然后反复漏）。

**根因**：`ledger evidence verify` 会把锚点与当前文件比对，但**没有任何机制在文件变化后强制重验**。写者（author）改了文件，读者（verdict）不知道。

---

## 2. 修法（三条路，推荐 B）

**A. 封存时重跑全部声明的 falsifier。**
最彻底（既查"锚点还在"也查"它仍会红"），但代价是封存现在依赖账本：一次全量重验 = 19 次（变异 + 选择器），实测每条约 1–3 秒 ⇒ 约 30–60 秒，外加"账本不可读时封存怎么办"这一整类新问题。**改变门禁依赖关系，需要单独决策**，本设计不推荐先做。

**B.（推荐）封存时做「锚点仍然唯一匹配」的静态检查，不成立即按名拒绝。**
- 这是必要条件的检查：锚点失配 ⇒ 那条证据**不可能**再证明任何事。它精确命中实测到的三类失配（9/3/1），成本是**毫秒级**（只读文件 + 数一次出现次数），不运行测试、不引入账本依赖。
- 拒绝文案必须**可执行**：点名证据 id、文件、以及"该锚点在当前文件里匹配 0 次/2 次"，并给出现成的重瞄命令（`ledger evidence replace --file …`）。
- 与现有机制的分工写清楚：**封存**保证"锚点还指着东西"（必要），**`ledger evidence verify`** 保证"它确实会红"（充分）。两者都不是对方的替代。

**C. 把锚点锚在内容上（记录所在文件/区域的摘要）。**
对所有编辑都过严（改一个无关的行也会作废证据），会把"重瞄"变成"每次都重瞄"。不采用。

**附带项**（实测到的操作坑，与 B 同批）：重瞄需要提交**完整**证据集（`evidence replace` 是"用给定集合替换"），而 CLI 没有"只更新某一条"的形式；今天因此两次丢掉其它证据。B 落地时把"重瞄一条"做成一条命令（按 id 更新），否则每次重瞄都是一次全量覆盖的机会。

---

## 3. 验收项

| AC | 属性 | 选择器 | falsifier |
|---|---|---|---|
| 原 AC | 现状 |
|---|---|
| 原 AC-1（封存拒绝 ≠1 锚点） | ✅ **已落地**（`aa39e8c`，见上）；本 change 只把**它的补救文案**改成可执行（下表 AC-2） |
| 原 AC-2（检查只读） | ✅ **已落地**（`seal-preflight.ts:314-317`）；R-1 的 `outOfScopeReason` 记录此事 |

| 本 change 的 AC | 属性 | 选择器 | falsifier |
|---|---|---|---|
| **AC-1** | **重瞄一条证据是一条命令**：`ledger evidence replace --change <id> --id <evidence-id> --reason <why>` 只更新那一条的锚点，其余证据的绑定（id / file / find / replace / claim 引用）**逐字不变**——所以重瞄**不可能**静默丢掉其余证据 | `tests/unit/re-aiming-one-evidence-item.test.ts` | 让 `--id` 退化成整集替换（用提交里的集合覆盖）⇒ 用例红 |
| **AC-2** | 封存的锚点拒绝**印出那条可执行的命令**（点名 `--id`），而不是要求提交整集 | `tests/unit/a-moved-anchor-refuses-the-seal.test.ts` | 把文案改回 `--file <整集>` ⇒ 用例红（断言的是"命令里含 `--id` 且不含 `--file`"这一**性质**，不是字符串） |
| **AC-3** | **分工被断言而非写在注释里**：锚点仍唯一匹配、但变异不再生效的证据，**封存不拒**；而 `ledger evidence verify` 仍报 `refuted` | `tests/unit/an-anchor-that-still-matches-is-not-a-verdict.test.ts` | 让封存顺带断言 verdict ⇒ 用例红（把充分条件混进必要条件） |

四个 AC 各自独立选择器文件（共用文件会被 `dedupeChecks` 折叠，本仓已因此三次留下没有证据的验收项）。

---

## 4. 边界（写清楚，不假装做到）

- 本设计**不**保证"证据仍然会红"——那仍是 `evidence verify` 的职责，且需要真实运行。封存只保证"锚点还指着东西"。
- 一条证据的锚点唯一、但**它测试的代码**被改写（同一行仍在、语义已变）时，本检查看不出——那是必须由独立审查承担的判断，不是机械检查能覆盖的。
- 选择器与检查之间仍是两处判据：**如果将来 `find` 的语法变了**，两处必须同批改（本设计不引入第二套锚点语义，检查复用 `locateAnchor` 这唯一的落点判据）。

---

## 5. 成本

| 项 | 估计 |
|---|---|
| 实现（3 AC，TDD；原 AC-1/AC-2 已落地不重复做） | 1.5–2 h |
| 每次封存的额外耗时 | 毫秒级（只读文件与计数），实测：一次 `String.split(find).length - 1` 级操作 |
| 一次封存 + Verify + 账本 | ~10 min（既有流程，未增加重跑） |
| 独立审查轮 | 一次（17–40 min） |
| **合计** | 约半天 + 一轮审查；它买到的是**不再需要人手工重瞄**（今天为此在三个轮次里漏了 9 + 3 + 1 次） |
