# 被替换的一轮必须被归档

**日期**：2026-10-11
**来源**：本 change（`the-review-loop-carries-its-defect-classes`）结束时的记录核对——**十轮独立审查里，第 4 轮与第 6 轮在 `.kata` 里没有受管记录**；队列项 **I-13**（与 **I-9** 同族）。
**用户决定**：先修 I-13，再归档那个 change（选项 2）。**范围收在一处**，以便该 change 的 Judge PASS 不被作废（见 §5）。
**profile**：`current_worktree / tdd / strict`（它动的是复核记录的**身份与归档**，不能放松任何门禁）。

---

## 1. 实测的问题

十轮审查，每一轮都走了受管的 `review --result-file`。盘上的结果：

```
review-history.jsonl  7 行 → 第 1,2,3,5,7,8,9 轮（缺 第 4、6、10 轮）
review-rounds.jsonl   7 行 → 第 1,2,3,5,7,8,10 轮（缺 第 4、6、9 轮）
grep 'R6-F1' .kata/tasks/<id>/            → 0 命中
grep 'R4-F1' .kata/tasks/<id>/            → 只在第 5 轮 R5-F3 的正文里被**提到**
grep 'R6-F2|F3|F4' .kata/tasks/<id>/      → 只在第 7 轮 rl-r7-F1/F2 的正文里被**提到**
```

**引用不是记录**：第 4、6 轮没有自己的受管记录。findings 本身还在 `tmp/` 与对话里（没有一条无人负责），但**受管存储无法回答「哪一类在复发」**——而这正是 `the-review-loop-carries-its-defect-classes` 存在的理由（A-1：102 轮只剩 56 条 finding，同一形状）。

## 1bis. 先测量，再改（**我的第一条根因假设被自己的测量推翻**）

在写实现之前我用 fixture 驱动了两条我以为是元凶的路径（`tests/unit/every-rounds-findings-survive-the-next-record.test.ts`，逐条实跑）：

| 路径 | 今天的实测行为 |
|---|---|
| 同一 revision、同一请求上的**第二轮**被记录 | **拒绝**（`A review result is already recorded for this revision, for this request …`）——**不是**静默替换 |
| 两轮之间**内容移动并重封** | 通过 ✔：旧记录被归档，`review-history.jsonl` 得到一行含它自己的 findings |

⇒ 我心里那两条候选路径**都不产生丢失**。第 4、6 轮记录消失的**确切路径我没有复现出来**，所以本文不把它当作已证根因（这一点必须写在设计里，而不是拿一个听起来合理的机制顶上去）。

**已证的两件事**（都由实跑支撑，构成本 change 的正当理由）：

1. **同一 revision 上的第二轮被拒绝**，而拒绝给出的补救是"移动问题"（改 claim / 改 plan → re-freeze）。在真实使用中这迫使我在第 10 轮**为了一次记录而去重述 C-3**——一次与内容无关、纯为开槽的动作。**第二轮的合法路径不存在**，这才是被证实的缺陷。
2. **一旦放行第二轮**，它必然要**替换**上一条记录 ⇒ **归档就成了这条新路的承重条件**：今天那条拒绝恰好把丢失**藏在门外**，而放行它就把丢失的窗口打开。所以 AC-2/AC-4 不是装饰，它们是 AC-1 的必要配套。

**仍然不假装**：第 4、6 轮的丢失**记为未复现的报告**（队列 I-13 保留，附本次未能复现的夹具）；本 change 不声称"已修那一例"，只声称"替换必归档 + 同槽能区分两轮"。

## 2. 根因（源码级）

**记录被放在「记录时刻的 revision」槽里，而槽的身份用它来判断「这是不是同一轮」。**（`src/workflow/orchestrator.ts`）

```
1735  existingRecord = { revisionId, manifestHash, codeManifestHash, … }   ← 从 review.json 读
1746  placeholder = isReviewPlaceholder(existing.record)
1764  currentSubject = ledgerNow.subjectAsDeclared?.revision
1765  answeredSameRequest = existingRecord.subjectRevision === currentSubject
1768  if (!placeholder && bindsToRevision(existingRecord, binding) && answeredSameRequest)
1769      → 拒绝「A review result is already recorded for this revision, for this request」
1806  reviewedRevisionId = placeholder ? existing.record.revisionId : binding.revisionId
1817  if (!placeholder && existingRecord 非空 && (!bindsToRevision(...) || !answeredSameRequest))
1820      → appendFile(review-history.jsonl, …)      ← **只在「内容移动」或「请求不同」时归档**
```

