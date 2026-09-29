# Bounded review convergence

**Change:** `bounded-review-convergence`  
**日期：** 2026-09-28  
**父设计：** [`2026-09-28-skill-first-independent-review-protocol.md`](./2026-09-28-skill-first-independent-review-protocol.md)

本文只实现父设计 §8（有界审查、finding 分级与循环关闭）在**本仓库实测状态下**有意义的那一部分。设计阶段先做了状态核对，结论与父设计的假设不同，因此下面先写实测，再写设计。

## 1. 实测状态

### 1.1 “哪些严重度拒绝批准”这条规则有三处派生

| 位置 | 规则 |
|---|---|
| `src/workflow/repair-entry.ts:132-135` | `severity === 'blocking'`，加上 `reviewMode === 'strict'` 时的 `major` |
| `src/workflow/navigation.ts:419,429` | `blockingFindings > 0`，加上 `reviewMode === 'strict' && majorFindings > 0` |
| `src/workflow/distill-gates.ts:85` | 只要 `severity === 'blocking'`（不区分档位，也不看 `major`） |

三处都以字符串字面量 `'strict'` 判断档位，因此 `security` 档在**每一处**都不比 `strict` 更严：`security` 的 `major` finding 既不授权修复、也不拒绝清理。这与 `src/kernel/policy.ts:104-135` 里三档策略（`standard` / `strict` / `security`，后者 `reviewers: 2`、`quorumOn: ['always']`、`assuranceFloor: 'sandboxed'`、多出两个 risk class）表达的强度顺序相反。

另外，`workflowProfile.reviewMode` 的取值是 `std | strict | security`，而内核档位名是 `standard | strict | security`：同一个概念两套拼写，映射关系写在谁那里也没有。

### 1.2 这条规则今天没有生产者

`review.json` 的 `findings` 在本仓库内只有写入 `[]` 的地方，没有任何地方写入 finding：

- `src/workflow/orchestrator.ts:1595-1606` 进入 review 时写 `findings: []`；`:1544` 批准时原样保留 `existing.findings`。
- `kata-cli adversarial record`（旧记录器）与 `src/quality/reviewer.ts` 的写入半已删除（`src/cli/ops.ts:167-186`、`:360-372`）。
- 实测三个已批准 change：`round-protocol` `status=approved findings=0`；`kata-gate-surface` `approved findings=0`；`review-record-integrity` `approved route=ledger findings=0`。

**三处读的不是同一个来源。** `navigation.ts:189-196` 已经从 ledger 取开放问题（`openLedgerProblems`，活的生产者），只是名字仍叫 findings；`repair-entry.ts:133-135` 与 `distill-gates.ts:85` 读的却是 `review.json.findings`，而该字段没有生产者，因此这两处今天恒为假（`repair-entry` 只剩 `superseded` 一条能进入）。同一个问题、两个来源、三处派生：这是本 change 要收口的东西，也是设计阶段第一版把它写成“三处都读空字段”时看错的地方。

这不是意外，而是被有意留下的半成品。`src/cli/ops.ts:370` 明确写了新路线的主张：

> "What it does not keep is a command that disposes of a *finding*: findings belong to the route that produced them, and the ledger's unit is a claim with evidence."

也就是说：**问题单位已经换成“带证据的 claim”，而严重度阶梯和 `schemas/review-finding.schema.json` 是旧路线留下的、还带着三个读者的残留。**

### 1.3 claim 路线有生产者，且 severity 已经在用

- claim 携带 `severity` 与 `riskClass`（`src/kernel/types.ts:80-95`）。
- claim 状态由内核判定（`src/kernel/decide.ts`），严重度决定证据强度下限（`src/kernel/evidence.ts:25-30`、`policy.ts:156-161`）。
- 未支持/被反驳的 claim 会进 `openLedgerProblems`（`src/workflow/navigation.ts:26`），并出现在 `ledger deficits` 里。

所以“哪个问题阻塞”这个问题**有**一个活的数据源，只是那三处派生没有读它。

### 1.4 review 批准今天只由 ledger verdict 决定

`cmdReview` 里读 `review.json` findings 的严重度分支已被删除（`src/workflow/orchestrator.ts:1521-1530`）；批准字节由 ledger 分支写出（`:1544`）。ledger verdict 是 `pass | fail | insufficient`（`src/kernel/types.ts:248-249`），由 claim 的证据强度推出，因此 claim 侧的阻塞仍然有效——**但 review 侧的阻塞完全没有了**，且 `distill-gates` 与 `navigation` 读的是另一个（空的）来源。

### 1.5 没有升级终态

`Decision['verdict']` 只有 `pass | fail | insufficient`；`LedgerVerdict.kind` 只有 `absent | unreadable | decided`；review 路径上不存在 `escalation_required` 或等价的“停止自动循环”状态。连续修复而阻塞项不下降时，系统没有任何机制停止重派 `/kata-build`。

## 2. 设计决策

### D1 —— 问题单位是 claim，severity 阶梯只有一处派生

**决定：** “哪些严重度在某个 review 档位下阻塞”由 `src/workflow/review-read.ts` 导出的单一函数回答，`cmdReview`、`authorizeReviewRepair`、`evaluateReviewClearance`、`suggestCandidateAction` 全部读它。`review.json.findings` 作为**输入**保留（有写入时才读），但不再是规则的来源。

**理由：** 三处字面量派生是同一个概念的三份拷贝，且已经互相不一致（`distill-gates` 不看档位）。一个导出、四个消费者，规则改动只有一个地方能改。

**为什么放在 `review-read.ts`：** 该模块已经拥有“已记录的 review 事实”（18 行，只做这一件事），且被 gate、navigation 与 approval 共同引用。规则与它判定的记录放在一起，读者与判定者不可能各说一套。

**考虑过的替代方案：**

- *放进 `src/kernel/policy.ts` 档位策略*：更“内核”。否决理由：内核档位词汇与本 change 要统一的 workflow 档位词汇目前是两个身份（`standard` vs `std`），把它们合并要同时改动 policy 加载、ledger tier、`ledgerTierCeiling` 与 risk floor 路由，超出本 slice；在 `review-read.ts` 里显式做 `std → standard` 的映射，反而让这个映射第一次有一个家。
- *删除三处派生、不引入新派生*：会把“阻塞”整个概念从 workflow 侧删掉，`distill-gates` 就只剩 `blocking_findings` 一个恒假条件，等于删掉一个已有的门。不采纳。

### D2 —— 阶梯单调，`security` 不比 `strict` 弱

| 档位 | 阻塞的严重度 | 说明 |
|---|---|---|
| `std`（→ `standard`） | `blocking` | 现状保持 |
| `strict` | `blocking`, `major` | 现状保持 |
| `security` | `blocking`, `major` | **修正**：现状比 `strict` 弱，与内核三档的强度顺序相反 |

`security` 目前**不额外增加**严重度，它更强的地方在证据与 assurance 下限（`policy.ts` 的 `assuranceFloor: 'sandboxed'`、`reviewers: 2`、`quorumOn: ['always']`）。这一点写进设计而不是让读者从“相等”里猜意图。

AC-2 要求的性质是单调：`std ⊆ strict ⊆ security`，且 `std` 严格弱于 `strict`。

### D3 —— 批准必须在阻塞项未处置时拒绝，并具名

