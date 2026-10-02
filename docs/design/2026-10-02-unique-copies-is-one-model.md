# 唯一副本是一个模型，不是若干处存在性判据

**日期**：2026-10-02
**来源**：`task-records-outlive-the-worktree` 与 `record-ownership-single-derivation` 的第一轮独立读数（两条 FAIL，
10 条 finding），根因分析见 `docs/design/2026-10-02-record-ownership-single-derivation.md` §8–§10。
**状态**：设计（未实施）

---

## 1. 三处各自回答同一个问题

**"哪些记录只存在于某处（因此删掉那个地方会丢东西）"** 有三个答案：

| 消费点 | 它的判据 | 已测出的失败 |
|---|---|---|
| `worktreeOnlyRecords` 的枚举 | `git worktree list` ∪ `.kata/worktrees/`，丢弃 root 外的候选 | root **之外**的 `--path` worktree 不可见 → 空集 → 守卫放行 |
| `hasTaskDir` / `findOwningCheckout` | `accessSync(join(root,'.kata','tasks',id))` 存在性 | **空目录**即可夺取归属（比原来只需写一个文件更便宜） |
| 归档的选择器 | `join(worktreesDir(root), taskId)` | 目录名 ≠ 任务时**根本不去看那个 worktree**；守卫还没被调用 |

**三处各自推导 → 三处各自可以错。** 每次修一处，下一轮找到另一处：这正是两个 change 花了四轮修出来的结果。

## 2. 四次修复，同一个形状

| 轮次 | 修复 | 只覆盖了 | 漏掉 |
|---|---|---|---|
| ① 第一轮 | 写了 `resolveCodeRoot` | 函数定义 | **调用者（0 个）** |
| ① 第二轮 | 检测器加 evidence 面 | `.kata/tasks/<name>` 一个目录 | 1053 个 evidence 文件 |
| ② 第三轮 | 检测器 union `git worktree list` | root **内**的 `--path` | **root 外**的 |
| ② 第四轮 | `hasTaskDir` 从文件改目录 | 判据的**形状** | 仍是**存在性判据** |

**这不是勤奋能补的**：形状的集合比枚举出来的大。**唯一能收敛的改动是让这个问题只有一个答案。**

## 3. 设计

### 3.1 一个模型

```ts
/** 一份记录只存在于某处 —— 删掉那个地方就会丢东西。 */
export interface UniqueCopy {
    /** 该记录相对于仓库根的路径。 */
    path: string;
    /** 它所属的任务。 */
    taskId: string;
    /** 它所在的工作树（当它在某个工作树内时）。 */
    worktreeRoot: string | undefined;
    /** 它所在的工作树的根，相对仓库根。 */
    worktreeRelative: string | undefined;
}

/**
 * 哪些记录只在某处存在 —— **唯一的推导**。
 *
 * 失败不是空集：来源不可答（git 失败、路径不可达）时抛错，因为"看不见"与"没有"必须是两个不同的答案。
 */
export async function uniqueCopies(input: {
    root: string;
    /** 限定到某个任务；省略时覆盖所有任务。 */
    taskId?: string;
}): Promise<UniqueCopy[]>;
```

**三个判据全部在模型内**：

1. **枚举**：`git worktree list` ∪ `.kata/worktrees/`，**包含 root 之外的**（用绝对路径，不做 `startsWith('..')` 过滤）
2. **归属**：一个任务目录的**内容**决定它是否持有记录（至少一个记录文件），而不是"目录是否存在"—— 空目录不授予归属
3. **唯一性**：跨所有工作树**去重**，一个 `(taskId, path)` 只在**所有**持有者中的记录完全一致时才算"不唯一"

### 3.2 三处消费点全部经由它

| 消费点 | 现在 | 改为 |
|---|---|---|
| `worktreeOnlyRecords` | 自建枚举 + 自建比较 | `uniqueCopies({root})` |
| `hasTaskDir` / `findOwningCheckout` | `accessSync` 存在性 | 问模型"这个 checkout 持有该任务的记录吗" |
| 归档的选择器 | `join(worktreesDir(root), taskId)` | `uniqueCopies({root, taskId})` 得到的 `worktreeRelative` 集合 |
| `worktree recover` | 自建 filter | `uniqueCopies({root, taskId})` |

### 3.3 fail-closed

`git worktree list` 失败、目录不可读、路径不可达 —— **任一来源不可答时抛错**，而不是返回空集。

**理由**：空集恰好是"没有记录会丢"的答案，而调用者（归档）无法区分"真的没有"与"看不见"。当前实现两种失败方向都产空集（F9）。

### 3.4 归档按"哪些工作树持有本任务的唯一副本"选对象

`orchestrator.ts:2300` 的 `join(worktreesDir(root), taskId)` **只看一个目录**。改为模型给出的集合：
**任何一个持有本任务唯一副本的工作树都不删**，而不是"名字对得上的那个"。

这同时消灭 F1（选错对象）与 F8（报告与动作解耦）。

### 3.5 位置参数与 flag 位置无关

`--change` / `--root` 的读取必须与位置参数**无关于顺序**：先扫出所有 `--flag value` 对与其内联形式，剩下的裸 token 才是位置参数。

（当前 `parseChangeArg` 会把 flag 之前的位置参数吞成 change id；`--root` 写在路径之后整条失效。）

## 4. 验收判据（草案）

| AC | 判据 | 可执行验证 |
|---|---|---|
| AC-1 | **唯一推导**：`uniqueCopies` 是唯一回答"只在哪里存在"的函数；三处消费点全部调用它（`grep` 无第二份判据） | 一条测试驱动三处，断言同一仓库得到同一集合 |
| AC-2 | **包含 root 之外的 worktree**：`git worktree add /tmp/outside` 建的 checkout 被枚举到 | 真 git worktree，路径在仓库外 |
| AC-3 | **空目录不授予归属**：`mkdir -p <任意目录>/.kata/tasks/<T>`（不写文件）**不**夺取归属 | 复现 F4 的命令必须不再劫持 |
| AC-4 | **fail-closed**：git 不可答 / 目录不可读时**抛错**，不返回空集 | 非 git 目录 / 模拟失败各一条 |
| AC-5 | **跨工作树去重**：两个工作树持有同一任务时，同一条记录只算一次 | 复现 F7 的命令 |
| AC-6 | **归档按唯一副本选对象**：目录名 ≠ 任务时，归档**不去删**那个持有唯一副本的工作树 | 复现 F1 的命令必须不再删 |
| AC-7 | **位置与顺序无关**：`--change`/`--root` 在位置参数之前或之后行为一致 | 复现 F2/F3 的命令 |
| AC-8 | **零结果不是成功**：`worktree recover` 什么都没恢复时必须报告"未找到"，不是 `movedCount: 0` 的成功 | 复现 F6 的命令 |

## 5. 与前两个 change 的关系

| 项 | 状态 |
|---|---|
| `task-records-outlive-the-worktree` | **FAIL，停在 review**，不 merge；它建立的（代码根接线、递归检测、evidence 面、恢复隔离）保留 |
| `record-ownership-single-derivation` | **FAIL，停在 review**，不 merge；它建立的（`recordOwner`、守卫按路径判定、CLI 位置参数形态）保留 |
| 本设计 | **待开 change** |
| 10 条 finding | 本设计的 AC-2…AC-8 |
| 三次修复的历史 | 本设计 §2 |

**两个 change 的代码在 master 上**（`current_worktree` 模式），但它们的**账本与裁决都是 FAIL** —— 记录如实。
