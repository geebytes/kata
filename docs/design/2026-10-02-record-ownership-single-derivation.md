# 记录归属的单一推导

**日期**：2026-10-02
**来源**：`task-records-outlive-the-worktree` 在第 2 轮独立读数中 fail（3 blocking + 7 major），根因分析见
`docs/design/2026-10-01-task-records-die-with-the-worktree.md` §13–§15。
**状态**：设计（未实施）

---

## 1. 现象

两轮"一次性修完"之后，缺陷在同一个地方重新长出来，而且第二轮出现了三条 blocking —— 其中一条在 `archive`
路径上删掉唯一记录却返回成功。

四条 blocking 复现（均由作者独立复核，非采信报告）：

| # | 复现 | 结果 |
|---|---|---|
| B1 | `kata-cli worktree remove <path>`（文档形态） | **抛错** —— 位置参数被 `parseChangeArg` 当成 change id；只有 `--path` 拼写可用 |
| B2 | `kata-cli worktree remove two --change aaa --force`（worktree 内有 aaa/zzz 两个任务） | `{"removed":true}` —— **`zzz/verdicts.json` 消失** |
| B3 | archive 路径，worktree 目录名 `T`、内装 `U` 的记录，用 `taskId='T'` 调用守卫 | `{"removed":true}` —— **`U` 的唯一记录消失** |
| major | `resolveCodeRoot` 对 `--path` 建的 worktree；detector 对该 worktree | 前者正确，**后者返回 `[]`** |

## 2. 根因

**"某 worktree 的记录属于哪个 task / 哪个 checkout" 有五份独立定义、五种形状。**

| 定义点 | 形状 | 后果 |
|---|---|---|
| `recordsRoot`（`core/layout.ts`） | 沿祖先找 `.kata/tasks/<id>/` **目录** | 空目录即可夺取归属（比原来只需写一个文件更便宜） |
| `worktreeOnlyRecords`（`core/layout.ts`） | 只扫 `.kata/worktrees/<dir>`，任务名取**目录名** | `--path` worktree、`dir≠task` 形状全盲 |
| `removeWorktreeSafely`（`workflow/worktree.ts`） | 按调用者给的 **`taskId`** 匹配 report | **看错对象 → 数据丢失（B3）** |
| `worktreeOwner`（`cli/ops.ts`） | `listWorktrees().tasks[0]` | **任取一个 → 用错守护对象（B2）** |
| `evidenceDir`（`core/layout.ts`） | `isUnderLinkedWorktrees(路径形状)` | `--path` worktree 仍是 per-root 第二份 |

### 为什么枚举式修复必然失败（两轮实测）

| 轮次 | 修复 | 下一轮发现的漏网 |
|---|---|---|
| 1 | 写了 `resolveCodeRoot` | **没有调用者**（0 生产调用点） |
| 1 | 检测器只查 `.kata/tasks/<name>` | 1053 个 evidence 文件不可见 |
| 2 | 把 evidence 纳入检测 | **`--path` worktree 完全不可见**；`tasks[0]` 取错任务 |
| 2 | 守卫自我推导 | **按 `taskId` 而非按删除路径匹配**；位置参数被当 change |
| 2 | 注释改了一句 | **五处 prose 仍在断言被删掉的 copy-in** |

**"把要修的地方列出来"这个方法是错的** —— 每一轮漏掉一个未被点名的调用者或形状。

## 3. 设计

### 3.1 一个函数：`recordOwner`

```ts
/** 一份记录（路径或任务 id）的 owner —— 唯一的归属推导。 */
export interface RecordOwnership {
    /** 持有该记录的 checkout 的根。 */
    ownerRoot: string;
    /** 该记录所属的 task id（当路径携带它时）。 */
    taskId: string | undefined;
    /** 该记录所在的 worktree 根（当路径在一个 worktree 内时）。 */
    worktreeRoot: string | undefined;
}

export function recordOwner(input: { root: string; path?: string; taskId?: string }): RecordOwnership;
```

**判据（三档，写下来而非隐含）**：

1. **路径形状**决定 worktree：一份路径若在某 worktree 内，`worktreeRoot` 即该 worktree；
2. **task id 从路径推导**，不从目录名猜：worktree 内的 `tasks/<id>/` 目录名即 id（`--path` 形状也适用）；
3. **owner 是最近的、持有该 task 的 checkout**，且**不是** `.kata/worktrees/` 下的任何一个。

### 3.2 五个消费点全部改为调用它

| 消费点 | 现在 | 改为 |
|---|---|---|
| `recordsRoot` | 自推导 | `recordOwner(...).ownerRoot` |
| `worktreeOnlyRecords` | 自推导（目录名 + 路径前缀） | 枚举所有 worktree，对每个问 `recordOwner` |
| `removeWorktreeSafely` | 按 `taskId` 匹配 | **按删除路径匹配**（`recordOwner({path})`） |
| `worktreeOwner` | `tasks[0]` | 删除该函数；守卫自己问 |
| `evidenceDir` | `isUnderLinkedWorktrees` | `recordOwner(...).ownerRoot` |
| 枚举面（`listTaskCandidates` 等） | `tasksDir(调用者 root)` | `recordOwner` |