`cmdReview` 的 ledger 分支在写批准字节之前，先用 D1 的派生问一次“当前 revision 上还有哪些阻塞问题”，有则拒绝并逐个具名（id + severity + 消息）。这样 review 侧的阻塞不再依赖一个空字段，也不再让 `distill-gates` 成为唯一的执行点。

拒绝信息必须能直接驱动修复，因此列出 claim id 或 finding id，而不是只报一个计数。

### D4 —— 无进展的修复循环转升级终态

**决定：** 从一个 change 已记录的修复历史推导“轮次”与每轮的阻塞项数量；当连续 `N` 轮（首版 `N = 3`）阻塞项数量不下降时，`suggestCandidateAction` 不再返回 `/kata-build`，而返回一个具名升级动作，带上轮次数与仍未处置的阻塞项。

**轮次的定义：** 每条已记录的 repair 授权（`repair.json`，`src/quality/repair.ts`）记一次，`baselineRevisionId` 是那一轮看到的内容。阻塞项数量从**该轮记录的 findings / 当时的 claim 状态**取，取不到就记 `null`，不记 0——本仓库的规则是“不可测记 null，不记 0”。

**为什么是升级而不是继续重派：** 继续重派没有上界，而“没有上界”正是父设计 §8.6 要终止的东西；直接忽略则会把不确定性写成通过。升级保留人的决定权，且是**自动 review 的终点**。

**为什么 `N = 3` 而不是更小：** 首版取 3 是判断而非测量，因此写进常量并在输出里具名（`no_progress_rounds: 3`），不藏在逻辑里。

### D5 —— 明确不做（留给后续 change）

- 不引入 MaterialManifest / citation digest 绑定。证据已经由 kata 自己重判（`src/producers/verifiers.ts`），契约比“引用冻结字节”更强；先做绑定会造出第二个判定来源。
- 不恢复 finding 记录器，也不恢复 `review.json.findings` 的严重度阶梯作为规则来源。要恢复记录器，应先决定它与 claim 的关系（一个身份还是两个），否则就是再造一处派生。
- 不合并 `std`/`standard` 两套词汇，只把映射写在一处。
- 不引入 `escalation_required` 作为新的 ledger verdict（那会改动内核判定词汇）；升级是 workflow 侧的候选动作状态，记录在任务产物里。

## 3. 验收映射

| AC | 由什么满足 |
|---|---|
| AC-1 | `review-read.ts` 导出单一派生；`orchestrator.cmdReview`、`repair-entry.authorizeReviewRepair`、`distill-gates.evaluateReviewClearance`、`navigation.suggestCandidateAction` 都调用它；测试断言四处对同一 (mode, severity) 给出同一答案，且改动派生的返回值会让四处一起变 |
| AC-2 | 表驱动测试断言 `std ⊆ strict ⊆ security` 且 `std ≠ strict`；变异：把 `security` 的 `major` 去掉，测试必须变红 |
| AC-3 | 用例：存在高于该档位门槛的开放问题时 `review --approve` 拒绝并具名；全部低于门槛时批准成功；变异：去掉拒绝分支后测试变红 |
| AC-4 | 用例：构造 3 轮阻塞项不下降的修复历史 → 返回升级动作并具名轮次与开放项；构造下降的历史 → 仍返回 `/kata-build`；变异：把比较反向，测试变红 |

## 4. 验证原则

实现后至少要有会变红的验证：

- 四个消费者对同一 (mode, severity) 的答案不再一致时，测试失败；
- `security` 掉到 `strict` 之下时，测试失败；
- 去掉批准前的阻塞检查，`review --approve` 用例失败；
- 把“不下降”的判断反向，升级用例失败；
- 阻塞项数量无法测量时输出 `null` 而不是 0，且用例断言这一点。

## 5. AC-3 的收口：选择 A（不改既有决定）

AC-3 要求 `review --approve` 在“达到模式门槛的问题开放时”拒绝并具名。实施时核到，在 `cmdReview` 里重新读 `review.json.findings` 并据此拒绝，等于**撤销一次有记录的修复**。`src/workflow/orchestrator.ts` 的 ledger 分支里留着删除说明（约 1463 行起）：

> “This branch used to consult the round-shaped findings table and the obligation store beside the decision … the last place where one fact had two derivations … the dead branch is deleted rather than left empty. An ordered list with nothing in it, checked for being non-empty, **is a guard that cannot fire — the class this repository has removed more times than any other**.”

因此采用**不改既有决定**的收口：批准路径不再新增第二个门，而是把已有的拒绝**用同一把阶梯具名**。

- `review-read.ts` 新增 `describeBlockingProblems(mode, problems)`：把每个问题按 id 与 severity 列出，并写明它是对着哪个门槛量的；
- `cmdReview` 在 ledger verdict 非 `pass` 时附上这句话，并把 `blockingProblems` 放进 diagnostics；
- 阶梯、拒绝与路由读的是同一个 `mergeBlockingSeverities`，三者不可能对“什么阻塞”给出不同答案。

### 5.1 AC-3 中不可取证的一个子句

AC-3 的末句“低于门槛的 finding 仍然批准”在 ledger 路线**没有见证**：内核 `evaluateClaim` 对任何未支持/被反驳的 claim 都产生 reason ⇒ `Decision.verdict` 为 `fail`/`insufficient`，与严重度无关（严重度只决定**所需证据强度**，不决定 ledger 是否通过）。所以低于门槛的问题仍然被拒，只是**不被点名**。

`tests/unit/review-approval-refuses-open-findings.test.ts` 把这个差别钉住，而不是回避它：

- `strict` 下的 `major`：拒绝，且句子说“At the strict bar (blocking, major)”，点名 `C-4 (major)`；
- `std` 下的同一个 `major`：仍然拒绝（内核规则），但句子为空，`blockingProblems` 为 `[]`——因为它在 `std` 的门槛之下。

也就是说：**模式决定“点名什么”，内核决定“是否通过”。** 末句若要按字面成立，必须把 `review.json.findings` 恢复成第二个判定来源，而那正是本仓库反复清除的类别；这一条留给你在验收上明确接受或推翻。

## 6. 尚未完成

- 本 revision 尚未 seal：四条 AC 的测试证据已经齐备，但 5.1 说明的那个子句需要你在验收层明确接受，或改由新的 change 处理；
- 父设计中与平台无关的 Skill 化 reviewer 路线（`.agents/skills/kata-review` 之外的部分）不在本 slice。

## 7. 独立审查推翻了什么（一轮真实的反例）

一个干净上下文的独立 agent 被派去**证伪**四条 claim，而不是确认它们。它在 `tmp/` 写了 8 个探针脚本、用 `vite-node` 跑真实代码，并确认没有改动受治理的工作区。结论：**C-3 被证伪**，另外四处缺陷。

### 7.1 C-3 被证伪（blocking）

`src/workflow/orchestrator.ts` 的批准路径只传 `{mode, claims}`，闸门传 `{mode, findings, claims}`。于是同一份内容：**批准通过、送去 judge、授权修复，而 distill 拒收**（`tmp/repro-c3c4.mts`）。我此前把那处 findings 分支的删除当成正确决定引用了两次，理由是“这条路线只读 ledger”。那条理由错在“表是空的”这半句：只要记录里有 findings，表就不空，而 distill 一直在读它们。

