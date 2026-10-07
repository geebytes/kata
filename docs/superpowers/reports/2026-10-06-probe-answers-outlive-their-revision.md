# Kata 探针台账问题报告：答案比它所问的 revision 活得更久

**日期**：2026-10-06
**状态**：Resolved — F1、F3 已在 `master`；F2 由 `bind-discovery-observations-to-questions` 以 fail-closed 规则实现，mutation evidence E1–E4 全部 `supported`。
**范围**：Kata 0.2.0；下游项目 `zenmpai` 的 `photo-observation-provider-layer` 在 `strict` tier 下经过 5 轮 review/repair 后的实跑。
**不把 Wiki / 设计稿当作代码正确性证明**：本报告的「复现」均给出命令与输出；「影响」引用实际被拒绝的批准路径，而不是推断。

## 摘要

strict tier 的 assurance 底线是 `observed`，把「审查者真的读了冻结 revision」钉住的机制是**探针**：`ledger ask` 从 claim 自己的阅读面派生问题（文件是否存在、内容摘要前 8 位），审查者实跑并把输出记入 `ledger answer`；每条探针**只答一次**，所以「试到过为止」不可行。

探针集**只在第一次 freeze 时被问一次，此后不可刷新**。于是一个 strict change 只要在首次 `ask` 之后修过任何东西，它的探针就会去问「这个 revision 已经没有的内容」，而问题换不掉、答案改不了。**这不是使用错误，是三条规则叠加后的必然结果**：review 要求「判决不能比它的内容活得久」，非 standard tier 的 blocking 与 major 都拒绝批准，而修复轮改的正是阅读集里的文件。

需要单独说清的是：**门禁算法并没有算错。** 实测 `probeResponseRate` 没有任何消费者，discovery floor 的触发条件是 `independentChallenges === 0`，而失效答案因为非空白仍然满足它 —— `ledger decide` 在一组三条摘要问题都不可满足的探针上照旧返回 `pass`。拒绝来自**协议规则由读者执行**，不是来自某个门禁算错。因此本问题的形状是「规则与机制不一致」，而不是「某个判据写错了」。

## 本次直接复现

| ID | 严重度 | 问题 | 影响 |
|---|---|---|---|
| F1 | blocking | 探针集只在首次 freeze 时问一次，且不可刷新 | strict change 修过一轮之后，探针通道永久失效且无法更正；协议据此拒绝批准 |
| F2 | major | 探针答案不校验 `observed` 是否回答所问，而计数注释声称它校验 | 自证式答案可满足 strict floor |
| F3 | minor | 两个 discovery 计数对「一次独立读数」给出两个答案 | 同一文件两处口径不一致，且生成器跨 claim 不去重 |

### F1 — 探针与答案都无法随 subject 更新

**复现。** 下游 change 经过 5 轮 review/repair 后，三条 digest 探针在**当前** revision 上全部退出 1：

| 探针 | 路径 | 探针断言 | subject 记录 | exit |
|---|---|---|---|---|
| `P1-CL-1` | `tests/architecture/test_photo_observation_boundaries.py` | `6ea3a611` | `98389ebc` | 1 |
| `P1-CL-2` | `tests/photo_observation/test_rawpy_sensor.py` | `26d19055` | `8f986e31` | 1 |
| `P1-CL-3` | `tests/photo_observation/test_rawpy_sensor_integration.py` | `4888fa51` | `55297add` | 1 |

```bash
node -e "process.stdout.write(require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync('tests/architecture/test_photo_observation_boundaries.py')).digest('hex').slice(0,8))"
# → 98389ebc   （探针断言 6ea3a611）

kata-cli ledger answer --change <id> --probe P1-CL-1 --command '<实跑命令>' --observed '98389ebc'
# → {"ok":false,"error":"P1-CL-1 has already been answered; a probe is answered once, ..."}

kata-cli ledger ask --change <id>
# → {"asked":["P1-CL-1","P2-CL-1",...],"seed":"rev:<当前>"}
#    而 probes.json 里 P1-CL-1 的 prefix 仍是 6ea3a611、askedAt 仍是第一轮的
```

**根因。** 四条规则各自合理，合起来使首次签发的摘要永久冻结：

| 规则 | 位置 |
|---|---|
| 探针 id 是**位置式**的：`P${probes.length + 1}-${claim.id}` | `src/kernel/discovery.ts:114` |
| 命令里的期望前缀取自**当前** subject：`input.subject.pathDigests[path].slice(0, 8)` | `src/kernel/discovery.ts:107` |
| `appendProbe` 同 id **永不覆盖**：`if (!items.some((entry) => entry.id === probe.id)) items.push(probe)` | `src/store/ledger.ts:105` |
| `answerProbe` 同 probeId 拒绝二次作答 | `src/store/ledger.ts:133` |

