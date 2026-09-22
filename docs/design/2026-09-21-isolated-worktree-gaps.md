# 已记录：`isolated_worktree` 在 Kata 里的五个实测缺口

**状态：已记录，作为 `adversarial-admissibility` 的输入。**

在开启 `adversarial-admissibility`（profile `isolated_worktree / tdd / strict`）时实测到三个缺口。
它们都属同一类：**声明的位置与实际生效的位置不一致**，正是本 change 的 AC-2/AC-3 要修的那一类。

## 1. `.kata` 被 gitignore，但代码假设 task state 随 git 跟踪

`src/core/layout.ts` 的 `resolveWorkspaceRootForTask` 注释写着：

> a nested worktree and its primary checkout both own the same task (**task state is tracked**)

而 `.gitignore:2` 把 `.kata/` 整个忽略。结果：

- `worktree create` 建出的 worktree 里，`.kata/tasks/` 是**空目录**；
- 在该 worktree 里运行任何 task-addressed 命令都报
  `ENOENT: .../.kata/tasks/<id>/task.json`；
- 即设计意图（"两边都拥有同一任务"）与仓库配置直接冲突。

**实测绕过**：把 worktree 的 `.kata/tasks` 软链到主 worktree 的同一目录，状态单份、路径自然。

**真正要修的**：要么让 task state 真的随 git 跟踪（与注释一致），要么把 worktree 的 `.kata` 解析规则
写清楚并让 `worktree create` 自己建立这条链。二者选一，不能像现在这样让注释和配置互相矛盾。

## 2. `implementation_gate` 在 `isolated_worktree` 下强制人机确认

`current_worktree` 的 change 会自动通过 implementation gate（`review-record-integrity` 时如此）；
`isolated_worktree` 会返回

```
implementation_gate requires an explicit user choice before continuing.
```

正解是 `kata-cli gate approve --task <id> --boundary implementation_gate --choice continue_current --for-task`。
`--for-task` 记录一次并覆盖后续边界（`recordedForTask: true`），避免在每个边界重复询问同一问题。

**这不是缺陷**，但它没有被文档化：CLI 的报错只说"需要显式选择"，没有说怎么记。
一个可被机械回答的 gate 应当在自己的错误信息里给出回答方式。

## 3. 在隔离 worktree 工作时，工具的 cwd 不会自动切过去

这是**本次实际发生的**：Phase 0 的代码被写进了**主 worktree**（`src/eval/admissibility-corpus.ts`
与 `tests/unit/eval-metrics.test.ts`），而 change 声明的是隔离 worktree。发现后已迁移并撤回，
两个位置现在都是正确的。

它不是工具 bug，而是**流程缺口**：kata 的 `isolated_worktree` profile 没有让任何一步强制"在 worktree 里操作"。
`kata-cli worktree create` 的 `nextSteps` 只说 `cd` 过去，之后的命令没有约束。

**要修的**：profile 为 `isolated_worktree` 时，写入类命令应当校验 cwd（或 `--root`）落在该 change 的
worktree 内，否则 fail closed 并给出正确路径。这与 AC-2 同源：**声明一份位置，写入另一份位置，不应静默成功。**

## 4. seal 的运行位置由 cwd 决定，因此它与 Build 的位置可以不一致

**实测（本次实际发生）**：实现在隔离 worktree 里完成，但 `kata-cli build --seal` 从主 checkout 执行时，
`resolveWorkspaceRoot()` 解析到**主 checkout**，于是 seal 在那边跑检查：

```
"workspaceRoot": "/data/work/ahaeureka/k2skills/kata"          ← 主 checkout
AC-1-test-…  → exitCode 1
日志：No test files found, exiting with code 1
```

原因是 `tests/unit/review-admissibility.test.ts` 只存在于 worktree，主 checkout 里没有该文件（AC-1 的测试
在 worktree 新建）。**seal 检查的目标与 Build 的位置不同，且没有任何一步阻止它**——与缺口 3 同源，只是发生在
seal 一侧。

从 worktree 内执行 seal 可以消除这一具体错配（`workspaceRoot` 随即指向 worktree），但它立刻暴露下面第 5 条。

