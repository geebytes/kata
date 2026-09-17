# 证据 check name 与它自己的 schema 不一致

## 症状

任何在验收矩阵里声明证据命令（`acceptanceMatrix.rows[].evidence[].command`）的任务，
封存都会在**验证自己的证据 artefact** 时失败：

```
evidence artefact .kata/evidence/<taskId>-<...>.json does not match its schema:
  $.name must match ^[A-Za-z0-9_.-]+$
```

## 根因

`src/quality/check-resolver.ts` 的 `checkIdentity()` 把**原始命令行**拼进 `name`：

```ts
name: `${row.acceptanceId}-${evidence.kind}-${suffix}`   // suffix = testSelector ?? command
```

命令行含空格与斜杠（`uv run pytest tests/x.py -q`），而 `schemas/evidence.schema.json` 约束
`name` 为 `^[A-Za-z0-9_.-]+$`。写入端不做清洗，于是 kata 产出的证据被自己的 schema 拒绝。

`evidenceFileSuffix()`（`src/workflow/orchestrator.ts`）**已经**做了同一套清洗——只是没用在
`name` 字段上，所以文件名是合法的、字段不是。

## 修复

新增并导出 `sanitizeCheckName()`（`check-resolver.ts`），`checkIdentity()` 用它构造 `name`，
`evidenceFileSuffix()` 改为复用同一实现（一处清洗，不分叉）。清洗后为空时回退到
`<验收项>-<种类>`，不产出空名字。

## 测试

`tests/unit/check-resolver.test.ts`：
- 矩阵派生的 check name 必须匹配 `^[A-Za-z0-9_.-]+$`（含 selector 路径与整条命令行两种形状）；
- 全非法字符的命令行仍产出可用名字；
- `sanitizeCheckName` 与文件名共用同一规则（既有断言更新为清洗后的名字，原断言钉的是旧行为）。
