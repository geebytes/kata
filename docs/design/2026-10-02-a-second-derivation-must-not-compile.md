# 让"第二份推导"无法编译

**日期**：2026-10-02
**来源**：`unique-copies-is-one-model` 的独立读数（FAIL，2 blocking + 5 major + 4 minor + 2 note）。
**状态**：设计（未实施）

---

## 1. 四轮，同一个形状

| 轮次 | 我的修复 | 只覆盖了 | 漏掉 |
|---|---|---|---|
| ① 第一轮 | 写 `resolveCodeRoot` | 函数定义 | 调用者（0 个） |
| ① 第二轮 | 检测器加 evidence 面 | 一个目录 | 1053 个 evidence 文件 |
| ② 第三轮 | 检测器 union `git worktree list` | root **内**的 `--path` | root **外**的 |
| ② 第四轮 | `hasTaskDir` 从文件改目录 | 判据的形状 | **仍是存在性判据** |
| ③ 第五轮 | 建 `uniqueCopies` 模型 | 2 处消费点 | **5 份推导仍在，含守卫** |

**第五轮最刺眼**：`src/workflow/worktree.ts` **同一个文件里有两份** —— `:184` 的 `recover` 用 `uniqueCopies`（新），`:291` 的守卫用 `worktreeOnlyRecords`（旧且更瞎）。**我写了两份，只接了其中一份。**

**结论：枚举调用点不可收敛。** 每一轮的形状集合都比枚举出来的大。

## 2. 为什么类型能收敛，而枚举不能

枚举**调用点**：集合是"谁调用了 X"，这是**语义问题** —— 我数不全（第五轮的 `worktreeOnlyRecords` 是一个**独立实现**，不是调用点）。
枚举**字面量**：集合是"哪里有 `.kata/tasks`"，这是**语法问题** —— 可判定，可机械检查。

**但字面量还不够。** F1 的 `worktreeOnlyRecords` 里**没有** `.kata/tasks` 字面量（它用 `kataDir(root)`、`join('.kata','worktrees',…)`、`surface` 拼），却是彻底的第二份实现。

**所以要两层：**
- **字面量层**：`.kata/tasks` 不得出现在收口文件之外 —— 挡住"再拼一次"
- **类型层**：记录位置只能由**收口函数**产出，挡住"逻辑上的第二份"

## 3. 设计

### 3.1 已有的收口点（复用，不新建）

`src/core/layout.ts` **已有 16 个路径函数**，14 个走 `recordsRoot`/`taskDir`：

```
taskPath · currentStatePath · stateEventsPath · transitionLockPath
reviewPath · judgePath · verifyPath · repairPath · scopeChangesPath · wikiClosurePath …
```

**它们已经是唯一入口。** 缺的是**强制力**。

### 3.2 类型层：一个 brand

```ts
/**
 * A path that names a task's records, produced only by `layout.ts`'s accessors.
 *
 * **Not `string`.** The brand exists so a second derivation cannot be written: a function that wants to read or write a
 * task's records has to accept this type, and the only way to obtain a value of it is to call an accessor — which goes
 * through `recordsRoot`. A caller holding a plain `string` cannot construct one, so "I assembled the path myself" stops
 * being expressible rather than being caught in review.
 */
declare const recordsPathBrand: unique symbol;
export type RecordsPath = string & { readonly [recordsPathBrand]: true };
```

**读写的收口**（`readJson`/`writeJson` 的任务记录版本）：

```ts
export function taskPath(root: string, taskId: string): RecordsPath;      // 16 个访问器都返回它
export async function readRecord<T>(path: RecordsPath): Promise<T | null>; // 只接受它
export async function writeRecord(path: RecordsPath, value: unknown): Promise<void>;
```

**效果**：`worktreeOnlyRecords` 里那种"自己拼一条路径然后读"**编译不过** —— 它没有 `RecordsPath`。

### 3.3 字面量层：一条可判定的检查

```ts
// 任意 src/**/*.ts（layout.ts 自身与注释除外）出现 `.kata/tasks` 字面量 → 失败
```

**理由**：字面量层挡不住逻辑重复（F1），但**挡得住"又一个拼接"**，而那是 30 处里最容易复发的一半。两层各挡一半，且都不是枚举调用点。

### 3.4 判据共用（F2）

