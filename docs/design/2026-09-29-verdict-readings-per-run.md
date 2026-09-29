# 判决的读数：每个 run 一条，投影派生

**状态**：设计（实施前）
**来源**：`gate-input-integrity` 第二轮独立审查期间实测出来的机制缺口（设计文档 §11.3 第 2 条）
**性质**：本 change 不修 `gate-input-integrity` 的任何文件；它修的是**判决存储**，`gate-input-integrity` 只等它落地。

## 1. 问题

`security` 档要求 `reviewers: 2`，而**这个要求在本仓库的结构上不可能满足**。

**实测**（2026-09-29，`gate-input-integrity` 的账本）：

1. 该 change 触及 `src/kernel/policy.ts`／`decide.ts`（floor `high`）→ 自身档位是 `security`；
2. 账本记录了一次读数（`--adapter inline --actor kata-agent`），`decide` 报 `quorum_missing`（1 submitted, 2 required）；
3. 第二次**独立**读数被如实记录（`--adapter file --actor independent-review-2 --results-dir .kata/review-results`，6 条证据全部 `supported`）；
4. `decide` **仍然**报 `1 submitted`。

原因在 `src/store/ledger.ts:505` 的 `recordVerdicts`：

```ts
const prior = new Map(verdicts.map((verdict) => [verdict.evidenceId, verdict]));
for (const verdict of incoming) {
    const index = verdicts.findIndex((entry) => entry.evidenceId === verdict.evidenceId);
    if (index >= 0) verdicts[index] = verdict;   // ← 替换
    ...
}
```

按 `evidenceId` **替换**，所以 store 里每个证据**只有一条**判决。而 `kernel/quorum.ts` 的 `groupByProducer` 是按 `verdict.producer.runId` 分组的——**它只能看见分组完成后的那一条**，于是 `records` 永远只有一个 run，`reviewers` 永远等于 1。被替换掉的那条读数只留在 `verdict-history.jsonl`（`superseded: true`），**quorum 不读历史**。

这不是新缺陷的形状，而是同族的第五次：`kernel/quorum.ts` 自己的注释写着

> Measured on this repository, `security.reviewers: 2` was unenforceable — a single producer reached `security`.

那次修复把**聚合**从 `producers/quorum.ts` 搬进内核，并改成"按 run 而非按名字计数"——**聚合对了，存储没跟上**，所以要求依然不可达。

## 2. 目标 / 非目标

**目标**

- 判决存储保留**每个 run 的读数**（append-only 的事实），投影（"这个证据现在算哪条"）**派生**而非覆盖。
- `security.reviewers: 2` **可达**：两次独立读数之后，`decide` 不再报 `quorum_missing`。
- 一条证据有多条读数时，**按 claim 的判定是确定性的**，且"被否证过的证据不会被多数投票洗掉"。

**非目标**

- **不改 `assurance` 的语义**（沙箱地板是宿主能力问题，另一个 follow-up）。
- **不改 `security` 的档位门槛或 `reviewers` 数字**——本 change 让要求可达，不降低要求。
- **不改 `kernel/decide.ts` 与 `store/verdict.ts`**：这是**硬约束**（见 §5），本 change 必须与 `gate-input-integrity` 的声明面**不相交**，否则两个 change 的 revision 会互相 supersede。

## 3. 设计

### 3.1 存储：一条读数一个条目

`verdicts.json` 改为**append-only 的读数列表**：条目 = `(evidenceId, producer.runId)`。同一 run 对同一证据的**重复**记录仍然替换（一次运行对一条证据只有一个结论——这是幂等，不是覆盖另一个 run）。写入点仍是 `recordVerdicts` 这一个。

`verdict-history.jsonl` 保留（它记录的是"同一条读数被后来的读数取代"），但**不再承担唯一的历史职责**。

### 3.2 投影：一条函数，两个消费者

| 消费者 | 它要的 | 从哪里取 |
|---|---|---|
| **per-claim 判定**（`evaluateClaim` → `verdictFor`） | 这个证据**现在**算哪条 | 投影（§3.3） |
| **quorum**（`groupByProducer`） | **每个 run** 各自读了什么 | **全部读数**，不做投影 |