`ledger ask` 把问题**算对了**，然后**无条件**报 `asked: [...]`（`src/cli/ledger.ts:528-554`），无论写入发生了什么。于是「问一个新鲜问题」的命令报告它问了，而盘上还是旧的那条：派生正确、写入被静默丢弃、调用方被告知成功。

**为什么修复循环必然触发它。** 三条规则相遇：

1. `docs/operations.md:307` 与 `.agents/skills/kata-review/SKILL.md:157`：*"a verdict outlives its content, so a declared path that moved after the decision refuses the approval and names the path."*
2. 非 standard tier 下 blocking 与 major 都拒绝批准：`mergeBlockingSeverities` 返回 `['blocking','major']`（`src/quality/review-ladder.ts:72`），消费点 `src/workflow/distill-gates.ts:108`。
3. 一轮 review 的 findings 是**关于守卫的**，而守卫就住在阅读集文件里 —— 修它们就会移动那些文件，这正是阅读集存在的意义。

因此：**任何 strict change 在首次 `ask` 之后完成一轮修复，就会到达「探针问的是已不存在的内容、无法更正、并被协议引用为拒绝理由」的状态。** 这个机制恰好在它本该服务的循环里不可用。

**实测：门禁并没有算错（所以不要修错地方）。**

| 问题 | 测量 | 结论 |
|---|---|---|
| `probeResponseRate` 卡什么门？ | 只在 `status --cost` 里构造，无其它读者；floor 的条件是 `input.discovery.independentChallenges === 0`（`src/kernel/decide.ts:427`） | **不卡。** 它只被报告 |
| 重复问题被数两次？ | `distinctProbeCount` 按 `command.trim()` 去重（`src/store/ledger.ts:931`）；实测原始 9 条 → `probesAsked: 6, probesAnswered: 6` | **报告口径上否** |
| 失效答案还满足 floor？ | `verifiedChallengeCount` 只要求 `command` 与 `observed` 非空白（`src/store/verdict.ts:50-57`） | **是。** `ledger decide` 在三条摘要问题不可满足时仍返回 `pass` |

台账不会察觉，也无法从审查者角色内部让它察觉。拒绝来自上面第 1 条规则**由读者执行** —— 实际发生的就是这样：一轮独立审阅发现它、判为 blocking、点名了三条路径。

**缺失的回归。** 现有测试覆盖「同一 claim 内问题不重复」，但不覆盖「subject 移动后问题与答案的寿命」。需要一条用例：**移动一个阅读集路径 → 重新 freeze → 断言旧答案不再计入、且同一问题可以再答**。

**关闭条件。** 三者任一即可闭合，都不改变探针的语义：

1. **探针 id 内容寻址** —— `P${index}-${claim.id}@${prefix}`（或含 subject revision）。新 subject 产生新 id，重问即追加一条新鲜问题，旧 id 自然退出计分。需要先决定「过期 id 对计数意味着什么」。
2. **`appendProbe` 在身份变化时覆盖** —— 同 id 但 `kind`/`path`/`prefix` 不同则替换，旧记录进历史，而不是静默保留。
3. **答案绑定 subject revision** —— 答案记录它被观测时的 revision；re-freeze 后旧答案作废（计为未答，而非已答），迫使重答。

第 3 条是唯一同时覆盖「阅读集移动但问题本身没变」这一般情形的：它把绑定写成显式事实，而不是从问题文本推断。**注意一条 fail-closed 后果**：既有 `probe-answers.json` 里没有 revision 字段，若按「未记录即不是本 revision 的证据」处理，只靠旧探针满足 floor 的 change 会报零条已验证读数 —— 这是刻意的，另一种处理（缺失当作当前）会让所有既有账本继续带着本缺陷。

**当前缓解（仅追加，不放宽门禁）。** 用 CLI 自带的 `--per-claim` 追加当前 revision 的新探针并实跑记录。实测：追加 3 条，前缀均为当前值，均以真实执行作答。局限是失效答案仍在记录里、仍满足 floor；且 id 仍是位置式，下一次移动会重演。

### F2 — 计数注释声称的校验，代码没做

**复现。** 第一轮记录下来的答案文本是自证的：

```json
"observed": "sha256(...test_photo_observation_boundaries.py)[:8]=6ea3a611 (probe asked for prefix 6ea3a611)"
```

括号里那句把**探针的期望**复述成了**观测结果**。它无法区分「读了文件」与「读了问题」，而它满足了一个 strict floor。

**根因。** `src/store/verdict.ts:30-34` 的注释写着探针答案 *"counts only when the recorded observation carries the fact the probe asked about — the digest prefix for `digest-prefix`, or the path for the existence questions."* 实现只检查 `answer.command.trim()` 与 `answer.observed.trim()` 非空白，此外什么都没有（`src/store/verdict.ts:50-57`）。

