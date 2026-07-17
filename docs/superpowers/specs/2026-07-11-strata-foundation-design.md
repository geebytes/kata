---
comet_change: kata-foundation
role: technical-design
canonical_spec: openspec
---

# Kata Foundation 技术设计

## 1. 设计结论

Kata 采用“Comet 外部运行时 + Kata 扩展层”架构。Kata 是独立的 Node.js/TypeScript 包，通过 Comet 的 CLI、Skill 分发、平台适配、基础状态守卫和恢复能力驱动跨 AI Coding 工具工作流；Kata 不 fork Comet，也不重写 Comet 的通用状态机。

Kata 的独有价值集中在四个协议：

```text
任务与上下文协议
模型等级与预算协议
证据 / Reviewer / Judge 协议
受治理 Wiki 协议
```

## 2. 边界与模块

```text
Comet runtime
├── CLI 与平台安装
├── Skills 与命令分发
├── 基础 phase/state/guard
├── handoff 与恢复
└── 平台 capability 发现

Kata extension
├── kata-core       task/context/evidence contracts
├── kata-policy     model tiers/budget/escalation
├── kata-quality    checks/reviewer/judge/repair
├── kata-wiki       provenance/drift/conflict/promotion
├── kata-adapters   Comet compatibility + normalized manifests
└── kata-eval       fixtures/metrics/release gates
```

Kata 通过公开的 CLI/脚本/manifest 边界调用 Comet，禁止依赖 Comet 未承诺的私有模块。Comet 版本、能力和路径由 `comet-compat.yaml` 声明，并由兼容测试验证。

## 3. 运行时与数据流

```text
/kata-open
  → Comet task/change lifecycle
  → kata task contract + acceptance IDs
  → context builder (rules + verified Wiki + source/tests)
  → /kata-build (economy implementer)
  → hard evidence (lint/typecheck/test/CI)
  → Reviewer
  → read-only Judge
       ├── FAIL → bounded repair → hard evidence
       └── PASS → Wiki candidate → approval → verified Wiki → archive
```

Comet 的状态负责“当前阶段能否继续”；Kata 的证据索引负责“本次 diff 是否有足够可审计证据”。任意一个守卫失败都不能进入 archive。

## 4. Wiki 治理模型

Wiki 采用 Markdown + front matter，记录 statement、scope、kind、source refs、source hashes、validation task、evidence refs、status 和 timestamps。状态只有以下几类：

```text
candidate → verified → stale
          ↘ rejected
```

实现者只能读 verified Wiki；candidate 只能由 distiller 生成，不能进入权威上下文；promotion 必须经过 schema/source/evidence 校验和 reviewer/human approval event。源 hash 变化、引用丢失或与规则/ADR/契约/测试冲突时，记录变为 stale 或触发 `needs-clarification`。

事实优先级固定为：

```text
approved policy/ADR/contract
> executable tests and CI evidence
> current implementation behavior
> verified Wiki
> candidate Wiki / agent summary
```

因此 Wiki 的作用是减少 agent 对项目的无知，而不是替代码正确性背书。

## 5. 模型与权限

模型通过 `economy`、`capable`、`frontier` capability tier 配置，不在代码中绑定具体厂商。实现者拥有任务代码和测试的有限写权限；Reviewer 只能写 findings；Judge 只能写结构化判定；Distiller 只能写 candidate；规则和 verified Wiki 的 promotion 需要显式批准。

升级条件包括：连续硬验证失败、结构化输出失败、源冲突、安全敏感范围、预算/改动上限或验收歧义。Repair 只允许修复失败 acceptance 的范围，且必须重新执行 hard verification。

## 6. 平台适配

第一版提供 Codex、Claude Code、OpenCode 适配器和 generic fallback。每个适配器生成 `/kata-*` Skills，但所有适配器都调用相同的 Kata CLI 与 `.kata/` schema。支持 hooks/sub-agents 的平台增强自动化；不支持的平台通过显式 Skill 和 CLI guard 工作。

`kata init/update/uninstall` 使用 ownership manifest 与 template hash，遇到用户修改的文件只报告冲突，不静默覆盖。

## 7. 验证和发布

验证分为四层：

1. Schema/state/property tests：证明非法状态和越权写入不能通过。
2. Hard checks：真实 lint、typecheck、unit/integration test、安全检查和 CI 结果。
3. Reviewer/Judge：基于 acceptance、diff 和 evidence 的独立审查/判定。
4. Evaluation/release：跨平台安装、恢复、失败修复、Wiki 漂移/冲突及成本可靠性指标。

没有当前 diff 对应的最新证据、Reviewer blocking finding 或 Judge PASS，任务不能 distill 或 archive。

## 8. 失败与回滚

Comet 兼容失败时，Kata 进入 `blocked` 并输出诊断，不回退为无守卫执行。Wiki 冲突时保留 candidate/source/evidence，进入人工澄清，不删除历史记录。安装回滚只移除 Kata 所拥有的生成文件；任务、证据与 Wiki 历史保持可读。
