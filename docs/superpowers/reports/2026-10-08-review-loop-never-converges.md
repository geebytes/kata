# Kata 迭代收敛问题报告：收敛探测器对「修复轮必换 revision」结构性失明

**日期**：2026-10-08
**状态**：Open — 七条均有可复现证据（源码行号 + 实跑记录 + 实测计数）；本报告不包含实现或测试修改。

**修订**：第三次提交补入 **F7**（在 `guard-the-property-not-the-proxy` 上复现）：CLI 自己打印的 review 收尾阶梯**不可执行** —— 第一步跨过 `review_gate` 并把它标记为 consumed，第二步（同一边界）又要求它，而 consumed 的 gate 无法重新批准；根因是 `recording` 判据只豁免了 `--result-file`，没有豁免 `--approve`。

**修订**：第二次提交补入 **F6**。F1 只覆盖「停滞探测器看不见」；而**同一套 revision 作用域也用在 finding 上，它关掉的是阻塞门禁本身** —— 那是这 14 轮循环之所以无界的直接机制。附录的数字口径同时修正为引用落盘记录（原为对话摘要）。
**范围**：Kata 0.2.0；下游项目 `zenmpai` 的 change `photo-observation-production-hardening` 在 `strict` tier 下经过 **14 轮 review/repair** 后的实跑。
**不把 Wiki / 设计稿当作代码正确性证明**：本报告每条结论都给出源码行号或盘上记录；「影响」引用实际发生的路由与服务输出，不做推断。

## 摘要

`strict` tier 下 `major` 与 `blocking` 都拒绝批准，因此一轮 review 若产生任一者，就会把控制权交回 `/kata-build`，修复后再 `--seal` 产出**新 revision**，然后重新 review。这条循环是这套工作流的核心机制，而 kata 也确实带了一个专门用来发现它「卡住」的探测器：`assessReviewLoop` 把连续无进展的轮次累积到 `NO_PROGRESS_ROUNDS = 3` 就报 `escalating`。

**这个探测器在它本该服务的循环里从不触发**，原因是一行过滤：

```ts
// src/quality/repair.ts:344
const scopedRounds = input.reviewRounds.rounds.filter((round) => roundBoundTo(round, identity));
```

`roundBoundTo`（`src/quality/repair.ts:262`）要求 `round.revisionId === currentRevision.revisionId && round.manifestHash === currentRevision.manifestHash`。而**修复轮的产物就是新 revision** —— 那是 `--seal` 的定义。于是每轮修复之后：

- 旧轮次全部不再绑定当前 revision；
- `scopedRounds.length === 0` → 返回 `{ kind: 'no_current_rounds' }`（`src/quality/repair.ts:345`）；
- `reviewProgress` 从未见过第二个轮次 → `noProgressRounds` 永远累积不到 3 → `escalating` 永远不为真。

**每一轮都看起来像第一轮。** 实测：本 change 的 `review-rounds.jsonl` 已有 **10 条记录**（每条一个 revision），而 `kata-cli status` 报 `"reviewLoop":{"kind":"no_current_rounds"}`。

**还有第二条独立的失明路径。** 那 10 条记录里 **9 条 `blockingCount: null`**。`reviewProgress`（`src/quality/repair.ts`）对 `blockingCount === null` 的轮次记入 `unmeasuredRounds` 并跳过；当全部轮次都不可测量时返回 `unmeasurable: true`，而 `assessReviewLoop` 把 `unmeasurable` 并入 `escalating`。也就是说：**假如那些轮次真的被 scoped 进来，第一次就会直接报 `escalating`。** 两条路径同时失效，方向相同 —— 探测器的输入被过滤掉，然后过滤剩下的部分又不携带可测的数字。

后果不是「门禁算错」，而是**工作流缺少一个它自己声称拥有的反馈信号**。协议要求每一轮由人读一遍结论并决定是否继续；当轮次成本恒定、而唯一的自动探测器恒报「无当前轮次」时，是否收尾只能靠人自己发现「我们已经在同一个 533 行区间里转了 9 轮」。