**修法不是把分支加回来**，而是让**没有人能各自组装这个问题**：`readBlockingProblems` 成为唯一的读者，批准、闸门、修复入口、路由都问它。一条反例（X-1）在 ledger 里复现过并已被修好。

### 7.2 另外四处

| # | 缺陷 | 反例 | 修法 |
|---|---|---|---|
| ① | 记录读不出来时，闸门**抛异常**而不是拒绝（`readValidatedOptional` 的 schema 错误逃出 gate） | 一个缺 `taskId` 的 finding 让 `evaluateReviewClearance` 抛出 | 闸门走同一个读者，返回 `unreadable_review` 并带上读者的原句 |
| ② | `mergeBlockingProblems` 不看 `disposition`，已 `fixed` 的问题仍拒绝闸门、仍授权修复、仍被点名 | `tmp/repro-disposed.mts` | `isOpenFinding` 一处表达 schema 的规则（“absent means open”） |
| ③ | 循环用**相邻两轮**比较，振荡循环永不升级 | `[5,4,5,4,5,4,5]` → 不升级 | 与**历史最小值**比较；`[5,4,5,4,5,4,5]` 现升级，`noProgressRounds` 报 5 |
| ④ | `NO_PROGRESS_ROUNDS = 3` 的文档与代码差一轮 | `[5,5,5]` 不升级，但注释说“连续 3 轮” | 常量语义写死并加测试：`[5,5,5]` 为 2、`[5,5,5,5]` 升级为 3 |

### 7.3 一并修掉的与记录的

- **阶梯搬到 `src/quality/review-ladder.ts`。** 它原来在 `workflow/review-read.ts`，于是 quality 侧的消费者必须**向上** import——这正是闸门后来依赖 `navigation.ts`（一个路由模块）的原因。搬完后 `openLedgerProblems` 也回到 `store/verdict.ts`，紧挨着它投影的 `unsupportedClaims`。
- **`one home` 守卫加宽**：原来只扫四个具名文件的 `severity === 'blocking'`，`case 'blocking':`、`includes('major')`、`reviewMode === 'strict'` 都能溜过去；现在枚举两个目录、认多种拼写，并有一条用例证明这些拼写真的会被抓到（守卫自身不能是“恒真检查”）。
- **未知模式 fail closed**：`reviewTierFor` 现在做大小写与空白归一，`undefined`/`''` 视为遗留任务（standard），而**写着但无法识别**的模式取最严的一档，而不是悄悄降为最弱；`'std'` 与 `'standard'` 两种拼写都在这里翻译。
- **记录一处已知倒挂、不在本 change 修**：`requiresMatrix` 以字面量 `strict` 判断，所以 `security` 要求的声明**少于**低一档。修它要回答的是“这个 change 的**路线**是否携带验收契约”，而不是“它的审查档位有多严”——实测把 `security` 也纳入会让 `kata-cli tweak … --review security` 拒绝 design 并以 “Build cannot run from intake” 失败。因此保留现状、把理由写在函数上，并由守门的例外清单具名放行（只有一条，且有理由）。

## 8. 第二轮：修复本身被证伪（focused re-review）

修复提交后又派了一个干净上下文的独立 agent，只做一件事：**验证这批修复是真的还是像真的**。它逐条攻击 6 项，结论：**第 1、2 项被证伪，第 3 项部分证伪并新引入一处 fail-open，第 4、5 项成立，第 6 项部分成立（引入一条新环）**。

它的诊断很好，值得原样记下：**那批修复的测试从未驱动 router 与 repair entry** —— 每一项“读不出来的记录”都只经由 approval 与 gate 走了一遍。于是：

| # | 缺陷 | 实测 | 修法 |
|---|---|---|---|
| ① | router **只报告不消费** `reviewRecordUnreadable`，同时把问题列表退化成空 | 畸形记录下 router 仍然 `judge_reviewed_change`，与“审查干净”完全同形 | 新增路由理由 `unreadable_review_record`（→ `/kata-review`），并把它接进 `UpstreamSummary` 的消费 |
| ② | gate 与 repair entry **仍会抛异常** | (a) `currentRevisionIdentity` 在 try/catch 之外，且对非 ENOENT 一律 rethrow，所以损坏的 `current-revision.json` 让 reader 与 gate 一起抛；(b) repair entry 在问 reader 之前自己 `readValidatedOptional` 打开同一个文件 | (a) 绑定读取移进 guard；(b) repair entry 只用 reader 的答案，baseline revision 改到决定之后再读且加 guard |
| ③ | `isOpenFinding` 把 `deferred`/`accepted`/`routed` 也判为已关闭 | 三类以前都拒绝 gate，改后放行；而 `change-record.ts` 的过滤器是 `disposition !== 'fixed'`，且有一条用例明确断言 `routed` **仍然 open** | 谓词改为 `!== 'fixed'`：同一 lifecycle 字段不能有两个相反读数 |
| ④ | 整份轮次历史无法测量时读起来像健康循环 | 全 `null` → `noProgressRounds: 0, escalating: false`，与“第一轮就完美”同形 | 新增 `unmeasurable` 并升级；空的（从未记录）历史仍不算卡住 |
| ⑤ | `mergeBlockingProblems` 在 `src/` 无调用者（reader 内联重写了同一表达式）；`hardestSeverity !== undefined` 恒真 | — | reader 改为调用它；删掉恒真判断 |
| ⑥ | 新增一条 import 环：`core/state → workflow/distill-gates → workflow/review-read → store/verdict → store/ledger → core/state` | 静态图 4 环 → 5 环 | reader 的 store 读取改回动态 import（同一处原先就是这么做的），静态环消失 |

复审同时确认第 4、5 项的算术与文档/循环一致（表格逐格攻击：振荡、只降后停、降到 0、仅有未测量、仅有变差），且分层方向没有被破坏（`quality/ → workflow/` 边数不变）。

### 8.1 一条反复出现的形状

两轮下来真正的教训不是“哪些行写错了”，而是：

> **一个读者可以是对的，却仍然被忽略。**

第一轮是“问题有多个来源”（approval 与 gate 各自组装），第二轮是“结论有生产者但没有消费者”（`reviewRecordUnreadable` 被写上却没人读；`exists` 与“空记录”本来同形）。两次都不是算术错误，而是**事实与决定之间的那条边断了**。因此新增的用例一律**直接驱动决定面**（router、repair entry、gate），而不是只驱动读者。

## 9. 第三轮：记录损坏不能降格为“从未写入”

> **`absent`、`usable`、`unreadable` 是三种事实，不能以空数组或空 identity 合并。**

> 当前模型的最终复审进一步证明：`{}` 形式的 `current-revision.json` 会被当成没有 revision；畸形 `claims.json` 会从共享 reader 的 `.map()` 抛出；整个 `review-rounds.jsonl` 无法读取时会被当作空历史，从而重新打开无限 repair 路径。

修复把三条边界分别钉住：revision 读取改用 `revision` schema（只有 ENOENT 返回 `null`）；共享 blocking reader 将 unreadable ledger 显式映射为拒绝；round 历史提供 `readReviewRoundsState`，仅 ENOENT 为 `absent`，其它读错为 `unreadable`，router 将其视为升级而不再派发 build。`tests/unit/review-artefact-read-state.test.ts` 分别压测三种真实文件状态。

