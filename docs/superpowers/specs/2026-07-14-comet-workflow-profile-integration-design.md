# Comet 开启与 Workflow Profile 集成设计

## 目标

让 `/kata-open` 成为新任务的统一入口：它记录开发工作流选择、执行可自动执行的 Comet 初始化，并明确交给宿主 Agent 执行 `/comet-open`。后续 Kata 阶段与跨平台 handoff 都读取同一份 profile。

## 方案比较

1. **仅改 skill 文案**：最小，但 profile 不可审计、CLI/CI 无法执行约束，拒绝。
2. **Kata 复制实现 Comet/OpenSpec**：会造成两个 artifact 生命周期，容易漂移，拒绝。
3. **Profile + Comet 适配边界（采用）**：Kata 持久化并强制 workflow 选择；Comet 继续拥有 `comet init` 与 `/comet-open` 的原生产物。CLI 只报告真正执行过的 `comet init`，不能声称执行 slash skill。

## 数据模型

每个 task 新增可版本化 profile：

```json
{
  "version": 1,
  "isolationMode": "current_worktree | isolated_worktree | git_flow | user_decides",
  "developmentMode": "tdd | standard",
  "reviewMode": "std | strict | security",
  "comet": { "projectInit": "initialized | skipped | failed | not_requested", "openStatus": "required | acknowledged" }
}
```

profile 写入 task record，避免 task 与 state 的 phase 双写不一致；handoff 复制 profile 与从 profile 推导的权限/守卫。

当 `isolationMode` 为 `git_flow` 时，profile 另带可选的实际分支记录：

```json
{
  "gitFlow": {
    "strategy": "git-flow | manual",
    "branch": "feature/<task-id>",
    "baseBranch": "develop",
    "status": "active | pending_confirmation | failed"
  }
}
```

## 行为

`kata open`：TTY 下通过选择器收集三个模式；非 TTY 默认 `current_worktree + tdd + std`。它检查/执行 Comet 项目初始化。由于 slash skill 由宿主 Agent 解释，不能由 Node CLI 安全调用，故 `nextAction` 返回 `/comet-open <id>`，而不是伪造成功。宿主完成后以 `kata comet acknowledge-open --change <id>` 记录确认，再进入 `/kata-design`。

`tdd` mode 的 build/handoff 写入“先写失败测试、验证 RED、最小实现、验证 GREEN”的约束。`std` 保持现有 reviewer；`strict` 增加架构/回归边界检查；`security` 增加安全与依赖检查要求。隔离模式被记录：Kata 可以建议/要求 worktree，但不在已有脏工作区静默创建或迁移 worktree。

`git_flow` 是受确认的分支管理操作：交互式 `kata open` 在 task 建立后检测 `git flow`。若已安装且仓库已初始化，显示将运行的 `git flow feature start <task-id>`，经确认后执行；若不可用或未初始化，显示将运行的 `git switch -c feature/<task-id> <base>`，经确认后执行。`base` 优先读取 Git Flow 配置中的 develop 分支；缺失时优先现有 `develop`，再使用当前分支。非交互模式绝不创建或切换分支，只持久化 `pending_confirmation` 与下一步确认动作。创建、切换和完成分支都不允许静默执行；Kata 也不会自动执行 feature finish、merge 或发布。

## 风险与非目标

- 不让 Kata 伪装调用 Codex/OpenCode/Claude Code 的 slash command。
- 不自动创建 Git worktree；避免迁移当前会话和未提交修改。profile 明确要求时，由宿主平台或用户确认创建。
- 不在未确认、脏工作区、无法识别基准分支，或目标功能分支已存在但不是当前分支时执行分支切换；返回可行动诊断。
- 不替换 Comet 的 OpenSpec artifact 所有权。

## 验收

覆盖 profile 默认值和交互选择、Comet init 结果、`/comet-open` next action、acknowledge 后转向 design、TDD/review guard、Git Flow 探测/命令构造/手动回退/确认拒绝、重复 handoff 不丢失 allowed writes，以及现有全套单元/E2E 测试。
