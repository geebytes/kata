# 治理记录与 worktree 同生共死（诊断）

**状态**：诊断完成，待开 governed change。
**发现于**：`security-tier-platform-boundary` 归档时的状态不一致回溯。
**严重度**：数据丢失级——**审计记录会在归档时被自己的清理逻辑删除**。

## 1. 现象

`security-tier-platform-boundary` 的 review 通过、judge PASS、`archive` 返回 `success: true`，但主检出里：

- `.kata/tasks/security-tier-platform-boundary/current-state.json` 停在 `phase: implement`；
- 没有 `review/` 目录，没有 `judge.json`；
- `state-events.jsonl` 只有 3 个事件（`intake → plan → implement`）。

而 `.kata/worktrees/security-tier-platform-boundary/.kata/tasks/.../` 里**这些全都有**。

## 2. 范围

不是孤例。同样的形态出现在**每一个用 `isolated_worktree` profile 跑的 change**：

| change | 合并进 master | 主检出记录的相位 | 完整记录在哪 |
|---|---|---|---|
| `bounded-review-convergence` | `1f45d12` | `intake` | worktree |
| `gate-input-integrity` | `802e8e8` | `implement` | worktree |
| `verdict-readings-per-run` | `03957a9` | `implement` | worktree |
| `security-tier-platform-boundary` | `f92ed83` | `implement` | worktree |

实测字节数：主检出的 `task.json` 5004 字节 vs worktree 的 7962 字节——**worktree 那份才是完整的**。

## 3. 根因

四步，每步都可核实：

1. **`.gitignore:2` 忽略 `.kata/`** —— 整个治理状态目录不进 git。
2. **`src/core/layout.ts:129` 的注释说 "task state is tracked"** —— **与事实矛盾**。设计意图是 worktree 与主检出共享同一份记录；实际是两边各自写入。
3. **`resolveWorkspaceRootForTask`（`layout.ts:117`）取"最近的所有者"**："running a command inside the worktree means the worktree — not the primary checkout it is nested in"。所以**在 worktree 里跑的每个 kata 命令，记录都写进 worktree 的那份**。
4. **`cmdArchive` 在 `archivePhase === 'archive'` 时删除 worktree**（`orchestrator.ts` 的 worktree cleanup 分支，注释写着 "A change's isolation ends where the change ends"）。

**合成后果**：代码通过 `git merge` 进 master，**记录留在 worktree，然后归档把它连同 worktree 一起删掉**。

## 4. 为什么现在还没丢

`security-tier-platform-boundary` 的 worktree 没被删除，因为里面有一个未跟踪目录 `.agents/skills/command-safety/`——`removeWorktree` 不带 `--force`，git 因此拒绝。**记录是靠一次意外幸存的**，而那次意外与本 change 的机制无关（是会话中途恢复了一个 skill 目录）。

`bounded-review-convergence` 与 `gate-input-integrity` 的 worktree 也还在，同样只是**没人执行过真正的清理**。

## 5. 三个可独立验证的断言

1. **删除 worktree 会删除它的审计记录**：`rm -rf .kata/worktrees/<task>` 之后，主检出读不到该 change 的 `review.json` / `judge.json` / 事件历史。
2. **两个 root 的记录会分叉**：在 worktree 里跑 `kata-cli status` 与在主检出跑，得到不同的 `phase`（实测：`archive` vs `implement`）。
3. **`git merge` 不搬记录**：`.kata/` 被忽略，所以合并后主检出的 task 记录仍停在 change 开始时的那一份。

## 6. 候选修法（未定）

- **A · 把治理状态移出 worktree**：任务记录写主检出（或一个与 worktree 无关的 store root），worktree 只放代码。改动最大，但符合"记录是审计"的语义。
- **B · 让 `.kata/tasks/**` 进 git**：与 `layout.ts:129` 的注释一致（"task state is tracked"），worktree 与主检出自带同一份。风险：`.kata/` 里还有 runtime / worktrees / 大文件，需要**选择性跟踪**。
- **C · 归档前把记录从 worktree 搬回主检出**：最小改动，仍然是"一个事实两处副本"，需要处理冲突与已存在的旧副本。
- **D · 归档时先搬记录再删 worktree**：C 的时序版本，保证清理不会先于搬迁。

