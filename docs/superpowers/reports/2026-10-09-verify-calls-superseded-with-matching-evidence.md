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

## 根因

> **更正（2026-10-10，由另一会话核实）：本节的根因不成立，其修复方向因此也修不了这个问题。**「结论（永久 FAIL、re-seal 无效）」
> 是对的，但原因不是 `content-diff` 的表面里混进了门禁自身的记账——`changedOutsideOwnership` 在 `src/` 里没有任何消费者，
> 它无法产生这 12 项 `revision_superseded`。实测的根因见文末《核实后更正》一节：**revision 的身份是在执行沙箱里计算的，
> 而 `verify` 在作者工作树里重算它**，两者对「被声明的、但策略视为永不是内容的路径」看到的是不同内容。
（已定位，2026-10-09 追加）

决定性证据来自 `verify` 输出里的 `diagnostics.changeRecord`：

```json
{
  "version": 1,
  "revisionId": "revision-1b7bf1d50f6de6ce",
  "baseRevisionId": "revision-1b7bf1d50f6de6ce",        // ← 与自身比较
  "surfaceBasis": "content-diff",
  "changedPaths": [ … ".kata/evidence/expose-the-complete-parameter-set-AC-1-….json",
                        ".kata/tasks/expose-the-complete-parameter-set/current-revision.json",
                        ".kata/tasks/…/change-record-revision-*.json", … "uv.lock", … ],
  "changedOutsideOwnership": [ ".kata/evidence/expose-the-complete-parameter-set-AC-1-….json", … ]
}
```

也就是说：

1. **`baseRevisionId == revisionId`** —— 变更记录把当前 revision 与它**自己**做 diff；
2. `surfaceBasis` 是 **`content-diff`** —— 于是「变更路径」= 该 diff 的产物；
3. 这个集合里混进了 **kata 自己的记账文件**：`.kata/evidence/*.json`（每次 seal/verify 都重写）与 `.kata/tasks/**`（pointer、change-record、handoff）；
4. 它们**不在 `ownedPaths` 里** ⇒ 落入 `changedOutsideOwnership`；
5. 每个验收项的判定读到的就是「声明面之外发生了变更」⇒ **全部 12 项判 `revision_superseded`**。

**这是自我否证**：门禁自己的记账写在它自己用来判定「表面是否移动」的集合里，于是 seal/verify 每跑一次就把它刚刚产出的结论作废一次；re-seal 只会写更多同类文件，因此「要求 re-seal」的补救在原理上不可能改变结论 —— 与实测的 `verify` 永久 FAIL 完全一致。

与前文「已排除的可能原因」并不矛盾：内容摘要确实一致（`contentDigests` 覆盖文件内容，而 supersede 判据用的是**声明面归属**），证据印章确实正确（31 条都是当前 revision）。两者查的是不同的东西，只有这一条把结论解释清楚了。

**修复方向（据此更新）**：`content-diff` 的表面计算必须排除门禁自身的工作区（`.kata/evidence/**`、`.kata/tasks/**`，至少排除其可写产物），或把这些路径显式声明为「不属于表面」；否则任何按 `content-diff` 判定的验收都会在每次运行后自废。第 2 条回归相应改写成：**当 `revisionId == baseRevisionId` 时，`changedOutsideOwnership` 不得由门禁自身的记账文件构成**。

---

## 核实后更正（2026-10-10，只读核实，kata HEAD `a8e45cb`）

### 结论：一半成立

| 主张 | 判定 |
|---|---|
| `verify` 永久 FAIL，且 **re-seal 在原理上救不了** | **成立**（根因不同，见下） |
| 12 项 `revision_superseded` 由 `content-diff` 表面里的 `.kata/**` 记账导致 | **不成立** |
| 修复方向「把门禁自身工作区从表面里排除」 | **修不了这个问题** |
| 回归 4（报 `revision_superseded` 必须给出导致它的具体比较） | **成立且必要**（是独立缺陷） |

### 实测的根因：身份在沙箱里算，却被工作树校验