两条事实合成这个洞：

1. `revisionId` 写进记录时取的是**记录时刻**在手的 revision（I-9）；
2. 于是当我在**重封之后**记录上一轮的结论时，两轮的记录落在**同一个 (revision, request) 槽**里 ⇒ `bindsToRevision` 与 `answeredSameRequest` **同时为真** ⇒ 新记录**就地替换**旧记录，而 1817 的归档条件不成立 ⇒ **旧那一轮无声消失**（1817 的注释本身写着「a record whose content moved is superseded just as surely」，但它没有覆盖「同一槽里的另一轮」）。

第 10 轮那次拒绝（`A review result is already recorded for this revision, for this request. A second round needs a different request…`）是同一判据的另一面：**它把「同一轮被记两次」和「第二轮审了同一内容同一请求」当成同一件事**。

## 3. 修法

1. **槽的身份改为「这一轮审的是哪个 revision」**：`reviewedRevisionId`（该值已经算出来，见 1806）成为记录的槽键；替换判定用它而不是「记录时刻的 revision」。两轮审同一 revision、同一请求 ⇒ **是两轮**，不是一轮。
2. **任何替换都要归档**：把 1817 的条件改为「被替换的记录与新的记录不是同一条（不同的 reviewedRevision 或不同的请求或不同的 finding 集）」⇒ 归档并写明 `supersededBy`。
3. **拒绝只针对「同一轮」**：同 reviewedRevision + 同请求 + 内容未动 且 已经有一条记录 ⇒ 仍然拒绝（这是防止一条结论被记两次），拒绝文案点名这个状态并给出能改变它的补救（改一个 claim / 改 plan → re-freeze；或动内容 → 重封）。
4. 记录里同时保留 `revisionId`（内容绑定）与 `reviewedRevisionId`（它审的是谁），**两者都可以不同**，读的人能分清。

## 4. 验收项

| AC | 属性 | 选择器（各自独立文件） |
|---|---|---|
| **AC-1** | 记录按**它审的 revision** 归档：同一 revision、同一请求下的两轮是**两条**记录 | `tests/unit/a-record-is-filed-under-the-rounds-revision.test.ts` |
| **AC-2** | **每一条替换路径**都把被替换的记录追加进 `review-history.jsonl`（另请求 / 内容移动 / review 入口取代）；行是**整条记录展开**加两个后继字段——`supersededByRevision`（取代它的那次封存）与 `supersededBy`（**只有问题确实移动时**才写的那个问题） | `tests/unit/a-replaced-round-is-archived.test.ts` |
| **AC-3** | 只有**同一轮**（同 reviewedRevision + 同请求 + 内容未动）被记两次时才拒绝，文案点名该状态 | `tests/unit/the-same-round-recorded-twice-is-refused.test.ts` |
| **AC-4** | 一条记录的 findings 能活过下一条记录：同一 revision 上 N 轮之后，history 有 N−1 行，且每轮的 finding id **恰好出现一次** | `tests/unit/every-rounds-findings-survive-the-next-record.test.ts` |

四个 AC 各自独立选择器（共用文件会被 `dedupeChecks` 折叠——本仓已因此三次留下没有证据的验收项）。

**单点变异**（每条都要**先确认落上**再采信读数）：

1. 槽键改回「记录时刻的 revision」⇒ AC-1、AC-4 红；
2. 归档条件改回 `(!bindsToRevision || !answeredSameRequest)` ⇒ AC-2、AC-4 红；
3. 拒绝条件放宽成「只要已有记录就拒绝」⇒ AC-1 红（第二轮被误拒）；
4. 把被替换记录的 `findings` 写成空数组 ⇒ AC-4 红（这正是第 4、6 轮身上发生的事）。

## 5. 范围与代价（写清楚）

