---
change: context-fabric
role: technical-design
canonical_spec: kata
---

# Kata Context Fabric 技术设计

## 1. 结论

Kata 的核心不是选择或编排特定 AI Coding 平台，而是提供平台无关、可验证、可恢复的上下文协议（Context Fabric）。Codex、OpenCode、GitHub Copilot、Claude Code 和未来工具都只是同一协议的 adapter。

第一版只保证**同一 Git 分支、同一工作树**内的交接；不提供远程同步、跨 clone 合并、聊天记录搬运或 provider API 编排。

## 2. 问题与边界

不同 agent 的会话上下文不可移植、会丢失，也不能作为审计依据。平台专属 memory、rules 或 model 配置同样不能成为系统的事实来源。

Context Fabric 的事实来源固定在仓库内：

```text
.llmwiki/                       长期、受治理的项目理解
.kata/tasks/<task-id>/        任务目标、验收、状态、handoff、角色产物
.kata/evidence/               与具体 diff 绑定的可复验命令证据
Git HEAD + working-tree diff    当前代码事实与新鲜度锚点
```

它不做以下事情：

- 不复制或总结任何平台的私有聊天记录；
- 不假定某平台一定支持 hook、sub-agent 或原生模型切换；
- 不用 Wiki、模型路由或 agent 声明替代测试、CI、Reviewer、Judge；
- 不在不同分支、不同 clone 或远程机器之间自动同步状态。

## 3. Canonical Handoff Packet

新增版本化 JSON 工件：

```text
.kata/tasks/<task-id>/handoffs/<handoff-id>.json
```

`HandoffPacket` 必须包含：

```ts
interface HandoffPacket {
  protocolVersion: 1;
  id: string;
  taskId: string;
  createdAt: string;
  from: { role: Role; platform?: string };
  to: { role: Role; preferredPlatforms?: string[] };
  phase: Phase;
  repository: {
    head: string | null;
    branch: string | null;
    diffHash: string;
    worktreeRoot: '.';
  };
  task: {
    title: string;
    acceptance: Array<{ id: string; statement: string }>;
  };
  context: {
    requiredReads: string[];
    sourceRefs: string[];
    authoritativeWiki: Array<{ id: string; path: string }>;
    excludedWiki: Array<{ id: string; reason: string }>;
    evidencePaths: string[];
    priorArtifacts: string[];
  };
  permissions: { allowedWrites: string[]; guardInstructions: string[] };
  executionHint?: { minimumTier?: Tier; preferredPlatforms?: string[] };
  nextAction: string;
}
```

所有路径必须是仓库相对路径，使用已有 task-id/role-id 校验并拒绝 `..`。`head`、`branch`、`diffHash` 是读取时重新计算的锚点，不能由平台声称替代。

## 4. 生产、消费与确认

```text
任意平台 /kata orient
  → create handoff
  → handoff.json（任务 + 已选 Wiki + 证据 + Git 锚点 + 最小写权限）
  → 另一平台读取并校验
  → receipt.json（platform、agent 标识、packet hash、实际 Git 锚点）
  → 平台执行并写入标准 role artifact
```

新增命令：

```sh
kata handoff create --task <id> --from <role> --to <role> [--platform <name>]
kata handoff show --task <id> --id <handoff-id>
kata handoff acknowledge --task <id> --id <handoff-id> --platform <name>
kata handoff verify --task <id> --id <handoff-id>
```

`acknowledge` 写入：

```text
.kata/tasks/<task-id>/handoffs/<handoff-id>.receipt.json
```

它记录 packet 的 SHA-256、接手平台、接手角色和实际 Git 锚点。若 packet hash、task/role、HEAD、branch 或 diff hash 不匹配，`verify` 失败；接手 agent 必须重新创建/读取 handoff，而不能沿用陈旧上下文。receipt 是“已读取协议工件”的审计记录，不是代码正确性证明。

## 5. 上下文选择规则

Packet 由 CLI 确定性构建，不能让 adapter 随意添加不可审计文本：

1. 始终包含 `AGENTS.md`（如存在）、任务文件、当前 state 和 `.llmwiki/{SCHEMA,index,log}.md`。
2. 只选择 `verified` Wiki，记录 candidate/stale/rejected 项为 excluded；源码与测试优先于 Wiki。
3. 引入 task evidence、review、judge、repair、模型路由等现有角色产物，但仅作为文件引用。
4. `allowedWrites` 继续由 task phase/role policy 计算，不能由 packet consumer 放宽。
5. `executionHint` 从 `modelPolicy` 派生，是可选建议；平台实际是否切换模型不影响 packet 有效性，也不能绕过质量门。

## 6. Adapter 责任

每个平台 adapter 都必须生成相同语义的 Skill：先 `handoff verify`，阅读 `requiredReads`，再执行该角色动作，最后 `handoff acknowledge` 或写入角色工件。

| 层 | 责任 |
|---|---|
| Kata core | 定义 packet/receipt schema，计算 Git 锚点和 Wiki/evidence 引用，校验新鲜度与路径安全。 |
| Kata workflow | 将 orient/handoff 和状态机连接，拒绝过期 handoff 进入 Review/Judge。 |
| Adapter | 以平台原生 Skill、command、rule 或 hook 呈现同一命令，不保存私有上下文。 |
| Agent | 读取指定文件、独立完成角色工作、回写受限工件。 |

Codex、OpenCode、GitHub Copilot、Claude Code、generic 的差异只能出现在安装路径、命令呈现和可选 execution hint，绝不能出现在 canonical packet 格式。

## 7. 质量与安全

需要新增 JSON schema 和测试，至少覆盖：同分支/同 diff 成功接手、diff 变化后拒绝、分支变化后拒绝、路径逃逸拒绝、stale Wiki 排除、不同平台读取同一 packet、receipt 无法伪造不同 packet hash、adapter 输出的必读/确认步骤一致。

`handoff verify` 只能验证上下文一致性。它不能代替 hard verification；进入 distill/archive 仍严格依赖当前 diff 的证据、无 blocking review finding 和 Judge PASS。

## 8. 迁移与兼容

现有 `createHandoff()` 继续作为内部兼容视图。新 `HandoffPacket` 首先由它扩展而来，随后 `orient` 输出 packet 路径和摘要而非将不受版本控制的完整 handoff 内联到终端 JSON。旧任务没有 packet 时，`orient` 可创建新的 v1 packet；不会修改历史 review/judge/evidence 文件。

现有 model-route artifact 保持不变，只在 `executionHint` 中被引用。这样实现跨平台上下文互通，而不把 Kata 绑定到任何供应商或模型切换 API。