因此 `readLedger` 的返回要同时给出两件事：`verdicts`（投影，per-claim 用）与 `readings`（全部，quorum 用）。`ledgerVerdict` 把 `readings` 交给 quorum——它已经在做这件事（用的是 `ledger.verdicts`），**所以只要 `verdicts` 保持"投影"的语义，`store/verdict.ts` 一行都不用改**：把 `ledger.verdicts` 换成 `ledger.readings` 会让它变化，于是**不能换**，见 §5 的约束推导。

### 3.3 投影规则（一条）

一条证据有多条读数时：

1. **任一读数 `refuted` ⇒ 该证据是 `refuted`。** 理由在内核自己的规则里：可复现的反例不被投票掉（"a reproducible finding is never voted away"）。这条保证"多记一次读数"不会把已被证伪的证据洗成 supported。
2. 否则取**最新**读数（按 `at`，同 `at` 取写下较晚者，再同则取 runId 字典序大者——**全序**，所以结果与遍历顺序无关）。
3. 读数只有一条时，投影就是它（没有行为的改变）。

### 3.4 谁读 `readings`

- `store/ledger.ts`：`readLedger` 返回 `readings`（全部）与 `verdicts`（投影）。
- `kernel/quorum.ts`：**不改语义**；它的输入由调用方从 `readings` 取。若它当前接的是"投影列表"，本 change 把调用方改对，而不是在 quorum 里补一层猜测。
- `kernel/evidence.ts`：`verdictFor` 实现 §3.3 的规则（它是 per-claim 判定的唯一入口）。

## 4. 验收标准（草案）

- **AC-1**：同一证据在两次不同 run 中被记录后，**两条读数都可读**，各自带着自己的 `producer.runId` 与 `actor`；同一 run 重复记录同一证据**仍只有一条**（幂等，不是覆盖另一个 run）。
- **AC-2**：`reviewers` 按**独立 run** 计数：两个 run 读了同一批证据 ⇒ `2`；一个 run 的读数被写两次 ⇒ 仍 `1`；两个 run 的 `actor` 不同 ⇒ `undiversified: false`。
- **AC-3**：投影规则确定：任一条 `refuted` ⇒ 该证据 `refuted`（反例不被投票掉）；否则取最新；**用例对三个分支各一条**，并证明结果与读数顺序无关（打乱输入数组，答案不变）。
- **AC-4**：**可达性**（本 change 的目的）：两次独立读数之后，`decide` 不再报 `quorum_missing`；**变异证明**——把 `recordVerdicts` 退回按 `evidenceId` 替换，用例必须变红。
- **AC-5**：读数**不丢**：任何时刻被记录的读数都能从 store 读回（`readings`），投影不删任何东西；一条读数被后来的取代时，历史里仍有它（含取代关系）。

## 5. 影响面与**硬约束**

**必须与 `gate-input-integrity` 的声明面不相交**（实测其声明的 28 条 `src/` 路径见其 `task.json`）。它已声明：`src/kernel/decide.ts`、`src/kernel/policy.ts`、`src/kernel/risk.ts`、`src/store/verdict.ts`、`src/store/corpus.ts`、`src/store/replay.ts`、`src/cli/ledger.ts`、`src/producers/submission.ts`、`src/workflow/**`、`src/quality/**` 等。

**本 change 的 ownedPaths（拟）**：

- `src/store/ledger.ts`（读数列表 + `readLedger` 的两个投影）
- `src/kernel/quorum.ts`（若需要，只补注释与类型；语义不变）
- `src/kernel/evidence.ts`（`verdictFor` 的投影规则）
- `src/kernel/types.ts`（若 `Ledger` 增字段）
- `src/producers/verifiers.ts`（若读数的 producer 形状需要说明）
- 对应测试 + 本文档