1. **revision 的身份是在执行沙箱里计算的**：`src/workflow/orchestrator.ts:674-679`
   ```ts
   const sealed = await createTaskRevisionIfChanged({
       root,
       contentRoot: sandbox.root,                    // ← 沙箱，不是工作树
       contentDigests: sandbox.contentDigests,       // ← 沙箱的内容图
       …
   })
   ```
   沙箱由 `src/workflow/execution-sandbox.ts:33` 建立：`git worktree add --detach <tmp> HEAD`（**只有已提交内容**），
   再叠加作者树里**未被策略排除**的文件（overlay 走 `listRepositoryFiles`）。
2. **`.llmwiki` 在策略的「永不是内容」名单里**（`src/core/repository-identity.ts:37`，`llmwikiDirName`），
   所以那个 overlay **不会**把 `.llmwiki/**` 带进沙箱：已提交的留在 HEAD 版本，未提交的新页干脆不存在。
3. **但身份对「被声明的路径」不做这个过滤**：`src/workflow/revision.ts:453-491` 的 `feedOwnedTree`
   对每条声明路径取内容（注释明说「过滤器只管 walk 往下走进什么，从不管声明」），文件不存在时记 `[missing]` 哨兵。
4. **`verify` 拿作者工作树重算同一个哈希**（`src/workflow/revision.ts:388-391`），于是必然不等 ⇒ `superseded`。

**结论**：只要一个 change 在 `ownedPaths` 里声明了 `.llmwiki/**`（kata 自己的 wiki 约定就是这样），
它的 revision 身份就记录着**沙箱里的**内容，而每次 `verify` 都拿**工作树里的**内容去比——**每次封存都复现，
re-seal 因此确实不可能改变结论**。

### 实测数字（zenmpai `expose-the-complete-parameter-set`，51 条声明路径逐条重算）

```
.llmwiki/concepts/expose-the-complete-parameter-set.md
   记录 8ba1b5d9…  ==  sha256('[missing]')  = true      磁盘 e18189a1…   ← 未提交的新页：沙箱里不存在 ⇒ 记了哨兵
.llmwiki/index.md      记录 fddd5622…   磁盘 362291a8…              ← 沙箱里是 HEAD 的版本，工作树是更新的
.llmwiki/log.md        记录 1d724d8d…   磁盘 5800309d…
其余 48 条                全部一致
重算 manifestHash 91725c38…  ≠  记录 48b6d286…（因此 revisionStatus = superseded）
```

这同时解释了报告里「按 `contentDigests` 逐条核对全部一致」：**那张 595 条的图恰好把这 3 条排除在外**
（它由被过滤的 walk 生成，声明路径不在其中），所以「判据说有问题、而任何可读工件都显示没问题」——
这本身是第二个独立缺陷（见回归 4）。

### 被证伪的两条

- **`changedOutsideOwnership` 不是判据**：`grep -rn changedOutsideOwnership src/` 只有 `src/quality/change-record.ts`
  自身与一处 eval 语料字符串，**没有任何门禁读它**。12 × `revision_superseded` 出自
  `src/workflow/orchestrator.ts:1352` 的 `status && !revisionIsCurrent(status) → supersededReadiness(...)`，
  而 `status` 出自 `revisionStatus` 的 `manifestHash` 比较。因此 `.kata/evidence/**`、`.kata/tasks/**` 是否出现在
  记录的表面里，与这 12 项判定**没有因果关系**。
- **排除门禁自身工作区**（原报告的修复方向）：不触及第 1–4 步中的任何一步，问题原样存在。

### 建议的修复方向（本报告之外，另开 change 实施）

- **A**：身份在**作者工作树**里计算，沙箱只负责**跑检查**（沙箱的用意是「检查不得写进作者树」，身份计算不需要这层隔离）。
- **B**（备选）：让沙箱能表示**每一条被声明的路径**，即使策略视其为「永不是内容」也 overlay 进去。
- **C**（与 A/B 无关，必须做）：`superseded` 必须给出**它比的是哪一侧**——哪个 revision、哪些路径、记录摘要 vs 观测摘要；
  并让可读的内容图覆盖被声明的路径。否则这个状态无法被操作者核对，而报告作者按现有工件核对只会得出「什么都没变」。
