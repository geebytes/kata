# Brainstorm Summary

- Change: kata-foundation
- Date: 2026-07-11

## 确认的技术方案

采用方案 A：Comet 外部运行时 + Kata 扩展层。

Kata 作为独立 Node.js 包，复用已安装 Comet 的 CLI、平台安装、Skill 分发、基础工作流、状态守卫和恢复能力；Kata 不复制 Comet 内部实现。Kata 自己拥有 `.kata/` 任务与证据协议、模型策略、Reviewer/Judge 合约和受治理 Wiki。通过兼容接口调用 Comet，使用版本兼容测试隔离上游变化。

核心数据流：`/kata-open` 创建或恢复任务 → Kata 生成任务契约和最小 Wiki context manifest → Comet Build 调用低成本执行模型 → Kata 收集 lint/typecheck/test/CI/Reviewer/Judge 证据 → 通过后生成 Wiki candidate → 显式批准后 promote 为 verified Wiki。

## 关键取舍与风险

- 不 fork Comet，降低上游同步和许可证/实现耦合风险。
- 不重写状态机，保持 Comet 为基础工作流事实源；Kata 只扩展领域协议。
- Wiki 永远是派生知识，不压过规则、ADR、契约、测试和证据。
- Comet 版本漂移由适配层、锁定版本范围和兼容 fixture 缓解。
- 平台能力不一致时使用 capability manifest 和 generic fallback，不伪造 hook/sub-agent 支持。

## 测试策略

- Comet 兼容接口与版本矩阵测试。
- Codex、Claude Code、OpenCode 的 Skill/命令 manifest golden tests。
- 状态守卫、证据新鲜度、Judge 只读权限和 Wiki promotion property tests。
- 中断恢复、失败修复、过期 Wiki、源冲突、未授权写入的端到端 fixtures。
- 评估 workflow pass rate、acceptance pass rate、repair/escalation rate、成本和 Wiki rejection rate。

## Spec Patch

无。现有 OpenSpec capabilities 已覆盖确认后的方案；如实现阶段发现需求级变化，再回写对应 delta spec。