- **本 change 只动 `src/workflow/orchestrator.ts`**（归档与槽判定都在那里，实测：`grep review-history.jsonl src/` 只有 1820 与 2259 两处）⇒ `the-review-loop-carries-its-defect-classes` 的 27 条声明路径**不含**该文件 ⇒ 它的 Judge PASS **不被作废**，可以在本 change 之后归档（这是用户选 2 时最省的形态）。
- **不修 `review-rounds.jsonl` 的完整性问题**（那在 `src/quality/repair.ts`，属该 change 的声明面 ⇒ 修它就会作废它的认证）：作为 **I-13 的第二面**留在队列里，交 successor。本 change 的边界一节会把这一点写明，不含糊。
- `orchestrator.ts` 同属在飞的 `unify-…` 与 `the-identity-is-computed-where-the-change-is` 的声明面 ⇒ 它们各自的认证会因本 change 移动，代价是它们各自的一次重封（`unify-…` 本来就在等重封）。
- 成本：实现 3–5 h（4 个选择器 + 三条记录路径的接线）、全套回归 ≈7 min、封存+Verify+账本 ≈12 min、一轮独立审查 ≈25 min。

## 6. 边界（不假装做到）

- 本 change **不**保证「任何丢弃都有人看见」——它保证的是：**被替换的一轮会被归档**，以及**同一槽里能区分两轮**。已经丢掉的两轮（第 4、6 轮）无法回溯补写（项目禁止手写 `.kata` 记录），且**其确切路径未复现**：本 change 只关闭了放行第二轮之后新出现的那个窗口，并保留那份未复现的报告。
- 本 change **不**动 `review-rounds.jsonl`（见 §5）。
- 本 change **不**改任何门禁强度：拒绝条件只是变精确（同槽同请求同内容才拒），归档只会让记录更完整。


---

## 9. 第 3 轮后的更正与边界（2026-10-11）

**修法变了，文档随之更新**（独立审查 N4 指出文档与代码不一致）：

- 后继者是**两个字段**而不是一个：`supersededByRevision`（取代它的那次**封存**，可在 `.kata/tasks/<id>/revisions/` 解析）与 `supersededBy`（**只有问题确实移动时**才写的**问题** revision）。两处含义各自单一，不互相顶替。
- **拒绝是有条件的**（R3-F1，major）：只有「该记录**绑定当前内容**」时才拒绝重入。早期版本对任何 approved 记录都拒绝，于是**通过门禁后被返修并重封的 change 再也无法复核**——而拒绝文案给出的补救（改内容）恰好是无效的。现在的形态：内容移动 ⇒ 该接受结论所回答的内容已不存在 ⇒ 允许重入，并在入口把那条记录**归档**（移动，不抹掉）。
- **"accepted" 只有一个读法**（R3-N3）：`status === 'approved'` **且** 不是 placeholder **且** `reviewEvidence` 非空——与 `navigation.ts` 的 `reviewReady` / `invalidReviewApproval` 同一问法，避免路由让操作者去 `/kata-review` 而入口拒绝，两条路互相矛盾。
- **一次指针读**：入口的身份与上面那个拒绝共用**同一次** `readReviewDecisionSnapshot`（套件持有"一次读"的不变量，且清单禁止在工厂外裸读指针），因此那次读被移到 transition **之前**，拒绝也就在任何写入之前判定。

### 写下来的边界（不假装做到）

