# Kata 反馈：`executable_falsifier` 被判 refuted 时不说原因，且同一条文案把探测失败说成「缺陷存在」

**日期**：2026-10-10
**状态**：Open — 结论由实跑输出、两个结果文件的字段形状与源码文案行号支撑；本报告**不包含**对 kata 源码的修改。
**范围**：Kata 0.2.0（容器内 `/app/kata`，即宿主 `/data/work/ahaeureka/k2skills/kata` 的实时 bind），HEAD `480d543`。
**复现 change**：下游 `zenmpai` 的 `unified-photo-parameter-output`，tier `strict`，账本 5 条 claim / 7 条 `executable_falsifier`。

## 摘要

`kata-cli ledger evidence verify` 对 `executable_falsifier` 只返回「通过/被证伪」这一位信息：

```json
{"ok": true, "verdicts": [
  {"id": "E-CL1-config-bounds", "verdict": "refuted"},
  {"id": "E-CL2-default-modes", "verdict": "refuted"},
  {"id": "E-CL3-registry-closed-set", "verdict": "supported"},
  ...]}
```

而 `executable_falsifier` 的「被证伪」至少有三种互不相同的成因，需要三种不同的修复动作：

1. **变异没有落上**（`find` 串跨多行 / 与文件当前形态不匹配 ⇒ 替换是 no-op）；
2. **变异落上了但命令没有变红**（改动的东西不是这条检查断言的东西）；
3. **命令变红了，但红在另一个属性上**（改的是同文件另一处，检查因别的原因失败）。

本 change 首轮 5 条 falsifier 里有 **2 条被判 refuted**，两条的实际成因分别是 (1) 与 (2)（第 3 种在后续轮次里也遇到过一次，见下）。由于输出与两个结果文件都没有留下成因，作者只能自己去猜并重试。

## 复现（实跑输出与文件形状）

1. `kata-cli ledger evidence verify --change <id>` → 上引输出（只有 id 与 verdict）。
2. `review/runs.json` 每条记录只有摘要字段：

```json
{"at": "2026-10-10T06:00:05.032Z", "producer": "unstated", "claims": 5, "evidence": 5, "diversity": "none"}
```

3. `review/verdicts.json` 每条对 **supported** 记了 `observed`（含 `before/mutated/after` 的实测退出码），例如

```json
{"evidenceId": "E-CL4-cv-provider", "evidenceType": "executable_falsifier", "verdict": "supported",
 "observed": "{\"evidence\":\"E-CL4-cv-provider\",\"file\":\".../cv_analysis.py\",\"before\":0,\"mutated\":1,\"after\":0}"}
```

也就是说：**判定成功时留下了可读的实测证据，判定失败时什么都不留**。

4. 我实际经历的三种成因（每个都是手工施加变异后跑一次所选命令确认的）：

| 编号 | 变异内容 | 实际发生的事 |
|---|---|---|
| (1) | 把配置字段改名 | 替换是 no-op：`find` 跨多行、与文件形态不匹配（改成单行后才生效） |
| (2) | 改「函数默认参数」 | 落上了，但入口每次都显式传值 ⇒ 默认值不参与运行 ⇒ 命令不变红 |
| (3) | 放宽某字段的上界 | 命令变红了，但红的是「顺序不变量」而不是「拒绝越界」 ⇒ 换到正确的字段块才见证到该 claim 说的属性 |

## 根因（文案与判定）

`src/kernel/types.ts:426`：

```ts
evidence_refuted: {
    message: 'An accepted evidence item reports this claim as refuted: the defect it names is present.',
    whoActs: 'author',
},
```

这条文案对**假设式**证据（「我认为存在这个缺陷」）是准确的。但对 `executable_falsifier`（「施加这个变异后，所选检查会变红」）语义是**反的**：被判 refuted 意味着**这条检查没能探测到这个变异**，也就是「缺陷被工具漏掉了」，而不是「产品里存在这个缺陷」。作者按这句文案去修，会去改产品代码，而真正要做的是**换一个打在判据真断言的东西上的变异**。

`src/store/ledger.ts:1696` 的判定类型也只有三态 `'supported' | 'refuted' | 'inconclusive'`，没有承载成因的字段；变异执行器把 `before/mutated/after` 写进 `observed`（成功路径），失败路径没有对应的记录。

## 为什么重要

1. **修复成本被浪费在猜上**：我从 (1) 到 (2) 到 (3) 试了三轮，每轮都要自己施加变异、跑一次 `-k` 选择器、再还原 —— 而 kata 本来就在做同样的动作（它跑过那条命令）。
2. **文案把方向说反**：按 `the defect it names is present` 去修产品，会把一个「检查太弱」的问题误诊成「代码有缺陷」。
3. **与 kata 自己的设计目标冲突**：`src/quality/defect-classes.ts` 明确把「检查不能变红」当作一类要抓的缺陷；那么当它抓到（或没抓到）时，理应像 `supported` 那样留下实测证据，而不是只回一位布尔。

## 修复选项

* **A（推荐）**：给 refuted 的 `executable_falsifier` 记录成因（哪一档：`mutation-not-applied` / `applied-but-green` / `applied-and-reddened-elsewhere`，后者可用「命令退出码变化但断言集合不同」近似），并写进 `verdicts.json` 的 `observed`，与成功路径对称。
* **B**：只修文案 —— 按 `evidenceType` 分派：`executable_falsifier` 被 refuted 时说「这个变异没有被所选检查探测到：或者变异没有落上，或者它改的不是这条检查断言的东西」；假设式证据保持现文案。
* **C（最小）**：在 `evidence verify` 的输出里附上 `observed`（成功与失败都附），不改文案与判定类型。

## 必需回归

1. 一条 `executable_falsifier` 的 `find` 与文件不匹配（变异 no-op）：判 refuted，且**输出中可见「变异没有落上」这一成因**。
2. 同一 `find` 能匹配、但命令在变异下仍退出 0：判 refuted，成因是「落上了但没变红」，且与上一条**可区分**。
3. 正对照：一条正常 falsifier 判 supported，其 `observed` 仍保留 `before/mutated/after` 三个退出码（防止修 A 时把成功路径的记录改坏）。
4. 假设式证据（非 executable_falsifier）被 refuted 时，文案与当前一致（防止 B 把这条语义一起改掉）。

## 非主张

* 本报告**不主张** kata 的 falsifier 校验机制有错 —— 它确实抓住了一条落错目标的变异，这正是它该做的事；这里要的是**把成因说出来**。
* 本报告**不主张**放宽 refuted 的判定（不放宽「命令必须变红」这一条）。
* 未给出 kata 侧补丁；下游侧没有绕过门禁：两次被证伪后我都是**重写变异**（让它在被选中的命令上、为 claim 所说的属性变红），而不是改判定或跳过证据。