**同一套作用域还有第二个消费点，而且它更关键。** 轮次过滤只影响探测器；**finding 也被按当前 revision 过滤**（`record.boundToCurrentRevision ? record.findings : []`），于是每轮 reseal 会把**上一轮的全部 finding 移出阻塞集** —— `reviewFindings` / `blockingFindings` 归零，`navigation.ts:636/645` 的修复路由不再触发。见 **F6**：这是「没有任何东西会强制人注意到第 N 轮」的另一半，而且是更强的一半。

## 本次直接复现

| ID | 严重度 | 问题 | 影响 |
|---|---|---|---|
| F1 | blocking | 收敛探测把轮次限定在当前 revision，而修复轮必换 revision | 探测器恒报 `no_current_rounds`，`escalating` 永不触发；14 轮里没有一次自动提示「已停滞」 |
| F2 | major | 没有承载「声明闭包」的字段 | 负向判据的闭包内泄漏与真缺陷同权，severity 无法锚定到验收项 |
| F3 | major | claim 的 `statement` 文本参与身份摘要 | 改一句 docstring 作废该 claim 名下**全部**可执行证据，强制重新 freeze + verify |
| F4 | major | `failingEvidence` 只数 `exitCode !== 0` | 「不许出现 X」这类负向判据无法被记录成通过，实测被迫改写成正向形式 |
| F5 | minor | `severity` 是无定义自由枚举，且 strict 下 `major` 无条件强制修复轮 | 循环的出口条件退化为「复核者选择把一切判成 minor」 |
| F6 | blocking | **finding 也按当前 revision 过滤**，而修复轮必换 revision | 每轮 reseal 把上一轮 finding 移出阻塞集：`blockingFindings` 归零、修复路由不再触发；14 轮后任务显示 `reviewFindings: 0` 并只需一次 `--approve` 即可进 judge |

### F1 — 收敛探测器对「修复轮必换 revision」失明

**复现。**

```bash
kata-cli status --change photo-observation-production-hardening
# → "reviewLoop":{"kind":"no_current_rounds"}
```

而同一条输出同时报告：

```json
"currentRevisionId": "revision-5f360c062b6920c8",
"reviewMode": "strict",
"reviewFindings": 0, "blockingFindings": 0, "majorFindings": 0,
"verifyResult": "PASS", "wikiClosureValid": true
```

盘上的轮次历史（`.kata/tasks/photo-observation-production-hardening/review-rounds.jsonl`）**有 10 条**：

| # | revisionId（前 22 位） | blockingCount |
|---|---|---|
| 1 | `revision-5fdb218f07f229d…` | `null` |
| 2 | `revision-6ebac09696f16fa…` | `null` |
| 3 | `revision-d70e642a434db38…` | `null` |
| 4 | `revision-9bc0a3834a98534…` | `null` |
| 5 | `revision-2f5b29ff9066ccc…` | `null` |
| 6 | `revision-f1a51d3dc48ed20…` | `null` |
| 7 | `revision-ced4ed2a6937f3b…` | `null` |
| 8 | `revision-9b775d3d36574f5…` | `1`（`blockingIds: ["R2R9-F1"]`） |
| 9 | `revision-fa3a8733148f8e6…` | `null` |
| 10 | `revision-c0fcebdbe090e71…` | `null` |

每条记录的 `revisionId` **互不相同**，因此其中**没有任何一条**能通过 `roundBoundTo` 对当前 revision 的比较 —— 包括刚刚提交的那一轮。

**根因。** 三处实现相遇：

| 实现 | 位置 |
|---|---|
| 轮次按 revision 绑定：`round.revisionId === currentRevision.revisionId && round.manifestHash === currentRevision.manifestHash` | `src/quality/repair.ts:262`（`roundBoundTo`） |
| 评估前按该绑定过滤：`rounds.filter((round) => roundBoundTo(round, identity))` | `src/quality/repair.ts:344` |
| 过滤后为空即返回 `no_current_rounds`，不再看历史 | `src/quality/repair.ts:345` |

以及上游那条使循环必然产生的规则：非 `standard` tier 下 `mergeBlockingSeverities` 返回 `['blocking', 'major']`（`src/quality/review-ladder.ts:71`），消费点 `src/workflow/navigation.ts:636`（`blockingFindings > 0`）与 `:645`（`majorFindings > 0`）都路由回 `/kata-build`。**修复 → 新 revision → 旧轮次全部失联**，因此：

