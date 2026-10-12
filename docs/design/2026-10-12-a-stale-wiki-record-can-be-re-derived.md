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
  - `revalidateWikiRecord` **重算 hash**；`statement` **只在它确实是该页面自己的摘要时**才重算——资格判据是**写者与它产出的形状**：`validationTaskId === 'llmwiki-register'`，**且**只有一个来源，**且**该来源位于 `.llmwiki/` 下（判断子 `isWikiPageRef` 与写者共用同一个常量）。回答带 `statement: {recomputed, why}`，`why` 陈述**失败的那一条**（不把 id 当证据重述，也不拿"来源个数"去解释"来源位置"的决定——两轮独立复核各抓到一次）；
  - **来源文件已不存在 ⇒ 按名拒绝**；**同一来源被声明两次 ⇒ 按重复具名拒绝**（旧的排序拼接比较会把它报成"声明了却没记 hash"，那是假陈述）；
  - **`verified`、`rejected`、以及"授权被撤回"（记录仍带 `approvalEvent`）⇒ 按名拒绝**；"这条记录是否带着一个决定"由**一处**派生（`carriesDecision`），store 的替换守卫与再派生守卫**都问它**；
  - **store 不替换带决定的记录**：`writeWikiRecord` 是替换而非合并，所以守卫放在每个写者都经过的卡口、在锁内、按磁盘内容判断；**不可读的记录按名拒绝**（锁把任何读错误都交成空串，"读不到"与"不存在"曾经同形）；拒绝文**只点能走的路**（实测：`reject` 要求 `candidate`、`retire` 把 verified 变成 rejected——两条都不打开这扇门，所以只给出"整体清库"并写明前提）；
  - `stale` 记录 ⇒ 照旧回到 `candidate`（唯一被允许的转移）。
- **同一批修掉那句补救文案**：`candidate_missing` 的补救改成**真实**的路（`kata-cli wiki candidate` 列候选；记录存在、页面已动过就先 `kata-cli wiki revalidate --record <wiki-id>` 再重记闭包），使读者照着做**真的能收敛**。
- **帮助清单与调度器同派生**（同一处表面，同一个根因）：`wiki --help` 的 `help.commands` 与 `help.withheld` 合起来必须覆盖调度器接受的每个动词。实测这条断言**当场又抓到第二个实例**：`rebuild` 也不在清单里（它是有意不摆在第一排的破坏性命令）⇒ 它现在以 `withheld: { rebuild: '<reason>' }` **具名held**，而不是**静默缺失**。**边界披露**：这一条**不在**任何冻结 AC 的字面范围内（AC-4 管的是"补救里出现的命令"），我按"同一根因"在实现里一并修并把断言写进 AC-4 的选择器，理由写在用例注释里。
- **`statement` 只在该 statement 确实来自页面时才重算**（AC-1 的措辞比这更宽，这里写明真实的规则）：判据是**写者与它产出的形状**——`validationTaskId === 'llmwiki-register'`**且**只有一个来源**且**该来源位于 `.llmwiki/` 下（`isWikiPageRef`，与写者共用同一常量）；`distilled` 记录（以及任何别的写者写的记录）的 statement 是**变更自己的结论**，任何文件里都没有它 ⇒ 只刷新 hash、**不动 statement**。三个子句**各有用例**（AC-1 的选择器里），免得日后有人顺手开始覆盖别人的文字。
- **批量路径收集拒绝而不是抛出**：`revalidateStaleRecords` 原本在遇到拒绝时会**中途抛出**（前面几条已刷新、后面的丢失、调用者拿不到账）⇒ 改为 `{ revalidated, refused }`，CLI 把两者都印出来。用例在 AC-2 的选择器里（混合仓库：一条可再派生 + 一条来源已失）。
- **第 4 轮的九条：两条 major 是"我自己的文字"，不是机制**
  - **F7（major）**：我在第 3 轮**声称**修掉了 F9（设计文档里的旧规则），而**那一行没动**——我的改法替换了另一段，而留着的那一句仍写着 `inferProvenance`。**这是第三次"声明了没做到"**（第 2 轮 F4 是提交信息、第 3 轮是我自己发现的假成功写入），所以本轮起我把规则写在这里：**提交信息里的每一句断言都要先用 `grep`/`git show --stat` 或运行证明**，本轮提交前逐条实测过（见提交前的检查输出）。
  - **F1（major）**：批量拒绝让操作者"review it, then promote it again"——而 `promote` 要求 `candidate`，拒绝**只在 `stale` 上触发** ⇒ 这句话在它出现的每一个状态下都不可执行。改成点名 `retire`（该状态接受）并**用用例真的走一遍**，同时断言句子不再包含 `promote it again`（falsifier E20）。
  - F2/F4/F5/F6/F9 是**同类残留**（一处事实两处派生）与新出现的**空肢/空手守卫**：`wikiRecordFileName` 现在被 store 与漂移检查共用（此前只在漂移检查里用了一次，注释却声称"已一处派生"）；漂移走查改为**遍历 `sourceHashes ∪ sourceRefs`**（否则"声明了却没记 hash"的路径永不进入走查，而再派生的拒绝正对着它）；**不可读的 store 不再被读成空 store**（reader 只把 `ENOENT` 当缺席，其余经 `invalid` 通道上报，闭包据此回答 `unevaluatable_records` 而不是 `candidate_missing`）；帮助守卫的**下限改由答复自身派生**（不再是手写的 15 而扫描看到 20）；回答的**中间子句**（注册写者+两个来源）补了形状。
  - **边界（写下、不声称更多）**：① `--wiki <path>` 非默认时，`register` 读页面的根与它写进 ref 的 `.llmwiki/` 仍可能指向不同的目录——**预存在的语义问题**，需要先决定"自定义 wiki 根到底意味着什么"，本 change 不擅自改（记入队列）；② 帮助守卫的动词集合仍来自**源码文本扫描**：能看见行为保持的重命名造成的**集合缩小**（新下限会打红），但看不见**数量相同**的重命名——这条写在用例注释里；③ 记录文件的**写入路径**（`layoutWikiRecordPath`）与 `wikiRecordFileName` 仍是两处（一个产出路径、一个产出名字），二者由同一 `normalizeId` 决定；本 change 只统一了名字那半边。
