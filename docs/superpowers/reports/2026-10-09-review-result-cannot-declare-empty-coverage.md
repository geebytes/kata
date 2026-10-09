# Kata 反馈：复核结果无法声明「空覆盖」，且 claim-less change 的干净一轮无法录入

**日期**：2026-10-09
**状态**：Open — 三条结论各由源码行号与实跑探针支撑；本报告**不包含**对 kata 源码的修改，也未绕过任何门禁。
**范围**：Kata 0.2.0（容器内 `/app/kata`，即宿主 `/data/work/ahaeureka/k2skills/kata` 的实时 bind）。
**复现 change**：下游 `zenmpai` 的 `expose-the-complete-parameter-set`，tier `strict`，revision `revision-a483ac7945001e11`。

## 摘要

一个**没有声明任何账本 claim** 的 change，其复核结果的状态空间是不完整的：

* 显式写 `declaredCoverage: []`（「我声明：本次没有任何 claim 被我读过并判定为可靠」）→ **被拒绝**，理由是「必须是非空列表」；
* 而**省略**该键 → **通过**。

也就是说，一个**忠实的空声明被拒、沉默被接受**。这与该判据自己写下的意图（`orchestrator.ts:1508` 附近注释：*A declaration is validated wherever it appears, and it is always kept*）方向相反。

更进一步：对 claim-less 账本，`findings: []`（一轮干净复核）**没有任何可写入的值** —— 空列表被第一条判据拒绝，非空列表被第二条判据拒绝（它必须点名账本持有的 claim，而账本里一个都没有）。**两条判据在 claim-less 状态下不可同时满足**，因此这种 change 的「零 finding」复核只能以 `--approve` 记录，而报错文本却让读者去「add declaredCoverage with the claim ids that were read and found sound」—— 而那些 claim 并不存在。

这与 review skill 自己的第 7 条直接冲突：skill 明确说 `probes: []`（以及 `claims: []`）是**完整**的 request，复核仍然是复核者的工作。request 侧允许「无 claim」，result 侧却无法表达「无 claim 可声明」。

## 复现（三个探针，同一份真实复核结果）

前置：`kata-cli ledger plan` 已存储（`plan.json`），账本持有 `subject.json` + `plan.json` 而**没有 claims**：

```
$ kata-cli ledger decide --change expose-the-complete-parameter-set
{"ok":false,"command":"ledger decide","state":"absent",
 "error":"the ledger holds subject.json, plan.json but no claims, so there is nothing to decide"}
```

复核者返回 7 条 findings（1 blocking / 1 major / 5 minor），其中 `declaredCoverage` 为 `[]`。三个探针只改动该键：

| 探针 | 载荷 | 观测结果 |
|---|---|---|
| **A** | `findings=[7 条真实]` + `declaredCoverage: []` | ❌ `declaredCoverage must be a non-empty list of the claim ids that were read and found sound` |
| **B** | `findings: []` + `declaredCoverage: ["CL-1"]` | ❌ `declaredCoverage names CL-1, which this ledger does not hold; the declaration must name the claims that were read` |
| **C** | `findings=[7 条真实]`，**省略** `declaredCoverage` | ✅ `success: true`，findings 已录入，相位推进为 `nextSkill: /kata-build`，`askUser` 提示「检测到 blocking review findings；建议先执行 /kata-build 修复」 |

命令（三个完全相同，只有载荷不同）：

```bash
kata-cli review --change expose-the-complete-parameter-set --result-file tmp/probe-<x>.json
```

**A + B 合起来就是不可满足性证明**：对 claim-less 账本，`findings: []` 时 A 要求的非空列表在 B 里必然被拒。C 说明「结果无法录入」这句过宽的话**不成立** —— findings 路径是可用的，前提是**省略**该键；因此缺陷不是「录不进去」，而是**该字段无法诚实表达 claim-less 这一事实**。

## 根因（`src/workflow/orchestrator.ts:1494-1529`）

```ts
let declaredCoverage: string[] | null = null;
const result = JSON.parse(await readFile(resultPath, 'utf8')) as { findings?: unknown; declaredCoverage?: unknown };
…
const coverage = result.declaredCoverage;
if (findings.length === 0 && coverage === undefined) {
    throw new Error('an empty findings array is only a result when the object also declares coverage: add declaredCoverage with the claim ids that were read and found sound');
}
if (coverage !== undefined) {
    if (!Array.isArray(coverage) || coverage.length === 0 || !coverage.every(…)) {
        throw new Error('declaredCoverage must be a non-empty list of the claim ids that were read and found sound');
    }
    const known = new Set(coverageLedger.claims.map((claim) => claim.id));
    const unknown = (coverage as string[]).filter((claimId) => !known.has(claimId));
    if (unknown.length > 0) {
        throw new Error(`declaredCoverage names ${unknown.join(', ')}, which this ledger does not hold; …`);
    }
    declaredCoverage = coverage as string[];
}
```

