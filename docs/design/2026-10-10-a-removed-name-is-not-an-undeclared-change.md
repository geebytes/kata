# 一个消失的名字不是「未声明的变更」

**日期**：2026-10-10
**来源**：下游 `zenmpai` 的反馈 `docs/superpowers/reports/2026-10-10-declared-path-that-seal-requires-ledger-refuses.md`（队列 A-4 / D-1），
以及我在树外 fixture（`/tmp/delcheck`，未改本仓源码）的独立复算 —— 复算记录写在 `docs/superpowers/reports/OPEN-DEFECTS.md` 的 A-4。
**决策**：用户在 2026-10-10 选定 **甲**（内容增量 + 账本拒绝不变）。
**为什么是独立 change**：`kata-cli tasks declare` 只写 `upstreamCoverage` 与 `acceptanceMatrix`，并**拒绝**改写验收契约
（实测：`Unknown declaration field 'acceptance'; … A task's acceptance criteria are its contract and are not rewritten here.`），
所以它不能作为一个 AC 加进已冻结的 `unify-the-remaining-integrity-and-workflow-gaps`。
**profile**：`current_worktree / tdd / strict`（它动的是封存前置读数，不能放松任何门禁）。

---

## 1. 实测的问题

一个把源文件**改名**（或**删除**）的 change 在账本阶段走不下去，因为两条规则对同一个事实给出**排他**的定义：

| 侧 | 规则 | 位置 | 后果 |
|---|---|---|---|
| seal | `changedGitPaths` 对 rename/copy **同时 push 新名字与原名字**（注释原文：*both names are paths the change touched*） | `src/core/git.ts:74-94` | **被删除/被改名带走的名字必须出现在声明里**，否则 seal 拒绝冻结 |
| ledger | `plan` / `freeze` / `run` 都从**声明**取路径，任何一个读不到即整体拒绝 | `src/cli/ledger.ts`（`currentSubject`） | **声明里不能有读不到的路径** |

实测（`/tmp/delcheck`，逐字）：

```
git status --porcelain=v1 -z --untracked-files=all   →  "RM src/moved.ts"  "src/keep.ts"
ledger freeze（声明含 src/keep.ts）  →  {"ok":false,"error":"these declared paths cannot be read, so they cannot be frozen: src/keep.ts","unreadable":["src/keep.ts"]}
ledger plan  （同一状态）            →  同一句错误、同一个 unreadable 列表      ← 报告只说 plan 取路径，这里实测它也过不去
ledger run   （同）                  →  "no plan has been stored"               ← 请求永远生成不出来
ledger freeze --paths src/moved.ts   →  {"ok":true,"revision":"rev:fefc6a5758b91233","paths":1}   ← 唯一的逃生口
ledger run    --paths src/moved.ts   →  --paths 被接受但被静默忽略（无未知 flag 拒绝，仍读声明）
```

**两个必须说清的附加面**：

1. **不是「没有逃生口」，而是「看起来有、实际没有」**：`run` 接受 `--paths`（族级 flag）却仍从声明取路径 ——
   这正是本仓 `I-6` / AC-8 的类别（动词不读的族级 flag 被静默丢弃）。
2. **纯删除与改名同形**：` D src/gone.ts` 也进 `changedGitPaths`；声明它 ⇒ 账本拒绝，不声明 ⇒ seal 报「未覆盖」。
   所以修法**必须一条规则同时覆盖改名与删除**，否则只解决一半。

---

## 2. 甲的语义（已定）

1. 「未覆盖」读数改为**内容增量**：**一个不再存在的名字不是「未声明的变更」，它是已声明内容的移除** ——
   账本的 drift / `removed` 读数本来就报这件事。声明面**不因改名或删除而扩张**。
2. **账本的拒绝保持不变**：它区分「声明后被删」与「故意声明的坏路径」，这是
   `a-declared-directory-excludes-its-build-output` 的 C2 **刻意断言**的不对称，不以本 change 放宽。
3. 每个动词要么读它接受的族级 flag，要么**按名拒绝**（`run --paths` 不再静默忽略）——与 AC-8 同一处判据。

---

## 3. 验收项

| AC | 属性 | 选择器（独立文件） |
|---|---|---|
| **AC-1** | 一个**改名**（原路径已不存在）且只声明新名字的 change：未覆盖读数为空、前置通过；**同一状态加入一个存在却未声明的文件仍被点名**（对照） | `tests/unit/a-removed-name-is-not-an-undeclared-change.test.ts` |
| **AC-2** | **纯删除**同样如此：不需要声明那个不再存在的路径 | `tests/unit/a-deleted-path-is-not-an-undeclared-change.test.ts` |
| **AC-3** | **C2 不变**：声明里含一个**从未存在**的路径 ⇒ `ledger freeze` 仍按名拒绝 | `tests/unit/a-declared-path-that-never-existed-is-still-refused.test.ts` |
| **AC-4** | 改名后的 change 能走完 `plan` → `freeze` → `run`，请求的 `subjectRevision` 与冻结值一致；且 `ledger run` 要么读 `--paths`、要么按名拒绝 | `tests/unit/a-renamed-change-can-produce-its-request.test.ts` |

四个 AC 各自独立选择器文件（共用文件会被 `dedupeChecks` 折叠，本仓已因此三次留下没有证据的验收项）。

**单点变异**：

1. 改回「把原路径也当成未声明变更」⇒ AC-1、AC-2 红；
2. 把「存在却未声明」也一并排除 ⇒ AC-1 的对照红；
3. 放宽账本的拒绝（读不到即跳过）⇒ AC-3 红；
4. 去掉 `run --paths` 的按名拒绝 ⇒ AC-4 红。

---

## 4. 边界（写下来，不假装做到）

- 本 change **不**声称「凡是消失的名字都必然安全」，只说：消失的名字**不是未声明的变更**（它们是已声明内容的移除）。
  「这次移除是否落在声明面的覆盖里」仍由声明面与 drift 读数回答，本 change 不合并这两件事。
- `--paths` 在 `freeze` 上仍是生效的逃生口，本 change 不删除它（它是冻结前唯一的手动收窄手段）。
- 内容增量的判据必须来自**同一个文件系统读数**（一次 `git status` + 一次存在性判断），
  不得在 seal 侧另建第二套「什么算存在」的枚举 —— 那正是本仓反复付学费的形状。

---

## 5. 成本

| 项 | 估计 |
|---|---|
| 实现（4 AC，TDD） | 3–5 h（含两处调用的接线与四条选择器） |
| 全套回归 + tsc | 每次 6–8 min |
| 封存 + Verify + 账本 | ~10 min |
| 独立审查轮 | 17–40 min / 200k–680k tokens |
| **合计** | 约半天 + 一轮审查；买到的是**改名与删除的 change 不再依赖操作顺序**（今天 zenmpai 因此只能人手装配请求） |