> 任何在 `strict` tier 下产生过 `major`/`blocking` 的 change，都无法让 `escalating` 为真，除非它在**同一个 revision 上**连续三轮无进展 —— 而修复轮的定义就是换 revision。

**第二条失明路径（独立）**：`reviewProgress` 对 `blockingCount === null` 的轮次只 `unmeasuredRounds += 1` 并跳过；`unmeasurable = currentRounds.length > 0 && measurable === 0`，而 `assessReviewLoop` 把 `unmeasurable` 并入 `escalating`。本 change 的 10 条里 9 条是 `null` —— **若它们被 scoped 进来，第一轮就会报 `escalating`**。因此「按 revision 过滤」与「轮次不携带可测计数」各自都足以让探测器失效，而它们同时存在。

**为什么这不是使用错误。** `--seal` 每次产出新 revision 是这套协议的核心（封印 = 内容摘要绑定），修复必须重新封印才能重新验证。所以「修复轮必换 revision」是**契约规定**的行为，探测器却把这个行为当作「换了一个不相关的主体」。两者直接冲突。

**缺失的回归。** 需要一条用例：**在同一 change 上产出 N 个 revision、每个 revision 各有一轮 review，断言 `reviewLoop.kind === 'stalled_current_rounds'`。** 现有测试覆盖单 revision 内的无进展累积，不覆盖「轮次跨 revision」这一必然情形。

**关闭条件（三条，语义不同，需要先做决定）。**

1. **把作用域从「当前 revision」提到「task 的轮次历史」** —— 例如按 `(findingId 集合)` 的**跨 revision 复发**计数：同一组 finding id 在连续 revision 上重复出现即算无进展。这最贴近真实停滞信号（本轮实跑里同类缺陷在 round 8/9/10/11 复发四次）。
2. **保留 revision 绑定，但新增跨 revision 的聚合读数**（例如 `roundsSinceLastReduce: n`），让 `status` 至少显示「已经连续 n 轮没有减少过 blocking 集合」。
3. **只修可测性** —— 让每一轮都写入 `blockingCount`（非 `null`），并把 `unmeasurable` 作为独立告警而不是 `escalating` 的同义词。这条最小，但**不解决** F1 的主张（跨 revision 仍然看不见）。

第 1 条是唯一同时覆盖「修复轮换 revision」与「同一缺陷复发」这一般情形的；第 3 条可以与它叠加（可测性是前提）。

### F6 — finding 也按当前 revision 过滤，于是每轮修复都把阻塞记录清空

F1 说的是**轮次历史**被 revision 作用域过滤 —— 那只影响停滞探测器。**同一套作用域还有第二个消费点，它在阻塞门禁本身：**

```ts
// src/workflow/review-read.ts —— readBlockingProblems()
const findings = record.boundToCurrentRevision ? record.findings : [];
return { ..., openProblems: openProblemsOf({ findings, claims }), ... };
```

`reviewFindings` 就是 `openProblems.length`。而 `--seal` 每轮修复都产出**新 revision**（封印 = 内容摘要绑定），于是 `boundToCurrentRevision` 立刻为假、`findings` 被清空，路由规则随即不再触发：

```ts
// src/workflow/navigation.ts:636
if (phase === 'review' && upstream.blockingFindings > 0) → /kata-build
// src/workflow/navigation.ts:645
if (phase === 'review' && blockingSeverities.length > 1 && upstream.majorFindings > 0) → /kata-build
```

**复现（本 change，14 轮之后）。**

```
$ kata-cli status --change photo-observation-production-hardening
currentRevisionId   revision-5779c4c3d5a2e753
reviewFindings      0
blockingFindings    0
majorFindings       0
reviewReady         false
verifyResult        PASS
askUser             ["Review 尚未形成绑定当前 revision 的显式结论和审查证据；
                      请以 /kata-review --approve --review-evidence <summary> 记录结论"]
```

也就是说这个**已经走过 14 轮、记录过 3 条 `major` 的任务，在任何一次 `--approve` 之后就能进 judge**，而状态里没有任何数字提示「它曾经反复不通过」。

审计轨迹**没有丢** —— 每轮 finding 都在盘上：

