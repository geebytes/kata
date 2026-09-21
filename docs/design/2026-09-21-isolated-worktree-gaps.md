# 已记录：`isolated_worktree` 在 Kata 里的三个实测缺口

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

## 与 AC 的对应

| 缺口 | 对应 AC | 为什么不是"操作失误" |
|---|---|---|
| 1 | AC-2 / AC-3 | 注释声明"A 与 B 都拥有任务"，配置使 B 拿不到任务——契约自相矛盾 |
| 2 | AC-6（守卫/门禁的可回答性） | 一个 gate 的报错没给回答方式，会把人推向手工绕过 |
| 3 | AC-2 | 声明的位置与实际写入的位置不一致而静默通过，正是变更面的定义问题 |
