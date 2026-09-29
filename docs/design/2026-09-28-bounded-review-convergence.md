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
