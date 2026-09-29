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
