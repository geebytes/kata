# The sealed identity is computed where the change is

**日期：** 2026-10-10
**Change：** `the-identity-is-computed-where-the-change-is`
**状态：** 设计已定，待实现（等 `unify-the-remaining-integrity-and-workflow-gaps` 的独立审查轮返回后再动 `src/`）

## 1. 问题（已核实，附实测数字）

一个 change 在 `ownedPaths` 里声明了 `.llmwiki/**`（kata 自己的 wiki 约定就是这样）时，`verify` **永久**判
`revision_superseded`，且**每次重封都复现**——即门禁给出的出路不可执行。来源报告：
`docs/superpowers/reports/2026-10-09-verify-calls-superseded-with-matching-evidence.md`（其结论对、根因错，已在该文件内更正并附证据）。

链条，逐行可指认：

1. **身份在执行沙箱里算**：`src/workflow/orchestrator.ts:674-679` 把 `contentRoot: sandbox.root` 与
   `contentDigests: sandbox.contentDigests` 交给 `createTaskRevisionIfChanged`。
2. **沙箱只有已提交内容 + 被策略允许的 overlay**：`src/workflow/execution-sandbox.ts:33`（`git worktree add --detach <tmp> HEAD`，
   再用 `listRepositoryFiles` 叠作者树的未提交内容），而 `.llmwiki` 在策略的「永不是内容」名单里
   （`src/core/repository-identity.ts:37`）⇒ **`.llmwiki/**` 进不了沙箱**。
3. **身份对声明路径不做这个过滤**：`src/workflow/revision.ts:453-491` 的 `feedOwnedTree` 取每条声明路径的内容，
   不存在时记 `[missing]` 哨兵（注释明说「过滤器只管 walk 往下走进什么，从不管声明」）。
4. **`verify` 拿作者工作树重算**：`src/workflow/revision.ts:388-391` 比较 `computeManifestHash` ⇒ 必然不等。

实测（zenmpai `expose-the-complete-parameter-set`，51 条声明路径逐条重算，2026-10-10）：

```
.llmwiki/concepts/<change>.md   记录 8ba1b5d9… == sha256('[missing]')  磁盘 e18189a1…   ← 未提交的新页
.llmwiki/index.md               记录 fddd5622…                          磁盘 362291a8…   ← 沙箱里是 HEAD 版本
.llmwiki/log.md                 记录 1d724d8d…                          磁盘 5800309d…
其余 48 条：一致 ；重算 manifestHash 91725c38… ≠ 记录 48b6d286…
```

同时被证伪的两条（写在报告里，避免重复修错方向）：

- `changedOutsideOwnership` **在 `src/` 里没有消费者**（只有 `change-record.ts` 自身与一处 eval 语料），
  因此它列的 `.kata/evidence/**`、`.kata/tasks/**` 与这 12 项判定无因果；
- 「把门禁自身工作区从表面里排除」**不触及上面四步中的任何一步**。

## 2. 决策

**A（采用）：身份在作者工作树里计算，沙箱只负责跑检查。**
沙箱的制度目的是「检查不得写进作者树」（`execution-sandbox.ts` 的头注释），身份计算不需要这层隔离——它只是读内容、算摘要。
于是 `contentRoot` 与 `contentDigests` 改为作者 root，检查仍通过 `checksForExecutionSandbox` 映射到沙箱执行。

**B（否掉）**：让沙箱能表示每一条被声明的路径（即使策略说它「永不是内容」也 overlay）。它要求沙箱复制一条
策略认为不该复制的路径，等于**在沙箱这一侧再造一个「什么是内容」的枚举**——本仓库反复删除的正是这种第二份答案
（`docs/design/2026-10-08-a-declared-directory-excludes-its-build-output.md`）。A 不新增枚举，只是让**算身份的树**与**校验身份的树**是同一棵。

**C（采用，与 A 无关且必须做）：`superseded` 必须给出导致它的比较。**
现在这个状态**无法被操作者核对**：唯一可读的内容图（`contentDigests`）由被过滤的 walk 生成，**恰好不覆盖能漂移的那些声明路径**，
所以按现有工件核对只能得出「什么都没变」。`RevisionStatus` 的 `superseded` 分支要带上：revision id、
**摘要不同的路径**、每条的「记录值 vs 观测值」。这是报告的第 4 条回归，方向正确。

**门禁强度不变**：内容**真的**移动时仍然 `superseded`、仍然 FAIL、仍然要求 re-seal。A 只是让「真的移动」与
「沙箱看不到」不再混为一谈；C 只是让前者可读。此处不削弱任何判据。

## 3. 验收与选配

| AC | 性质 | selector（各自独立文件） |
|---|---|---|
| AC-1 | 身份取自**变更所在的仓库**：被声明但未提交、或比 HEAD 更新的路径，记录的是操作者能看到的内容；`verify` 重算相同摘要，不再对未移动的树报 `superseded` | `tests/unit/the-identity-is-computed-where-the-change-is.test.ts` |
| AC-2 | `superseded` 给出它比的是哪一侧：revision、**摘要不同的路径**、每条的记录值 vs 观测值 | `tests/unit/a-superseded-verdict-names-its-comparison.test.ts` |

**两条 AC 各用独立 selector 文件**：本仓库在 seal 的 `dedupeChecks` 上三次踩到「两个 AC 共用同一文件 ⇒ 第二条
criterion 完全没有证据、verify 判 `insufficient_evidence_level`」（最近一次是 `unify-the-remaining-integrity-and-workflow-gaps` 的 AC-16）。

**Falsifier（每条 AC 一个单点可逆 mutation，必须让它红）**

- AC-1：把 `contentRoot`/`contentDigests` 改回 `sandbox.root` ⇒ 用例红（fixture 用一个未提交的声明文件）。
- AC-2：去掉 `superseded` 分支的路径/摘要明细 ⇒ 用例红。

## 4. 边界与代价

- **与在飞 change 共享文件**：`src/workflow/orchestrator.ts` 也是
  `unify-the-remaining-integrity-and-workflow-gaps` 的声明路径。按本仓库惯例**如实记录共享 ownership，不缩窄声明**；
  代价是两个 change **不得同时封存**（同一 checkout 里 seal 的隔离执行会互相干扰），本条已记入流程约束。
- **不动**：`execution-sandbox.ts` 的复制规则（B 被否）、任何门禁判据的强度、`revision_superseded` 作为 RepairScope 的存在与语义。
- **风险**：身份改从作者树计算后，作者树的**未提交**内容会进入 revision 身份——这正是 A 想要的（revision 描述操作者眼前的内容），
  但意味着「先提交再封存」不再是让身份稳定的必要条件；这一点写进实现的注释，并由 AC-1 的用例钉住。

## 5. 验证注记（本仓库已付过学费的教训）

- **测差异的守卫必须构造真子集**：AC-1 的 fixture 必须让**声明面 ≥2 条**、且只有**一条**未提交，否则「只展开第一条声明」这类
  defect 在单声明 fixture 下不可见。
- **测「同一物理文件两个名字」**：`dev`+`ino` 那五次教训提示，凡涉及路径身份的用例都要覆盖别名（`./x`、符号链接、硬链接）。
- **机械自审在派发审查轮之前**：对两条 selector 各施加它自己的 mutation，要求至少一条变红；打不红的守卫当场补，不带进审查轮。