## 10. 第四轮：完整快照、损坏历史与历史 identity

> **内容 identity 不能以廉价指纹的大小上限为代价；历史 identity 不能在读取时被重写。**

> 复审进一步发现三条剩余断边：`computeContentDigests` 复用了 tree-hash 的 2MB 上限，因而能遗漏未声明的大文件；JSONL 历史只要含一条有效行就被降格为 readable；缺 `contentDigests` 的 legacy revision 会在相同内容重封存时被新 identity 取代。

> 收口规则：content snapshot 遍历全部非忽略文件；任一损坏 JSONL 行都使整个历史为 `unreadable`（但保留可解析前缀供诊断）；新 identity 未命中时才探测旧 identity，并原样复用 legacy record，绝不把新 snapshot 反写进旧绑定。三条回归分别落在 `revision-delta.test.ts` 与 `review-artefact-read-state.test.ts`。

## 11. 第五轮：修复自己引入的缺陷，以及一个有条件的复用

> **复审可以是对的，而修复可以是错的。** 第四轮的三条修复各自引入了新的断边，独立审查逐条证伪。

第五轮的独立审查（干净上下文、只做证伪）报了 8 项，全部可复现：

| id | 事实 | 复现 |
|---|---|---|
| R-4 | legacy 探测不设内容条件，任何后续内容都复用同一 identity | 三次封存同一 id、`revisions/` 只有一个文件 |
| R-5 | legacy 复用把当前 revision 覆盖成旧记录（降级） | `current-revision.json` 从带快照的 id 变成 legacy id |
| R-6 | ledger 分支排在循环终态之前，违反 AC-4 | 循环已升级仍路由 `/kata-build` |
| R-7 | `openLedgerProblems` 抛错，`cmdVerify` / `cmdJudge` 裸调用 | 畸形 ledger 变成命令级异常 |
| R-8 | R-2 的回归只驱动 reader，删掉 router 条件仍全绿 | 正是本 change 的 §8.1 缺陷类 |
| R-9 | legacy 分支丢掉 `ownershipConflicts` / `ack` | 探针打印 `undefined` |
| R-10 | "malformed" 只等于 JSON 解析失败 | `{}`、`[]`、`42` 被当作 round 计数 |
| R-11 | `ledgerClosure.mayClose` 有写者无消费者 | grep 只有写者与测试自造输入 |

收口规则，按顺序：

1. **循环终态先于一切修复派发**（R-6）。两条 ledger 路由移到它之后；`mixedRevisionEvidence` 保持在上，因为它是关于证据的事实而非循环出口，属另一个排序问题。
2. **legacy 复用是有条件的，且不提升**（R-4/R-5/R-9）：只有 `current-revision.json` **正指向**该记录时才复用；命中即原样返回，不写回 current、不补 `contentDigests`、冲突字段照常折入；内容一动就铸新 revision 并带上快照。`mint()` 在同 id 已在历史中时提前返回，所以历史 id 永不被重编号。
3. **能抛的读者不再抛**（R-7）：`openLedgerProblems` 返回 `read | unreadable`，两个报告面把三种答案分开（有问题 / 没问题 / 读不出来），不再用 `0` 冒充「没有问题」。
4. **回归必须驱动决定面**（R-8）：新增两例把损坏的轮次历史送进 `readUpstreamSummary` → `suggestCandidateAction`，并用变异验证——把升级分支移回 ledger 之后，用例立刻变红（实测 `expected 'satisfy_ledger_deficits' to be 'escalate_review_without_progress'`）。

**一处必须记下的教训**：R-4/R-5 的用例我重写了三次，两次在断言引擎无法到达的状态——一次手写 `current-revision.json`，一次用「先封存」的方式去发现 legacy id（那次封存本身就把指针移开了）。只有当用例的装置与真实 seal 的装置一致时，它才在测量引擎而不是在测量我的算术。**「测试写错了」和「实现写错了」在红之前长得一模一样。**

## 12. 第六轮：把「有条件」做成真正的条件

> **一个 gate 只有在它能对两种内容状态给出两种答案时才是条件。**

第五轮的 gate 问的是「`current-revision.json` 是否指向这条记录」。这是个**指针问题**，而被问的是一条**没有快照的记录**——它无法回答「内容是否相同」，gate 把这个沉默读成了「相同」。实测：一个已处于该状态的 change，未声明文件改三次，三次复用同一 id。**R-4 的原始缺陷完整存活，只是被条件化了一半。**

第六轮把条件换成内容能回答的形式：snapshot-less 记录**只有在它正是本次封印的 content-bound identity 时**才可复用（即指针既指向它、这个名字也等于本次内容派生的 id），否则铸新并带上快照。历史 id 因此仍然可复用、也仍然不被重编号，但它不再能替内容回答。

同时收口同族的其余五项：

| 项 | 事实 | 修法 |
|---|---|---|
| R-6 残余 | 混合证据分支仍在终态之前，已升级的循环仍被派回 `/kata-build`（违反 AC-4） | 终态上移到**所有返回修复路由的分支之前**；只剩 `phase === 'archive'` 在其上，那不是修复路由 |
| revision 读取 | `readCurrentTaskRevision` 以 `null` 表示缺失、以抛错表示漂移，12 个调用点分裂成两种读法：router 崩、seal 拒、其他静默当作「没有 revision」 | 新增 `readCurrentTaskRevisionState` 返回 `absent / current / unreadable`，router 用第三个状态给出具名拒绝 `repair_unreadable_current_revision` |
| R-7 残余 | 读不出来时仍发布 `openProblems: 0`，另加一个无人读的字段 | 字段**省略**而不是填 0，理由放进 `openProblemsUnreadable` |
| 死导出 | `readReviewRounds` 只剩测试在用，成为全仓唯一未被引用导出 | 删除；测试改用 `readReviewRoundsState` |
| 死条件 | `ledgerDecision.claims === 0` 恒假（零 claim 已返回 `absent`） | 删除 |
| 不实注释 | 声称 `mint()` 会提前返回以「永不重编号历史」，实际没有该检查 | 改为陈述真实保证来自 `existing`，并点出该 id 上的损坏文件会被覆盖而非拒绝 |

**两次证伪的教训合起来是一条**：第五轮我把「指针指向它」当成了「它是同一份内容」；第六轮我把「内容变了」当成了「必须铸新」——后者差点删掉一个真实状态（mid-flight 的老 identity），而那个错误立刻被一个用例抓回来。**条件不是越多越好，是可被内容回答的才对。**

## 13. 第七轮：把「装置必须与引擎同构」变成可执行的约束

第六节结尾记录了一条方法论错误（**测试装置与引擎不同构**），但当时只是**写在文档里**。文档不是约束：同一处用例在这个 change 里已被重写四次，其中三次的失败来自装置而非引擎。所以第七轮把它变成机制。

**装置侧收口**