三条判据各自都合理，**组合起来在 claim-less 账本上留下一个空洞**：

1. `coverage.length === 0` 被无条件拒绝 —— 「非空」规则只在账本**持有** claim 时才有意义；账本为空时，`[]` 是唯一为真的声明。
2. `unknown.length > 0` 要求每个名字都属于账本 —— 账本为空时任何名字都违规。
3. 因此 `findings.length === 0` 的分支（要求 coverage）**无法被满足**；它给出的补救建议（点名被读过的 claim id）在该状态下不可执行。

## 为什么重要

1. **激励方向错误**：忠实的空声明被拒、省略键被接受。这恰好是该文件自己的注释要避免的形状（「声明在哪里出现就在哪里被校验，而且总是被保留」），现在变成了「声明受罚、沉默获益」。
2. **一整类状态无法表达**：claim-less change 的零 finding 复核没有任何合法载荷；唯一的记录途径是 `--approve`。这层含义没有写在 skill 里 —— 而 skill 第 7 条反而在鼓励「空 request 也算完整」。
3. **skill 与实现口径不一致**：skill 说 `claims: []` 的 request 是完整的（复核仍要做），但 result 侧的判据把「无 claim 可声明」当作非法输入。两个信号同时到达复核者，只有一个是对的。

## 修复选项

**A（推荐，最小且方向一致）**：把「显式的空列表」当作**合法且等于「本次没有声明任何覆盖」**，仅当账本**持有** claim 时才要求非空。

* 具体：`coverage.length === 0` 不再直接拒绝；改为在账本持有 claim 时拒绝空列表（那条「声明了却一个都没读」是真问题），在账本为空时接受并把 `declaredCoverage` 记为 `[]`（与 `undefined` 区分保留：**声明过**与**没声明**是两件事，这正是该字段存在的理由）。
* 同时把 `findings.length === 0 && coverage === undefined` 的报错文本改为在 claim-less 状态下可执行的说法（例如：「本账本没有 claim，因此这一轮请以 `--approve --review-evidence` 记录结论，或提供 `declaredCoverage: []` 明确声明本次没有覆盖任何 claim」）。

**B**：让账本**始终**至少持有一个 claim（在 `ledger plan` 阶段强制），从而让 claim-less 状态不可达。代价：把「我给这次 change 声明多少 claim」变成形式义务，反而鼓励凑数声明。

**C**：在 request 侧就拒绝 `claims: []`（于是 skill 第 7 条也需要改写为「request 必须带 claim」）。代价：对「一开始没计划账本 claim」的 change 直接关门，与 skill 现有表述相反。

我推荐 **A**：它同时消除「沉默优于声明」的错向激励，并让 `findings: []` 在 claim-less 账本上重新可写。

## 必需回归

1. 账本持有 `["C-1"]` 时：`declaredCoverage: []` 仍被拒（现有行为不能被放松）。
2. 账本为空时：`declaredCoverage: []` **被接受**，且记录里能区分它与「键缺失」。
3. 账本为空 + `findings: []`：可写入（不再存在不可满足组合）。
4. 账本持有 claim 时：`declaredCoverage: ["C-9"]` 仍被拒并点名 `C-9`（现有反例继续有效）。
5. 键缺失 + `findings: [...]`：仍接受（本轮实测的可行写法不能被新判据挡掉）。

## 非主张

* 本报告**不主张** `declaredCoverage` 应当变成必填 —— 记录里「没声明」本身是有信息的状态。
* 本报告**不主张**校验应当放宽到不校验 claim 归属 —— 第 4 条反例正是它存在的意义。
* 本报告**不主张** kata 的 review 流程整体不可用：本轮 7 条 findings 已成功录入，阻塞门禁也正确路由回 `/kata-build`。缺陷范围仅限「claim-less 账本下 `declaredCoverage` 的取值空间不完整」。
* 探针 A/B 都是**只读失败**（未写入任何记录）；探针 C 写入的是真实复核结果，不是构造载荷。