```
$ cat .kata/tasks/photo-observation-production-hardening/review-history.jsonl | ...
revision-5fdb218f07f229db   5 条
revision-6ebac09696f16fa2   5 条
revision-d70e642a434db387   9 条
revision-9b775d3d36574f55   7 条   （1 major）
revision-5f360c062b6920c8   8 条   （1 major）
revision-494df8848779c923   6 条   （1 major）
```

（另有逐 revision 的 `change-record-revision-*.json`，本任务 19 份。）

**根因：被判掉的是「驱动路由的计数」，而真正需要被看见的是「跨 revision 的复发模式」。** 两者不等价：

- 「一个 verdict 不能比它的内容活得久」——这条规则本身是**对的**（内容变了，旧判决自然失效，F1 与 F6 都建立在它上面）；
- 但把这条规则**只**用于「当前 revision 的开放问题数」，就等于宣称「修过一轮就算清零」。于是同一个缺陷族在相邻 revision 上复发多少次，都不进入任何计数器。

本任务实测符合这个结构：同一类缺陷在 round 8 / 9 / 10 / 11 / 12 / 13 / 14 反复出现，其中 6 轮的 finding **全部是上一轮修复自己引入的**，而 `blockingFindings` 每一轮都归零。

**为什么这不是使用错误。** `--seal` 产出新 revision 是协议核心，修复必须重新封印才能重新验证 —— 与 F1 同理。把「换主体」当成「问题已解决」，是判据把契约行为误读成了内容变更。

**缺失的回归。** 一条用例：同一 change 上依次产出 revision A（一轮 review 记 2 条 `major`）与 revision B（再次 review 记同 2 条 `major`），断言状态里存在一个**跨 revision 的读数**——例如「连续 n 轮未减少的 finding 集合」——并且在该读数达到阈值时路由进入升级而不是 `repair_strict_major_findings`。

**关闭条件。** 与 F1 应作为一个决定处理，因为它们是**同一作用域的两处消费点**：只修 F1 会让探测器能看见停滞（好），但只要 F6 还在，`blockingFindings` 就继续每轮归零 —— 于是「看得见」与「会阻断面」之间仍然脱节。可行方向：

1. 在 F1 的跨 revision 聚合之上再暴露一个**跨 revision 的开放问题集合**（例如按 finding id 的复发计数），让 `status` 与路由都能读到它；
2. 或者保留 per-revision 的阻塞语义（它对「内容是否仍成立」是正确的），但**额外**要求：一个 finding id 在连续 N 个 revision 上复发即计入停滞，无论它当前绑在哪个 revision 上。


### F2 — 没有承载「声明闭包」的字段

**复现。** 下游项目的 `AGENTS.md` 有成文规则：

> **判不了的不假装能判**：静态分析诚实闭合不了的形状，写进规则 docstring 的「声明边界」并在 review 清单点名，而不是留一句「已强制」
> 负向分类器（「这个形状不允许」）反复泄漏时的正解是**收窄可判定域**，不是继续加一层外衣

而 kata 的 schema 里没有地方放它：

```json
// schemas/claim.schema.json —— 顶层字段实测为：
["id", "statement", "riskClass"]
// 不含 boundary / closure / scope / limit
```

`review-finding.schema.json` 同样只有 `id / taskId / acceptanceId / severity / message / path / reproduction`，**没有 `insideDeclaredBoundary` 或同类字段**。

**根因。** 一个**负向分类器** claim（「这类形状不允许」）的本质是「判据的闭包之外还有东西」。工作流要求复核者尝试证伪，于是复核者每次都能找出一条闭包外的形状；而因为它无处声明「这条落在我声明的闭包之外」，它只能表现为一个普通 finding，再由复核者**自由选择** severity。

**影响实测。** 落盘的 40 条 finding（6 条记录，见附录口径说明）里，验收结论（AC-1..AC-8）**一次都没有变过** —— 14 次 `verify` 全部 PASS。后期多轮 finding 集中在同一条判据的边界措辞上，被记成 `major` 的有 5 次，每次都触发一轮必做的修复。**闭环的出口条件是「复核者选择把一切判成 minor」，而不是「验收项已达成」。**

**缺失的回归。** 一条用例：claim 声明了闭包、finding 标记落于闭包内、且无 blocker 时，路由**不得**进入强制修复轮。

**关闭条件（两处 schema + 一处路由）。**