### 3.3 守卫按路径，不按调用者给的 id

`removeWorktreeSafely` 的判定必须能回答"**我要删的这个 worktree 里，有没有只存在于这里的记录**"：

```ts
const stranded = await worktreeOnlyRecordsForPath(input.root, input.path);
if (stranded.length > 0) { /* refuse, naming them */ }
```

`taskId` **不再是守卫的输入** —— 它是调用者的说法，而守卫要判定的是路径的事实。这也顺带消灭 B2（`tasks[0]` 无从参与）。

### 3.4 CLI 参数形态

位置参数不得被 `parseChangeArg` 吞掉。两条候选：

- **(a) 声明式**：给每个子命令一个"位置参数个数"，`parseChangeArg` 跳过它们；
- **(b) 结构式**：`worktree remove` 只接受 `--path <p>`，位置形态从 Usage 与文档中移除。

**倾向 (a)** —— 因为 `remove <path>` 是已在文档里承诺的形态，移除它等于改契约；而 (a) 让"哪些 token 是值"这件事有一个显式表，与 `VALUE_FLAGS` 同源。

### 3.5 prose 与代码同源

五处失效叙述必须清掉，且**检查必须覆盖它们**：

| 位置 | 现在说的 | 事实 |
|---|---|---|
| `workflow/worktree.ts:17` | "the task's own state, copied in when it is not already present" | cp 已删 |
| `cli.ts:483` | "carries the task's state into the checkout" | 同上 |
| `cli/ops.ts:86` | 同上 | 同上 |
| `docs/operations.md:250-254` | "state is tracked…copied in"；"nearest owner wins" | 两个都被推翻 |
| `core/layout.ts:558` | "resolveWorkspaceRootForTask prefers the nearest owner … worktree.test.ts pins that" | 同一个 change 把那个用例改成了反面 |

**检查方式**：不是 grep 单个字符串，而是**从代码事实生成断言集** —— 例如"凡声称 copy-in 的叙述，其对应的 `taskStateCopied` 字段必须仍存在且可为真"。这与本 change 反复出现的"prose 检查只覆盖我改过的那句"是同一个问题。

## 4. 验收判据（草案）

| AC | 判据 | 可执行验证 |
|---|---|---|
| AC-1 | **归属只有一份推导**：`recordOwner` 是唯一的归属函数；`recordsRoot`/`worktreeOnlyRecords`/`removeWorktreeSafely`/`evidenceDir` 全部调用它（`grep` 断言无第二份） | 一条测试驱动五条路径，断言同一路径得到同一 owner |
| AC-2 | **守卫按路径判定**：worktree 目录名 ≠ 任务 id、且内含他人记录时，**拒绝**并点名（B3 的复现命令必须变红） | 驱动真实 `archive` 路径 |
| AC-3 | **CLI 形态可用**：`worktree remove <path>` 不再抛错（B1 的复现命令必须成功或按事实拒绝） | 驱动 `runWorktreeCommand`，两种拼写各一次 |
| AC-4 | **归属不由存在性授予**：空目录不夺取归属；`--path` worktree 被检测器看见 | 构造两个形状各一条 |
| AC-5 | **prose 检查从代码生成**：五处叙述的断言由对应字段派生，删掉字段即红 | 变异验证 |

## 5. 与清单的关系

| 项 | 状态 |
|---|---|
| `task-records-outlive-the-worktree` | 收窄收尾（保留 F1 接线、递归检测、evidence 纳入、`skipped` 隔离、死代码清理） |
| 本设计 | **待开 change** |
| 三条 blocking（B1/B2/B3） | 本设计的 AC-2/AC-3 |
| 五份归属定义 | 本设计的 AC-1 |

## 8. 第一轮独立读数：**FAIL** —— 10 条 finding，全部复核成立

读数用一个**我没想到的方法**：它把 ① 的冻结 revision 用 `git archive d5c1adf` 还原到 `/tmp/probe3/d5tree/` **再独立跑** ——
因为工作区已被 ② 改写，在工作区上跑 ① 的挑战必然 exit 0，那个绿灯什么也不证明。

### 我亲自复核的三条

| finding | 复核命令与输出 | 判断 |
|---|---|---|
| **F5 · blocking** | `if (relativePath !== '' && !relativePath.startsWith('..'))` —— **把 root 之外的 worktree 全部丢弃** | ✅ 成立 |
| **F4 · C4 被证伪** | `mkdir -p vendor/copy/.kata/tasks/held`（**空目录，不写任何文件**）→ `recordsRoot` = `<P>/vendor/copy`，`taskDir` 也搬过去 | ✅ 成立 |
| **F1 · blocking** | 归档用 `join(worktreesDir(root), taskId)` 选对象 —— **只看 `<taskId>` 命名的目录**，所以目录名 ≠ 任务时归档根本不去看它 | ✅ 成立 |