- 删掉两个手写 `current-revision.json` 的用例（引擎无法产生该状态），把价值合并进一个**全程走真实 seal** 的用例：连续三次 seal + 一个"历史目录里恰好存在旧记录"的装置。
- 该用例现在就断言完整的身份契约：未声明文件移动必须移动 identity（三次 → 三个 id）；identity 跟随声明看不见的内容；历史记录保持可读、不被改写、不被提升、不被重编号。
- helper 从 `writeLegacyRevision`（同时写指针）退化为 `appendHistoricRevision`（**只追加记录，指针永远由引擎写**），并在用例里断言"指针必须等于引擎刚写的那个 id"——这条断言的作用是：将来任何装置若伪造了当前状态，会先在这里失败，而不是在身份断言上给出一个看似合理的结果。

**机制侧收口**

新增 `tests/unit/tests-do-not-read-the-live-task-store.test.ts`（既有扫描型用例）里的第二条守卫：**禁止 fixture 自行制造 revision 身份**。

守卫的写法本身经过了两次修正，值得记下：

1. 第一版把范围定成"禁止写 `current-revision/current-state/review/verify/judge`"。实测**九个既有用例**会命中——`layout.test.ts` 一处就写十二次 `current-state.json`。那些是测试**读者**的合法装置。**规则比事实宽，就只是一条没人遵守的注释。**
2. 收窄到"禁止写 `current-revision.json`"之后，仍然让真正的伪造漏过：我的变异复现了它（把 `writeFile(... 'current-revision.json' ...)` 加回 helper），守卫却全绿。原因是**窗口看错了方向**——写入语句里的字符串是 `record`，而 `record` 的 `JSON.stringify({ id, ... })` 出现在**它上一行**。守卫向前看三行，看的是下一条语句。窗口改成"写入点前 12 行 + 后 3 行"之后，它精确报出 `revision-delta.test.ts:57`。

所以这条守卫现在区分两件事：**制造缺陷**（`{}` 这种截断记录，用来测"读不出来"，允许）与**制造身份**（带 `id`/`manifestHash` 的记录，禁止）。**允许前者是因为没有任何命令能产生一个损坏的产物；禁止后者是因为每一个这样的装置都在替引擎回答一个引擎自己的问题。**

## 14. 第八轮：删掉 legacy 复用，把「谁是 identity」变成一句话

> **一个没有快照的记录，无法回答一个关于内容的问题。** 这不是条件写错了，是问题问错了。

第 11～13 节里这条分支被改了**六次**，三种可能的口径我都实测过，每一种都在两个状态之一上失败：

| 条件 | 危险状态（指针指向历史记录 + 仓库含未声明文件） | mid-flight 状态（指针指向历史记录，无未声明文件） |
|---|---|---|
| 无条件探测 | ❌ 三次 seal 一个 id、一个 revision 文件 | ✅ 保留历史 id |
| 仅看指针 | ❌ 同样复用 | ✅ 保留历史 id |
| 指针 + 内容约束 | ✅ 铸新 | ❌ 条件不可满足（`legacyId !== id` 正是探测成立的前提） |

几何上的原因：**这两个事实在同一个状态里同时为真**——「指针指向一条 legacy 记录」既意味着"这个 change 在旧 identity 上"，也意味着"这条记录没有快照、看不见未声明改动"。所以没有任何条件能同时满足它们；继续调条件只是在两个错误之间移动。

**决定：删除 legacy 复用探测。** 规则变成一句话：**identity 只由 content-bound 派生决定**（`existing` 命中即复用，否则铸新）。

- 历史 revision **文件不动、仍可读**：停止的是它们作为"当前 identity"被复用，不是它们的存在。
- 同内容永不同铸（R-3 的真实诉求）由 `existing` 保证，不受影响。
- 代价已实测：仓库自身 122 个 revision 里，**2 个**既是 pre-snapshot 又是 current（`check-log-artifact-missing`、`worktree-no-commit-message`），它们的下一次 seal 会铸新 id。而它们的 `revisionStatus` 现在就是 `superseded`（owned 内容已变），旧规则下同样会重铸。
- `mint()` 随之内联消失——它当初存在只是为了给"探测未命中"提供第二个出口。

**同一轮收口的其余四项**

| 项 | 修法 |
|---|---|
| 守卫漏检 | 匹配裸文件名（模板串也行）+ 接受任意写入调用 + 双向窗口；并**补了自检**：三条必须抓到、两条必须放过的样本。它立刻抓出一处活的同类实例（`tests/unit/repair-entry.test.ts` 手写 `manifestHash`），该处已改为走真实 seal |
| 读取三态被吞 | `readCurrentTaskRevision` **不再抛错**（`null` = "没有可用的"），需要区分时用 `readCurrentTaskRevisionState`；`review-read.ts` 明确问第三个状态，那个为抛错而写的 `try/catch` 随之删除 |
| 有写者无读者 | `openProblemsForReport` 投影移入 `store/verdict`（与读者同居），两个报告面共用；用例断言"读不出来时计数**缺席**" |
| 排序倒挂 | 终态 priority 1200 → **2200**：它 return 在前，但 `cli/tasks.ts` 用 priority 给人看的候选列表排序，压不住就没压住 |

**教训（第三次同一形状）**：我三次把文档写在了代码前面——"历史 id 仍然可复用"、"every consumer decides"、"窗口是整个函数"——三次都**没有对应的断言**。所以这一轮每写一句就补一条断言，并且**先写变异证明它会红**，再写结论。

## 15. 第九轮：删掉抛错把"可见中止"变成了"静默开闸"

> **一个读者可以被修得更"宽容"，结果是决定面更不安全。**

第八轮为了证明三态可达，删掉了 `readCurrentTaskRevision` 的抛错（损坏 → `null`）。第九轮的独立审查证明这个动作在**人类授权边界**上降低了安全性：

`currentRevisionIdentity` 仍裸调那个读者，于是损坏的 `current-revision.json` → `revisionId: null` → `bindsToRevision` 把"没有 revisionId"定义为**"什么都没封存"**（`if (!current.revisionId) return !artifact.revisionId;`）→ **`user-choice-gate` 复用一条内容已经不匹配的 task choice，并如实报告 `reusedFromTaskChoice: true`**。

对照实验（同一装置、只换 revision 文件）：可读但内容已变 → 正确拒绝；**非法 JSON → 静默复用**。HEAD 上这个输入会抛错，所以这一状态是**我引入的**。

修法：`currentRevisionIdentity` 问三态读者，`unreadable` 时**拒绝并具名原因**（`The revision this decision is about cannot be read`）。用例先写红（实测拿到 `reusedFromTaskChoice: true`），再改代码。

**同一轮其余收口**