1. `claim.schema.json` 增加 `boundary`（声明的闭包，负向分类器 claim 必填）。
2. `review-finding.schema.json` 增加 `insideDeclaredBoundary: boolean`（必填）。
3. `src/workflow/navigation.ts` 的分级路由（`:636`、`:645`）只对 `insideDeclaredBoundary === false` 的 `blocking`/`major` 触发修复；落在闭包内的仍然记录，但按「提示更新声明或改判据」处理。

这**不削弱**门禁：它把「这条算不算缺陷」这个判断从 severity 数字里挪到显式字段上，可复核、可审计。复核者仍然要判断在内还是在外 —— 只是判断不再隐藏在 grade 里。

### F3 — claim 的 `statement` 文本参与身份摘要

**复现。** 下游在 14 轮里执行 `kata-cli ledger claim restate` 十余次，只为改一句边界措辞。每次 restate 之后：

```bash
kata-cli ledger freeze --change <id>        # 重新冻结 subject
kata-cli ledger evidence verify --change <id>   # 7 条 falsifier 全部重跑
kata-cli orient → handoff create → acknowledge  # 重新拿 receipt
```

原因是 claim 的 `statement` 属于 subject 身份摘要的一部分，改它就等于换了主体，证据随之失联。

**根因。** claim 身份把**散文**与**可执行证据**摘要在一起。而 claimed 的可执行证据（falsifier 的 command / mutation / expect）在这些措辞改动里**一次都没变过**。

**影响。** 「改一句 docstring」的边际成本 = 一次完整 freeze + 7 条 falsifier 重跑 + 一套 handoff 循环 + 一次 seal。这一项是**时间**成本的主因：14 轮里每轮都要付一次。

**缺失的回归。** 一条用例：只改 `statement` 文本（不改 command / mutation / expect）之后，`evidence verify` 的既有 verdict 仍有效或至少**只需重跑受影响的 claim**。

**关闭条件。** claim 身份摘要只覆盖**可执行证据**（command + mutation + expect + claim id），`statement` 改为可自由重述的叙述字段。若担心「改措辞掩盖了改判据」，可以对 statement 做**独立**校验（例如要求 falsifier 的 mutation 与 statement 的闭包声明一致），而不是把它塞进同一份摘要。

### F4 — `failingEvidence` 忽略 `expect.exitCode`

**复现。**

```ts
// src/workflow/navigation.ts:439
failingEvidence: evidence.filter((item) => item && typeof item.exitCode === 'number' && item.exitCode !== 0).length,
```

实测：一条 C3 claim 的检查是 `grep -rE '<pattern>' <dir>`，**语义是「不许出现」**，因此 `expect.exitCode: 1`。它在盘上记成：

```json
{ "passed": true, "exitCode": 1, "expectExitCode": 1 }
```

而 `failingEvidence` 数到它，报 `1`，`verify` 因此判 FAIL —— 症状是 `acceptanceResults` 全 PASS、`openProblems: 0`，而 `verifyResult: FAIL`。

**根因。** 计数只看 `exitCode !== 0`，**完全不读 `passed` 与 `expectExitCode`**。因此任何「期望非零退出码」的检查都无法被记录成通过。

**为什么这是结构性的。** 「不许出现 X」是负向判据最自然的表达形式（本 change 里就有「domains 全树不得 import 任何解码器 SDK」）。在这条计数下，**所有负向判据天然显示为失败**。

**缺失的回归。** 一条用例：`expect.exitCode: 1` 且实跑 `1` 的 evidence 不计入 `failingEvidence`。

**关闭条件。** 计数读 `passed`；若无 `passed` 则读 `expectExitCode` 与 `exitCode` 的比较。**一行改动**。

**当前缓解（仅绕开，不改门禁）**：把检查改写成等价的**正向形式** `bash -c '! grep …'`（exit 0 = 声明成立）。判据强度不变（有违规即 exit 1，违规行进日志），但依赖了那个失效字段的替代路径。

### F7 — review 收尾阶梯的两步里，第二步要求第一步已经消耗掉的那张 gate

**状态**：Open，2026-10-08 在 `zenmpai` 的 strict change `guard-the-property-not-the-proxy` 上实跑复现（Kata `/app/kata` 0.2.0，commit `2468205`）。