**倾向 A 或 B**：C/D 都在保留"两份副本"这个缺陷本身，而本仓库反复成立的规则是"一个事实一个来源"。

## 7. 与清单里其它项的关系

这条**优先级高于** `cli-flag-reader-design` 等设计稿：那些是"行为可以更好"，这条是"已经做过的证明会消失"。在它修好之前，**任何一个 `isolated_worktree` change 的归档都不是可信的归档**。

## 8. 设计（本 change 的实施输入）

**Change**：`task-records-outlive-the-worktree`，profile `current_worktree / tdd / strict`。
**为什么不是 `isolated_worktree`**：本 change 修的是"记录会随 worktree 消失"。用它自己会产生自指——**修复过程的审查记录同样会落在那个会消失的 worktree 里**。这是选择 `current_worktree` 的**唯一原因**，不是偏好。

### 8.1 五条判据的形态

| AC | 判据 | 可失败的证据 |
|---|---|---|
| **AC-1** | 同一个 task 从两个 root 读到**同一相位** | 现在实测分叉（worktree `archive` / 主检出 `implement`）；用例在 linked worktree 里写一条记录，再从主检出读，断言一致；**变异**：让写入只落 worktree → 红 |
| **AC-2** | 归档**绝不删除**拥有唯一副本的 worktree | 用例构造"记录只在 worktree 里"，执行归档，断言**要么拒绝并列出会丢的记录、要么先搬走**；**变异**：恢复成"直接删" → 红 |
| **AC-3** | 两个 root 的差异**可检测**并具名 | 一条命令/函数报告"哪些 task 记录只存在于某个 worktree 下"；用例用真 fixture 造出该状态；**变异**：让它恒返回空 → 红 |
| **AC-4** | `layout.ts` 的 "task state is tracked" 要么**成真**、要么**改成事实** | 用例读该注释/常量并与**实际写入位置**比对；**变异**：改注释而不改事实 → 红 |
| **AC-5** | **枚举并恢复**现有仅存于 worktree 的审计记录 | 用例遍历 `.kata/worktrees/*/`，断言不存在"只在 worktree 里的记录"；恢复动作本身要可复核（列出文件 + 计数） |

### 8.2 取舍：为什么 AC-4 给两个方向

`.gitignore:2` 忽略 `.kata/`，而 `layout.ts:129` 的注释说 *"task state is tracked"*。**两者必有一错**，而修哪个是设计决定：

- **方向 1（让注释成真）**：选择性地把 `.kata/tasks/**/` 纳入 git（`runtime/`、`worktrees/` 继续忽略）。**优点**：worktree 与主检出自带同一份，符合注释的原意，`git merge` 自然搬家。**风险**：task 记录里的绝对路径/时间戳会进版本历史；每次 `seal` 都产生 git 变更。
- **方向 2（把注释改成事实）**：承认记录只在一处（某个 root），并**明确它是哪一个**、其他 root 读同一份。**优点**：不动 git 模型。**风险**：需要决定"唯一 root"是主检出还是 worktree，并让所有命令都解析到它。

**本 change 不预先锁定方向**：AC-4 只要求"语句与代码一致且有测试守住一致性"，方向由实现时按实测成本选。若选方向 1，AC-1 由 git 自然满足；若选方向 2，AC-1 需要一个"记录 root 解析"的统一入口。

### 8.3 非目标

- **不改归档的 worktree 清理语义本身**（"隔离随 change 结束"是已定的规则）；只要求它在**删之前确认记录已不在那里**。
- **不引入新的 store**（不是再造一个 `.kata` 之外的状态目录）。
- **不修 `.kata/` 其它内容**（`runtime/`、`worktrees/` 的生命周期不在本 change）。

### 8.4 与其它待办的关系

本 change 修好之前，**任何 `isolated_worktree` change 的"完成"都不可信**——包括 `cli-flag-reader` 那个大 change。所以本 change 先行，其余待办（CLI 参数类型收口、`scope` 写时校验、route 可执行性、三条文案漂移）在它之后合并处理。

---

## 9. 第 1 轮独立读数：裁决 `refuted` 4/5 —— 本 change 的核心判断是错的

**结论：不是"实现有疏漏"，是"设计错了"。** 下面每条我都自己复现过，不是采信读数。

### F1 · blocking · 我把 `cp` 删掉时，也删掉了 worktree 的可识别性

