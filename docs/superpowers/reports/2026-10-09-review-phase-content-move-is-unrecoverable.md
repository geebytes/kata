# Kata 缺陷：review 期间内容移动后，四条路线互相指向对方而全部拒绝（死锁）

**日期**：2026-10-09
**状态**：Open — 四个方向的输出逐字记录在下方，均为实跑；本报告**不包含**对 kata 源码的修改，也未绕过任何门禁。
**范围**：Kata 0.2.0（容器内 `/app/kata`，即宿主 `/data/work/ahaeureka/k2skills/kata`）。
**复现 change**：下游 `zenmpai` 的 `expose-the-complete-parameter-set`，tier `strict`。
**与既有报告的关系**：这是同一「revision 作用域」家族的**第三种形态**。`2026-10-08-review-loop-never-converges.md` 的 F1 是「停滞探测器看不见」、F6 是「阻塞门禁被清零」；本条是「内容移动后状态不可恢复」。

## 摘要

在 `review` 相位里改动了受控路径（这是**修复复核 finding 的正常动作**），于是上一个封存被 supersede、`currentRevisionId` 变为 `None`。此后：

* `build --seal` 拒绝，并让你「Re-run /kata-review」；
* `ledger run` 拒绝，并让你「Re-seal (`build --seal`)」；
* `review` 的 askUser 要求「绑定当前 revision 的显式结论」，而**当前没有 revision**；
* `verify` 给出的 `nextAction` 正是那条被拒绝的 `build --seal`。

四条路线构成闭环，没有任何一条能执行 —— 而任务本身没有任何失败：同一次输出里 `failingEvidence: 0`。

## 实测（逐字）

```
$ kata-cli build --seal --change expose-the-complete-parameter-set
error: Build cannot run from review because its findings are not bound to the current sealed
       revision (or to the same content under a new revision). Re-run /kata-review.
diagnostics.repairEntry: { entryPhase: "review", denial: <同上> }
askUser: ["建议执行 /kata-build，角色 implementer。"]        ← 同一次输出里让你去跑刚刚被拒的命令
failingEvidence: 0                                          ← 工作本身没有问题

$ kata-cli ledger run --change expose-the-complete-parameter-set --out tmp/request.json
error: … the subject describes content that has moved since it was sealed, so a request derived
       now would name content the reviewer could not bind a result to.
       Re-seal (`kata-cli build --change <id> --seal`) after the content or the declaration is settled

$ kata-cli verify --change expose-the-complete-parameter-set
"revisionId": "revision-a483ac7945001e11", "revisionStatus": "superseded",
"workspaceDrift": [".kata/relations.json", "uv.lock"],
"nextAction": { "nextSkill": "/kata-build", "slashCommand": "/kata-build … --seal",
                "reason": "rebuild_superseded_revision" }
error: Verify failed; repair evidence or blocking findings before review/judge.

$ kata-cli status --change expose-the-complete-parameter-set
phase: review | currentRevisionId: None | verifyResult: None
askUser: ["Review 尚未形成绑定当前 revision 的显式结论和审查证据；…"]
```

已排除的外因：

* **不是 receipt 缺失**：补齐 implementer 与 reviewer receipt 后（`handoff verify` → `valid: true`）四条输出不变。
* **不是声明面缺项**：把 `uv.lock` 纳入 ownedPaths（`scope change` + `scope apply`，`applied: true`）后输出不变。
* **不是缺复核记录**：`review --result-file` 已在同一 change 上成功录入过 7 条 findings（相位因此处于 `review`）。
* **不是证据失败**：`failingEvidence: 0`。

## 根因

```ts
// src/workflow/repair-entry.ts:205-232
const revision = blockingRead.revision;
…
if (!blockingRead.exists || !blockingRead.boundToCurrentRevision) {
    const ledgerAdmission = await ledgerDeficitRepairAdmission(root, taskId, entryPhase);
    if (ledgerAdmission.authorized) return ledgerAdmission;
    if (!blockingRead.exists) {
        return denial(entryPhase, 'Build cannot run from review without a recorded review. Run /kata-review first.');
    }
    return denial(entryPhase, 'Build cannot run from review because its findings are not bound to the current sealed revision …');
}
```

