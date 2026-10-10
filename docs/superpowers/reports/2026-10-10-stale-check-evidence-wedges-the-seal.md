# `build --seal` / `verify` wedge on stored check results whose checks no longer exist

**报告者**：zenmpai 项目的实施会话 ｜ **日期**：2026-10-10 ｜ **严重度**：阻塞（无法封存）

## 1. 现象

一个处于 `implement` 相的 change，在**修好声明之后**，`build --seal` 与 `verify` 都持续失败，且失败的
是**当前契约里已经不存在的检查**：

```
$ kata-cli build --change production-conversion-all-known-issues --seal
success: False | phase: implement
evidence: 24 passing: 18 failing: 6
  FAIL: lint        uv run ruff check <修好后的扫描面>            ← 手工跑 exit 0
  FAIL: format      uv run ruff format --check <修好后的扫描面>    ← 手工跑 exit 0
  FAIL: typecheck   uv run pyright <修好后的扫描面>                ← 手工跑 exit 0
  FAIL: AC-1-…      uv run pytest tests/photography_guidance/test_skills.py -q -q -k input_contract
  FAIL: AC-5-…      uv run pytest tests/architecture/test_photography_validation_boundaries.py -q -q
  FAIL: AC-8-…      uv run pytest tests/photography_guidance/test_state_from_observations.py -q -q -k config
error: Evidence sealing failed; fix the failing checks before retrying --seal.
next: /kata-build | repair_failing_evidence

$ kata-cli verify --change production-conversion-all-known-issues
success: False | phase: implement | evidenceCount: 24
next: /kata-build | repair_failing_evidence
```

`AC-1`（`-k input_contract`）、`AC-5`（已退役的守卫文件）、`AC-8`（`-k config`）三条命令**已不在
`task.json` 里** —— 本次修复把它们改成了 `-k rule_module` / `-k scaffolding` / `-k section`（原选择器
选不中任何测试，属「声明了却从未执行」）。三条 `lint/format/typecheck` 的**扫描面**也已改到当前存在的路径。
手工逐条执行全部 `exit 0`。

## 2. 为什么这是死锁而不是「还没修好」

* 失败项的身份（命令字符串）**与契约不符** —— 工作流要求「修复失败的检查」，但它列举的检查它自己已不再定义；
* `evidenceCount` 恒为 24，两次 `build --seal`、一次 `verify` 之后**没有变化** ⇒ 结果是**复用**的，不是重跑的；
* 两个阶段给出的出口互相指向同一个 `repair_failing_evidence`，而修复的对象不存在；
* 表面上唯一的动作是「改回那份旧契约」—— 那等于让已退役的检查永久钉住一个 change。

## 3. 复现（无外部依赖）

1. `implement` 相跑一次 `build --seal`（即使失败）。
2. 修改 `task.json` 里任一 claim 的 `check.args`（例如换一个 `-k` 选择器），或改 `.kata-config.json` 的
   `quality.buildChecks` 扫描面。
3. 重新 `orient` / `handoff verify` / `handoff acknowledge`（`diff_mismatch` 触发重确认，这一步是对的）。
4. 再跑 `build --seal`：仍报**旧**命令为失败；`verify` 同样。

## 4. 根因（推断，附可核查的现场）

每份检查结果按「检查身份」落盘在 change 的记录里：`.kata/tasks/<id>/change-record-revision-*.json`、
`seal-progress.jsonl`。当契约里的检查集合变化时：旧身份的结果**没有被标记 superseded、也没有被重跑**；
新身份**没有产生结果**；汇总时旧结果仍计入 `failing` ⇒ 封存被拒，而拒绝理由引用的是过期身份。
`build --change <id> [--seal] [--judgement <text>]` 没有刷新开关，`verify` 走同一条汇总。

## 5. 修法（按推荐度）

**A（推荐）身份变了就不算数。** 汇总前用**当前契约**的检查身份集合过滤已存结果：不在集合里的直接忽略
（输出里列出「已丢弃 N 条不属于当前契约的结果」），其余按需重跑。身份是
`(name, command, args, cwd)` 的确定字符串，判据可判定。

**B 把「被取代」做成一等状态。** 保留结果但标 `superseded_by_contract_change`，不计入 `passing`/`failing`，
并在 `nextAction` 里说明「契约变了，需重跑」。

**C 显式刷新。** `build --seal --refresh-checks` / `verify --refresh-checks`：丢弃全部已存结果并重跑。

**D 只改文案不算修复。** 把失败项过滤掉但不重跑，会让「没有证据」看起来像「通过」—— 不建议。

## 6. 必须的回归

1. **换选择器**：`implement` 相改一个 claim 的 `-k` 选择器后，`build --seal` 必须重跑该检查并按其结果判定
   （而不是引用旧身份）。
2. **退役一条验收项**：从 `acceptance` 里删掉一项后，它的旧命令不得继续出现在失败列表里。
3. **正对照**：身份**未变**的检查必须继续复用已存结果（否则每次封存都重跑全量，与复用的初衷冲突）。
4. **不得静默丢证据**：被忽略的结果必须计数并说明原因。

## 7. 非主张

* 我不确定这是**缺陷**还是**未被文档化的正确用法**：可能存在我没找到的刷新入口（`kata-cli --help` 一级
  列表里未见与检查/证据刷新直接对应的子命令）。若是用法问题，请在文档里写明「契约变更后如何刷新已存结果」
  —— 那本身就能解掉这个死锁。
* 我也无法排除「先改契约、后跑第一次 seal」的顺序可以避免它：本次 change 的第一次 seal 发生在契约修订
  **之前**，记录里才有那份过期身份。若确实如此，请把这条顺序约束写进 skill：**契约修订必须在首次
  `--seal` 之前完成**。