`createWorktree` 里那份 `cp taskDir(...)` 承担着**第二个职责**：它是在 `.kata/` 被忽略的仓库里，让 worktree 成为 `resolveWorkspaceRootForTask` 可识别的 owner 的**唯一依据**。

实测（真 git 仓库 + `.gitignore` 写 `.kata/`，即本仓库的规则）：

```
worktreePath:        /tmp/kata-f1b-*/​.kata/worktrees/f1b-task
resolvedFromWorktree: /tmp/kata-f1b-*          ← 解析回主检出
isWorktree:          false
copied:              false
```

**后果：从 worktree 里跑的命令操作的是主检出，代码隔离失效。**

**而 `worktree.test.ts` 的 fixture 从不忽略 `.kata/`**，所以它看不见这件事——我把那条用例改绿了，那个绿灯**证明不了任何事**。这是本仓库反复出现的形状：改断言不等于有证据。

### F2 · major · 守卫被绕过

`kata-cli worktree remove`（`src/cli/ops.ts:190`）直接调 `removeWorktree`，不走 `removeWorktreeSafely`。读数实测：同一次移除，`removeWorktreeSafely` 拒绝，而这条命令**删掉了 `judge.json`**。我在归档路径上加了守卫，却留下了另一条通往同一个删除的路。

### F3 · major · 检测器非递归 → **AC-5 的结论是假阴性**

`worktreeOnlyRecords` 只比较**顶层名字**。实测 worktree 里有 **213 个嵌套文件**（`review/*.json`、`handoffs/*.json`）；顶层目录名两边都有时，一个 nested 文件都看不见。

**所以我先前说的"129 个已全部恢复、`worktreeOnlyRecords` 返回 0"是错的**：恢复覆盖的只是顶层名字那一层，**实际还有 252 个嵌套文件留在 worktree 里**。那条"本仓库无孤立记录"的用例是**假阴性**。

### F4 · major · 恢复函数没有生产调用者

`recoverWorktreeRecords` 只在测试里被调用——教科书式的"机制无消费者"（本仓库 wiki 有这个概念页）。我手工跑了它一次，却没把它接进任何命令，所以**任何后来的 change 都不会被恢复**。

### F5 · major · `.kata/evidence` 不在 owner 规则内

`evidenceDir(root)` 仍是 per-root，检测器也看不见它。记录面不止 `.kata/tasks/`。

### F6 · 注释仍失实（我的 AC-4 只覆盖了 `layout.ts`）

`worktree.ts:14-20` 还写着 "the task's own state, copied in … (**the state is tracked**)"——cp 删了，注释没改。AC-4 的用例只读 `layout.ts`，所以它绿着。

## 10. 根因：两个职责被当成一个

我假设"记录应该只有一个 owner"，于是把 `cp` 当成"产生第二份副本的动作"删掉了。**但那份 `cp` 同时在做另一件事**：在 `.kata/` 被忽略时，给 worktree 一个能被识别的 `current-state.json`。

所以正确的问题不是"记录该归谁"，而是：

> **在 `.kata/` 被忽略的前提下，worktree 如何既是可识别的 owner、又不产生第二份会被归档删除的审计记录？**

候选 A（记录归主检出）与代码隔离**冲突**，除非把"owner 识别"与"记录存放"**分成两件事**。而这两个职责耦合的根源，是 **`.gitignore:2` 忽略了整个 `.kata/`**——也就是诊断文档 §6 的候选 B。B 本应是首选，我在设计阶段选了 A 而没有验证它与隔离的兼容性。

## 11. 状态：本 change 不能按现状收尾

- `revision-67b7b279fcc32891` 的 verify PASS 与"5/5 AC PASS"**建立在 F1 与 F3 之上**，而这两条都被证伪；AC-4 是**测错了文件**。
- 已恢复的 129 个文件**不是废话**——顶层名字那一层的审计确实回到了 owner——但**"全部恢复"这句话必须撤回**，改成"顶层层已恢复；嵌套层 252 个文件待处理"。
- 已落地的 `removeWorktreeSafely` / `recoverWorktreeRecords` / `recordsRoot` **都是未完成的机制**：一个有绕过路径、一个无调用者、一个只覆盖一半的记录面。

---

