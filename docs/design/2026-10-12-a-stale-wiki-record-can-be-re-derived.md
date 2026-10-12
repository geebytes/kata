# 设计：`a-stale-wiki-record-can-be-re-derived`（I-27）

> profile：`current_worktree / tdd / strict`。每条 AC 一个**独立选择器文件**（`dedupeChecks` 会把共用文件折叠——本仓已三次付学费）。

## 1. 实测的问题（先证据，后设计）

> **本节先改过一次。** 初版写的是「**没有任何受支持的命令**把 `stale` 变回可用」——**那是错的**，我按 `kata-cli wiki --help` 的命令清单枚举，而那份清单漏了一个真实存在的动词。更正如下（全部实测）。

| 事实 | 位置 / 实测 |
|---|---|
| 再派生**存在**且**可用** | `src/cli/wiki.ts:97-112`（`wiki revalidate --record <id> \| --all`）＋ `src/wiki/drift.ts:103`（`revalidateWikiRecord`）。实测：`kata-cli wiki revalidate --record llmwiki-concepts-a-test-that-never-reaches-the-code` → `{status: candidate, refreshed: [.llmwiki/concepts/a-test-that-never-reaches-the-code.md]}`，记录里的 hash 由 `ca56868f…` 刷新为 `2b9d295a…` |
| **帮助清单漏掉它** | `src/cli/wiki.ts:41` 的 `commands:` 数组没有 `revalidate`，而调度器接受它 ⇒ 照帮助文本枚举命令的读者（我）会得出「这条路不存在」 |
| 闭包只接受 `candidate`/`verified` | `src/wiki/closure.ts:92` |
| 门禁给的补救**点名不存在的命令** | `src/wiki/closure.ts:64`：`wiki list`（只有 `wiki candidate`），且**不点名** `wiki revalidate --record <id>` 这条真路 |
| `revalidateWikiRecord` 的三个 fail-open 行为 | ① 只重算 `sourceHashes`、**不重算 `statement`**（`drift.ts:126-136`）；② **无条件** `status: 'candidate'`（`:130`）⇒ **`verified` 记录被静默降级**；③ 来源文件**已消失**时保留旧 hash 仍返回 `candidate`（`:119-123`）⇒ 闭包会接受一条**来源已不存在**的记录 |
| 后果（实测） | `unique-copies-is-one-model` 的 Wiki 闭包卡在 `candidate_missing`；跑一次 `wiki revalidate` 之后它的 Verify 错误变成「repair evidence or blocking findings」（wiki 轴已解除，剩下的是它的 revision 被后续提交 superseded ⇒ 需重封） |

一句话（更正后）：**这条路存在，但两个面向读者的表面各自说谎**——帮助清单把存在的动词藏起来，补救文案把一个不存在的动词推荐出来；而这条路上还有三个 fail-open 行为，使"再派生"能把 `verified` 静默降级、也能把来源已消失的记录变回可用。

## 2. 决定

- **采用**：**不新增命令**，而是在既有 `wiki revalidate` 这条路上修掉三个 fail-open 行为，并让它对外可枚举：
  - `revalidateWikiRecord` **同时重算 `statement`**（用与 `register` **同一个派生函数**），使「记录描述的是当前页面内容」成立；
  - **来源文件已不存在 ⇒ 按名拒绝**（不再保留旧 hash 冒充可用）；
  - **`verified` 记录 ⇒ 按名拒绝**（授权状态不由一条重算命令静默降级）；
  - `stale` 记录 ⇒ 照旧回到 `candidate`（这是唯一被允许的转移）。
- **不采用 甲（让 `register` 在内容变化时刷新）**：它把「幂等注册」变成「内容驱动刷新」，语义更强但**要改 `src/wiki/llmwiki.ts`，而该文件被 `enrich-packet-outside-the-task-store`（review 中）声明** ⇒ 会移动它的 revision。**取舍**：先解阻塞（本 change 的关键路径），把「`register` 应否在内容变化时刷新」记为后继项。**边界**：本 change 不声称 `register` 的语义是对的。
- **同一批修掉那句补救文案**：`candidate_missing` 的补救改成**真实**的路（`kata-cli wiki candidate` 列候选；记录存在、页面已动过就先 `kata-cli wiki revalidate --record <wiki-id>` 再重记闭包），使读者照着做**真的能收敛**。
- **帮助清单与调度器同派生**（同一处表面，同一个根因）：`wiki --help` 的 `help.commands` 与 `help.withheld` 合起来必须覆盖调度器接受的每个动词。实测这条断言**当场又抓到第二个实例**：`rebuild` 也不在清单里（它是有意不摆在第一排的破坏性命令）⇒ 它现在以 `withheld: { rebuild: '<reason>' }` **具名held**，而不是**静默缺失**。**边界披露**：这一条**不在**任何冻结 AC 的字面范围内（AC-4 管的是"补救里出现的命令"），我按"同一根因"在实现里一并修并把断言写进 AC-4 的选择器，理由写在用例注释里。
- **`statement` 只在该 statement 确实来自页面时才重算**（AC-1 的措辞比这更宽，这里写明真实的规则）：`ingested` 记录的 statement 就是页面的摘要 ⇒ 跟着页面重算；`distilled` 记录的 statement 是**变更自己的结论**，任何文件里都没有它 ⇒ 只刷新 hash、**不动 statement**。判定问 `inferProvenance`（既有的那一处派生），不从 `sourceRefs` 的形状猜。这条**反向情形也写成用例**（AC-1 的选择器里），免得日后有人顺手开始覆盖 distilled 的文字。
- **批量路径收集拒绝而不是抛出**：`revalidateStaleRecords` 原本在遇到拒绝时会**中途抛出**（前面几条已刷新、后面的丢失、调用者拿不到账）⇒ 改为 `{ revalidated, refused }`，CLI 把两者都印出来。用例在 AC-2 的选择器里（混合仓库：一条可再派生 + 一条来源已失）。
- **声明面追加两条**（原本承诺不动 `llmwiki.ts`，实现时发现做不到而不假装）：`src/wiki/llmwiki.ts`（`statementForPage` 的唯一派生必须由 register 与 revalidate 共用，否则就是第二份实现）与 `tests/unit/wiki-revalidation.test.ts`（它钉的是被本 change 改掉的旧契约）。**冲突已披露**：`src/wiki/llmwiki.ts` 被 `enrich-packet-outside-the-task-store`（review 中、已 approved）声明 ⇒ 那个任务的 revision 会因本 change 而 supersede。

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
