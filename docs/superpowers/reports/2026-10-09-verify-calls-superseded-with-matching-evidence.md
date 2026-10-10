# Kata 缺陷：证据与当前 revision 一致，verify 却把全部验收项判为 `revision_superseded`

**日期**：2026-10-09
**状态**：Open — 下列数值均为实跑取回；本报告未修改 kata 源码，也未绕过门禁。
**范围**：Kata（容器内 `/app/kata`，宿主 `/data/work/ahaeureka/k2skills/kata`），HEAD `89ba08a`。
**复现 change**：下游 `zenmpai` 的 `expose-the-complete-parameter-set`，tier `strict`，12 项验收。
**与既有报告的关系**：第三份「revision 作用域」家族报告（前两份：`2026-10-08-review-loop-never-converges.md`、`2026-10-09-review-phase-content-move-is-unrecoverable.md`）。前两份是「看不见」与「不可恢复」，本份是**判据与事实相反**。

## 摘要

`verify` 报 `verifyResult: FAIL`，12 项验收的修复范围全是 `revision_superseded` —— 而同一时刻：

* `currentRevisionId` = `revision-1b7bf1d50f6de6ce`；
* 该 revision 的 `current-revision.json` 记录 595 条 `contentDigests`，逐条重算 **missing 0 / mismatch 0**（含全部 ownedPaths）；
* `.kata/evidence/` 下 31 条证据**全部**盖着 `"revisionId": "revision-1b7bf1d50f6de6ce"`，`exitCode: 0`，`coveredAcceptanceIds` 齐备；
* `failingEvidence: 0`、`failedAcceptance: 0`、`wikiClosureValid: true`。

**没有任何事实支持「被 supersede」**，但 12 项验收全部按它处理，于是 `verify` 永远 FAIL、`judge` 无法进入。

## 实测（逐字）

```
$ kata-cli status --change expose-the-complete-parameter-set        # upstream 字段
phase                  = "hardVerify"
currentRevisionId      = "revision-1b7bf1d50f6de6ce"
verifyResult           = "FAIL"
failedVerifyAcceptance = 12
failingEvidence        = 0
failedAcceptance       = 0
wikiClosureValid       = true
verifyRepairScopes     = ["revision_superseded" × 12]
repairScopes           = []
nextAction             = { nextSkill: "/kata-build", reason: "rebuild_superseded_revision",
                           cliCommand: "kata-cli build --change … --seal" }
askUser                = ["建议执行 /kata-build，角色 implementer。"]
```

已经排除的可能原因（每条都由实跑排除，不是推断）：

| 可能原因 | 实测 | 结论 |
|---|---|---|
| 当前 revision 指针为空 | `currentRevisionId` 有值，且等于证据里印章的 revision | 排除 |
| 指针文件损坏/不可读 | `kata-cli revision digests --change …` 正常返回 595 条摘要 | 排除 |
| 内容在封存后移动 | 逐条重算 595 个文件 sha256：missing 0 / mismatch 0 | 排除 |
| 证据缺失或未记录 | `.kata/evidence/` 31 条，全部存在且非空 | 排除 |
| 证据盖错 revision | 31 条全部 `revisionId = revision-1b7bf1d50f6de6ce`（= 当前） | 排除 |
| 检查本身失败 | 全部 `exitCode: 0`；`failingEvidence: 0` | 排除 |
| 封存未发生 | 同一次 `build --seal` 报 `success: true`、`31 passing / 0 failing` | 排除 |

剩下的事实是：**判据说 superseded，而所有可观测的状态都不支持它**，且给出的补救（re-seal）会写出同样的记录 —— 于是形成「seal 绿 → verify 红（superseded）→ 要求 re-seal → seal 绿」的死循环。

（补记一条同类观察：把「工具文件漂移」纳入本 change 之外后，`workspaceDrift` 曾显示为空数组 `[]`，同一时刻 `verifyRepairScopes` 仍是 12 条 `revision_superseded` —— 漂移与这条判据不同源。）

## 影响

* `verify` 永远 FAIL ⇒ `judge` / `archive` 不可达；而门禁本身给出的出路（re-seal）无法改变结论。
* 与既报的两份同源：`revision` 作用域被复用为**判据**（而不是「结论不得比内容长寿」的绑定），一旦它与实际状态不一致，就没有可执行的恢复路径。
* 下游后果：本 change 的 12 项验收、31 条证据、17 条变异验证全部就绪却无法推进；`failingEvidence: 0` 与 `failedVerifyAcceptance: 12` 同时为真，会误导读者以为工作失败。

## 修复方向（供参考，未实现）

1. **让 `revision_superseded` 的判据可解释**：当它成立时，`status` 应指出**是哪个字段/哪条比较**导致 supersede（当前只有结论，没有证据），否则无法与「一切一致」的事实并存。
2. **判据与实际状态对齐**：证据印章 revision == `currentRevisionId`、且该 revision 的内容摘要与工作树一致时，不得判 `revision_superseded`。
3. **给出一条能兑现的出路**：若确实需要 re-seal，re-seal 必须能改变结论；否则应降级为非阻塞的告警，而不是让 `verify` 永久 FAIL。

## 必需回归

1. 证据印章 revision == 当前 revision == 内容摘要一致 ⇒ 不得出现 `revision_superseded`。
2. 上述条件成立时 `verify` 必须能 PASS（不得因作用域判据永久 FAIL）。
3. 真正 supersede（内容移动）时判据仍必须成立（现有保护不被放松）。
4. `status` 报 `revision_superseded` 时必须给出导致它的具体比较（哪个 revision、哪个摘要）。

## 非主张

* 本报告**不主张**作用域绑定应当取消 —— 「结论不得比它读过的内容活得更久」是对的；缺陷在于**判据与实际状态相反且无出路**。
* 本报告**不主张** `verify` 应当对未通过检查放行 —— 本 case 里 `failingEvidence: 0`、全部 `exitCode: 0`，没有任何检查失败。
* 本报告**不主张**这是 kata 本次更新引入的 —— 我没有对比更新前后的实现，只记录当前 HEAD `89ba08a` 下的实测。
