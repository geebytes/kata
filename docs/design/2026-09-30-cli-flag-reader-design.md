# CLI 取值读取的类级收口（follow-up 设计）

**状态**：已记录，未实施。由 `security-tier-platform-boundary` 第 4–7 轮读数累积而成。
**触发**：该 change 的主题（assurance 平台边界）连续七轮未被证伪，而它在 `src/cli/**` 的参数解析上耗掉了四轮修复；被反复证伪的是**我用文本扫描守卫去关闭一个语法类**这件事。

## 1. 现象

四轮的守卫形状数与发现数：

| 轮 | 守卫覆盖的形状 | 该轮发现 |
|---|---|---|
| 4 | 2 条规则（**实为死代码**：守卫先清空引号内容，再找以引号开头的模式） | 13（含"已修"实为未修） |
| 5 | 4 | 10（含"已扫净"实为漏 21 处） |
| 6 | 5（加谓词遍历） | 7（扩的那一档自身漏了 `.slice().some()`） |
| 7 | 5 | 5（含活实例 + **11 种实测绕过**） |

第 7 轮实测守卫看不见的写法（**第 8 轮又补了 3 种**：`argv.slice(...)` 在前再接谓词遍历——第 7 轮在 `invocation.ts` 里找到的活实例就是这个；谓词遍历里的 flag 是**模板**（`` t => t === `${flag}=` ``）；局部数组上的 `rest.includes('--all')`）：`argv.at(i+1)`、`argv.reduce`、`[...argv]` 别名、`for…of argv.entries()`、`argv.join().includes('--x')`、从 `VALUE_FLAGS[0]` 取 flag、`argv.flatMap`、`process.argv` 别名、`` `--${name}` `` 模板、**跨行的 `argv\n.indexOf('--x')`**、**跨行的 `argv.some(\n… === '--x')`**。

**这不是不够仔细，而是方法本身的性质**：文本扫描在**枚举写法**，而写法是无穷的。每扩一档，下一轮就读出"扩的那一档没写对"或"还有第 N+1 种"。

## 2. 目标

让"读取一个 CLI 取值"在 `src/cli/**` 里只有**一种可表达的写法**，且**绕过它无法通过编译**（而不是让扫描守卫变红）。

## 3. 设计方向（候选）

- **A · 不把 `argv` 交给 parser。** CLI 入口解析一次，构造一个 `Flags` 值：`Flags.of(argv)`，并暴露 `value(name): string | undefined` / `present(name): boolean` / `values(name): string[]` / `switch(name): boolean`。所有 parser 只接 `Flags`，**不接 `string[]`**——于是 `argv[i+1]` 这类写法根本写不出来（没有 argv 可索引）。
- **B · 类型层面的约束。** 保留 `string[]`，但用一个 branded 类型（`type RawArgv = string[] & { __raw: unique symbol }`）让直接索引需要显式转换，转换点集中在一处并被 review。
- **C · 保留扫描，但把范围与形状写成事实。** 即当前状态：**强近似**，声明等于覆盖，且**不为它写"已关闭"的结论**（本轮已做）。

**建议 A**：它把"两种拼写等价 / 缺失与空值是两事实 / flag 不吞下一枚 flag"从**需要在每处记得写**变成**写法上只有一种**。B 依赖纪律（一次转换即可绕过）；C 已经被四轮证明不能收敛。

## 4. 范围

- `src/cli.ts` + `src/cli/**`（含当前被守卫跳过的 `invocation.ts` 自身）
- **`src/policy/guard-script.ts`**（生成的 hook 里有同类手写查找，第 7 轮 F-3）
- 开关类语义统一（`switchPresent` 已是唯一入口，需核查是否还有 `argv.includes('--x')` 的等价物）
- 每个 parser 的行为用例：**分支逐一覆盖**（第 6 轮 F-2 的教训——我修了五个分支里的三个，而用例只测了一个的顺序）

## 5. 判别式

**不要**用"扫描守卫的用例变红"作为验收证据（它只能证明扫描器认得这个形状）。验收应当是**行为断言**：对每个 parser、每个取值 flag、每种拼写、每种空值形态，断言解析结果；并用**变异**证明断言承重。

## 6. 与当前 change 的关系

本 change（`security-tier-platform-boundary`）的主题是 assurance 平台边界，其 AC-1…AC-6 在七轮里**未被证伪**。CLI 参数解析不属于它的主题，第 4–7 轮的发现里 **6 条在该 change 之前就存在**。因此本 change 以其声明的主题收口，本文档承接其余。


## 7. 从 `security-tier-platform-boundary` 第 8 轮带出来的其余项

| 项 | 站点 | 事实 |
|---|---|---|
| 开关类的**存在性**读取仍有手写形态 | `src/cli/wiki.ts:105`（`rest.includes('--all')`）、`src/cli/scope.ts:92`（`--allow-ownership-conflicts`）、`src/cli/ops.ts:190`（`--force`） | 只读"有没有给"，不吞下一枚 flag，因此**未造成**静默改行为；但同一个问题（一个开关两种拼写）仍有两套语义。`switchPresent` 已存在，应统一 |
| `src/cli/**` 之外的同形取值读取 | `src/policy/guard-script.ts:49-50`（`process.argv.indexOf(name)` + 无守卫的 `argv[index+1]`） | **会吞下一枚 flag**；flag 固定为 `--project-root` 故实际影响有限，但仍在扫描范围外 |

### 7.1 拒绝措辞的规则（由第 8 轮 F-1 带出）

`ledger policy --set-file` 用 `!isCurrentAssuranceLevel` 作判据，于是**未知值**也得到"historical only"这句话。正确规则：**只有 `LEGACY_ASSURANCE_LEVELS` 里的是"历史值"，其余未知值交给 schema 说 `must be one of …`**。同一形状在该 change 里出现过五次（`writePolicy`、`decide`、CLI 三站点、措辞），修法是让"这是什么值"只有一个判据、一处文案。