**由该约束推出的关键设计决定**：`store/verdict.ts` **不能改**（它被 `gate-input-integrity` 声明），所以 `ledger.verdicts` 必须**保持"投影"语义**、quorum 改从新的 `readings` 取——这条约束不是风格偏好，而是两个 change 能否同时 `current` 的**机制条件**。

## 6. 风险

1. **投影规则本身是新的判据**：它决定"一个被一个 run 证伪、被另一个 run 支持的证据算什么"。§3.3 取"否证优先"，与内核既有规则一致；若将来要允许"复审推翻证伪"，那需要一条**显式**的取代记录，而不是靠计数。
2. **旧的 `verdicts.json`**（单条形状）必须仍然可读：读取侧要认"每个 `evidenceId` 只有一条"的旧文档（它就是今天的全部账本）。这是 `gate-input-integrity` 的 R-10 教过的同一课——**改了存储形状就等于改了已存记录的可读性**。
3. **quorum 的 `disputed` 语义会被首次真正用上**：两个 run 对同一证据给出不同结论时，`disputedClaimIds` 才第一次非空。要有一条用例把它钉住，否则 `quorum_disputed` 仍然是"永不触发的分支"。

## 7. **硬约束的实测结果：本 change 无法与 `gate-input-integrity` 并行**

§5 的那条约束（声明面相交通常会让两个 change 互相 supersede）在本 change 上**不是理论风险，而是实测的阻断**。逐点测量：

`verdict.ts` 里 `ledger.verdicts` 被用了三次（`:114` 传给 `decide`、`:251` 交给 `groupByProducer` 组 quorum、`:264` 再传给 `decide` 的另一个分支），而**它按 `evidenceId` 替换**（§1）。所以要么：

- **(A) `ledger.verdicts` 保持"投影"**（一条证据一个答案），quorum 改从新字段 `readings` 取 ⇒ **必须改 `src/store/verdict.ts`**；
- **(B) `ledger.verdicts` 改为"全部读数"**，投影下移到 `verdictFor`（`src/kernel/evidence.ts`，可用）⇒ quorum 那行不用改，但**其余消费者会看到重复读数**，它们各自的语义都会变：

| 消费者 | 文件 | 在 gate-input 的声明面里？ | 若 `verdicts` 变成"全部读数" |
|---|---|---|---|
| per-claim 判定 | `src/kernel/evidence.ts` | **未声明（可用）** | 改 `verdictFor` 即可 |
| 重放 | `src/store/replay.ts` | **已声明（冲突）** | `Map` last-wins 会取到"任意一条"，与投影规则不一致 ⇒ decide 与 replay 对同一账本给出不同答案 |
| 展示/计数 | `src/cli/ledger.ts` | **已声明（冲突）** | `find(evidenceId)` 取第一条、`filter(evidenceIds)` 出重复行 |
| delta 复用 | `src/kernel/delta.ts` | 未声明（可用） | 需按投影读 |

也就是说：**无论走 (A) 还是 (B)，都至少要改一个被 `gate-input-integrity` 声明的文件**（(A) 改 `store/verdict.ts`；(B) 改 `store/replay.ts` 与 `cli/ledger.ts`），而 (B) 还会在 `replay` 与 `decide` 之间制造**两个答案**——正是本仓库最反对的形状。

**结论**：本 change 与 `gate-input-integrity` 不能同时 `current`。要么 gate-input 先出清（放行记录 + 合入），要么本 change 先做而 gate-input 的 revision 因这四处声明路径而 `superseded`（届时它需要重新封存、重新 verify、重新冻结账本、重新走审查批准）。

按 `#689` 记录的机制，后者不是"多跑几个命令"：一个 change 的 revision 一旦 supersede，它的 `freshPassingTestEvidence` 就不再包含它，distill/archive 门会拒绝——所以**顺序上"先出清再做"是唯一不产生返工的顺序**。

## 8. 约束解除后的设计选择（§5 的推导已被历史取代）

`gate-input-integrity` 已按放行记录合入 `master`（其设计文档 §12），所以 §5 那条"必须与其声明面不相交"的约束**不再存在**：本 change 现在可以按**最好的设计**来做，而不是按"能避开谁"来做。