**影响**：CLI **自己打印**的收尾阶梯不可执行 —— 照做的人会卡在一条没有出路的拒绝信息上，而 review 结论写不进去。

**复现。** 实现与硬验证完成后，`nextAction.pauseInstruction` 打印的是（`src/workflow/navigation.ts:793`）：

```text
进入 review 后要跑两条命令：`kata-cli review --change <id>` 先把相位推进 review，
`kata-cli review --change <id> --approve` 在相位推进前会被拒绝。
```

而 `followUpCommand`（`navigation.ts:788`）给的正是第二条：

```text
kata-cli review --change <id> --approve --review-evidence "<...>"
```

实测序列：

```bash
kata-cli gate approve --boundary review_gate --choice continue_current   # ✓ approved
kata-cli review --change <id> --confirm-host-model                       # ✓ phase: hardVerify → review
kata-cli review --change <id> --approve --review-evidence "<...>"        # ✗ review_gate requires an explicit user choice before continuing
kata-cli gate approve --boundary review_gate --choice continue_current   # ✗ User choice gate review_gate has already been consumed. <rebuild instruction>
```

第一步跨过边界时把 gate 标记为 `consumed`，第二步命中**同一边界**又要求它，而 consumed 的 gate 无法重新批准 —— `approveUserChoiceGate`（`src/workflow/user-choice-gate.ts:167-169`）在 `gate.consumedAt` 存在时直接抛错，只给「由创建该边界的命令重建」这条指示，而对 `review_gate` 而言重建命令是 `verify`（重跑一次 verify + 重新 approve 才能继续）。于是**阶梯的第二条永远不可能在第一条之后成功**。

**根因（源码）。** `src/cli/workflow.ts:70-73` 已经把「记录不是跨界」这条规则写对了，但判据只认一种记录形态：

```ts
const boundary = boundaryForCommand(command, inputPhase, { recording: resultFileRequested(argv) });
```

而 `boundaryForCommand`（`src/cli/workflow.ts:329-341`）在非 recording 时对 `phase === 'review'` 返回 `review_gate`。因此：

- `review --result-file <file>` → `recording: true` → 不需要 gate ✓（这条路径下游实测可用）；
- `review --approve --review-evidence <...>` → `recording: false` → 要求 gate ✗ —— 而它**同样是**「把已经跨过边界的会话结论写下来」，不是又一次跨界。

同一处判据覆盖了一半：它豁免了 findings 的记录，没有豁免 approval 的记录。

**为什么这不是使用者漏了一步。** 阶梯文本、`followUpCommand` 与 `pauseInstruction` 都是 CLI 自己给的；`--for-task`（把选择记到任务级、后续边界复用）确实是可行的替代，但**阶梯文本没有提到它**，而 `--for-task` 的语义是「别再问同一个人同一个问题」，与「记录结论不是跨界」是两件事。使用者按打印出来的两条命令操作，得到的是一个无法自洽的固定点。

**建议修复（任选其一，建议 A）。**

- **A（推荐）**：把 `--approve`（带 `--review-evidence` 的 review 调用）纳入 recording 判据 —— 它与 `--result-file` 一样只写结论，不打开相位。判据应基于「这次调用是否**打开**这个边界」，而不是基于它带的是哪个 flag 名字：`review --change <id>`（无结论参数）跨界，带 `--result-file` 或 `--approve --review-evidence` 的都是记录。
- **B**：保持现状，但把阶梯改成**单条**命令 —— 即打印 `kata-cli review --change <id> --confirm-host-model --approve --review-evidence "<...>"`（实测这一条能一次完成跨界 + 记录，因为它把两次动作放进同一次调用，gate 只被要求一次），并说明「先 `review` 再 `review --approve`」在未加 `--for-task` 时会失败。
- **C（仅作配套）**：在阶梯文本里补上 `gate approve --for-task`，让任务级选择覆盖后续边界。

**必需回归测试。**

