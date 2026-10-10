# 检查参数里的 `/app` 被当成工作区根替换，把 `application` 改成了临时目录

**报告者**：zenmpai 项目的实施会话 ｜ **日期**：2026-10-10 ｜ **严重度**：阻塞（封存无法通过）

> **本报告已更正。** 初版把这里的现象判成「已过期、且契约里已不存在的检查结果被复用」。复核后
> **那个判断是错的**：失败的检查**确实被重跑**，失败原因是**检查命令的参数被改坏**（见下）。初版
> 提到的三条「契约里已不存在的命令」另有原因 —— 是我自己在 `task.json` 里只改了 claim 的
> `check.args`、没同步改 `acceptanceMatrix.rows[].evidence[].command`，属于**我的声明缺陷**，已修好。
> 保留这份更正记录，是因为初版给出的两个出口（`build --seal` 与 `verify` 指向同一个
> `repair_failing_evidence`）确实让人不容易看出真正的原因。

## 1. 现象

`build --seal` 报三个质量门失败，而这三条命令**手工在项目根跑全部通过**（`ruff check` exit 0、
`ruff format --check` exit 0、`pyright` 0 errors）。证据文件里的日志给出了真正的失败：

```
env: cwd=/tmp/kata-seal-execution-KdZIU3 node=v22.23.3 platform=linux
cmd: uv run ruff check packages/…/crosscutting packages/…/application … tests/architecture tests/application …
log: E902 No such file or directory (os error 2)
     --> packages/zenmpai-core/src/zenmpai_core/tmp/kata-seal-execution-KdZIU3lication:1:1
     E902 No such file or directory (os error 2)
     --> tests/tmp/kata-seal-execution-KdZIU3lication:1:1

typecheck 同样：
     File or directory "file:///tmp/kata-seal-execution-KdZIU3/packages/zenmpai-core/src/zenmpai_core/tmp/kata-seal-execution-KdZIU3lication" does not exist
```

把参数拼回原样就能看出被改坏的位置：

| 传入的参数 | 沙箱里实际使用的参数 |
|---|---|
| `packages/…/zenmpai_core/application` | `packages/…/zenmpai_core/` **`/tmp/kata-seal-execution-KdZIU3`** `lication` |
| `tests/application` | `tests/` **`/tmp/kata-seal-execution-KdZIU3`** `lication` |

## 2. 根因

kata 把工作区根 `/app` 替换成沙箱根 `/tmp/kata-seal-execution-<id>` 时，替换的判据是**普通字符串
包含 `/app`**，而不是**路径前缀**。于是任何参数里出现 `/app` 这个子串的地方都会被替换：

* `.../zenmpai_core/application` 与 `tests/application` —— **`/app`**`lication` ⇒ 命中（实测两条错误都是它们）；
* `packages/zenmpai-app/...`、`zenmpai_app` —— `-app/`、`_app` ⇒ 不含 `/app`，未被替换（与日志一致）；
* `tests/support` 等不含 `/app` 的参数 ⇒ 未受影响。

这与「日志里恰好只有两条 E902、且都在 `application` 上」完全吻合。

## 3. 复现（无外部依赖）

1. 在 `.kata-config.json` 的 `quality.buildChecks` 里放一条带 `application` 目录的参数，例如
   `uv run ruff check tests/application packages/<pkg>/src/<pkg>/application`。
2. 跑 `build --seal`。
3. 证据日志出现 `E902 No such file or directory`，路径里 `application` 被替换成
   `<sandbox>/lication`。

## 4. 修法（按推荐度）

**A（推荐）按路径边界替换。** 只替换「**整个参数等于工作区根**」或「**参数以 `工作区根 + /` 开头**」
的情形；其余参数原样传入。判据可判定，且不会碰到子串。

**B 先规范化再前缀替换。** 对参数做 `posixpath.normpath` 后按 `PurePosixPath.is_relative_to(root)`
判断，再替换前缀。

**C 不改参数，改用 `cwd`。** 大多数检查用相对路径，沙箱里把 `cwd` 设成沙箱根即可；只有显式写了绝对
工作区路径的参数才需要替换（那时按前缀判断）。

**D 只把 `/app` 这一处的替换限制成「前面是行首或空白、后面是 `/` 或行尾」** —— 能挡住本次现象，但仍然是
靠字符串形状，不建议（路径里出现空格或引号时又会漏）。

## 5. 必须的回归

1. **子串不得被替换**：参数 `tests/application`、`.../src/x/application` 在沙箱里必须原样使用。
2. **正对照**：参数确为工作区根或以工作区根开头时（`/app`、`/app/packages/...`）必须仍然被替换成沙箱根。
3. **不得只在某些子命令上修**：`build --seal` 与 `verify` 走同一套检查解析，两条都要覆盖。
4. **日志要能看出替换**：证据里记录**实际执行**的参数（当前记录的是替换后的字符串，看起来像合法的项目
   路径，容易读成「文件真的不存在」）。

## 6. 附带发现（另一条，独立）

`make test` 在沙箱里 `collected 918 items` 后失败：沙箱是从 git 内容派生的副本，**被 `.gitignore`
排除的测试素材（本仓的 `tests/assets/` 真实照片与 `tmp/`）不存在**。这与本仓早先记录过的
「判据沙箱里没有 gitignore 的素材」同形。建议在 skill 里写明：**依赖 gitignore 素材的判据不要放进
`quality.buildChecks`**，或让沙箱把这类素材一并复制（本仓的做法是把这类判据设计成「素材缺失即 skip」，
但如果 check 要求 exit 0，skip 也要能被接受）。

## 7. 非主张

* 我没有读 kata 的替换实现，只从日志与被改坏的字符串形态推断（两条错误位置与「`/app` 恰好出现在
  `application` 里」一一对应，且不含 `/app` 的参数未被影响）。请按实际实现核对。
* 初版报告里「过期检查结果被复用」的判断**不成立**，已在开头更正；本条不影响上面这条新发现。