因此 §3.2 的选择确定为 **(A)**：

- `readLedger` 返回 **`verdicts`（投影：一条证据一个答案）** 与 **`readings`（全部读数）**；
- 需要"这个证据现在算哪条"的消费者拿 `verdicts`，**不多写一行**；
- 需要"每个 run 各读了什么"的 quorum 改从 `readings` 取（`src/store/verdict.ts` 的 quorum 取数点一处改动）；
- 投影**只在 store 里算一次**，所以不存在"三个消费者各自投影、必须彼此一致"的第二事实源。

被放弃的 (B)（把 `ledger.verdicts` 变成全部读数、投影下移到 `verdictFor`）不再是"为避免冲突而放弃"，而是**因为设计更差**：它会把投影规则复制到每个消费该列表的地方（`replay`、`cli/ledger`、`delta`），也就是本仓库反复删除的那一类（一个事实、多个来源）。

**唯一保留的约束**：本 change 的改动会令 `gate-input-integrity` 的 revision 变为 `superseded`。那是**预期的**——它的记录是合入的提交与设计文档，不再依赖 kata 相位；此处写明以免后来者把这条状态误读为异常。

## 9. 实施记录（六条 AC 落地）

| AC | 落地位置 | 用例 | 变异证明 |
|---|---|---|---|
| **AC-1** 一个 run 一条读数 | `store/ledger.ts`：条目键改为 `(evidenceId, runId)`（`readingKey`），同 run 重写幂等、异 run 追加 | `tests/unit/verdict-readings-per-run.test.ts`（两条读数各自带 `runId`／`actor`） | 把键退回 `evidenceId` ⇒ 4 条用例红（含 AC-4 的可达性） |
| **AC-2** quorum 按 run 计数 | `store/verdict.ts` 的 quorum 取数点改读 `ledger.readings` | `tests/unit/quorum-counts-runs.test.ts`（两 run = 2；同 run 写两次 = 1；同 actor = `undiversified`；分歧 → `disputed` 并点名 claim） | 同上（键退回时计数失去第二 run） |
| **AC-3** 投影确定性 | `kernel/evidence.ts` 新增 `projectVerdicts`：任一 `refuted` 胜出，否则取最新（`at` → runId 全序），输出按 `evidenceId` 排序 | `tests/unit/verdict-projection-is-deterministic.test.ts`（含"倒序输入答案相同"） | 用例自身先抓到一个真实缺陷：投影原本按"首次出现"返回，倒序输入会改变列表顺序 |
| **AC-4** 档位要求可达 | 上述两处合起来 | `tests/unit/two-reviewers-satisfy-the-tier.test.ts`：第二次读数后 `decide` 不再报 `quorum_missing`；同 run 写两次仍报 | 键退回 ⇒ 该用例红 |
| **AC-5** 不丢读数 | `readLedger` 仍读同一份文档，`readings` 即文档内容；投影是视图 | `verdict-readings-per-run.test.ts`（`readings` 长度 = 文档长度；投影 ≤ 读数） | —— |
| **AC-6** 旧文档可读 | `readingKey` 对缺少 `producer` 的旧判决用空 runId ⇒ 与 `groupByProducer` 的 `UNATTRIBUTED_RUN` 同键，旧文档读作**一条**读数 | 同文件（手写旧形状文档 → 仍得 `supported`） | —— |

**投影的规则是新的判据，因此它被单独钉住**：`refuted` 优先（反例不被投票洗掉，与内核既有规则一致）、否则取最新、并按 `evidenceId` 排序输出（列表顺序也确定）。第三点是用例先发现、再补的实现——不是我先写的规则。

**改动面**（与设计 §8 一致）：`src/store/ledger.ts`、`src/store/verdict.ts`（quorum 取数点一行）、`src/kernel/evidence.ts`。`store/replay.ts`、`kernel/delta.ts`、`cli/ledger.ts` **一行未改**——它们要的是"这个证据算哪条"，拿投影即可，这正是把投影放在 store 的收益。

全套：193 文件 / 1216 用例通过，`tsc --noEmit` 干净（数字随后续修复批更新）。