1. `gate approve` → `review --confirm-host-model` → `review --approve --review-evidence <...>`：第二条必须成功（或按 B 的改法，阶梯只给单条命令且该命令成功）。
2. 断言 consumed 的 gate 上运行 `--approve` 的失败信息**包含可执行出路**（重建命令 + 是否需要 `--for-task`），而不是只报「已被消耗」。
3. `--result-file` 的既有豁免必须保持（`recording` 判据扩展后不得把它弄坏）。
4. 反例夹具：真正**打开**边界的那条调用（`review --change <id>`，不带任何结论参数）仍然必须要求 gate —— 豁免不得扩散成「review 相位内一切调用都免检」。

**非主张。**

- 不主张取消 review_gate 或让 approval 免于人工确认：需要的是把「记录结论」与「跨界」分开，而不是让 approval 不再需要人。
- 不主张下游的做法（重跑 `verify` 重建 gate、再单次 `--confirm-host-model --approve`）是正解 —— 它只是可用，且要求使用者自己从源码里推出这条路径。这与 F1/F6 是同一族缺陷：**正确的规则写在一处，而消费它的地方只认一半。**

### F5 — `severity` 是无定义自由枚举，且 `major` 无条件强制修复轮

**复现。**

```json
// schemas/review-finding.schema.json
"severity": { "type": "string",
  "enum": ["blocking", "major", "minor", "note", "nit"] }
```

**无 `description`、无定义**；`.agents/skills/kata-review/SKILL.md` 里对 severity 也**零约束**（实测 grep 无命中）。而路由：

```ts
// src/workflow/navigation.ts:636
if (phase === 'review' && upstream.blockingFindings > 0) → /kata-build
// src/workflow/navigation.ts:645
if (phase === 'review' && blockingSeverities.length > 1 && upstream.majorFindings > 0) → /kata-build
```

`blockingSeverities` 来自 `mergeBlockingSeverities`（`src/quality/review-ladder.ts:71`），`strict` 下是 `['blocking', 'major']`。

**根因。** 没有任何机制把 severity 锚定到**验收项是否因此不成立**。一条「守卫的边界措辞与实现闭包不符」的 finding 与一条「生产行为错误」的 finding，都可以被记成 `major`，都强制一轮修复。

**影响。** 这是 F1 之外使循环**无上界**的另一半：即使探测器能看见停滞，只要复核者继续把闭包类 finding 判成 `major`，路由就继续要求修复。两者叠加的结果就是本 change 的 14 轮。

**缺失的回归。** 一条用例：`major` finding 若指向**已声明闭包内**的形状，路由不进入强制修复。

**关闭条件。** 与 F2 同源：**`blocking`/`major` 必须携带 `insideDeclaredBoundary === false`**，或者更直接地要求 `blocking`/`major` 必须点名一个**因此不成立的 `acceptanceId`**。后者是一行 schema 约束（把 `acceptanceId` 在该 severity 下变为必需），且语义清晰：**一条缺陷之所以是 major，是因为它让某条验收项不成立。**

## 建议

**先修 F1 + F6（均为 blocking）+ F4（一行）。** F1 与 F6 是**同一 revision 作用域的两处消费点**，必须一并处理，否则只修好「看得见」而没修好「会阻断」；两者都属于「声明了机制却不工作」这一类。F4 是纯粹的计数错误且修复成本最低。三者都不改变协议语义。

**F2 与 F5 应作为一个决定一并处理**，不要拆开：它们是同一个缺失概念的两面（severity 无法锚定，因为闭包无处声明）。建议先决定「闭包声明放在 claim 上还是在规则 docstring 上」，再动 schema —— 后者会影响下游项目如何写守卫。

**F3 单独开。** 它需要先决定「claim 身份应该绑定什么」（可执行证据 vs 叙述），那是一个独立的设计问题，与收敛无关；但它决定了每轮修复的**时间**成本，因此值得排在 F2/F5 之后、但不应与它们混在一个验收契约里 —— 那会让「这次改了什么」变模糊。

**一条本报告不主张的事。** 本报告不主张给 review 加轮次上限。停滞信号的意义是**让人看见**并据此做决定（收窄判据、拆出后继 change、或声明闭包后收尾），而不是自动截断 —— 自动截断会把「引擎真的在收敛但需要 5 轮」误杀。F1 关闭后，`escalating` 会把「已停滞」这件事摆到操作者面前，这正是缺的东西。

## 附：本次实跑的量