| 项 | 事实 | 修法 |
|---|---|---|
| 守卫又漏一处活伪造 | `REVISION_ARTEFACT` 要求文件名**字面**出现，于是 `currentRevisionPath(...)` 整行被跳过——而 `revision-delta.test.ts:146` 正是这样写指针的 | 正则加 `currentRevisionPath\(`；**并把这个形态补进自检样本**（原来 3 条命中样本全用字面文件名，证明不了"守卫只认一种写法"） |
| 守卫把"staged defect"写得太窄 | 只认 `{}`，于是我自己新写的 `'not json\n'` 用例被误报 | 放宽到整类"刻意不可读"（`{}` / `not json` / `malformed` / `corrupt`） |
| C4 的修复在决定面无断言 | "省略而非填 0"实现成立，但新用例断言的是投影（`problems` 键恒在），把 spread 改回去**全套仍绿** | 改为驱动 `runCommand('verify')`，断言 envelope **没有** `openProblems` 且有 `openProblemsUnreadable`；并用变异验证（改回去即红） |
| 死 catch + 假注释 | `repair-entry.ts` 的 `try/catch` 永不执行，注释仍说"refuses here rather than throwing"；真正的拒绝来自上游 reader | 删除 catch，注释指向真实拒绝点 |
| 注释指向不存在的函数 | `revision.ts` 提到 `readCurrentRevisionOrRefuse`，该函数从未存在 | 改为指向 `readCurrentTaskRevisionState` |
| 终态 priority 无断言 | 2200 本身对，但改回 1200 全套仍绿 | 加断言 `priority > 2100`（其上是混合证据 2100、ledger 1995/1990） |
| 孤儿注释 | `revision-delta.test.ts` 留着已删规则的 doc 块，**漏 `*/`**，把下一个用例的注释吞进去 | 删除 |
| 可选参数的理由已失效 | `revisionIdFor` 第 4 参的注释以"读回历史 revision"为由，而该路径已随 §14 删除 | 改为陈述真实理由：fixture 用它**命名**一个历史 id |

**教训（第四次同一形状，但这次方向相反）**：前三次是"文档写在代码前面"，这次是**"我去掉了一个保护，并把它当成可读性改进"**。判据很简单：**一个读者变得更宽容时，要问的是它的消费者会不会把"读不出来"当成一个正面的答案。** 三个消费者（choice gate、review record、router）里，只有我把它们逐个改成显式问三态之后才安全；还有一个我漏了，而漏掉的那个正好在人类授权的门上。

## 16. 已记录、未修：声明面之外的行为改动会卡在两个阶段之间

**这一节是 follow-up 记录，不是本 change 的交付内容。** 本 change 的 AC（§1）不覆盖它，所以它在这里被记下来、带最小检查设计，并交给一条独立 change。

### 现象（可复现）

我在第 9 轮改了两样东西：`tests/unit/user-choice-gate.test.ts`（新用例）和 `src/workflow/verdict-binding.ts`（**行为**：改 import、加拒绝）。我只把**测试**加进了 scope。

结果卡在一个**没有任何命令报错**的位置：

| 阶段 | 读什么 | 那次的结果 |
|---|---|---|
| `scope change --add tests/…` | 只记录、去重 | 不提示"这个测试校验的源码没声明" |
| `build --seal` | 只看 ownedPaths 的内容 | **静默成功**——漏掉的源码在 owned 面之外，没进 revision 的 manifest |
| `verify` | **读工作区** | 报 `workspaceDrift: ['src/workflow/verdict-binding.ts']`（在一个 20 字段的 diagnostics 里） |
| `build --seal`（重试） | 声明面 | **拒绝**：`Build cannot run from hardVerify without a repairable verify FAIL result, and the sealed revision's declared manifest is unchanged` |

于是两个阶段**互相认为对方该处理**：verify 说"有漂移"，build 说"声明面没变、没有可修的 FAIL"。而我若无视那条 drift，sealed revision 会**带着声明面之外的行为改动**进入 review/judge，且 `revisionStatus` 仍是 `current`。

根因一句话：**`seal` 的信封面是 ownedPaths，`verify` 的事实地平线是工作区。** 两者之间的差额没有主人。

### 建议的检查设计（两条，独立可做）

1. **写时拒绝（`scope change --add`）**：解析新增 test 路径的 `import` 图，取其指向 `src/` 的符号所在模块；若**一个都不在** next-ownedPaths 里，则拒绝并指名"这个测试校验的源码未声明"。落点已存在：`src/quality/scope-change.ts` 的 `recordScopeChange` 已经在做 `refused` 判定（`src/cli/scope.ts:88`），这条规则接在同一个出口上即可。
   - **已知边界**：它只能看到测试**直接 import** 的源码。测试通过第三个文件间接校验一个模块时看不出来。这个边界必须写进规则本身，而不是留在注释里。
2. **封存时拒绝（`build --seal`）**：worktree 里**任何 owned 面之外的 tracked 改动**都拒绝封存（而不是静默收入信封）。这条更全面，代价是需要在 seal 前有一个"工作区改动集 ∩ ¬ownedPaths"的检查，且要处理 `.kata/**`、`tmp/**` 等已排除项。

### 为什么不在本 change 里做

本 change 的验收契约是**审查循环有界**（AC-1～AC-4），而 AC 文本在 `open` 时冻结，`tasks declare` 只能改 `acceptanceMatrix` / `upstreamCoverage`。要把这条检查纳入本 change，只有两条路：加一条与主题无关的 AC，或重开 bootstrap 换掉已封存 9 轮的验收契约。**两条都会把一个已验证的审查 change 变成一个声明完整性 change**，与"流程成本应与改动规模成比例"直接冲突。

## 17. 第十轮：修「一个事实一个来源」时，又造了一个第二来源

> **我这一轮的修复本身，就是它要修的缺陷。**

第九轮我在 `src/store/verdict.ts` 里为 `openLedgerProblems` 新增了一个"这个 ledger 读不出来吗"的谓词：

```ts
if (ledger.malformedFiles.length > 0 || ledger.policyRejected !== null) { … }
```

而 `ledgerVerdict` 早就有一个**同样的**谓词，**外加第三个条件**：`!ledger.subject`（有 claims 但没有冻结的 subject，同样决定不了任何事）。实测分歧（同一 fixture，删掉 `subject.json`）：

```
openLedgerProblems -> {"kind":"read","problems":[AC-1(major),...]}
ledgerVerdict      -> {"kind":"unreadable","detail":"...claims but no frozen subject..."}
agree on whether the ledger can be read? false
```

于是消费者分裂：`navigation.ts` 按 `unreadable` 拒绝闭包并路由修复，而 `readBlockingProblems`（**批准、归档门、修复入口共用**）按"可读"发布问题数。

**修法**：`openLedgerProblems` 不再重写谓词，`unreadable` 的判定与措辞**委派** `ledgerVerdict`。

**而这次委派立刻造出了第二个回归**（由既有用例抓住）：我把 `absent`（根本没有 ledger）也并入了 `unreadable`，于是**一个从未记录过 ledger 的 change 拒绝了自己的修复入口**。`absent` 与 `unreadable` 是两件事——前者是正常状态，后者是错误——这一点在第九轮我刚为 revision reader 写过一遍，转头在 ledger reader 上又犯。

### 同一轮的第二条 major

第九轮的拒绝只覆盖了**决定面**（choice gate、review record、router），但 router 派发到的**命令**仍裸调 `currentRevisionIdentity`。实测（pointer = `'not json'`）：

```
router (hardVerify): currentRevisionUnreadable=...
router suggested next command: /kata-verify
verify THREW: The revision this decision is about cannot be read
verify.json: NOT written (the run was discarded)
```

即：router 结构性地报告了问题，然后派发到一个**会抛错并丢弃整次运行**的命令；而 `repair_unreadable_current_revision` 只在 `phase === 'review'` 生效，hardVerify 阶段没有修复路由。**修法**：`cmdVerify` 在该状态返回结构化拒绝 envelope（含 `currentRevisionUnreadable`），不再抛。

### 其余收口