## 10. 流程本身上发现的三件事（都在本 change 里踩到）

1. **`testSelector` 只能喂一个验收标准——这是本仓库第二次踩到。** AC-5 与 AC-1 共用 `tests/unit/verdict-readings-per-run.test.ts`，封存按 selector 生成 evidence，于是 AC-1 拿到它、**AC-5 一条都没有**：`verify` 报 `AC-5 FAIL` + `repairScope: insufficient_evidence_level`，而实现是对的、用例也是绿的。症状极具误导性（看起来像"这条标准没实现"）。修法：AC-5 独立成文件（`tests/unit/nothing-is-lost-from-the-store.test.ts`）+ `tasks declare` 重声明该行。
2. **矩阵声明了不存在的文件会让封存直接失败**（"Evidence sealing failed; fix the failing checks"），因为 check 命令会去跑它。第一次封存即因此失败：AC-6 的行指向 `tests/unit/legacy-verdict-list-still-reads.test.ts`，而用例当时写在共享文件里。修法：把 AC-6 的用例搬进它自己声明的文件。
3. **三条命令必须相邻**：`tasks declare` / `scope change` 会改变任务的声明面 ⇒ implementer 收据失效 ⇒ 先 `handoff create` + `handoff acknowledge`，再 `--seal`；而**失败的封存同样消耗收据**。此外 `scope change` 的 `--add` 是**逐条**的（逗号不分词），且新矩阵行引用的测试文件必须在 ownedPaths 里，否则封存报 "Owned path coverage incomplete"。

**一条状态报告**：本 change 触及 `src/kernel/evidence.ts` 等内核路径 ⇒ 自身档位为 `security` ⇒ 若记录账本，`assurance_below_tier`（本机无沙箱执行器）仍会令 `decide` 返回 `insufficient`。本 change **未记录账本**：其六条验收标准各有可执行用例、每条都用变异证明会变红，而账本在本仓当前状态下对本 change 无法 pass（原因不在本 change 表面，见 `gate-input-integrity` 设计文档 §12）。这条选择在此写明，而不是留给读者去猜。

## 11. 第一次独立审查（`revision-3a003d2f9a113a94`）与修复批

审查由一个**不同上下文**的独立审查者执行（它没有作者上下文），七条 finding 全部由我复跑确认，**一条是 blocking**，而且是**本 change 引入的**。

### 11.1 关键发现：跨 revision 的证伪会永久作废该证据（R-1，blocking）

- **测量**：readings = `[refuted@rev:old（更早）, supported@<当前 subject>（更晚）]` ⇒ 投影取 `refuted@rev:old`，`decide` 报 `evidence_refuted`（不是 `evidence_stale_subject`），claim 状态为 `refuted` ⇒ 永久 `fail`。
- **为什么是本 change 引入**：改动前 store 按 `evidenceId` **替换**，后一条读取覆盖前一条，不会出现这个状态。
- **为什么不能自愈**：`replaceEvidence` 对**内容未变**的证据不丢判决（实测 `replaced: 0, droppedVerdicts: []`），所以"重读证据"这条 `decide` 自己开出的补救路径永远清不掉它。
- **修法**：投影增加"**当前 revision 区域**"作为第一判据——关于当前 subject 的读数优先于关于其他 revision 的读数；区域内仍是"证伪优先 → 最新 → runId → 判决强度 → `observed`"的全序。当**没有任何**读数关于当前 revision 时，回退到"全局最新"（这正是旧行为，`decide` 会把它报成 `stale`，而不是当成当前读数）。
- **对 AC-3 措辞的收窄（必须写明）**：AC-3 的原文是"**任一** refuted 读数使该项保持 refuted"。实现现在收窄为"**关于当前 revision 的**任一 refuted 读数"。理由与内核既有规则一致：关于另一个 revision 的判决**不能**对当前 revision 作出结论（`evidence_stale_subject` 就是这条规则的名字）。AC 文本在 `open` 时冻结（`tasks declare` 只能改矩阵／upstreamCoverage），因此这条收窄记录在此，并以用例钉住两个方向：**当前 revision 的证伪仍然胜出**（否则修复会把反例变成可投票抹掉的东西），**旧 revision 的证伪不再否决**。