`hasTaskDir` 数**目录项**，模型的 `recordFilesOf` 数**文件** —— 两个判据。**抽成一个**：

```ts
/** Whether a checkout holds a task's records — the one judgement. */
export async function holdsRecords(checkout: string, taskId: string): Promise<boolean>;
```

`hasTaskDir`（同步）、`recordOwner`、`uniqueCopies` **全部调用它**。

### 3.5 一处实现，不是两处（F1）

`worktreeOnlyRecords` **删除**，`removeWorktreeSafely` 改用 `uniqueCopies`。

**而类型层保证它不能被重新写出来** —— 这正是 3.2 存在的理由（否则下一次我还会写第二份）。

### 3.6 fail-closed 要可达（F3/F4）

- `gitWorktreeList` 的 `!result.ok → []` 改为**区分**"git 不可用"与"没有 worktree"（返回 outcome 而非数组）
- `filesUnder`/`taskIdsWithRecords` 的 `catch { return }` 改为**传播不可读**（只有 ENOENT 是"没有"）

**这条的依据**：本 change 的 `UniqueCopiesUndetermined` **在被点名的一条路径上存在，在真实的三条路径上都不可达** —— 一个"写了但到不了"的判据。

### 3.7 其余 finding

| finding | 处理 |
|---|---|
| F5 守卫不去重 | 守卫改用 `uniqueCopies`（3.5 已含） |
| F6 归档吞 `undetermined` | `.catch(() => undefined)` → **拒绝归档并说明** |
| F7 `tasksInWorktree` 用 `current-state.json`；`tasks[0]` | 改走 `holdsRecords`；删除 `tasks[0]` 取法 |
| F8 `foundNothing` 含 skipped | 区分 `foundNothing` 与 `movedNothing` |
| F9/F10 测试只驱动模型 | 每条 AC 的 case **必须驱动消费者**（互相比对），不只驱动模型 |
| F11 非 git 嵌套 worktrees | 枚举统一走一个函数 |
| F12 未用导入 + 注释与代码相反 | 修 |
| F13 E7 变异打错地方 | 变异对准"顺序无关"那一行 |

## 4. 验收判据（草案）

| AC | 判据 | 可执行验证 |
|---|---|---|
| AC-1 | **类型层**：第二份记录路径推导**无法编译** | 在 `src/` 加一个"自建并读取任务记录"的文件 → `tsc` 必须报错 |
| AC-2 | **字面量层**：`src/**`（收口文件除外）无 `.kata/tasks` 字面量 | 一条检查（注释与 `layout.ts` 白名单） |
| AC-3 | **一处实现**：`worktreeOnlyRecords` 不存在；守卫与 recover 用同一个函数 | 删掉它后守卫的用例仍绿，且 `grep` 无第二实现 |
| AC-4 | **一个判据**：`holdsRecords` 是唯一回答"是否持有"的函数 | 空子目录与空目录都不授予；样例文件也不授予 |
| AC-5 | **fail-closed 可达**：git 不可用、worktree 内容不可读 **各一条**都会抛错 | 两条真实的失败注入 |
| AC-6 | **归档不吞**：模型不可答时归档**拒绝**并说明 | 注入 undetermined → 归档 `success: false` + 理由 |
| AC-7 | **AC 的证据驱动消费者**：每条 AC 的 case 至少驱动两个消费者并比对 | 一条测试统计每个 case 驱动的函数名 |

## 5. 成本（已测）

| 项 | 数量 |
|---|---|
| 直接拼接 `.kata/tasks` | 68 处 / 18 文件 |
| `join(root, '.kata', …)` 形态 | 7 处 |
| `` `.kata/tasks/${id}/…` `` 模板形态 | 23 处 |
| 已有收口函数 | 16 个（14 个已走 `recordsRoot`） |
| 需要改的调用点 | **约 30 处** |
| 需要改的签名 | **16 个访问器** + 读写收口 2 个 |

**不是大重构**：收口点已存在，缺的是强制力。

## 6. 与前三轮的关系

前三轮是**修实例**；本轮是**关掉类**。**若本轮又漏**，其证据将是"类型层挡住了 A 却漏了 B" —— 那是一个**可判定的缺口**，而不是"我又数漏了一个调用者"。

**这是我认为它能收敛的、唯一的理由。**