放行条件只有两个：**复核记录绑定当前 revision**，或**账本 deficit**。而本状态里：

* `currentRevisionId === null`（旧封存已 superseded，新封存正是被拒的那条命令的产物）；
* 复核记录绑定的是 `revision-a483ac7945001e11`，它在 `currentRevisionId` 为 `null` 时**不可能**算「绑定当前 revision」；
* 账本没有 deficit（`ledger decide` 早前报的是 `no claims`，不是 deficit；且 `ledger run` 自己的拒绝理由是「内容已移动」，不是 deficit）。

于是 `boundToCurrentRevision` 恒为 false、`ledgerAdmission.authorized` 恒为 false ⇒ **必然拒绝**，而拒绝给出的补救（重跑 review）产出的记录同样绑定不到 `null`，所以补救不可执行。

`navigation.ts:766` 又对 `rebuild_superseded_revision` 拼出 ` --seal`，于是 CLI 自己把用户指回被拒的那条命令 —— 提示与判据来自同一个导航平面，却没有一处检查「这条命令现在是否可行」。

## 为什么这比 F1/F6 更严重

F1/F6 的后果是「循环看不见自己」「阻塞计数归零」，两者都还允许继续推进（只是没有刹车）。本条是**无出口**：修复复核 finding 是本工作流的核心动作，而只要修复发生在 review 相位内，状态就进入不可恢复态 —— 除非把内容**退回**到旧 revision（等于丢弃修复）。

## 修复选项

**A（推荐）**：把「封存被 supersede 且当前无 revision」当作**可重封存**的合法状态 —— 即当 `currentRevisionId` 为 `null` 而存在历史封存时，允许 `build --seal` 进入 implement 并重封，而不是要求一个已经不存在的绑定。

* 依据：代码注释自己写着「once the sealed revision is superseded the evidence cannot describe the current implementation, and the only alternative would be judging with stale evidence. A new revision invalidates the review binding, so the task still has to seal, verify and be reviewed again」—— 这段意图正是「supersede 授权重入」，只是判据只覆盖了「有新 revision」这一支，漏了「当前 revision 为 null」这一支。

**B**：让 `ledgerDeficitRepairAdmission` 也承认「subject 已移动」这一类（它现在只承认账本 deficit），语义为「内容移动 = 需要重新封存的合法理由」。

**C**：把 `navigation.ts` 的 nextAction 生成与 `repair-entry.ts` 的准入判据绑到**同一个**函数，使 CLI 不可能再打印一条自己会拒绝的命令（治的是症状面，但顺带修掉所有同形不一致）。

我推荐 **A**（+ 顺带 C，因为「提示的命令被同一次调用拒绝」是这次之所以难诊断的直接原因）。

## 必需回归

1. `currentRevisionId` 为 `null` 且有历史封存时：`build --seal` **被允许**，且重封后 `verify` → `review` → `judge` 可依次推进。
2. 复核记录绑定**当前** revision 时：`build --seal` 的行为不变（现有准入不被放松）。
3. 存在真实账本 deficit 时：仍走 `ledgerDeficitRepairAdmission` 分支（现有放行不被遮蔽）。
4. 任何 `nextAction`/`askUser` 打印的命令，必须是**当前状态下会成功**的命令；否则必须在同一次输出里给出拒绝原因（一条能兑现的提示）。
5. `failingEvidence: 0` 且无 deficit、无未绑定 finding 时，`ledger run` 不得要求一个不存在的 re-seal 前置。

## 非主张

* 本报告**不主张** revision 绑定应当被取消 —— 「结论不得比它读过的内容活得更久」是对的；缺陷在于**重封的路被那个绑定本身堵死**。
* 本报告**不主张** `build` 应当从任意相位放行 —— 本状态是 `review` + 有历史封存 + 有已录入复核记录，属于「需要修复并重封」的正常流转。
* 本报告**不主张** `uv.lock` 的声明确认是病因 —— 它只是 `workspaceDrift` 里的一项，补齐后死锁照旧；我把它写进证据是为了排除它。
* 本报告中 `uv.lock` 的 `scope change` 是**下游仓库**的正常操作（吸收生成器更新的合法产物），不是对 kata 的改动。