### 完整清单

- **F1 · blocking** —— 归档路径仍会删掉唯一副本并返回成功（`orchestrator.ts:2300-2311` 的选择器与守卫同源，因此选错对象）
- **F2 · major** —— `--change` 在 argv 层被静默丢弃（位置参数**在 flag 之前**时）
- **F3 · major** —— 位置参数形态**依赖位置**：`--root` 写在路径之后就整条失效
- **F4 · major → C4 refute** —— "归属不由文件授予"是假的：判据仍是存在性，只是从文件降级成目录（**比原来更便宜**）；测试名 `an empty directory is not an owner` 名不副实（它问的是**不存在**的任务目录）
- **F5 · blocking** —— `worktreeOnlyRecords` 看不见 root 之外的 worktree，`45a6535` 的修复**只覆盖了被点名的那一种**
- **F6 · major** —— `worktree recover` 在什么都没恢复时报"成功"（`movedCount: 0`，对任意 `--change` 值都如此）
- **F7 · major** —— 两个 worktree 持有同一任务时**重复计数**；恢复的 owner-wins 静默覆盖另一个 worktree 已搬的那份
- **F8 · major** —— 守卫按路径判定后，"删的是什么"与"报告说删的是什么"**解耦**：报告抱怨 B，实际动作把 A 的副本也带走了
- **F9 · major** —— 检测器**总体 fail-open**：`gitWorktreeList` 失败返回 `[]`、root 外候选被丢 —— 两种失败方向都产**空集**，而空集恰好是"没有记录会丢"的答案
- **F10 · note** —— 无界目录遍历（每个 worktree × 每个 surface 各一次全树 walk）

### 读数指出的、我漏掉的根本问题

> **① 的 verify/review 绑 `revision-c91a7e52`，而那个 revision 的守卫是坏的。**
> **守卫是 ② 修的，② 的改动在 `revision-0ce95c74`。**

**① 的"收窄后 honest"状态 —— verify PASS + 账本 `pass` —— 是在一个守卫仍然坏的 revision 上取得的。**
我在 ② 修好守卫后把 ① 也 re-seal 了，但**没有重新验证 ① 的挑战 X2**，所以 ① 的 `pass` 建立在旧读数上。

## 9. 根因：这不是 10 个缺陷，是一个缺失的模型

三次修复，同一个形状：

| 轮次 | 我的修复 | 只覆盖了 | 漏掉 |
|---|---|---|---|
| ① 第一轮 | 写了 `resolveCodeRoot` | 函数定义 | **调用者（0 个）** |
| ① 第二轮 | 检测器加 evidence 面 | `.kata/tasks/<name>` 一个目录 | 1053 个 evidence 文件 |
| ② 第三轮 | 检测器 union `git worktree list` | root **内**的 `--path` | **root 外**的（`!startsWith('..')`） |
| ② 第四轮 | `hasTaskDir` 从文件改目录 | 判据的形状 | **仍是存在性判据** |

**"哪里有唯一副本"这个问题在三处各自回答**：

| 消费点 | 它的判据 |
|---|---|
| `worktreeOnlyRecords` 的枚举 | `git worktree list` ∪ `.kata/worktrees/`，且丢弃 root 外的 |
| `hasTaskDir` / `findOwningCheckout` | `accessSync` 存在性 |
| 归档的选择器 | `join(worktreesDir(root), taskId)` |

**三处各自推导 → 三处各自可以错 → 每次修一处，下一轮找到另一处。** 这与 ② 自己的设计文档 §2 论证过的根因**完全同形** —— 而 ② 在检测器上又犯了一次。

## 10. 决定：停止迭代，合并为架构级 change

**理由**：F1/F4/F5 不是三个 bug，是**同一个模型缺失的三个表现**。修形状无法收敛 —— 前两次证明过，这一次又证明了。

**下一步 change 的范围**（待开）：

- **一个模型**：`uniqueCopiesOf(root) → { path, taskId, worktreeRoot, uniqueTo[] }` —— 回答"哪些记录只在某处存在"的**唯一**推导
- 三处消费点（检测器枚举、`hasTaskDir` 的判据、归档的选择器）**全部经由它**
- **fail-closed**：枚举来源（git、目录）任一失败**不是空集**，而是"无法判定"→ 拒绝归档（F9）
- **跨 worktree 去重**（F7），计数与恢复都以去重后的集合为准
- **归档按"哪些 worktree 持有本任务的唯一副本"选对象**，而不是按目录名（F1/F8）
- 位置参数的**位置无关**解析（F2/F3）
- `worktree recover` 的零结果**不是成功**（F6）

**在它落地之前，两个 change 都停在 FAIL，不 merge。**
