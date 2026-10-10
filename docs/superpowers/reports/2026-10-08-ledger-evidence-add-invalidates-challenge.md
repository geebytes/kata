# Kata 反馈：`ledger evidence add` 改写 claim 后使当前 subject 失效，challenge 投影静默归零

**日期**：2026-10-08  
**状态**：Confirmed — 固定点已在当前 `master`（HEAD `2468205`）实测复现；但触发机制不是报告所说的 `evidenceIds`，而是**冻结之后才声明的 claim**（见下「核实结论」）。
**影响**：`ledger decide` 在所有可执行 falsifier 已通过、challenge resolution 与 verifier verdict 都在盘上的情况下，仍永久返回 `discovery_unverified`；CLI 提示重跑同一个 challenge，但重跑不会改变结果。

**独立复核（2026-10-08）**：与上面「核实结论」一致，另补一条**实际安装版本**的证据 —— 运行的 `/app/kata`（commit `2468205`）上 `tests/unit/discovery-challenge-binding.test.ts` 6/6 PASS，且对 zenmpai 的 `guard-the-property-not-the-proxy` 执行新鲜 `kata-cli ledger decide` 返回 `verdict: "pass"` / `tier: "strict"` / `reasons: []` / `deficits: []`。原始固定点已不可复现。

## 2026-10-08 核实结论（当前 `master`，HEAD `2468205`）

**固定点成立；报告指出的触发机制不成立。**

先否定机制的一半：`evidenceIds` 不参与 question identity。`src/kernel/subject.ts:35-45` 的 `questionOf` 只含 `planDigest`、claim `id`、`statement`、`dependsOn`；`evidenceIds`、severity、status 都是「回答的记账」而非问题。实测（临时用例，跑完即删）：`claim add → freeze → evidence add`（submission 只把既有 claim 的 `evidenceIds` 补成 `["E1"]`）→ `declaredSubjectRevision` **不变**，`verify → challenge add --falsifier → challenge check` 的 `resolution.subjectRevision` 等于当前 declared subject。所以「`evidence add` 必然使 subject 漂移」是错的。

再确认真正的那一半：**冻结之后才声明的 claim** 会移动 declared subject，而读数仍按冻结 subject 盖章，于是投影永远不认它。实测（同一 HEAD）：

```text
claim add C1 → freeze            frozen   = rev:5a81669e28cccad7
evidence add（submission 新增 C2） declared = rev:059aefc473180016
evidence verify                  verdict.subjectRevision = rev:5a81669e28cccad7
challenge add --claim C2 --falsifier E1   failsOn = rev:5a81669e28cccad7
challenge check ×2               resolution.subjectRevision = rev:5a81669e28cccad7
ledger decide → insufficient / discovery_unverified
  need: "re-run the recorded challenge against the current revision …"
```

两处「问题」来自两个不同的派生：`src/cli/ledger.ts:544-562` 与 `:799-835` 用**冻结** subject 建 context 并盖章，`src/store/verdict.ts:67-83` 的 `discoveryProjection` 却拿**当前声明** subject（`readLedger` 的 `subjectAsDeclared`）比较。只要两者不同，任何「重跑」都只会再次盖同一个冻结值 —— 这正是报告说的可重复固定点，也是错误信息给出一条无法改变状态的命令的原因。

因此：报告的四条必需回归（尤其第 3、4 条）依然有效；需要修的不是 `evidenceIds` 的身份，而是**「读数盖章用哪份问题」这个不一致**，以及**拒绝语必须给出真正能清除该状态的命令**（本例中先 `ledger freeze` 再跑）。

**与同文件「独立复核」一条的分歧（据实记录）**：那条结论说固定点「已不可复现」，依据是 zenmpai 现盘上 `ledger decide` 返回 `pass`。这不构成反证：它的账本是在 claims 齐备之后冻结的，属 declared == frozen 的正常情形；本节的复现构造的是「freeze 之后又声明了 claim」，两者不是同一个状态。同一 HEAD 上两种状态可以同时为真。

## 摘要

Kata 的 ledger workflow 当前要求：

1. `ledger freeze` 固化 subject；
2. `ledger evidence add` 记录 evidence；
3. `ledger evidence verify`；
4. `ledger challenge add/check`；
5. `ledger decide`。

但 `ledger evidence add` 除写 evidence 外，还会把 submission 中的 claim 写回 `claims.json`。如果 submission 正确地给每条 claim 填入 `evidenceIds`，claims 的内容改变，`claimsDigest` 随之改变；**刚刚 freeze 的 subject 立即变成旧问题**。challenge 的 resolution 仍绑定旧 revision，`discoveryProjection` 以「当前声明 subject」过滤它，得到 `verifiedChallenges = 0`。

CLI 只报告：

```text
re-run the recorded challenge against the current revision and let it persist a fresh observation
```

但此时 challenge 的 `failsOn` 仍是旧 revision，且 `challenge check` 对该 terminal challenge 只重写同一旧 subject 的 resolution；重复执行不会产生新的 current-revision observation。因此用户进入一个无效重试循环。

## 最小复现（实跑）

任务：`guard-the-property-not-the-proxy`，strict tier。

1. `kata-cli ledger freeze --change <id>`
   - subject：`rev:52056c0f8ab535e3`
2. 生成 submission：四个 claim 各带一个 `evidenceIds`，四条 `executable_falsifier`。
3. `kata-cli ledger evidence add --change <id> --file <submission>`
4. `kata-cli ledger evidence verify --change <id>`：四条均支持：

```json
{
  "id": "E-CL1-use-point-containment",
  "verdict": "supported",
  "observed": "{... before:0, mutated:1, after:0}"
}
```

四条真实变异都满足 `before:0 → mutated:1 → after:0`。