## 12. 重做设计：拆开「代码根」与「记录根」（方向 A，2026-10-02）

§10 提出的问题在本节回答。前提已经改变：`.gitignore` 现在**不是**忽略整个 `.kata/`，而是 whitelist 模式——
`git check-ignore` 实测 `current-state.json` / `task.json` 未被忽略，`seal-progress.jsonl` 被忽略，
`git add -An .kata/` 得到 **476 个文件**（459 任务记录 + 17 wiki）。`repository-identity.ts` 也已把 `.kata` 移出
`ignoredDirectoryNames`，改为按前缀排除 machinery（worktrees/runtime/locks/evidence）。

**但这些改动全部未提交**，所以运行时仍是旧行为——这正是 F1 成立的现场。

### 12.1 F1 的根层诊断（比第 1 轮读数更精确）

```ts
// layout.ts:117-140
if (hasFileOrDir(directory, join('.kata', 'tasks', taskId, 'current-state.json')))
    candidates.push(directory);        // ← 判定 owner 的唯一依据
```

`resolveWorkspaceRootForTask` **靠文件存在性判断谁是 owner**。这就是那份 `cp` 存在的真正理由——不是为了
「两份审计副本」，而是**为了让 worktree 有一个文件能让解析器认出它**。`recordsRoot()` 让记录只住一处之后，
worktree 里就没有这个文件，解析器认不出，于是回落到主检出，**代码隔离失效**。

把这个函数的名字与用法放在一起看，冲突是必然的：

| 目标 | 要求解析指向 |
|---|---|
| 记录单一所有权（本次改动要实现） | **主检出** |
| 代码隔离（从 worktree 跑命令作用于 worktree） | **worktree** |

而 `layout.ts:131-136` 的注释自己承认了错位：**「This is about the code, not about the records.」**——一个名叫
`...ForTask` 的函数在找**记录**，却被用来决定**代码**在哪。**这才是 F1 的根层原因：一个函数承担了两个语义**，
而这两个语义在当前设计下必然冲突。

### 12.2 方向 A：两个根，两次解析

不再让任何解析依赖「某个文件是否存在」。

```ts
// 代码根：纯路径逻辑，不读文件系统
export function resolveCodeRoot(from?: string): string {
  // from 落在 <root>/.kata/worktrees/<id>/ 之内时，该 worktree 就是代码根；
  // 否则为 resolveWorkspaceRoot(from)。判定只看路径形状，不看文件是否存在。
}

// 记录根：任务记录的唯一 owner（已由 recordsRoot 实现）
export function resolveRecordsRoot(taskId: string, from?: string): string {
  // 跳过任何位于 .kata/worktrees/ 之下的候选；记录永远在持有任务的主检出。
}
```

**判据：解析结果不再随文件存在性变化。** 这正是 F1 可利用的漏洞形状——原实现里，往任意目录放一个
`current-state.json` 就能改变「这个任务属于谁」。

### 12.3 为什么这是「拆开」而不是「加标记」

候选 B（在 worktree 写一个 `root.json` 指针）能止血，但它**保留隐式耦合**：解析仍然依赖文件存在性，
只是把被依赖的文件从一个换成另一个。那意味着：

- 新文件本身又要决定「是否进 git」（whitelist 要再加一条）；
- 它仍是「放进目录就能改变归属」的形状，与 F1 同族；
- worktree 里仍有 `.kata/` 内容，与「worktree 只隔离代码」的表述继续含糊。

A 把这两个语义显式分开，让「谁拥有记录」由**任务的存放位置**决定（`recordsRoot`），
让「命令作用于哪个 checkout」由**调用者所在的路径**决定（`resolveCodeRoot`）——两者都不再读文件系统。

### 12.4 调用点（实测，共 1 处真实使用）

```
src/cli.ts:172        resolveWorkspaceRootForTask(requestedChange)   ← 唯一真实调用
src/cli/handoff.ts:26 resolveWorkspaceRootForTask(args.task)           ← 第二处（handoff 命令）
src/cli/tasks.ts:11   import 未使用
src/cli/workflow.ts:26 import 未使用   ← 独立读数 F-minor 已指出
```

拆分后：