- **第 2 轮的一条 major（F1）改变了"每条路"的含义**：`writeWikiRecord` 是**替换**（不合并），而 `ingest` 只守页面不守记录 ⇒ 页面不在时重新 ingest 会**把 candidate 写进一条已批准的记录**，作者自己却报 `refused: []`。守卫因此放在**每个写者都经过的那一个卡口**（store 内部、锁内、按磁盘上的内容判断），拒绝文点名状态与出路。**边界**：这让"重写一条已批准/已拒绝的记录"必须显式先 reject/retire 或 `wiki rebuild` 清库——是刻意的（替换是一次决定）。
- **同轮 F2/F3/F5 三处措辞与身份的精修**：重复来源**按重复具名**（旧的排序拼接比较会把它报成"声明了却没记 hash"，那是**假陈述**）；写者资格**连它产出的形状一起检查**（`llmwiki-register` + 单一来源且位于 `.llmwiki/` 下），回答里陈述真正检查过的事实；不可读记录的查找**按 store 自己派生的文件名精确比对**（`endsWith` 会让 `bca.json` 替 `a` 作答）。
- **F4 是一次被独立复核抓住的假声明**：`854f303` 的提交信息写"AC-2 的 fixture 时间戳已钉住"，而该提交只改了一行 import ⇒ 声明是**假的**（我的写入脚本当年无条件打印成功）。现在时间戳真的钉住，并用 `grep` 证明；教训写进本文件：**提交信息只能陈述被测过的差异**。
- **F7：`acceptanceMatrix` 被重新派生**——它此前仍指向计划里的路径（`record.ts`、AC-3 指向 `cli/wiki.ts`），而行为落在 `drift.ts` 与 store ⇒ 现在四行的 `implementationPaths`/`testPaths` 与实现一致（受管的 `tasks declare --field acceptanceMatrix`）。
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

## 5. 声明面（13 条路径，直接取自 task 记录）

本节此前手抄，于是漏掉了 `src/wiki/store.ts`（第 2 轮 F1 修复的主场）、把 `record.ts` 只写在散文里，计数与封存面相矛盾（第 3 轮 F10 实测）。现在这张表由 `task.json` 的 `ownedPaths` 生成。

| 路径 | 为什么在里面 |
|---|---|
| `docs/design/2026-10-12-a-stale-wiki-record-can-be-re-derived.md` | |
| `src/cli/wiki.ts` | |
| `src/wiki/closure.ts` | |
| `src/wiki/drift.ts` | |
| `src/wiki/lifecycle.ts` | |
| `src/wiki/llmwiki.ts` | |
| `src/wiki/record.ts` | |
| `src/wiki/store.ts` | |
| `tests/unit/a-re-derivation-refuses-a-record-without-a-source.test.ts` | |
| `tests/unit/a-re-derivation-refuses-what-it-must-not-touch.test.ts` | |
| `tests/unit/a-stale-record-can-be-re-derived.test.ts` | |
| `tests/unit/a-wiki-refusal-names-a-command-that-exists.test.ts` | |
| `tests/unit/wiki-revalidation.test.ts` | |

**未声明**：`.llmwiki/concepts/a-capability-a-reader-cannot-find.md` 与 `.llmwiki/index.md`（Wiki 页面属于知识闭环，不是被本 change 修改的代码内容；`.llmwiki` 属于仓库的 never-content 策略名）。`src/wiki/record.ts` 在本 change 里**被改动了**（`carriesDecision`、`isWikiPageRef`、`wikiRecordFileName`——第 2/3 轮修复引入的三处共享派生都住在它里面），所以它在声明面里是诚实的；本节早先的版本曾写它"未被改动"，那是第 3 轮修复时留下的假陈述，第 4 轮独立复核 F8 实测指出。
