# 设计：读状态语义（read-state semantics）

**状态**：设计稿，待开 governed change 实施
**上游**：`docs/design/2026-09-28-bounded-review-convergence.md` §15–§18（12 轮对抗审查的残余项）
**性质**：本文件收的是**一类**缺陷，不是一次事故

---

## 1. 这一类是什么

十二轮对抗审查里，同一族缺陷以不同面貌出现了 **六次**，每次都被当成独立 bug 修掉，然后在下一次换位置复现：

| 出现 | 面貌 |
|---|---|
| 1 | `readCurrentTaskRevision` 以 `null` 同时表示"没写过"与"读不出来" |
| 2 | `openLedgerProblems` 重推 `ledgerVerdict` 的谓词（漏第三个条件），两个读者分裂 |
| 3 | 修②时只借了 verdict 的**措辞**，谓词仍本地重推，又引入假拒绝 |
| 4 | 修③时为了计数**第二次裸读** ledger，于是 `openProblems: 0` 又能出现在 verdict 说 `unreadable` 的 fixture 上 |
| 5 | `review-read.ts` 先问三态、再把同一文件交给仍会抛的 identity 派生 |
| 6 | `readUpstreamSummary` 读 pointer 两次，第二次失败时 router 报的是**另一个**原因，新分支被绕过 |

共同结构：

> **一次决策内，同一 artefact 被读了多次；而"读不出来"这件事没有跟着数据一起传下去。**

所以修法不是在每个消费者那里补 `try/catch` 或补一个 `kind` 判断——那是第六次复现的原因——而是：

1. **一次决策，一次读。** 读状态（`absent` / `current` / `unreadable`）是**值**，随数据一起传，而不是让每个消费者自己再读一次。
2. **判定只有一个来源。** 需要同一判定的两个函数，其中一个**委派**另一个（`ledgerVerdictOf(ledger)` 纯函数），而不是重推谓词，也不是只借措辞。

## 2. 具体条目

### A-1 ledger：kind 与 problems 来自同一次读

- 现状：`openLedgerProblems` 先调 `ledgerVerdict` 拿 `kind`，再 `readLedger` 拿 problems——**两次读**；第二次失败时 `openProblems: 0` 与 verdict 的 `unreadable` 并存。
- 修法：抽出纯函数 `ledgerVerdictOf(ledger): LedgerVerdict`（不读盘）；`ledgerVerdict` 与 `openLedgerProblems` 都先读一次 ledger，再各自委派它。
- 验收：一个"第二次读失败"的 fixture 下，`openLedgerProblems` 与 `ledgerVerdict` 的 kind **必须一致**（`readLedger` 每调用只读一次可由插桩证明）。

### A-2 summary：sealedRead 传进 review reader

- 现状：`readUpstreamSummary` 读 pointer（`navigation.ts:201`），`review-read.ts` 又读一次；第二次失败时 router 报 `unreadable_review_record`(1150)，绕过 `repair_unreadable_current_revision`(1160) 分支。
- 修法：`readBlockingProblems` / `readReviewRecord` 接受可选的 `revisionRead`，summary 把它传下去。
- 验收：只让**第二次**读失败的 double 下，router 报的是 `repair_unreadable_current_revision`。

### A-3 identity：类型与一次读

- 现状：`candidateFreezeHashFor` 的 `revisionRead` 参数是 `CurrentRevisionRead` 的**手抄结构克隆**，并用 `(revisionRead.revision as never)` 抹掉类型。
- 修法：`import type { CurrentRevisionRead }`，去掉 cast。
- 验收：删掉 cast 后 `tsc` 通过；类型等价由编译器而非人工保证。

### A-4 **能红的用例**：驱动命令，而不是驱动助手

- 现状：本轮"hand-over 而非 re-read"的用例直接调 `currentRevisionIdentityFrom`，注释声称"a re-read cannot pass"，但把两处命令级实现换回 re-read，**全套 1113/1119 全绿**。
- 修法：用 `readFile` double 让**第二次**读失败，然后 `runCommand('verify')` / `runCommand('judge')`，断言**写出的** `verify.json` / `judge.json` 的 `revisionId` 是第一次读到的那个。
- 验收：把实现换回 re-read → 用例必须红（这是本条唯一的验收方式）。

### A-5 死注释与重复用例

- `orchestrator.ts` 的 "The ledger's open problems, for the two report surfaces" docblock 实际挂在 `readTaskEvidence` 上（其内容在别处）。
- `navigation.ts` 新分支带着**两个别的分支**的注释（verify-failure 优先级、终态），却没有一句关于自己。
- 用例有第二份更弱的 `verify` 副本。
- 修法：删/改到与代码一致；重复用例删除。

## 3. 非目标

1. 不改变"读不出来即拒绝"的策略（第十二轮已确认该策略在 10 个稳态下无假拒绝）。
2. 不重构 `store/ledger.ts` 的读实现；只为 `ledgerVerdictOf` 抽出纯函数。
3. 不引入"读一次缓存到全局"之类的机制——传值是局部且显式的。

## 4. 为什么它是一条独立 change

A-1…A-5 触及 `src/store/verdict.ts`、`src/workflow/navigation.ts`、`src/workflow/review-read.ts`、`src/quality/review-ir.ts`，以及 judge/verify 的命令边界——与 `bounded-review-convergence` 的 AC-1…AC-4（审查循环有界、严重度阶梯唯一、批准拒绝、终态升级）**没有共同验收面**。把它塞回原 change 会让那个已 12 轮验证的 change 继续在修它自己。

## 5. 未决问题

1. `readLedger` 是否已经保证"一次调用一次读"？若它内部有多次读，A-1 的改写需要先让它成为单一读点。
2. `currentRevisionIdentityFrom` 是否应该**取代** `currentRevisionIdentity`（让"必须传读"成为类型要求），还是保留后者的便利？前者更安全但调用点多（11 处）。
3. A-2 的传递会不会让 `readReviewRecord` 的签名变得难用？可考虑一个 `UpstreamReads` 结构一次传齐。