- `cli.ts:172` 与 `cli/handoff.ts:26` 都问的是**任务的记录在哪** → 改调 `resolveRecordsRoot`；
- 需要**代码根**的地方（worktree 命令、seal、check 的执行目录）→ 用 `resolveCodeRoot`；
- 两个未使用的 import 删除（`tsc` 的 `noUnusedLocals` 会因此变红，正好当守卫）。

### 12.5 非目标

- **不**恢复那份 `cp`（它产生第二份会被归档删除的记录副本）；
- **不**改 `.gitignore` 的 whitelist 形状（476 文件已实测，方向已定）；
- **不**在本 change 里提交 `.kata/`（那是独立的一步，见 §12.6）。

### 12.6 与清单里其它项的关系

| 项 | 状态 |
|---|---|
| `.gitignore` whitelist + `repository-identity.ts` 收窄 | **已写、未提交** —— 本 change 要提交 |
| F2 `worktree remove` 绕过守卫 | 在本 change 内修（`ops.ts:190` 走 `removeWorktreeSafely`） |
| F3 检测器非递归 | 在本 change 内修（并入 F3 的 252 文件实测为判据） |
| F4 `recoverWorktreeRecords` 无调用者 | 本 change 内**接上调用者**，或删除 |
| F5 `.kata/evidence` 不在 owner 规则内 | 本 change 内修（`evidenceDir` 走 `recordsRoot`） |
| F6 注释失实 | 在本 change 内修（并把 prose 检查扩到 `worktree.ts`） |
| 252 个嵌套层滞留文件 | 用修好的检测器枚举并恢复，作为 AC 的实测判据 |

## 13. 第 2 轮独立读数：裁决 `fail` —— 3 blocking + 7 major + 3 minor

第 2 轮读数（`rev:aad95f7088426ea2`，25/25 digests 逐字节一致）判定本 change **fail**。它复核了第 1 轮 10 条发现的闭合状态，结论是：**真正闭合 3 条（F1/F4/F8/F9 中除残留外），名义闭合 3 条（F3/F6/F7），部分闭合 3 条（F2/F5/F10）**。

三条 blocking 都已由我本人独立复核（不是采信报告）：

### B1 · `kata-cli worktree remove <path>` 在守卫生效的路径上**不可用**

`src/cli/ops.ts:188-208`。`rest` 的第一个裸 token（即 worktree 路径）被 `parseChangeArg` 当成 change id 取走：

```js
const path = rest.find((argument) => !argument.startsWith('--')) ?? argValue(rest, '--path');
const change = parseChangeArg(rest);   // ← rest=['.kata/worktrees/T'] → change='.kata/worktrees/T'
```

`parseChangeArg`（`src/cli/invocation.ts:123-146`）对裸 token 的规则是"第一个未被 `--change` 占用的 token 即 change id" —— 而 `worktree remove` 的位置参数**没有**被排除。于是 `change='.kata/worktrees/T'` ≠ `derived='T'` → 走 mismatch 分支**抛错**。

**实测**：文档形态 `remove <path>` 抛错；只有 `remove --path <p>` 可用。**verb 被自己的守卫挡死**，且 `docs/operations.md:244` 与 `ops.ts:199` 的 Usage 都与实现相反。

### B2 · 守卫按 `taskId` 匹配，而 `taskId` 由 `worktreeOwner` 任取 `tasks[0]`

`src/cli/ops.ts:249-256` `worktreeOwner` 返回 `match.tasks[0]`；`src/workflow/worktree.ts:271` 守卫用 `report.find((entry) => entry.taskId === input.taskId)` 匹配。

**一个 worktree 里有第二个任务时**（B3 的机制会自然制造这种情况），传第一个任务的 `--change` 就能通过守卫，**删掉第二个任务唯一的记录**。实测：`remove two --change aaa --force` → `{"removed":true}`，`zzz/verdicts.json` 消失。

**而 B1 的错误文案正在点名推荐那个错误的值**（"or with `--change aaa` to acknowledge"）。

### B3 · 归档路径的守卫**看错对象**（数据丢失，返回成功）

`src/workflow/worktree.ts:266-274`：

```js
const report = await worktreeOnlyRecords(input.root);
const forThisTask = report.find((entry) => entry.taskId === input.taskId);
if (forThisTask && forThisTask.files.length > 0) { /* refuse */ }
return removeWorktree(input);         // ← 放行
```