## 5. worktree 内无法 seal：CLI bundle 与 `node_modules` 都在主 checkout

在 worktree 内执行 `kata-cli build --seal` 时，7 条 matrix check 全部以 `MODULE_NOT_FOUND` 失败：

```
Error: Cannot find module
  '/data/work/ahaeureka/k2skills/kata/.kata/worktrees/adversarial-admissibility/node_modules/vitest/vitest.mjs'
```

机制（已定位到具体代码）：

- 依赖确实存在，只是位于**祖先 workspace**（`/data/work/ahaeureka/k2skills/kata/node_modules`）；worktree 按
  设计不带自己的 `node_modules`，由 Node 的祖先解析代偿；
- `src/quality/check-resolver.ts` 把 runner 入口解析为 `join(runtimeProjectDir, 'node_modules', …)`，
  即 **worktree 字面路径**——一个按设计永远不存在的路径；
- 于是「依赖可用」与「路径可用」被判成了同一件事。

**这是第 4 条的直接后果**：即使把 seal 挪进 worktree，check 也会因为入口路径的字面解析而全灭。

**要修的**：runner 入口应当按**依赖解析结果**定位（与 `execution-sandbox.ts` 复制依赖时用的是同一份候选列表），
而不是按 project dir 拼字面路径。本次已在本 change 内按此实现并加了回归测试
（`tests/unit/check-resolver.test.ts` 的 `resolves the runner entry through dependency resolution…`），
但它要生效必须让 **seal 执行的那份 bundle** 含这次修复。已解：在 worktree 内就地构建（`npm run build`，`esbuild`
经祖先解析取得，63ms），再用 **worktree 自己的 `dist/cli.js`** 执行 seal。修复随即生效——6 条 matrix check 全绿，`failingEvidence` 由 7 降到 1。

**遗留（见「seal 停在哪一条」）。**

## 与 AC 的对应

| 缺口 | 对应 AC | 为什么不是"操作失误" |
|---|---|---|
| 1 | AC-2 / AC-3 | 注释声明"A 与 B 都拥有任务"，配置使 B 拿不到任务——契约自相矛盾 |
| 2 | AC-6（守卫/门禁的可回答性） | 一个 gate 的报错没给回答方式，会把人推向手工绕过 |
| 3 | AC-2 | 声明的位置与实际写入的位置不一致而静默通过，正是变更面的定义问题 |
| 4 | AC-2 / AC-3 | seal 与 Build 可以位于不同 checkout，而没有任何记录或阻止——"这一轮检查的是哪份内容"因此不可判定 |
| 5 | AC-2 | runner 入口按字面路径解析而非按依赖解析结果，使"依赖可用"被当成"路径可用" |

## seal 停在哪一条（与本 change 无关的环境失败）

修好第 5 条后，`--seal` 达到 **8 条 evidence / 7 passing / 1 failing**，6 条 AC matrix check 全部通过。
唯一失败是项目级 `npm test`（`checkId: null`，即 matrix 之外的整库 check）：

```
FAIL tests/unit/comet-init-platforms.test.ts > initCometProject … > runs a single comet init when no platforms are given
AssertionError: expected 'failed' to be 'initialized'
```

**最小复现（不经过 kata）**：

```
$ mkdir /tmp/ctest && cd /tmp/ctest && git init -q .
$ HOME=/tmp/ctest comet init --yes --scope global
…
  Comet v0.4.2
  No platforms selected. Exiting.        ← 未初始化任何平台
```

本机真实 `comet` 在 `--platform` 缺省时**主动退出且什么都不做**，而该测试期望 `status: 'initialized'`。
这是 kata 的期望与已安装 comet 行为之间的既存不匹配。

**与本 change 无关的证据**：把本 change 的全部改动 stash 掉后在干净树上运行同一测试，结果相同
（1 failed / 1 passed）。因此它是环境性的，不是本次实现引入的，也没有被跳过或改写期望。

如实停在此处：seal 未通过，`failingEvidence: 1`，`nextAction = repair_failing_evidence`。
修它要么改 kata 的期望（等于伪造通过），要么单独开一个 change 处理"comet 无平台时的行为"。
两条都不属于本 change 的写入范围。
