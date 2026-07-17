# Wiki Closure Gate 设计

## 目标

每个 Kata task 在进入归档前必须留下知识处理结论，而不是强制新增 Wiki 页面。结论是 task-owned、跨平台可读、可审计的 `wiki-closure.json`。

## 决策模型

```json
{
  "taskId": "example-task",
  "decision": "captured | not_applicable | deferred",
  "reason": "为什么沉淀、为何无可复用知识、或依赖何处尚未满足",
  "candidateIds": ["llmwiki-concepts-example"],
  "updatedAt": "ISO-8601"
}
```

- `captured`：至少一个 candidate/verified record 存在，且执行决策时 Wiki lint 与来源验证通过。
- `not_applicable`：必须有非空理由；可正常通过门禁。
- `deferred`：必须有理由，但不能通过 verify/archive 门禁。

## 生命周期

`build` 在 task 缺少该文件时创建 `deferred` 占位，并返回明确提示；不会猜测知识价值。Agent 通过 `kata wiki closure --task <id> --decision ...` 写入结论。`verify` 在原有代码证据检查之外检查闭环；`archive` 复查，防止跳过 verify 直接归档。

`captured` 只能通过 CLI 写入：CLI 读取 candidate ids，执行 `wiki lint` 与来源漂移验证，然后持久化结果。这样 Wiki 仍是项目理解辅助，不能取代代码测试、Reviewer 或 Judge。

## 跨平台语义

闭环文件位于 `.kata/tasks/<id>/wiki-closure.json`，Wiki 页位于 `.llmwiki/`，治理记录位于 `.kata/wiki/`。同一分支、同一工作区的任何平台读取同一文件；不同 clone 必须经 Git 同步这些文件。