守卫**按 `taskId` 匹配，而不是按"正在删的那个 worktree 路径"匹配**。worktree 目录名是 `T`、里面装着 `U` 的记录时，报告中只有 `taskId='U'` 的条目；用 `taskId='T'` 调用 → `find` 得 `undefined` → **放行 → 删掉 `.kata/worktrees/T` → `U` 的唯一记录消失**，而返回值是 `{"removed":true}`。

**这是本 change 存在的理由（保护唯一副本）被它自己的守卫绕过的情形，发生在 `archive` 路径上。**

## 14. 根因（第二轮）：**"记录归属"有四份独立定义**

四条 blocking 不是四类 bug，是**一个**：

| 定义点 | 形状 | 后果 |
|---|---|---|
| `recordsRoot` | 沿祖先找 `.kata/tasks/<id>/` 目录 | 空目录即可夺取归属（F7） |
| `worktreeOnlyRecords` | 只扫 `.kata/worktrees/<dir>`，任务名取**目录名** | `--path` worktree 与 `dir≠task` 形状全盲（F8） |
| `removeWorktreeSafely` | 按 **`taskId`** 匹配 report | 看错对象 → 数据丢失（B3） |
| `worktreeOwner` | `listWorktrees().tasks[0]` | 任取一个 → 用错守护对象（B2） |
| `evidenceDir` | `isUnderLinkedWorktrees(路径形状)` | `--path` worktree 仍是 per-root 第二份（F5 残留） |

**同一个问题 —— "这份记录属于哪个 worktree / 哪个 checkout" —— 有五份答案，五种形状。**

这正是本 change 自己的诊断原话（§10「两个职责被当成一个」）在**它自己身上**重演：`resolveWorkspaceRootForTask` 因为"一个函数承担两个语义"而出错，而修复它的这批代码**又造出了五份语义定义**。

### 为什么枚举式修复必然失败（两轮实测）

| 轮次 | 修复 | 下一轮发现的漏网 |
|---|---|---|
| 1 | 写了 `resolveCodeRoot` | **没有调用者** |
| 1 | 检测器只查 `.kata/tasks/<name>` | 1053 个 evidence 文件不可见 |
| 2 | 把 evidence 纳入检测 | **`--path` worktree 完全不可见**；`tasks[0]` 取错任务 |
| 2 | 守卫自我推导 | **按 `taskId` 而非按路径匹配**；位置参数被当 change |
| 2 | 注释改了一句 | **五处 prose 仍在断言被删掉的 copy-in** |

**"把我要修的地方列出来"这个方法是错的** —— 每一轮都漏掉一个我没有点名的调用者或形状。修复必须**从定义收口**，而不是从调用点枚举。

## 15. 判断：本 change 的 scope 装不下它的根因

本 change 的 5 条 AC 是"加一个检测器、一个守卫、一个恢复命令"。而根因是**归属定义有五份** —— 要修它必须：

1. **一个函数**决定"某 worktree 的记录属于哪个 task / 哪个 owner"（唯一推导）；
2. **五个消费点**全部改为调用它（检测、守卫、恢复、枚举面、evidence 落点）；
3. **守卫按"正在删的路径"匹配**，而不是按调用者给的 `taskId`；
4. **CLI 参数形态**：位置参数不得被 `parseChangeArg` 吞掉；
5. **prose 与代码同源**：五处失效叙述必须清掉，且检查必须覆盖它们。

这是一次**架构级收敛**，不是本 change 的增量。**继续在本 change 内修，等于在错误的层次上打第三个补丁。**

## 16. 本 change 的收尾决定（③）

本 change **收窄到它真正做到的**，并把上述作为下一 change 的输入：

| 项 | 处置 |
|---|---|
| F1 接线 `resolveCodeRoot`（`resolveCommandRoot`） | **保留** —— 第一轮读数已独立确认闭合（真实 git worktree 复现） |
| 递归检测机制 | **保留** —— 递归本身成立（第二轮读数独立复现嵌套路径被报出） |
| evidence 纳入检测面 | **保留** —— 机制成立，但**形状覆盖不全**（归 F8） |
| `worktree recover` 命令 + `skipped` 逐条隔离 | **保留** —— F8 独立确认为闭合 |
| 死 import / 死参数清理 | **保留** |
| `.gitignore` whitelist + identity 收窄 | **保留** |
| 守卫（B1/B2/B3）、归属五份定义、五处 prose | **移出** —— 下一 change |
| AC-1 / AC-4 / AC-5 | **降级** —— 它们断言的正是被移出的部分 |