5. `kata-cli ledger challenge add --claim CL-1 --falsifier E-CL1-use-point-containment`
6. `kata-cli ledger challenge check --id X1`

`challenges.json` 的记录完整且三方绑定一致：

```json
{
  "id": "X1",
  "falsifierEvidenceId": "E-CL1-use-point-containment",
  "resolution": {
    "falsifierEvidenceId": "E-CL1-use-point-containment",
    "subjectRevision": "rev:52056c0f8ab535e3",
    "verdict": "supported"
  }
}
```

`verdicts.json` 也有同一 falsifier、同一 revision 的 `supported` verifier verdict。

7. `kata-cli ledger decide --change <id>` 仍返回：

```json
{
  "verdict": "insufficient",
  "reasons": [{"code": "discovery_unverified"}],
  "deficits": [{
    "claimId": "discovery:verified_challenge",
    "need": "re-run the recorded challenge against the current revision ..."
  }]
}
```

8. 按提示再跑 `kata-cli ledger challenge check --id X1`，输出仍是 `state: "withdrawn"`，`ledger decide` 仍是同一 `discovery_unverified`。这是可重复的固定点，不是暂态失败。

## 根因（源码）

### 1. `evidence add` 在 freeze 后写回 claim

`src/cli/ledger.ts` 的 `ledger evidence add` 分支先执行：

```ts
for (const claim of read.submission.claims) await appendClaim(options.root, changeId, claim);
for (const item of read.submission.evidence) await appendEvidence(options.root, changeId, item);
```

而 `appendClaim`（`src/store/ledger.ts`）按 id **替换**既有 claim：

```ts
const existing = claims.findIndex((entry) => entry.id === stamped.id);
if (existing >= 0) claims[existing] = stamped;
```

因此把 `evidenceIds` 写回声明会改变 claims 内容。

### 2. current subject 使用「现在声明的 claims」，不是 freeze 时的 claims

`readLedger`（`src/store/ledger.ts:860-883`）明确构造：

```ts
subjectAsDeclared: subjectOf(
  subjectForProjection.pathDigests,
  subjectForProjection.declaredPaths,
  claimsForProjection,
  planDigest,
)
```

该注释本身也说明：claim restate 后，声明 subject 与 frozen subject 可能不同。这里不只 restate 会触发它，**正常 evidence 绑定也会触发它**。

### 3. discovery 投影只承认 current declared subject

`src/store/verdict.ts:31-80` 的 `discoveryProjection` 要求：

```ts
resolution.subjectRevision === current
&& recorded.subjectRevision === current
```

其中 `current` 是上一步的 declared subject。于是 challenge resolution 和 verdict 虽然一致、虽然是刚才实际跑出的，却都绑定到 add 前 freeze 的 revision，因而被静默排除。

## 为什么这不是使用者漏了一步

- submission 的 claim 需要 `evidenceIds`，否则 claim 无法得到证据；
- `evidence add` 的公开语义就是同时写 claim 与 evidence；
- 文档化顺序把 `freeze` 放在 `evidence add` 之前；
- `challenge check --id` 按当前实现没有使旧 challenge 重新绑定新 subject 的机制；
- 当前错误信息只要求重跑，不说明「先重新 freeze，且旧 terminal challenge 的 resolution 仍绑定旧 subject」。

也就是说，遵循当前公开 workflow 的标准路径必然产生 stale subject；重复推荐命令不能修复。

## 建议修复（需要 Kata 维护者选择其一）

### 方案 A（推荐）：evidence 绑定不参与 question identity

将 claim 的可执行问题（`statement`、风险、依赖）与其 evidence 绑定分离：`evidenceIds` 不参与 `claimsDigest`。这样在已 freeze 的问题上添加证据不会改变 question identity，challenge 与 verifier verdict 保持有效。

这是语义最匹配的方案：**添加证据不是改变正在回答的问题**。

### 方案 B：`ledger evidence add` 检测 subject drift 并显式要求重新 freeze

若 `evidenceIds` 必须参与 identity，`evidence add` 完成后必须：

1. 输出 `subject_drifted: true`；
2. 明确要求 `ledger freeze`；
3. 禁止在新 subject 上使用旧 challenge，或让 `challenge check --id` 自动建立新 resolution；
4. 把完整顺序写成 `add → freeze → verify → challenge → decide`。

至少要让 CLI 不再建议一个无法改变状态的命令。

### 方案 C：在 `challenge check --id` 检测 `failsOn !== current` 时自动重新绑定

这只能作为 B 的配套；它不能解决 evidence add 在 workflow 中隐式漂移、错误信息不透明的问题。

## 必需回归测试

1. Freeze → evidence add（claim 的 `evidenceIds` 发生变化）→ verify → bound challenge check → decide，应得到 `discoveryProjection.verifiedChallenges === 1`。
2. 在该序列后，`ledger status` 应报告 challenge 的已解决状态，而不是 `challenges: 0` 造成“无 challenge / 有未验证 challenge”混淆。
3. 若保留漂移语义：旧 subject 的 terminal challenge 上运行 `challenge check --id` 必须明确报 stale binding，或确实写入新 subject 的 resolution；不得静默重放旧 binding。
4. CLI 的诊断必须给出**可改变状态的完整命令序列**，不能只重复一条已无法生效的 `challenge check`。

## 非主张

- 本报告不主张删掉 subject binding；challenge 与 verifier verdict 必须绑定同一内容版本。
- 本报告不主张手改 `challenges.json` 或放宽 strict discovery floor。
- 本报告不主张 zenmpai 绕过 ledger：所有四条 falsifier 及其变异结果都已保留，问题是 Kata 对它们的身份投影，而不是证据缺失。