| 项 | 事实 | 修法 |
|---|---|---|
| 同一政策两次读 | `review-read.ts` 先问三态，再把同一文件交给仍会抛的 `currentRevisionIdentity`；pointer 是**非原子写入**，第二次读能抛出那个自己写着 "must not crash" 的 gate | 新增 `currentRevisionIdentityFrom(read, …)`，**从已有的读派生**，不再读第二次 |
| 三个被改宽的调用点 | 我把 reader 改宽后，`cli/ops.ts`、`context-fabric.ts`、`eval/runner.ts` 从"抛错"变成**静默默认**：`revision digests` 对损坏 pointer 报 "no revision is sealed for this task"，handoff 静默把 scope 降级为 `task_context` | 三处改问三态并显式拒绝/具名 |
| 死 catch | `readCurrentTaskRevision` 不再可能 reject，四处 `.catch(() => null)` 成为不可达代码 | 删除 |
| 两份手抄 spread | C3 的 spread 抄在两个报告面上，**只有 verify 那份有断言**（变异 judge 那份 → 全套绿） | 抽出 `openProblemsReportFields` 单一生产者，两个面共用 |

### 第四次教训，措辞更准了

前三次是"文档写在代码前面"，第四次是"去掉保护当成可读性改进"，**这次是"我一边修'一个事实一个来源'，一边为同一个事实写了第二个来源"**。判据可以合成一句：**新增任何判定之前，先问这个判定在仓库里是否已经存在——若存在，读它，不要重写它。**

## 18. 第十一轮：把「委派」从措辞做到决定

> **借了结论的措辞，却自己重新下结论——那是两个来源，只是其中一个更礼貌。**

第十轮的修复被独立审查逐条证伪，其中最关键的一条是：我声称 `openLedgerProblems` 已把"这个 ledger 读不出来吗"**委派**给 `ledgerVerdict`，但实际上我只借了**措辞**，谓词仍在本地重推（第三次条件补上了 `!ledger.subject`，看起来对齐了）。而它多了一个 `nothingRecorded` 判断，于是：

- 状态：有 `evidence.json`、**没有 claims**
- `openLedgerProblems` → `unreadable`（维修入口 `authorized: false`）
- `ledgerVerdict` → `absent`（正常）

**HEAD 上这个状态是放行的**，所以第二轮修复引入了一个**假拒绝**：一个合法 change 卡在自己的修复入口上。

**修法**：问 verdict 的 **kind**，而不是重推谓词。用例改为**遍历状态**（无文件 / 有记录无 claims / malformed / 有 claims 无 subject），让第三个"重推"无法靠覆盖作者想到的那几个通过。

### 同一轮证伪的五条

| 项 | 事实 | 修法 |
|---|---|---|
| verify 的拒绝是 check-then-use | `:1274` 读一次、`:1289` 又通过 `currentRevisionIdentity` 读一次；mock 证明两次读之间改坏文件，**命令仍抛错、`verify.json` 仍没写** | 用它**我这轮自己建的原语** `currentRevisionIdentityFrom(verifyRevisionRead, …)`——建了正确的工具却没用 |
| `judge` 有完全相同的缺陷 | `judge.json` 写入在 `:140`，抛错在 `:138`，**整次判定被丢弃** | `cmdJudge` 返回同样的结构化拒绝；`JudgeInput` 接受调用方的读；`judge()` 不再重读 |
| "一次读"的函数内部又读了 | `currentRevisionIdentityFrom` 调用 `candidateFreezeHashFor`，后者**又读一次** pointer（经宽松 reader）；实测一次 verify **4 次读**，identity 可由两个文件状态拼装 | freeze-hash 生产者接受调用方的读 |
| judge 面的省略无断言 | 变异 judge 那处 spread → **158 文件 / 1007 用例全绿** | 用 `runCommand('judge')` 驱动并断言省略；变异后变红 |
| 拒绝 envelope 发布未读过的计数 | `openProblems: 0` 且无 `openProblemsUnreadable` | 省略该字段 |

**另两条 minor**：指针拒绝排在 ledger 分支之下（两个 artefact 同坏时命名错的阻塞点，并派发到会抛错的 `build`）→ 上移；新增两个无消费者生产者（`openProblemsForReport`、`readOpenProblems` 别名）→ 删除。

### 第五次同一形状，判据可以定稿了

五次：文档先于代码（×3）、去掉保护当成可读性改进（×1）、**修"一个事实一个来源"时造出第二个来源（×1）**。合并后的判据：

> **判定只能有一个来源；借来源时要连决定一起借，不能只借措辞。**

## 19. 收口：AC-1…AC-4 的结论，与移交给两条 follow-up 的残余项

### 本 change 的验收结论

AC-1…AC-4 在十二轮对抗审查后仍然全 PASS，且每一条都有**会红的用例**（含变异验证）：

| AC | 内容 | 证据 |
|---|---|---|
| AC-1 | 严重度阶梯只有一个导出，四个读者都问它 | 源码扫描用例：在 `src/workflow/` 重写 `severity === 'blocking'` 即红 |
| AC-2 | `std ⊆ strict ⊆ security`，`security` 不再最弱 | 变异 `security` 的 `major` → 红 |
| AC-3 | `review --approve` 在达到模式门槛的问题开放时具名拒绝 | 驱动命令的用例；拒绝文本含 claim id 与 severity |
| AC-4 | 连续 3 轮不下降即停止派发 `/kata-build`，升级并要求人工 | 与历史最小值比较、不可测记 `null`；终态 `priority 2200` 压过所有修复路由（变异验证） |

### 十二轮的净结果

- 交付：一处严重度阶梯、一个阻塞问题读者、循环终态、以及**读状态语义**（`absent`/`current`/`unreadable`）在三个决定面（choice gate、review 记录、router）上的显式化。
- 成本：**每一轮修复都带出了新缺口**，其中三处由我引入：假拒绝（把 `absent` 并入 `unreadable`）、check-then-use（建了 `currentRevisionIdentityFrom` 却没用）、以及一个指向会抛错命令的路由。
- 因此本 change **到此为止**：残余缺陷不属于 AC-1…AC-4 的任何一条，而是两个独立类别。

### 移交

| follow-up | 文档 | 收的条目 |
|---|---|---|
| **读状态语义** | `docs/design/2026-09-29-read-state-semantics.md` | 同一 artefact 一次决策内被多次读（ledger 计数第二次裸读、summary 与 review-read 各读一次 pointer）；`revisionRead` 的手抄类型克隆与 `as never`；"hand-over 而非 re-read" 缺少会红的命令级用例；两处死注释与一份重复用例 |
| **声明面完整性** | `docs/design/2026-09-29-scope-surface-completeness.md` | §3.4 封存前的集合差（改动集 \ 声明面）——同一类事故发生过两次；§3.5 **路由的目标必须在同状态下可执行**（新路由指向会抛错的 `build`）；§16 的原始现象 |

两条都**只记录、未修**，并且各带验收标准草案与已知易错点。

### 一句话教训（本 change 的最终产出之一）

> **判定只能有一个来源；借来源时要连决定一起借。而一个读者变得更宽容时，要问它的消费者会不会把"读不出来"当成一个正面的答案。**

## 20. 收口时被 ledger 拒绝：诊断与移交

### 现象

第十二轮修复后 `review --approve` 被拒，两次，理由不同：