**未 merge 到 master**，因此三条 blocking 的路径不会被触发。

## 17. 收窄后的账本状态：诚实为 `insufficient`

收窄后本 change 的三条 claim（C1 代码根接线 / C2 检测器递归且覆盖双面 / C3 任务由内容推导 + 恢复隔离）
全部有 `executable_falsifier` 证据并 `supported`（3/3）。而 `ledger decide` 仍是 **`insufficient`**，原因是：

| reason | deficit | 含义 |
|---|---|---|
| `challenge_open` | `challenge:X2` | 一条**能失败在本 change 上**的独立挑战仍失败：守卫按调用者的 `taskId` 匹配而非按删除路径匹配 |
| `discovery_unverified` | `discovery:verified_challenge` | 该挑战尚未记录观测 |

**这是正确的终态，不是失败**：收窄后的 change **只声称它做到的**，而它**没有**修守卫 —— 账本如实反映了这一点。挑战 X2 的复现命令：

```
npx vite-node --config vitest.config.ts tmp/probe-guard-blindspot.mts
  report: [{"taskId":"U","worktree":".kata/worktrees/T","files":["tasks/verdicts.json"]}]
  guard asked with taskId='T': wouldRefuse=false
  the path being removed holds the only copy: true
  → exit 1: the guard matches the caller's task id instead of the path being removed
```

这条挑战的存在是**本 change 与它的下一步之间的接缝**：它把"守卫缺陷仍未修"变成一个可执行、可复现、由机器判定的句子，而不是文档里的一句声明。

守卫缺陷本身的设计在 `docs/design/2026-10-02-record-ownership-single-derivation.md`（AC-2）。

## 18. 终态：verify PASS，账本诚实为 `insufficient`（交接给 ②）

| 项 | 值 |
|---|---|
| revision | `revision-c91a7e52010dce93` |
| 相位 | `hardVerify` |
| verify | **PASS**（`failedAcceptance: 0`，`failedVerifyAcceptance: 0`） |
| 账本 | **`insufficient`** —— `challenge_open` + `discovery_unverified` |
| 挑战 X2 | **复现中（exit 1）**，指向守卫缺陷 |
| 测试 | 218 文件 / 1348 全绿，`tsc` 干净 |

**本 change 不通过审批，这是正确的终态**：它只声称它做到的（代码根接线、递归检测覆盖双面、任务由内容推导 + 恢复隔离），
而它没有修守卫 —— 账本如实反映这一点，并把它变成一条**可执行、可复现、由机器判定**的挑战（X2）。

`X2` 是 ① 与 ② 之间的接缝：② 修好守卫后，这条挑战会自然闭合，① 的账本随之转 `pass`。

### 过程中发现的两条机制缺陷（均在本 change 之外）

**M1 · seal 的沙箱不含声明的全部路径。** `cmdBuild --seal` 在 `/tmp/kata-seal-execution-*/` 里算 digest，
而该副本只含 `src/`、`package.json`、`node_modules`（实测）。于是声明面里的 `docs/**`、`.gitignore`、
`.agents/**` 在沙箱中**不存在**，其 digest 不参与 revision 身份。

**实测的后果**：改动已提交的 `docs/design/*.md` 后，工作区里的 `manifestHash` 变了
（`c7641bda…` vs revision 的 `c786ffcb…`），而 `build --seal` **复用了旧 revision**（`revision-d401d54a1013c630`
的 mtime 停在 11:54，文档提交于 12:02）。随后 `verify` 报 `revision_superseded` 与 3 个失败的 AC —— 因为
`revisionStatus` 用的是工作区哈希，而 seal 用的是沙箱哈希。**同一个问题（"内容变了吗"）在两处各算一次。**

**M2 · 从声明面移除一个已提交路径，被 preflight 判为"未声明的改动"。**
`scope change --remove docs/design/…` 之后 `build --seal` 拒绝：
"The working tree holds 3 change(s) the declared surface does not cover" —— 而这三个文件都已提交、工作树干净。
即**声明面无法通过 `--remove` 收窄**，除非同时改掉那些文件的内容。