| 项 | 值 |
|---|---|
| review/repair 轮次 | 14 |
| `verify` 结果 | **每次全部 PASS**，AC-1..AC-8 从未变过 |
| `review-rounds.jsonl` 记录 | **10 条**，9 条 `blockingCount: null` |
| `review-history.jsonl` 记录 | **6 条 / 40 条 finding**（含 3 条 `major`） |
| `change-record-revision-*.json` | 19 份（逐 revision 留档） |
| `status` 收敛读数 | `{"kind":"no_current_rounds"}`；`reviewFindings: 0`（14 轮之后） |
| 累计 finding（落盘口径） | 40 条（见下「口径说明」） |
| 被争的判据所在文件 | `tests/architecture/test_photo_observation_boundaries.py`，1521 行（其中约 533 行服务于被争的三处判据） |
| 同期交付物 | 生产代码 3,633 行 + 生产测试 4,806 行 |

也就是说：**约 6% 的变更吃掉了 14 轮复核，而验收契约自始至终没有被推翻过一次。** 这个比例本身就是 F1 与 F6 共同掩盖的东西。

**口径说明（第二次提交修正）。** 本报告初版写「12 轮 / 62 条」，那个数字取自下游会话的**对话摘要**，不是盘上记录 —— 与本报告自身「每条结论都给可复现证据」的标准不符，故更正为落盘口径：`review-rounds.jsonl` 10 条轮次、`review-history.jsonl` 6 条记录共 40 条 finding。差额来自**下游的操作疏漏**：第 4/5/6/7/8/10/11 轮的 finding 只在对话里报告过，**没有通过 `review --result-file` 落盘**，因此不进 `review-history.jsonl`。这不影响 F1/F6 的结论（两者的证据是「作用域把已落盘的记录也过滤掉了」，不是 finding 总数），但**它本身是 F6 的一个注脚**：一个只按当前 revision 计数的门禁，连「这个任务一共被记过多少条 finding」都不会让人看见。

## 边界：本报告不主张的

- 不主张 kata 造成了这 14 轮。产生它们的是下游把「对所有违规形状都必须变红」写成了验收项 —— 一个静态分析无法满足的无界全称；而项目自己的 `AGENTS.md` 已写明正解（声明边界、收窄可判定域），执行者没有照做。**kata 的缺陷是没能让这件事被看见，不是让它发生。**
- 不主张 severity 应该由算法自动判定。F2/F5 的改法是要求 severity **带上它的依据**（闭包内/外，或点名一条因此不成立的验收项），不是替复核者做判断。
- 不主张把 `boundToCurrentRevision` 去掉。那条规则对「判决是否仍成立」是正确的；F6 要的是**在它之外另有一个跨 revision 的复发读数**，不是取消它。
- 未验证：`review-rounds.jsonl` 里 9 条 `blockingCount: null` 的**写入路径**（是提交结论时未携带计数，还是某条分支漏写）—— 这决定了 F1 关闭条件第 3 条是「补写」还是「修读取」。本报告只证明这些记录**不携带可测计数**且因此无法参与 `escalating` 判定。

## 与本仓已有任务的关系（供维护者定位）

本仓 `.kata/tasks/bounded-review-convergence/`（phase = `intake`）的 AC-4 已经写着：

> Review-to-repair cycles that do not reduce the count of merge-blocking findings stop being routed back to `/kata-build` and instead produce an escalation that names the cycle count and the findings still open, derived from recorded repair history rather than from prose.

**F1 给出的是这条 AC 目前无法被满足的机制原因。** 该 AC 的措辞是「derived from **recorded repair history**」—— 而 `review-rounds.jsonl` **就是**那份历史，它也确实记录了 10 条（每条一个 revision）；问题在于 `assessReviewLoop` 在读它之前先用 `roundBoundTo` 把范围收到**当前 revision**，而修复轮的产物就是新 revision。因此「从记录的历史派生」这一步在实现上被否掉了：历史存在、被读了、然后被过滤空。

换句话说，AC-4 的**数据来源**已经具备，缺的是「作用域应为跨 revision 的 task 历史」这一决定 —— 也就是 F1 关闭条件第 1 条。本报告不主张采用哪一条关闭条件（那是一个设计决定），但指出：若沿用当前的作用域定义，AC-4 无论怎么写都会在「修复轮必换 revision」这一契约行为上失明。
