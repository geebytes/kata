# Kata 反馈：两条验收项共用命令时，后一条被静默丢弃且诊断指向错误的原因

**日期**：2026-10-10
**状态**：Open — 结论由源码行号、逐字实跑输出与「补齐后变为 14/14」的前后对照支撑；本报告**不包含**对 kata 源码的修改。
**范围**：Kata 0.2.0（容器内 `/app/kata`，即宿主 `/data/work/ahaeureka/k2skills/kata` 的实时 bind），HEAD `480d543`。
**复现 change**：下游 `zenmpai` 的 `unified-photo-parameter-output`，tier `strict`，14 条验收项。

## 摘要

`acceptanceMatrix` 的检查在解析后被**按 (kind, command, args, cwd) 去重**，只保留第一次出现的那一条。于是当两条验收项声明了同一条命令时（本 change 里 AC-1/AC-6/AC-10 与 AC-5/AC-7/AC-11 各自与邻居共用），**后一条从未被执行**，也就没有属于它的证据文件。触发的报错却指向一个不相关的原因：

```
verify: FAIL
error: Verify requires integration/entrypoint evidence for at least one AC; unit evidence alone is insufficient.
nextAction: /kata-build | add_entrypoint_evidence
```

而当时的真实情况是：11/14 条验收项有证据、3 条没有，且**与 entrypoint/integration 无关**。按这条提示去补 entrypoint 证据不会解决任何事（我实际做的修正与 entrypoint 无关：把每行的命令改成互不相同的单 token 选择器）。

## 复现

1. 14 条验收项的矩阵行里有 6 行两两共用同一条命令，例如

```
AC-1-test-uv-run-pytest-tests-photo_observation-test_config_thresholds.py--q--k-thresholds_are_declared   (kind=test)
AC-5-test-uv-run-pytest-tests-photo_observation-test_config_thresholds.py--q--k-out_of_range              (kind=test)
```

两行指向**同一个文件**且当时选择器相同 ⇒ 恰好构成一个去重对。

2. 跑 `kata-cli build --change <id> --seal` → evidence **32 / passing 8 / failing 24**、12 条验收 claim 报 failed（"expected exit 0, got exit 5"）。
3. 修正为互不相同的 selector 后再跑 → seal `32 / 32`、verify PASS。
4. 证据文件目录的前后对照说明被丢弃的是**后一条**：修好之前 `.kata/evidence/` 里 `unified-photo-parameter-output-AC-*` 只有 11 个（AC-5/AC-7/AC-11 缺席），修好后 14 个齐全。

## 根因（`src/quality/check-resolver.ts`）

```ts
export function matrixChecks(root: string, matrix: AcceptanceMatrix, options: {...} = {}): CheckCommand[] {
    const checks: CheckCommand[] = [];
    for (const row of matrix.rows) {
        for (const evidence of row.evidence) {
            const result = resolveCheckForRow(row, evidence, root, options);
            if (result instanceof Error) { throw result; }
            checks.push(result);
        }
    }
    return dedupeChecks(checks);            // ← :256
}

/** One identity tuple for checks: kind, command, arguments and working directory. */
export function dedupeChecks(checks: CheckCommand[]): CheckCommand[] {   // ← :260-268
    return checks.filter((check, index) => checks.findIndex((candidate) =>
        candidate.kind === check.kind
        && candidate.command === check.command
        && (candidate.args ?? []).join('\0') === (check.args ?? []).join('\0')
        && candidate.cwd === check.cwd,
    ) === index);
}
```

`dedupeChecks` 的注释只说明**身份元组是什么**，没有说明「命令相同的两条声明会丢掉一条」这一后果。因为 check 对象里没有 `acceptanceId`（去重键里也没有），被保留的那一条无法与两行分别对应 —— 而 `evidence-adequacy.ts` 判定某条验收项是否有证据时，要求的是**能被该行的选择器覆盖到**的证据（`selectorMatches`）。于是「两行共用命令」在结构上必然让其中一行失去证据。

**报错文案与真实原因脱节的地方**：`src/quality/evidence-adequacy.ts` 给出的 repair scope 是 `insufficient_evidence_level`，`src/workflow/orchestrator.ts:1533-1534` 把它渲染成「需要 integration/entrypoint 证据」。那对**确实**声明了 entrypoint 行却没跑的情形是对的（本 change 早期确实遇到过：AC-2 声明为 entrypoint 却没跑过入口脚本），但对「两条 unit 行共用命令」这种情形指向了错误的修复方向。

## 为什么重要

1. **静默**：没有任何提示说「你的两条验收项共用了同一条命令，后者不会被跑」；seal 的汇总只显示 passing 数少了几条，作者会先去怀疑测试本身。
2. **诊断误导**：`add_entrypoint_evidence` 会让人去改 `verificationLevel` 或补一个入口脚本，而真正要做的是让每行有独立的命令。
3. **与「命令即身份」的设计冲突**：kata 有意用命令做去重键（避免同一检查跑两次，这是对的），但验收项的**归属**是另一个维度；去重时没有保留归属，导致「同一条检查服务两行」这一合法意图无法表达。

## 修复选项

* **A（推荐）**：`dedupeChecks` 保留去重后的执行列表，但把**归属映射**一起带上（`acceptanceIds: string[]`），使同一份执行结果能被多行同时引用。理由：这与「同一检查服务两行」的真实意图一致，且不增加执行成本。
* **B**：去重在**声明期**拒绝 —— 若两行的 (kind, command, args, cwd) 完全相同，`build --seal` 直接报「第 X 行与第 Y 行共用同一条命令，后者不会有独立证据」，并给出两行的 acceptanceId。
* **C（最小）**：只修诊断：当 `insufficient_evidence_level` 的成因是「该行的命令与另一行重合且已被去重」时，错误文案点名两行与它们的命令，而不是笼统说需要 entrypoint 证据。

## 必需回归

1. 两行声明同一条 `kind=test` 的命令：`build --seal` 后**两行都有证据**（选项 A）或 **seal 在声明期拒绝并点名两行**（选项 B）——两种方向都行，但不得是「静默丢掉一行」。
2. 一行为 `verificationLevel=entrypoint` 且其证据 kind 不是 entrypoint/integration 时，仍然报 `insufficient_evidence_level` 且文案指向该行（防止修 A/B 时把这条真实规则一起放宽）。
3. 正对照：14 行互不相同的命令 ⇒ 14 条证据齐全，seal 全绿（本 change 修好后的状态即此）。
4. 反向：把两行改成同一条命令 ⇒ 必须出现可诊断的失败（不是 0 条证据的静默通过）。

## 非主张

* 本报告**不主张**取消去重 —— 同一命令只执行一次是正确的（本 change 的一次完整 seal 有 32 条检查，重复执行会成倍耗时）。
* 本报告**不主张** `insufficient_evidence_level` 这条规则有错；错的是它在「命令重合」这个成因下的**文案与 repair scope**。
* 未给出 kata 侧补丁；下游侧没有绕过任何门禁（修正方式是把选择器改成互不相同，属于声明本身的修正）。
