# 工作区根替换只认「指向仓库内的路径」

**日期**：2026-10-11 ｜ **来源**：`docs/superpowers/reports/2026-10-10-workspace-root-substitution-corrupts-check-arguments.md`（zenmpai 会话反馈）
**profile**：`current_worktree / tdd / strict`（不改门禁强度；它只改判据参数被改坏这一处）

---

## 1. 核实结论（在 `git archive HEAD` 的副本里独立复现，未改本仓 `src/`）

`checksForExecutionSandbox` 把作者根替换成沙箱根时，用的是**子串替换**：

```
src/workflow/execution-sandbox.ts:163
function rewriteAuthorReference(value: string, authorRoot: string, sandboxRoot: string): string {
  return value.replaceAll(authorRoot, sandboxRoot);
}
```

以 `authorRoot = '/app'` 实测（副本内跑 `checksForExecutionSandbox`）：

| 传入的参数 | 实际执行 | 判定 |
|---|---|---|
| `tests/application` | `tests/tmp/kata-seal-execution-KdZIU3lication` | **坏**（`/app` 是 `application` 的前缀） |
| `packages/x/src/x/application` | `packages/x/src/x/tmp/kata-seal-execution-KdZIU3lication` | **坏** |
| `/app/tests/support` | `/tmp/kata-seal-execution-KdZIU3/tests/support` | 好 |
| `/app` | `/tmp/kata-seal-execution-KdZIU3` | 好 |
| `cwd`（`/app`） | `/tmp/kata-seal-execution-KdZIU3` | 好 |

⇒ 报告成立，且**同一文件里已经有正确的做法**：旁边的 `mapRepositoryPath`（`:157`）用 `relative`/`resolve` 做**前缀**判定，只有 `cwd` 用了它。**同一个问题（"这个字符串指向仓库里吗"）在一处文件里有两套处理，其中一套是错的。**

**报告里已满足的一条**：证据日志记录的就是**实际执行**的参数（`runBoundedCommand` 用 `check.execution ?? …`，日志由同一份数据渲染，`evidence.ts:619-625`（`runBoundedCommand` 的 `check.execution ?? {…}`，日志记下的是**实际执行**的参数；`:688` 的 `renderCommand` 渲染的是**计划**里声明的命令）），所以被改坏的参数**在日志里看得见**——报告正是这样发现的。

**未复现的一条**（报告 §6）：沙箱里被 `.gitignore` 排除的测试素材缺失（`tests/assets/`、`tmp/`）。本仓早已记过同形（"判据沙箱里没有 gitignore 的素材"）。它是**独立**问题：本 change 不修，按报告建议落到文档与队列。

## 2. 修法（取报告的 A，并写成"一处判定"）

`rewriteAuthorReference` 改为：**只有当作者根的出现位置以 `/` 或值尾结束时**才替换那一次出现；其余出现原样通过。

```
'/app'              → sandboxRoot
'/app/tests/x'      → sandboxRoot + '/tests/x'
'/app/tests/application' → sandboxRoot + '/tests/application'
'tests/application' → 原样            ← 'application' 不是 'app'
"--flag='/app/second-started'" → "--flag=sandboxRoot/second-started'"  ← 内嵌但成段的出现也映射
```

> **一处实现与本文早先写法的差别（复核第 1 轮实测）**：本节曾把规则写成「整个值就是作者根或以其 + `/`
> 开头」，并据此声明「值内嵌的出现不再被替换」。落地的规则是**逐次出现**的边界判定，所以脚本参数
> 里的内嵌段（`--flag='/app/second-started'`）**会被**映射 —— 而且必须被映射：serial 与 concurrent 的
> 两次检查要指向同一份快照，`tests/unit/a-check-argument-that-points-inside-is-rewritten.test.ts` 的正
> 对照就断言这一点。§4 的边界因此只覆盖「出现之后还跟着字符」的那种（`tests/application`），不覆盖
> 内嵌段。

实现要点（防止"改完又长出一套新规则"）：
- 与 `mapRepositoryPath` 的判定**同源**：同一个「值是否就在仓库内」的谓词，路径版与字符串版各用一次；
- 处理尾斜杠（`/app/` 与值以 `/` 结尾）不产生 `//`；
- 只改这一个函数，`checksForExecutionSandbox` 的四个调用点（command / args / env / cwd）都经它。**实测更正**：该函数只有**一个**调用者（`src/workflow/orchestrator.ts` 的封存路径），所以本节早先写的「`build --seal` 与 `verify` 共用这条解析」不成立 —— `verify` 读的是既有证据，不执行新的沙箱命令。

## 3. 验收项（各配独立选择器文件）

| AC | 属性 | 选择器 |
|---|---|---|
| **AC-1** | **子串不受影响**：参数 `tests/application`、`packages/x/src/x/application`、`application` 原样传入 | `tests/unit/a-check-argument-is-not-rewritten-by-substring.test.ts` |
| **AC-2** | **正对照仍在**：`/app` 与 `/app/packages/x` 仍被替换成沙箱根与沙箱内路径（这条防止"修成什么都不替换"） | `tests/unit/a-check-argument-that-points-inside-is-rewritten.test.ts` |
| **AC-3** | **执行的就是声明里写的那一个**：沙箱执行时参数被映射进快照（`mapped.startsWith(process.cwd())` —— 检查自己的 cwd 就是快照根），而内嵌的长名原样到达 | `tests/unit/the-executed-argument-is-the-one-the-check-declared.test.ts` |

**单点变异**（每条先确认落上再采信读数）：
1. 还原成 `replaceAll` ⇒ AC-1 红；
2. 改成"从不替换" ⇒ AC-2 红；
3. 只在 `command` 上修、`args` 仍用旧规则 ⇒ AC-1 红（args 才是本次现象）。

## 4. 边界（写清楚，不假装全覆盖）

- **出现之后还跟着字符**的（`tests/application`、`packages/x/src/x/application`）**不被替换**：`application` 不是 `app`。这是本 change 的刻意选择（修法与边界以实现为准，见 §2 的更正）。"是**响亮**的失败（日志里会显示原始绝对路径，且沙箱里该路径不存在 ⇒ 判据失败并留下证据），比"猜着换"好。
- 报告 §6 的 gitignore 素材缺失**不在本 change 范围**（另记队列，并在文档里写一句）。
- 本 change 不动沙箱的其它部分（内容同步、依赖符号链接、身份计算）。

## 5. 代价

实现 1–2 h（一个函数 + 3 个选择器 + 3 个变异），全套回归 ≈7 min，封存+Verify+账本 ≈12 min，一轮独立审查 ≈20 min。它**不改门禁强度**：被改坏的参数是判据的输入，修好它只会让判据看到它声明要跑的东西。