| # | 边界 | 来源 |
|---|---|---|
| B7 | **2026-10-11 更正：我原先记错了这一条。** 原文写「锁内那份 belt 在已交付的夹具里不可达，因此没有任何声明的 falsifier 能覆盖它」——**被第 10 轮证伪**：`options.guard` 是调用方提供的钩子，它的 `check` 在 `cmdReview` 里跑在**前置拒绝之后、锁之前**，所以守卫可以在途中把记录改成 accepted，belt 随后在**选择器可以观察到**的位置触发。现在它由 `a-refusal-names-the-road-that-works.test.ts` 的 belt 用例 + **E21** 覆盖；belt 的存在目的仍是覆盖「两次读之间记录被移动」的 TOCTOU | R3-N1 → R10-F1 更正 |
| B8 | `review-history.jsonl` 在 `src/` 里**没有 reader**（只有两个 writer）；行是整条记录 ⇒ 字段齐全的归档行**将来**可能被误当活动记录读。现在没有这个 site，但这个陷阱是潜在的 | R3-N2 |
| B9 | 归档行**不**保证在语料层面唯一标识"哪一轮"——它记的是那一轮读过的 revision 与它回答的问题；同一 revision 上的两轮在行里只能靠 findings/archivedAt 区分 | 本文件 §7 的未复现报告 |
| B10 | **`bindsToRevision` 只按 `revisionId` 就判"绑定"**（`verdict-binding.ts:163`，且当两侧都能给出 `candidateFreezeSha256` 时以它为准）。因此"同一个 id、不同内容"这种状态**产品不会产生**（id 由内容派生）——独立审查提出的"把绑定收窄成只比 id"这个变异**与正确实现在可产生的状态上等价**，没有任何选择器能区分它。这是**边界**，不是待修项：正确的实现在内容移动时给出新 id（E9 覆盖的方向），而收窄版在同样情形下也拒绝，只有人造状态（id 相同、manifest 不同）才分得开 | R4-N3 |
| B11 | 入口的**指针读**移到了 `guardTransition` 之前（两条不变量所迫）；因此"守卫期间落地的封存"现在会在任务已经进入 `review` **之后**才拒绝。锁内的提交会重新校验那次快照，所以**没有任何写入使用过期的绑定**；变化只是**拒绝与状态移动的先后**。 | R4-N2 |
| B12 | `isAcceptedReviewRecord` 现在与其它所有"批准算不算数"的读者**逐字同问**（`status === 'approved'` + 非空 `reviewEvidence`）。因此"批准的 placeholder 形状"（产品不会产生）算作已批准并拒绝重入——与 `navigation.ts` 的读法一致；若将来要让入口更严，必须**同时**改那些读者，否则又是第四个读法。 | R4-N1 |
| B13 | **一个"被拒绝的轮次"不留痕迹**：拒绝不写任何东西（本仓 AC-7 的规则），所以 store 无法区分"这一轮没被尝试过"与"尝试过但被拒"。今天把四个历史结果重放进同一个 revision 时，第 1 个成功、第 2–4 个被拒 ⇒ 盘上只有 1 行历史 + 1 条当前记录，另两轮的 findings 只在操作者的报告里。机制**应当**如此（拒绝是纯的）；缺的是"被拒的尝试"这个事实的**位置**，它只能落在操作者的说明里，而不是 store 里 | R5-N2 |
| B14 | **入口拒绝被"接受结论"顶掉，结果路径不拒绝**：入口对"approved 且仍绑定当前内容"的记录拒绝对待，但结果路径在**请求移动后**（restate + re-freeze）会把 approved 记录归档并记录新结果 ⇒ 同一件事两条路两个答案；入口那句话（"would move an accepted conclusion out of the store"）是关于**那条路**的事实，不是关于 store 的规则。现在的处置：入口文案已改为精确表述（并给出真正可走的路），规则写在这里。**更深一层的问题**——结果路径是否也应拒绝顶掉 approved 记录——是**门禁语义**决定（会改变"接受结论能否被什么取代"），留给你明确选择，我不自行收紧 | R5-N4 |

## 行为变更（第 12 轮实测，未写进任何 AC，故记录在此）

把"移动"移进决策锁内，除了修掉"拒绝会移动任务"之外，还**顺带**改变了它失败路径上的行为：迁移前，
`cmdReview` 先 `transition(review)` 再 `commitReviewDecision`，所以当提交随后返回 `missing`（revision 缺失）、
`unreadable`（不可解析）、`moved`（指针移动）或回调在损坏记录上抛错时，**任务已经被移动**；迁移后这些拒绝都
**留在原相位**。实测（第 12 轮）：`S7`/`S8`（revision 缺失/不可读）`hardVerify → hardVerify`、状态字节不变、无 placeholder；
`S6`（记录损坏）`review → review`、状态字节不变。

方向与第 11 轮的缺陷相反，且是改进（一次失败的进入不再"半移动"任务），但它是一次**未被 AC 陈述的行为变更**——
本条即为记录；若要把它变成受守卫的属性，那是一份新的验收契约（后继 change），不是本 change 的修补。

另记一条：`E2` 与 `E13` 的变异**逐字节相同**（入口归档条件的同一行），只是命令不同（各自的文件都能打红）⇒ 两者
都承重、但**不是相互独立的见证**；保留是为了覆盖两条不同的用例路径，记录以免被当作两份独立证据。