这与 `docs/architecture-reviews/2026-09-27-current-workflow-code-review.md:98,105` 已记录的缺口（`ledger answer` 不校验 `observed` 是否等于期望摘要）相邻；**新的是这条计数的注释现在声称它校验了** —— 即「声明覆盖 ≠ 实现覆盖」在本条链上再次出现。

**缺失的回归。** 一条用例：把期望值复述为观测的答案不得计入。

**关闭条件。** 让计数按探针类型做确定性比对（`digest-prefix` 比前缀、`file-exists` 比路径），或在注释里如实写明只查非空白。**注意**：答案类型刻意不携带 kind/path（`src/store/verdict.ts:55-56` 说明了理由），所以真要校验需要先决定这条查找从哪里来 —— 这本身是一个决定，不宜顺手改。

### F3 — 同一文件对「一次独立读数」给出两个答案

**复现。** `src/store/verdict.ts:292-296` 的 `independentChallenges` 用 `readProbeAnswers(...).length`（**原始记录数**），而同文件的 `verifiedChallengeCount` 按 `answer.command.trim()` 去重（`:57`，注释写明 *"Distinct questions, not distinct answer records"*）。

生成器只在**单个 claim 内**去重（`const asked = new Set()` 是 per-`probesFor` 调用，`src/kernel/discovery.ts:111`），跨 claim 不去重。实测：同一 change 的 `P3-CL-1` 与 `P3-CL-3` 是同一条命令，分别挂在 CL-1 与 CL-3 下。

**影响。** 只有 `independentChallenges` 的**零性**参与判定（`src/kernel/decide.ts:427,438`），所以今天这只是报告口径问题，不是门禁漏洞 —— 但同一个文件对「什么算一次独立读数」给出了两个答案，而这正是这条工作线花过最多轮次的缺陷类。

**缺失的回归。** 一条用例：同一命令记录两次，两个计数都得 1。

**关闭条件。** 两个计数共用同一个去重派生。

## 建议

先修 F1（blocking）——它是「规则与机制不一致」，会让任何经过一轮修复的 strict change 卡在批准前，且只能靠手工改写记录绕开。F3 与 F1 同文件同概念，宜一并收敛。F2 是一个独立决定（需要先定「校验从哪里取 kind/path」），建议单独开，不要与 F1 混在一个验收契约里 —— 那会让「这次改了什么」变模糊。

本报告由下游项目 `zenmpai` 的 dogfooding 产生；原始英文诊断（含完整测量与非破坏性边界）曾落在 `docs/design/2026-10-05-probe-answers-outlive-their-revision.md`，随「不实现、只反馈」的决定并入本报告。


## 关闭记录

- **F1（blocking）**：探针与答案都绑定它们所问的 revision 与问题身份；旧 revision 的答案不再作为当前内容上的读数。修复已在 `master`（`src/store/ledger.ts`、`src/kernel/discovery.ts`）。
- **F2（major）**：**决定权被移除，而不是被加强。** `ProbeAnswer` 仍是 append-only 审计历史，但它不再能增加 discovery count、不再满足 strict/security floor、也不再构成 approval request gap。floor 只接受当前 revision、已声明 `executable_falsifier`、且该 falsifier 有 `supported` verifier run 的 challenge。
  - 为什么不改为校验 `observed` 与 `expected`：`observed` 由被审者自由书写，宿主 receipt 目前只携带 run 绑定、能力与遥测，不含单条命令的 stdout/exit code。任何 Kata 内的"校验"仍是对自述做字符串比较，可被复述期望值绕过；要真正证明执行，需要宿主平台提供平台中立的 receipt contract，那是独立工程，不在本 change。
  - 变更：`src/store/verdict.ts`（projection 不再接收答案）、`src/store/review-request.ts`（未答探针不再是 gap）、`src/kernel/decide.ts`、`src/kernel/discovery.ts`、`src/cli/ledger.ts`、`src/workflow/orchestrator.ts`（文案）。
- **F3（minor）**：`independentChallenges` 与 `verifiedChallenges` 由同一个以"已声明 falsifier"为键的投影导出。

**证据。** E1（答案不能增加计数）、E2（未答探针不阻塞 approval）、E3（无 challenge 时 floor 仍拒绝）、E4（CLI 拒绝错配 command），每条均为可逆 mutation：`before:0 → mutated:1 → after:0`，`verdict: supported`。

**这个修复的边界，如实写下。** 它消除的是"自述式 observation 决定门禁"这条路径，不是"审查者真的读了文件"这一证明。后者在当前宿主契约下不可证，因此不做，也不假装做到。
