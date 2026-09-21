# 已记录：`review-record-integrity` 的第四轮独立审查结论

**状态：已记录，未修复。任务在本轮结束后关闭，问题作为架构重构的输入移交给
`docs/design/2026-09-21-adversarial-execution-control-optimization.md`。**

## 这轮做了什么

第四轮 strict verify 的独立 adversarial pass（cold，190 tool calls，2401s）在
`revision-e2d4ee3029bd7021` 上记录 **6 条 finding：5 major + 1 minor**。本轮**不修复**，
按要求记录后结束任务线。

Verify 自身的结果是 **PASS，5/5 AC 全通过**（不再是 `revision_superseded`）；被记录的
adversarial finding 不改变 AC 判定，它们是对**已实现机制**的证伪。

## 唯一根因：变更面锚在「声明」上

前两轮修的缺陷是「记录依赖 `git status`，提交后变空」。本轮修好了那一半，
但独立审查证明**修复本身沿着同一个错误的依赖方向前进了一步**：

```
revision.pathDigests 在 seal 时只对 ownedPaths 计算
        ↓
契约的记录与 delta 都以「声明」为世界边界
        ↓
声明外的变更在提交后同时逃过两个来源（digest 表不含它，git status 也不报它）
```

具体证据（均通过 shipped CLI 在 `tmp/` 的临时 git 仓库复现）：

| finding | 严重度 | 可复现事实 |
|---|---|---|
| `change-record-omits-committed-unowned-paths` | major | 一次提交改了 `.gitignore`、`docs/guide.md`、`src/a.ts`；record 报 `changedPaths: ['src/a.ts']`、`changedOutsideOwnership: []`，而 `git log -1 --name-only` 列出三个 |
| `delta-brief-omits-committed-unowned-paths` | major | brief 声称 "complete difference" 只含 `src/a.ts`；`revision digests --since`（gate 自己的比较）同样只报它 |
| `recorded-delta-scope-empties-when-the-brief-used-a-default-base` | major | brief 的 delta 是 `['src/added.ts']`，record 存的 scope 是 `[]`，gate 答 `delta_stale` —— **拒绝 kata 自己刚签发的 brief** |
| `batch-derived-delta-brief-records-as-full-so-the-gate-never-checks-its-coverage` | major | 平台自动选的 delta 轮（batch base）被记为 `scope: {kind:'full'}`，`deltaCoversChange` 从不运行；本任务所有 issued brief 的 `since` 都是 none |
| `declared-test-guard-refuses-a-test-the-brief-tells-the-reviewer-to-read-and-run` | major | permit set = matrix 声明 ∪ **当前** revision 的 `changedPaths`；`task.json` 声明 9 个测试文件，其中 3 个两个来源都不含。A/B 同一 verdict：散文描述路径 → satisfied；写路径字面量 → `undeclared_test_path` |
| `judgement-refusal-still-misses-multiplier-and-vague-count-phrases` | minor | 放宽后的 `COUNT_WORD` 仍放过 `A couple of paths changed`、`dozens of findings were raised`、`several files changed` |

## 为什么这不属于「继续修 `review-record-integrity`」

三条独立理由，都指向架构而非补丁：

1. **修的是定义，不是实现。** 让 record 与 delta 看见声明外路径，等于改变「revision 的内容身份
   由什么构成」。这是 AC-2/AC-4 的**语义**变更，不是 defect 修复；在已有 AC 下继续改会让
   acceptance 名不副实（契约冻结后改语义正是本 change 自己禁止的行为）。
2. **第三条 finding 是自指矛盾。** `recorded-delta-scope` 与 `batch-derived-delta-brief` 说明
   「brief 声明什么 / record 记录什么 / gate 校验什么」三者在 delta 轮上从未对齐。这需要一个
   **单一来源的 scope 契约**，而不是在 record 侧再加一次重算。
3. **第五条 finding 是自伤。** 反抄袭守卫拒绝引用 brief 自己让 reviewer 去读的测试文件——
   守卫在惩罚诚实报告、奖励模糊措辞。这与 `docs/verfify.md` 的诊断（「手写记录没有校验」）
   是同一结构，只是位置从作者散文移到了 reviewer 的引用。

## 交接给重构的具体输入

以下五点应作为 `adversarial-admissibility` 重构的**验收项**，而非新 change 的可选改进：

1. **变更面必须由内容身份定义，而非由声明。** 需要一个不依赖 `ownedPaths` 的
   revision 内容快照（例如 base→current 的完整路径差异），使「声明外且已提交」的变更不可逃逸。
2. **一对契约只有一个 scope 来源。** brief 与之绑定的 record 必须共享同一个不可变 scope 对象；
   签发时确定，记录时**读取**而非重算。
3. **平台自动选择的 delta 轮必须与显式 `--since` 等价。** `since` 必须是 issued brief 的必填字段，
   否则 `evaluateDeltaScope` 会把它当 full 放行。
4. **测试引用的许可集必须来自任务声明，而非来自「当前 revision 恰好含有什么」。**
   一个被声明、被 hash、被 brief 指向的测试文件，任何一轮都应可引用。
5. **守卫的假阴性同样要测。** 第五条（以及前几轮的 `undeclared_test_path`）都是守卫伤害
   诚实报告；`docs/verfify.md` 的「不能因为成本优化降低 critical recall」应当扩展为
   「守卫不得惩罚准确引用」。

## 与本轮修复的关系

本轮修复（`1a9d239`，seal `revision-e2d4ee3029bd7021`）**是净改进**：它把
`changedPaths` 从「0，静默」变为「12，真实」，并修掉了 `COUNT_WORD` 的枚举漏洞与
`tasks.md` 的陈旧计数。独立审查没有推翻这些，只是在它们之上指出：**同一个依赖方向
还有一层更深的问题**，而那一层属于架构。