### 11.2 同一轮的其他发现

| id | 级别 | 事实（我已复跑） | 修法 |
|---|---|---|---|
| R-2 | minor | 投影**不是全序**：两条 `refuted` 由文档顺序决定，而 store 是 append ⇒ 胜者是**最旧**那条，而 `observed`／`at`／`subjectRevision`／`producer` 全取它并展示给读者 | 证伪之间也比 `at`（解析有效的）→ `runId` → 判决强度 → `observed` |
| R-3 | minor | 同 `at` 同 `runId` 的两条读数仍由位置决定（AC-3 的顺序无关用例未覆盖这一格） | 增加"判决强度"判据：同一时刻同一 run 下 `supported` 胜 `inconclusive`（`refuted` 已在更前面判定，所以永远不会因此被洗掉） |
| R-4 | minor | `at` 是**未校验**的排序键：中继读数（`file-adapter` 用文件里的 `at`）写入 `at: "zzz"` 即可赢得"最新"分支 | 时间戳必须可解析才参与排序；不可解析者排最后 |
| R-5 | minor | **AC-5/AC-6 没有变异证明**，且 AC-6 声明的落点（`readingKey` 的空 run 回退）**不在读路径上**（只有写路径用它）——把回退改成随机值，1210 条用例一条不红 | AC-6 的用例补 `readings` 与 **quorum 归组**断言；变异改为**读路径**（按当前 revision 过滤读数 ⇒ 旧文档投影为空 ⇒ 用例红，实测） |
| R-6 | minor | AC-4 里"第二个 run 证伪"的用例在"投影完全忽略 refuted、只取最新"的变异下**保持绿色**（它的证伪读数恰好也最新，分不清两条规则） | 把该用例的证伪读数改成**更早**的时间戳——只有"证伪优先"成立才可能通过（实测：忽略 refuted 的变异现在让它红） |
| R-7 | nit | `ledger status` 报的是投影数（存两条读数时仍显示 1），"没有读数丢失"在操作员看得见的地方**不可观测** | `status` 增加 `readings` 计数，并加一条用例（把该行改回投影 ⇒ 用例红） |

### 11.3 审查者**未能**证伪的（负结果，同样重要）

- **消费者审计**：`src/` 中唯一读 `ledger.readings` 的是 quorum（`store/verdict.ts`）；其余（`cli/ledger.ts`、`store/replay.ts`、`kernel/delta.ts`、`store/ledger.ts` 的报告、`store/verdict.ts` 的两处、`workflow/orchestrator.ts`、`store/baseline.ts`、`store/review-request.ts`）都按"一条证据一个答案"使用投影，逐个核对无错配。
- **AC-6 的真实数据**：仓库现存 6 份账本（含两个 worktree 的历史 change）全部 `readings.length === verdicts.length`、`evidenceId` 一对一、逐字段相同——**没有一份旧文档因新形状读错**。
- **quorum 两个方向**：一次 `evidence verify` 只调用一次 `producerFor`，无法自造 quorum；无 producer 的旧判决全部归入同一条未归属 run；`replay` 不写账本；`reviewers` 在 `strict`=1／`security`=2 未变。
- 两条变异（退回 `evidenceId` 键、投影忽略 refuted）确实变红，红在预期用例上。

### 11.4 修复批的验证

全套 193 文件 / **1217 用例**通过，`tsc --noEmit` 干净；三条新变异各自红在预期用例上（忽略 revision 区域 → R-1 用例红；忽略 refuted → 4 条红含 R-6 的用例；读路径过滤读数 → AC-6 用例红）。

**一条环境事实**：`kata-cli` 运行的是**主检出的 `dist/`**（本次未重建），所以 `ledger status` 的新字段要等 `dist/` 重建后才由 CLI 显示；改动与用例都在源码里（用例直接驱动 `cli/ledger.ts` 的路径）。
