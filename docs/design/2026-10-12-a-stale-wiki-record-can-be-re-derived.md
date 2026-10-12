# 设计：`a-stale-wiki-record-can-be-re-derived`（I-27）

> profile：`current_worktree / tdd / strict`。每条 AC 一个**独立选择器文件**（`dedupeChecks` 会把共用文件折叠——本仓已三次付学费）。

## 1. 实测的问题（先证据，后设计）

| 事实 | 位置 |
|---|---|
| Wiki 闭包只接受 `candidate`/`verified` | `src/wiki/closure.ts:92` |
| 记录的来源漂移检查会把记录**标成** `stale` | `src/wiki/drift.ts:47-59`（`markRecordStale`，单向） |
| `register` 遇到已存在的 id **跳过**（不重算 `sourceHashes`） | `src/wiki/llmwiki.ts:358` |
| `promote` 要求当前状态恰为 `candidate` | `src/wiki/promotion.ts:25` |
| `wiki verify` 只报告（`checked/intact/stale/missing`） | `src/cli/wiki.ts:167` |
| `wiki refresh --task` 产出**给宿主 agent 的再派生包**，不改记录 | `src/cli/wiki.ts:153` |

**后果（实测）**：44 条记录中 4 条 `stale`。`llmwiki-concepts-a-test-that-never-reaches-the-code` 的页面（`.llmwiki/concepts/a-test-that-never-reaches-the-code.md`）在注册后被**合法编辑**（页面 hash 现为 `2b9d295a…`，记录里是 `ca56868f…`），于是记录被标脏，而 `unique-copies-is-one-model` 的 Wiki 闭包（`decision: captured`，页面对、也在 index 里）**永久无法再通过** ⇒ Verify 报 `candidate_missing`，该任务从 10-02 起停在这里。

**门禁给的补救是错的**：`wikiClosureRemedy`（`src/wiki/closure.ts:64`）说「用 `kata-cli wiki list` 列出候选」——**该命令不存在**（只有 `wiki candidate`）；而「用一个存在的 id 重新记录闭包」等于让它 named 一个**不是它 capture 的东西**：那是失真，不是修复。

一句话：**状态机单向，而闭包只认两个可用状态**；页面是散文本体、记录是它的派生，派生必须能跟着本体重算——而现在没有这条路。

## 2. 决定

- **采用**：新增一条**显式的、内容驱动的**再派生命令 —— `kata-cli wiki refresh-record --id <record-id> [--task <task-id>] --by <actor> --role <role>`：
  - 读该记录的 `sourceRefs`，**按当前文件内容**重算 `sourceHashes` 与 `statement`（`statement` 仍取页面 frontmatter/首段摘要，与 `register` **同一个派生函数**）；
  - `status` 由 `stale` 回到 `candidate`，`lastVerifiedAt`/`updatedAt` 前进；
  - 来源文件已不存在 ⇒ **按名拒绝**（不能把一条没有来源的记录变回可用）；
  - `verified` 记录 ⇒ **按名拒绝**（授权状态不由一条重算命令静默降级或悄悄续期）；
  - 记录不存在 ⇒ 按名拒绝。
- **不采用 甲（让 `register` 在内容变化时刷新）**：它把「幂等注册」变成「内容驱动刷新」，语义更强但**要改 `src/wiki/llmwiki.ts`，而该文件被 `enrich-packet-outside-the-task-store`（review 中）声明** ⇒ 会移动它的 revision。**取舍**：先解阻塞（本 change 的关键路径），把「`register` 应否在内容变化时刷新」记为后继项。**边界**：本 change 不声称 `register` 的语义是对的。
- **同一批修掉那句补救文案**：`candidate_missing` 的补救改成真实命令（`kata-cli wiki candidate`，再加上本 change 新增的 `wiki refresh-record --id <id>`），使读者照着做**真的能收敛**。

## 3. 验收（4 条，各一个独立选择器）

| id | 属性 | 选择器 |
|---|---|---|
| **AC-1** | 一条 `stale` 记录**能按其当前来源被再派生**：`sourceHashes` 与 `statement` 重算为**当前页面内容**的派生、状态回到 `candidate`；且**重算之后**页面再被编辑仍会重新被判 `stale`（证明它是真的重算，不是把状态改成「可用」） | `tests/unit/a-stale-record-can-be-re-derived.test.ts` |
| **AC-2** | 来源文件**不存在**时按名拒绝（原因含该路径），记录保持原状 | `tests/unit/a-re-derivation-refuses-a-record-without-a-source.test.ts` |
| **AC-3** | `verified` 记录与不存在的 id 都**按名拒绝**，且被拒绝的记录**一个字节都没变** | `tests/unit/a-re-derivation-refuses-what-it-must-not-touch.test.ts` |
| **AC-4** | 闭包门禁给出的补救**点名真实命令**：对每一种失败原因，把补救里出现的命令**逐个真的跑一遍**（CLI 入口），断言不是 usage 类拒绝；`wiki list` 不再出现在任何补救里 | `tests/unit/a-wiki-refusal-names-a-command-that-exists.test.ts` |

每条 AC 的**单点变异**（写进 ledger 的 falsifier）：
- AC-1：把「重算 hash」换成「只置状态」⇒ 用例中「再编辑仍会 stale」的那半变红。
- AC-2：删掉来源缺失的拒绝 ⇒ 用例红。
- AC-3：让 `verified` 也走重算 ⇒ 用例红。
- AC-4：把 `wiki candidate` 换回 `wiki list` ⇒ 用例红。

## 4. 边界（写下，不声称更多）

- 再派生**不改页面**，也不做「页面变了、记录该说什么」的语义判断（那是宿主 agent 的 `refresh` 包的工作）；它只让**派生**追上本体。
- 再派生**不提升权威性**：结果只是 `candidate`，不代替 `promote`（后者要求 Judge 过的任务与一致的来源哈希）。
- 不解决「闭包是否应绑定它 capture **当时**的页面 hash」这一语义问题 —— 记为后继项（今天的语义是「闭包 named 一条当时可读的记录」）。

## 5. 声明面（写入 ownedPaths 的路径）

`src/wiki/drift.ts`、`src/wiki/record.ts`、`src/cli/wiki.ts`、`src/wiki/closure.ts`（仅补救文案）、4 个选择器文件、本设计文档。**刻意不动** `src/wiki/llmwiki.ts`（避开在飞 change 的 revision）。