1. 第一次：`The ledger describes content that has moved since it was frozen: …（9 个文件）… Re-freeze the subject and re-verify the claims` —— 14 轮修复确实改了内容，**这条是对的**。修法：`ledger freeze`（新 subject `rev:22d17467ea711860`，34 paths）。
2. 第二次：`evidence_below_strength (C-1..C-4): major requires strength 3 … strongest supported is 0` —— **这条的措辞误导了我**。真正原因见下。

### 诊断

`kernel/decide.ts:164-172` 对 `verdict.subjectRevision !== input.subjectRevision` 的证据执行 `continue`，**不计入强度**：

```ts
if (verdict.subjectRevision !== input.subjectRevision && !input.reusedEvidence.has(item.id)) {
    reasons.push(reason('evidence_stale_subject', `${item.id} was decided against ${verdict.subjectRevision}…`));
    problems.add('stale'); continue;                    // ← 强度因此为 0
}
```

四条 verdict 都判在旧 subject `rev:d51db427771f7b4b` 上，所以 `strongestSupported = 0`，于是报"强度不足"——**而强度根本不缺**（`executable_falsifier` = 4）。修法是重放证据：

- `ledger replay` → 4/4 `agrees`、`replayRate 1`，但它**只报告、不写盘**（模块注释自己写明 "verdicts are returned, not recorded"）；
- `ledger evidence verify` → **确实写了**：四条 verdict 的 `subjectRevision` 现在都是 `rev:22d17467ea711860`。

### 剩下的拒绝：一条机制缺口，不属于本 change 的 AC

重放后 `decide` 只剩一条：

```json
{"ok": false, "verdict": "insufficient",
 "reasons": [{"code":"uncovered_risk_class","claim":null,"detail":"no claim covers: failure_mode"}],
 "deficits": []}
```

链条：变更触及 `src/quality/**`、`src/workflow/**` → floor `medium` → `FLOOR_TIER.medium = 'strict'` → `strict.requiredRiskClasses = ['consistency','boundary','failure_mode']` → 四条 claim 覆盖 `consistency/boundary/state_transition`，无 `failure_mode`。

**这是机制问题**：`failure_mode` 对任何 `strict` 变更都是无条件要求的风险类，与变更内容无关；补一条 claim 只是让检查通过（claim 是声明不是证据），而这正是本项目最反对的"gate 可以被文字满足"。且 `deficits: []` 与拒绝并存——操作者无法从中得知该做什么。

完整设计见 `docs/design/2026-09-29-required-risk-classes.md`（含 A/B 两种解法与 4 条拟验 AC）。

### 本 change 的处置

按**人工裁定**收口：ledger 的 `uncovered_risk_class` 如实记入 review evidence，**不在本 change 内改 `src/kernel/**`**（那是 gate 强度所在位置，应与 `bounded-review-convergence` 分开）。本 change 的交付面是 AC-1…AC-4，全部 PASS 且有会红的用例。

### 三处措辞/输出缺陷（一并记录）

1. `evidence_below_strength` 在 stale 场景下以**强度**措辞报告真实原因是"判定过期"——我据此去补更强证据，方向完全错误；
2. `replay` 与 `evidence verify` 的差别（只报告 vs 写盘）没有在输出里区分，而前者看不出来；
3. `deficits: []` 与 `reasons` 非空并存，没有解释二者关系。

## 21. 放行记录：本 change 以人工裁定终结在 review 相位

### 事实（实测，逐条可复现）

| 步骤 | 命令 | 结果 |
|---|---|---|
| 1 | `kata-cli verify --change bounded-review-convergence` | **PASS**，AC-1…AC-4 全 PASS，`drift: []`，并**重建了**绑到当前内容的 `review_gate` |
| 2 | `kata-cli gate approve --boundary review_gate --choice continue_current` | **成功**（gate 绑 `manifestHash 517acb9a…`，未消费） |
| 3 | `kata-cli review --change … --approve --review-evidence "…"` | **拒绝**：`The evidence ledger does not pass (insufficient): uncovered_risk_class: no claim covers: failure_mode` |
| 4 | `kata-cli ledger decide` | `ok: false`，唯一 reason 是 `uncovered_risk_class`，且 **`deficits: []`** |

### 为什么没有可走的出口

`review --approve` 是硬门槛，挡住它的是第 20 节已诊断的机制缺口——**`strict.requiredRiskClasses` 按档位无条件要求**，与变更内容无关。而 `deficits: []` 表示**没有可补的缺项**：这不是"缺一条证据/claim"，而是"一条与本次变更无关的要求"。

两条本可"通过"的路都不走，理由写在明处：

1. **手写 `review.json` / `claims.json`** —— 绕过审计。本 change 存在的理由就是消除"绕过审计的路径"，用它来终结本 change 是自毁。
2. **硬造一条 `failure_mode` claim** —— 用**声明**满足 gate，而 claim 不是证据。第 20 节刚刚判定这就是"gate 可以被文字满足"的形状；如果为收口而做，第 20 节的结论当场作废。

### 决定（人工）

**本 change 以人工裁定终结在 `review` 相位**：AC-1…AC-4 全部 PASS 且有会红的用例；ledger 的唯一残余拒绝是一条已登记、已设计、已移交的机制缺口。

- 放行依据：人类判断（本记录的作者与 change 所有者），**不是** ledger 的 pass。
- 由此产生的状态必须如实标注：**`review.json` 的 `status` 停留在 `pending`，`judge` 相位不可达。** 本 change 不是 `approved`，而是 `human-waived with a recorded gap`。
- 该豁免**不隐含**"gate 可以放宽"：缺口本身已经以四条拟验 AC 移交给 `docs/design/2026-09-29-required-risk-classes.md`。

### 本次运行登记的全部缺口（四份设计稿 + 本节）

| 缺口 | 设计稿 / 章节 | 一句话 |
|---|---|---|
| 声明面差额 | `2026-09-29-scope-surface-completeness.md`（§3.4 集合差、§3.5 路由可执行） | `seal` 的信封面是 ownedPaths，`verify` 的事实地平线是工作区，两者之差无人拥有；同一类事故发生两次 |
| 读状态语义 | `2026-09-29-read-state-semantics.md` | 同一 artefact 在一次决策内被读多次，"读不出来"没有跟着数据传下去；**同一族以六种面貌出现** |
| 风险覆盖要求 | `2026-09-29-required-risk-classes.md` | `strict` 档位无条件要求 `failure_mode`，使纯一致性修复无法通过，且拒绝不给可执行信息 |
| gate 重建路径 | 本节 §21 | re-seal 之后必须重跑 `verify`，否则 `review_gate` 仍绑旧内容而被拒；**行为正确但未在任何文档或输出中说明** |
| 拒绝的可执行性（跨三条） | 三份设计稿的 AC 均含此条 | 拒绝必须给出**可执行的下一步**：`deficits: []` + `reasons` 非空、`gate not bound` 不给重建路径，都是同一形状 |

### 给下一位读者的最短路径

1. 四条 AC 与它们的会红用例在 `tests/unit/review-*` 与 `tests/unit/revision-delta.test.ts`；
2. 十二轮的每一条发现与修法在本文档第 11–20 节；
3. 未修的缺口在四份设计稿里，各自带验收标准草案与已知易错点；
4. **不要为收口而把 gate 做成文字游戏**——这一节的存在就是为了让那件事有替代品。
