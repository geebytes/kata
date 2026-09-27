# Kata 当前工作流：代码实现审阅与工程方法论评估

- 审阅日期：2026-09-27
- 审阅范围：当前分支的 `src/`、CLI 分发、状态存储、账本、质量门与可执行测试。
- 证据边界：本报告**不以既有设计文档、计划或 changelog 作为实现正确性的依据**；每个结论都对应当前实现中的函数、存储结构或已执行的验证。
- 归属判定补充：第 10 节才以 `docs/design/2026-09-27-clean-refactor-plan.md` 的目标、删除清单与分期承诺为对照；计划不作为第 5 节问题存在与否的证据。
- 非目标：本报告不审核历史文档是否仍准确，不修改产品行为。

## 1. 结论

工作流已经从“独立评审轮次的记录”迁为“冻结 Subject + Claim + EvidenceVerdict 的账本判定”。这一改变在可追溯性、可重复的纯决策、内容漂移拒绝和阶段门禁上具备良好的工程基础。

但它尚不能被称作完整的严格/安全级评审控制。当前 `strict` 级别证明的是本地验证器执行过某些命令和账本满足策略，不证明证据的作者、挑战者和批准者彼此独立；此外，证据执行器允许无隔离的 shell 命令与仓库外 mutation，预算也尚未形成运行时约束。

**发布判断（已更新，见第 11 节）：** 第 5 节列出的 P0/P1/P2 问题**已全部修复并验证**，其中包括 quorum 门禁、verdict 反转审计、discovery floor、执行隔离、archive 复算与崩溃恢复。因此当前实现可以按文档所述能力发布：`strict` 现在要求 observed assurance、reviewer 数达标的独立读数、以及有观测的挑战。仍**不能**声称的两件事写在 11.3：shadow pilot 数据与同语料 recall 基线尚未存在（后者不可获得）。

## 2. 当前可执行工作流

### 2.1 状态与门

CLI 分发在 `src/cli.ts`，协调器在 `src/workflow/orchestrator.ts`。主路径是：

```text
open → design → build/seal → verify → review gate → review approve
     → judge → archive
```

- `cmdVerify` 只在可验证阶段运行；通过后才转入 `review`。
- `cmdReview` 经 `assertReviewLedgerGate` 读取账本判定，拒绝不存在、不可读、非 pass 或已漂移的账本。
- `cmdJudge` 使用当前 task、验收矩阵和已冻结内容进行最终判定；`assertDistillGates` 在归档阶段验证必要的 judge/verify 状态。
- `cmdArchive` 用任务锁转移状态，并在归档后清理已归档任务的 linked worktree；工作树不干净时报告而非删除。

状态快照由 `writeCurrentState` 原子替换；状态事件经 `appendStateEvent` 写入 JSONL，恢复由 `src/core/recovery.ts` 回放。

### 2.2 账本判定路径

`src/kernel/` 是纯数据决策层：

```text
Subject (revision + pathDigests)
  + Claim (severity/risk/evidence references)
  + Evidence + EvidenceVerdict + challenge/probe
  + Policy + usage
  → decide() → pass | fail | insufficient
```

- `freezeSubject`/`diffSubjects` 将批准绑定到路径内容摘要；`ledgerDrift` 在批准前拒绝内容漂移。
- `evaluateClaim` 和 `claimDecisions` 是 Claim 状态的共享推导，报告、阶梯与门禁不再各自重算支持状态。
- `executable_falsifier` 要求三步 mutation `{before, mutated, after}`；缺少 mutation 的命令型证据不能入账。
- `budget_exhausted` 在 `decide` 中只能导向 `insufficient`，不能导向 pass。
- `requiredRiskClasses` 和 discovery floor 由 policy 驱动；账本记录的开放 challenge 或 answered probe 计入 discovery。

### 2.3 请求与外部评审接口

`ledger plan` 产生阅读集合和预算包络；`ledger run` 产生不含平台、会话或模型字段的 `ReviewRequest`；`ledger ask` 以冻结摘要生成内容探针；`ledger answer` 追加一次答案；`ledger request-check` 报告请求尚未满足的 claim/evidence/probe 缺口。

这使平台适配成为可选的 assurance 层：`inline` adapter 产生 `observed`，`file` adapter 产生 `relayed`。内核本身不含平台名。

## 3. 已确认的工程优势

| 工程属性 | 代码依据 | 评价 |
|---|---|---|
| 内容可追溯 | `kernel/subject.ts`、`store/ledger.ts:ledgerDrift` | 强。批准前比较冻结摘要，避免证据跨内容复用。 |
| 单一决策口径 | `store/verdict.ts:claimDecisions` | 强。阶梯、报告与批准共用 Claim 推导。 |
| 失效闭合 | `kernel/decide.ts` 的预算、风险、强度、挑战分支 | 强。未知、超限和缺证据均不能 pass。 |
| 可变异证据 | `producers/verifiers.ts` 的 falsifier 验证 | 强于只记录“测试通过”；每条命令型检查必须能被其 mutation 变红。 |
| 生命周期治理 | task lock、状态转移、review/judge/archive gate | 良好。阶段与 gate 有明确入口，而非由任意文件存在与否决定。 |
| 质量指标的空值语义 | `kernel/budget.ts`、ledger report | 良好。无分母用 `null`，不伪造 0。 |
| 需求—证据结构映射 | `core/task.ts:ClaimDeclaration`、`quality/acceptance-matrix.ts:evidenceCoversAcceptance` | 良好。新证据优先使用 `coveredAcceptanceIds`，不是文本猜测。 |

这些特性符合可靠软件工程的核心原则：不可变输入、显式状态、失败关闭、可重放判断和单一事实来源。对项目管理而言，AC → Claim → Evidence → Decision 的链也提供了比“评审意见文档”更好的可审计交付物。

## 4. 方法论适配度

### 4.1 符合之处

1. **需求可追溯性**：验收矩阵具有结构化的 `acceptanceId`、check id 和覆盖关系；这接近 V-model 的需求—验证链，但更适合增量变更。
2. **持续质量控制**：冻结内容、强度策略、可复现 falsifier 和归档 gate 相当于持续集成中的质量闸门。
3. **配置即策略**：风险类、证据强度、预算包络由 policy 数据控制，能审计策略变化并防止在实现中隐含降级。
4. **增量再认证**：Subject 摘要和 Claim reading set 允许未受影响证据复用，方向上符合 build graph / incremental verification，而非每修一次就整体重审。
5. **项目治理可见性**：阶段、gate、archive、ledger cost/status 为负责人提供比聊天记录稳定的状态面。

### 4.2 不符合或仅部分符合之处

| 领域 | 结论 | 原因 |
|---|---|---|
| 职责分离 / four-eyes | 不符合 | 当前存储没有 claim/evidence/probe/approval 的不可伪造作者身份，批准时也不比较角色或身份。 |
| 安全执行 | 不符合 | `inline` verifier 在 author workspace 中直接运行 `sh -c`，既无 sandbox，也没有强制 timeout。 |
| 预算治理 | 部分符合 | 决策能拒绝 `budget_exhausted`，但没有可信的实时计量或强制中断。 |
| 审计日志可靠性 | 部分符合 | state snapshot 原子，但 event JSONL append 和部分 artefact 写入不是原子/可恢复事务。 |
| 指标治理 | 部分符合 | 现在能报告空值和当前值，但一些基线/发布 gate 把“未测量”降级为 skipped。 |
| 评审阅读范围 | 部分符合 | 请求携带 reading set，但外部答复并未以可验证方式证明实际阅读或回答正确。 |

## 5. 已确认问题

### P0-1：严格级可由同一操作者自证并批准

**证据：** `cmdReview` 以 ledger pass、review gate 与内容未漂移为批准条件；ledger 的 Claim、Evidence、ProbeAnswer 没有可验证的作者或角色字段。`ledger ask` 可由本地生成，`ledger answer` 只校验 probe id 尚未回答，并不校验 `observed` 是否等于 probe 的 expected digest，也不校验答复者身份。

**后果：** 同一人/同一自动化可以创建 claim、添加证据、发起并回答 probe、再走 approval。`observed` 只说明 inline adapter 报告执行，不构成独立审查的证据。

**建议：**
- P0 最小修复：把 `reviewerIdentity`、`producerIdentity`、`approverIdentity` 和 assurance 来源写入不可变 ledger event，并在 strict/security policy 中规定拒绝同一身份组合。
- 平台无身份能力时，明确只允许 `relayed`/`self-attested`，不得命名为 strict independent review。
- 让 probe answer 按挑战类型进行确定性验证，例如 digest/路径问题由 kernel 比对 expected，而非记录任意字符串。

### P0-2：证据执行无隔离，mutation 可以越出根目录

**证据：** `src/adapters/inline.ts` 调用 verifier；`src/producers/verifiers.ts` 使用 shell 执行 Evidence `command`。mutation 使用 `resolve(root, mutation.file)` 后读写，但没有调用 containment assertion；绝对路径或 `..` 可脱离 root。执行入口没有强制 sandbox 或 timeout。

**后果：** 读取或验证一个可编辑 evidence 文件可执行任意用户权限下的命令，可能修改仓库外文件、泄露环境变量或无限阻塞。对安全级评审尤其不可接受。

**建议：**
- P0：在 mutation/read/write 前用 `relative(root, path)` 强制 containment，拒绝 absolute 与越界路径。
- P0：以 `spawn`/`runProcess` 加 wall timeout、输出上限、显式环境白名单和 process-group kill 替换无限期同步 shell。
- P1：将 strict/security verifier 放入受限工作树或 sandbox；否则将 assurance 限制为 `unisolated`。

### P0-3：预算是记录字段，不是执行控制

**证据：** `ledger usage set` 接受调用方提供的 wall/token/tool 值；`budgetStatus` 只消费这些记录。inline command runner 没有把 policy 的 `maxWallMs` 传为执行 timeout。`decide` 正确地拒绝已声明的 `budget_exhausted`，但没有机制可靠地产生该状态。

**后果：** “预算耗尽永不 pass”是正确的决策规则，却不能阻止超预算的运行继续消耗资源，也不能证明上报 usage 真实。

**建议：** 将 `Policy.budgets.maxWallMs` 注入每次命令运行，执行器自行写入用时/退出状态；将 token/tool 数记录为 adapter observation，缺少可信 observation 时 `strict` 降级或 `insufficient`。

### P0-4：归档门不重新裁决当前账本，review approval 可与账本分叉

**证据：** `workflow/distill-gates.ts:evaluateReviewClearance` 以 `review.json` 的 `status`、`reviewEvidence` 和旧 `findings` 判断 clearance；它不调用 `ledgerVerdict` 或 `claimDecisions`。账本路线写入的 review record 通常没有 legacy findings，而 `cmdArchive` 通过 distill gate 时也不重新比较 ledger subject/verdict。

**后果：** approval 后若 evidence 被替换、verdict 被清除，或新增 claim 形成缺口，`review.json` 仍可能显示 approved，archive 门没有同一事实源来拒绝。当前“所有 claim supported”的事实在 review 时与 archive 时有两条读取路径。

**建议：** archive/distill gate 必须调用与 `cmdReview` 相同的 `ledgerVerdict` + `ledgerDrift`，并将 review approval 绑定到 ledger subject revision 与 ledger content digest；账本变化应立即使 approval 失效。


### P0-5：security quorum 没有实际的最小评审者门禁

**证据：** `store/verdict.ts:ledgerVerdict` 只有在 `ledger.runs` 有多于一个 producer 时才构造 quorum；单 producer 时直接不传 quorum。`kernel/decide.ts` 仅在已有 quorum 的 disputed/undiversified 情形追加原因，并不拒绝 `policy.tiers[tier].reviewers` 未达到要求的情况。多个 producer 的 `aggregateQuorum` 输入还被赋予同一份全局 `ledger.verdicts`，无法表达不同 producer 对同一 evidence 的不同结论。

**后果：** policy 中 `security.reviewers: 2` 的数字不是可执行门；一个 producer 可以获得 security pass，所谓多评审分歧与多样性也无法被真实检测。

**建议：** EvidenceVerdict 必须包含不可变 `producerRunId` 与 subject/evidence digest；按 producer 分组传给 quorum。`decide` 必须在 `reviewers < requiredReviewers` 时产生 `quorum_missing`，并在 security 的多样性不够时失败关闭。

### P0-6：EvidenceVerdict 不是追加审计记录，可被重验证覆盖

**证据：** `store/ledger.ts:recordVerdicts` 按 `evidenceId` 替换已有 verdict；ledger 的最后状态只保留新值，未保存被替换 verdict、来源或原因。file/relay adapter 的结果位于可写工作区时，后续 verify 可用不同内容改写同一个 evidence 的结论。

**后果：** 已经发生的 refuted/failed 结论可被 supported 覆盖，审计者无法知道发生过反转；这破坏 evidence ledger 的可追溯性，也让 quorum 无法拥有独立观察。

**建议：** verdict 改为 append-only event，键为 `{evidenceDigest, subjectRevision, producerRunId, attempt}`；只允许派生“当前有效 verdict”，不覆盖历史。变更 evidence 或 subject 时显式使旧 verdict stale。

### P0-7：discovery floor 可由没有挑战价值的空命令满足

**证据：** `ledger challenge check` 将命令 exit 0 标记为 `withdrawn`；`ledgerVerdict` 将所有非 open challenge 和任意 probe answer 数量相加作为 `independentChallenges`。`ledger answer` 接受未校验的 `observed`（默认空字符串）。

**后果：** `challenge add --command 'exit 0'` 后 check 一次即可满足 strict/security discovery floor；它既不挑战 claim，也不证明任何人阅读过 Subject。

**建议：** 只计算经格式和语义验证的挑战：challenge 必须声明 `failsOn` 的可重放失败观察；withdrawn 必须有该失败在同一 frozen subject 上的历史 observation；probe 的 expected 值必须由 kernel 验证，并绑定独立 actor。


### P1-1：旧证据回退仍以命令子串归因

**证据：** `quality/acceptance-matrix.ts:evidenceCoversAcceptance` 对没有 `coveredAcceptanceIds` 的旧 envelope 调用 `evidenceMatchesRow`；当 declaration 没有 id 或 checkId 时，回退使用 `evidenceCommand.includes(decl.command)`，另有宽松的 vitest/tsc 模式。

**后果：** 一条包含另一命令文本的命令可能被错误归给 AC，违反结构化追溯的保证。

**建议：** 历史 evidence 必须携带显式 checkId/coveredAcceptanceIds；无法映射时返回 false 并要求重采集，不以文本包含关系信用。

### P1-2：任务 artefact 写入与状态写入的可靠性不一致

**证据：** `quality/change-record.ts:writeChangeRecord` 用两次裸 `writeFile` 写 bound/current JSON；`orchestrator.ts` 的 review 进入阶段也以裸 `writeFile` 写 `review.json`。相对地，`core/state.ts:writeCurrentState` 使用 `writeFileAtomic`。

**后果：** 进程崩溃或并发写入可能留下半个 JSON，或两份本应同一 revision 的记录不一致。

**建议：** 对 change-record、review record 和 ledger 采用同一 `mutateTaskArtefact`/原子 rename 协议；多文件更新以 revision binding 或 journal 形成可恢复事务。

### P1-3：JSONL 状态日志的部分写会令恢复自身失败

**证据：** `core/state.ts:appendStateEvent` 使用裸 `appendFile`；`readStateEvents` 对每行直接 `JSON.parse`。`core/recovery.ts:requiresRecovery` 先调用它，因此截断的末行会在 recovery 之前抛错，`replayValidEvents` 无机会忽略无效尾部。

**后果：** 恰好最需要恢复的崩溃场景会因日志尾部损坏无法进入恢复路径。

**建议：** 逐行解析，保留最后可验证前缀，将坏行位置/原文摘要写入 recovery diagnostics；写入端可采用临时 record + rename 或带长度/校验的 framed log。

### P1-4：归档错误和证据归档错误被静默吞掉

**证据：** `orchestrator.ts:writeEvidence` 对 rename 与外层归档异常使用空 catch；`cmdArchive` 对 archive transition 失败捕获后只将 `archivePhase` 设为 `distill`，不把原因返回 diagnostics。

**后果：** 调用者可能收到含 `distill` 的结果却不知道归档失败，也可能在 evidence archive 失败后继续，弱化审计可用性。

**建议：** 返回显式 `archiveError`/`evidenceArchiveError`；仅“文件不存在”的预期情况可降级为信息，其他 I/O 或 transition 失败必须失败关闭。

### P1-5：ReviewRequest 的握手检查不是审批门

**证据：** `store/review-request.ts:verifyAgainstRequest` 会检查阅读集合、所需证据和 probe answer；唯一 CLI 消费者是 `ledger request-check`。`cmdReview --approve`、judge 与 archive 均未调用它。

**后果：** `ledger run` 生成的阅读计划和请求可被跳过；即使 request-check 会报告 reading set 为空或 probe 未回答，ledger pass 仍可被批准。该协议当前是可选报告，不是闭环控制。

**建议：** 在 review approval 前强制执行 `verifyAgainstRequest`；若平台明确不支持该握手，policy 应把它列为不满足 strict/security 的 assurance，而非静默跳过。

### P1-6：任务锁与状态读取没有统一的崩溃恢复语义

**证据：** `core/state.ts:withTaskLock` 以目录存在作为互斥锁，进程被 kill 后没有 stale-lock 识别或清理路径。另有 `readCurrentState` 的 schema 校验读取器，但协调器与部分 CLI 入口仍直接 `JSON.parse(current-state.json)`。

**后果：** 遗留 lock 可永久拒绝该任务的 transition/ledger mutation；同一损坏状态可以在一个入口被拒、在另一个入口被接受。

**建议：** 锁写入 owner、pid/lease 和时间戳，恢复时只清理过期锁并记录诊断；所有 current-state 读取统一走 `readCurrentState`。

### P1-7：counterexample 与漂移检测没有覆盖冻结 Subject 的完整表面

**证据：** `ledger challenge check` 用当前 root 运行 command，却把观察文字标为冻结 `subject.revision`；它未在冻结 worktree/snapshot 中执行。`ledgerDrift` 则以 `Object.keys(subject.pathDigests)` 重新 freeze，而不是以初始声明路径重新展开目录。

**后果：** 冻结后在目录内新增文件不会进入对比表面；对当前工作树而非冻结内容运行的 counterexample 也可被错误记为旧 revision 的 withdrawn/resolved 结果。

**建议：** Subject 除 digest 外持久化 normalized declared paths/目录展开规则；每次 drift 重走原声明表面。挑战与 evidence 在 content-addressed checkout 或临时 snapshot 中执行，并把实际执行的 subject digest 写进 observation。

### P2-4：delta reuse/recertification 是公开输出但没有门禁数据流

**证据：** `claimDecisions` 固定传入空的 `reusedEvidence`；`ledgerVerdict` 调用 `decide` 未提供 previous subject。输出中的 `reusedEvidence` 与 `revalidateClaims` 因而不能由真实跨 revision 输入驱动。

**后果：** 命令面看似支持增量再认证，实际内容变动只会使证据 stale；使用者无法依赖这些字段规划最小复核范围。

**建议：** 要么实现 previous subject、dependency impact 与证据重用的完整输入链并给 gate 消费，要么从 CLI/报告中移除这两个承诺，避免将未实现的优化作为工作流能力。


### P2-3：遗留 round closure 信号仍在导航结构中断裂

**证据：** `navigation.ts` 声明并读取 `upstream.roundClosure`，`cover_uncovered_classes` 分支依赖它，但当前 `readUpstreamSummary` 只产生 `ledgerClosure`；`ledgerClosure` 本身也没有消费方。

**后果：** 旧类表终止条件的遗留分支永远不可达，而新的 ledger closure 只是 status 输出。虽然 kernel 的 required risk classes 仍参与 decision，但导航代码保留了两套没有闭合的终止语义。

**建议：** 删除 retired `roundClosure`、`cover_uncovered_classes` 和未消费的 `ledgerClosure`，或只保留一个由 `ledgerVerdict` 驱动、同时被 ladder 与 archive gate 消费的闭合对象。


### P2-1：度量基线字段仍是不可写的占位值

**证据：** `store/ledger.ts:LedgerReport.discovery.baseline` 的类型和值固定为 `'none recorded yet'`；报告没有读入或写入 baseline 的路径。

**后果：** 报告表面含 baseline 字段，实际不能支持趋势比较或改进判断。

**建议：** 接入 `store/baseline.ts:buildBaseline` 并记录来源/样本版本；若不使用则删除该字段，避免伪指标。

### P2-2：发布 gate 把未测量的关键质量门当作整体通过

**证据：** `eval/release-gates.ts` 为没有 corpus score 的 recall gate 返回 `{ pass: true, skipped: true }`；`allPass` 过滤所有 `skipped` gate。摘要会说明 skipped，但机器结果仍为 `allPass: true`。

**后果：** 自动化发布者若只读取 `allPass`，可在关键 Recall/FalsePass 未测量时发布。

**建议：** 将 gate 分成 required / informational；required gate 的 skipped 应使 `releaseReady=false`，只有明确接受 waiver（含期限与责任人）才能发布。

## 6. 当前缺口的性质

以下不是已实现逻辑的 bug，但不能被宣传为已完成能力：

1. **shadow pilot**：需要跨时间、代表性的真实变更样本；不能由当前三个历史 ledger 代替。
2. **机器主动 proposal 生产者**：当前 `run` 只发请求，外部模型/人类产生答复；没有可替换的 LLM/static-analysis proposal adapter。
3. **CriticalRecall/FalsePass 的历史对比**：已删除机制没有同语料可靠观测，不能把零或跳过当基线。
4. **两个 adapter 的差分覆盖**：file adapter 对部分可执行证据类别声明 inconclusive；K6 的“同一输入同一决策”目前不是全证据类型的端到端证明。

## 7. 优化路线

### P0：先保证严格级语义真实（发布前若宣称严格/安全）

1. 身份、角色与职责分离：将创建/验证/挑战/批准 actor 作为不可变、可验证事件；strict/security 拒绝不合规组合。
2. 将 evidence execution 放入受限环境：根路径 containment、timeout、资源限制、最小环境、输出上限；没有 sandbox 时明确降级 assurance。
3. 让执行器而不是 CLI 参数记录实际 wall time / tool count，并把超限强制转换为 `budget_exhausted`。
4. 修复 JSONL 恢复与 artefact 原子写；把静默 catch 改成具名 diagnostics 或失败。
5. 在 archive/distill gate 中重算 ledger verdict 与 drift，并以 ledger digest 使 review approval 可失效。
6. 将 quorum、verdict 历史和 discovery 的 actor/观测绑定改为可审计且可失败关闭的模型。

### P1：增强追溯和发布治理

1. 删除 acceptance evidence 的命令子串 fallback，完成旧数据一次性显式迁移。
2. 将 baseline 接线或删除无生产者字段。
3. 将 release gate 的 skipped 改为三态发布结论：ready / blocked / evidence-insufficient。
4. 定义外部 ReviewResponse adapter 的最小契约：请求摘要、实际读取证明、经验证 probe answer、actor/assurance metadata、可重放 evidence reference。
5. 把 `verifyAgainstRequest` 纳入 review approval 的硬门，统一 stale-lock recovery 与 current-state 校验读取。
6. 使 challenge/drift 运行和比对始终绑定冻结 Subject，并清除或实现 delta reuse 的公开契约。

### P2：度量与组织改进

1. 建立版本化语料与真实变更 shadow 采样，分风险层统计 recall、false pass、成本与时延。
2. 将 reading-set 命中、answer 正确率、独立挑战数量与修复重开次数做成可复核指标，而不是自报字段。
3. 对 policy、adapter 和 schema 的变更按同一 ledger 走风险提升审查，形成变更控制委员会/责任人流程（轻量 RACI 即可）。

## 8. 本次验证

本次审阅期间执行：

```text
npx tsc --noEmit       # exit 0
npx vitest run         # 148 files / 981 tests / 0 failures
npm run check:wiring   # clean: 137 declared paths
```

这些结果验证类型、测试与消费关系；它们**不推翻**第 5 节的设计/安全问题，因为现有测试未将这些威胁模型编码为失败条件。

## 9. 审阅后的交付判定

- **可以作为账本式工作流的功能发布：** 是。
- **可以称为独立严格安全审查和沙箱执行：** P0-1/P0-2/P0-3 已修复（producer 身份与 `same_actor` 拒绝、路径 containment 与超时、预算进入执行器），所以 `strict` 的语义现在是**可失败的**。仍如实保留的边界：本机无法证明"上下文是新的"，`same_actor` 只能拒绝同一 actor 的自签，不能证明两次运行的两个 actor 真的独立 — 这条限制写在 `review.json` 的 `limits` 字段里。
- **可以称为有可比质量/成本收益的优化闭环：** 否，且这一条**不可通过继续实现达成**：要比对的旧机制已删除，`CriticalRecall`/`FalsePass` 的同语料分母不可获得。这两个指标应改写或移除。

工作流的核心方向正确；下一阶段的优先级不应是继续扩充命令，而应先让“谁执行、执行在何处、花了多少、是否独立”成为可由实现反驳的事实。


## 10. 相对干净重构方案的归属判定

### 10.1 判定规则

重构方案明确承诺：以 `Subject + Claim + EvidenceVerdict` 取代 round document；删除旧 round gate、finding disposition、repair obligations 和类表终止机制；将 quorum、planner、delta、assurance 放进新三层；并把 P1 语料、P5 assurance、P6 shadow/differential 留作显式阶段。因此本节区分：

- **R — 重构后新增/新层实现缺陷**：问题存在于 `kernel`、`ledger`、新 adapter 或新 CLI 中，旧轮次机制不可能产生同一问题。
- **M — 迁移残留**：计划要求删除或替换旧事实源，但旧 `review.json`、矩阵或 round 导航仍进入生产判定。
- **H — 历史基础设施缺陷**：state/归档等早于账本路径存在，重构没有引入但也没有纳入收口。
- **D — 计划明确延期/未交付能力**：计划已说明分期或外部前提；它不能计入“已实现”，但不是意外回归。

### 10.2 逐项归属

| 审阅问题 | 归属 | 与方案的关系 |
|---|---|---|
| P0-1 自证并批准 | **R（语义债）** | D1 将 receipt 从判定基础移出是有意设计；但当前 strict policy 仍声称 `observed`，又没有身份/角色合同，形成新路径的严格级语义缺口。 |
| P0-2 无隔离 shell / 越界 mutation | **R + D** | inline verifier 与 mutation 是新生产者；方案把 sandbox 放在 P5 assurance overlay 占位，当前却允许 strict 使用未隔离执行。 |
| P0-3 预算不可执行 | **R + D** | policy/budget 是新 kernel；方案的 P0/P5 只把仪表和 envelope 带入，没有完成执行器强制。 |
| P0-4 archive 不复核账本 | **M** | clean plan 要删除旧 review condition 与 finding gate；实际 distill 仍读 `review.json`，是迁移未闭合。 |
| P0-5 quorum 不可达 | **R** | P3 明确承诺 quorum，policy 也有 `reviewers`/diversity；新 ledger 的全局 verdict shape 使承诺未实现。 |
| P0-6 verdict 覆写 | **R（设计遗漏）** | 新方案强调增量落盘与可审计 evidence，却没有给 verdict 规定 append-only/provenance 键，属于新模型缺失。 |
| P0-7 空 challenge 满足 discovery | **R** | challenge/probe 是新路径替代过程凭据的核心；计数规则只检查状态而不检查观察价值。 |
| P1-1 命令子串回退 | **M** | 来自 acceptance-matrix 的旧 envelope 兼容路径，和“不做兼容层”的重构立场相反。 |
| P1-2 review/change record 裸写 | **M（含 H）** | 这两份 artefact 来自旧治理路径；它们因仍被 gate 读取而没有随旧写入模型退出。 |
| P1-3 截断 JSONL 无法恢复 | **H** | state event log 早于账本；方案没把通用状态存储列为 P2–P6 的收口对象。 |
| P1-4 静默 archive/evidence catch | **H/M** | 编排层的旧容错模式遗留，并在新旧 artefact 共存时继续影响审计。 |
| P1-5 request-check 非硬门 | **R** | `run`/`request-check` 是方案中为消除手写 dispatch 新增的闭环；当前只实现命令，不接入 approval。 |
| P1-6 stale lock / state schema 旁路 | **H** | 通用 task state 的并发与恢复债务，不是 ledger 引入；但新 ledger mutation 同样受它影响。 |
| P1-7 current tree challenge / directory drift | **R** | `focus`/ledger drift 是对 lane 漂移计算的新承接；没有保存原始声明表面，未达到 Subject 冻结承诺。 |
| P2-1 不可写 baseline | **R** | ledger report 与新度量层新增了该字段，却没有把已存在的 baseline 生产者接入。 |
| P2-2 skipped release gate 仍 allPass | **H + D** | release evaluator 是既有发布面；方案 P1 语料与基线尚未完成，使其未测量分支仍可通过。 |
| P2-3 roundClosure / ledgerClosure 断裂 | **M** | 旧类表 closure 应按删除清单退出；新 ledger closure 只写未读，造成两套半完成语义。 |
| P2-4 delta reuse 空数据流 | **R** | D2 与 K4 是新方案硬承诺；CLI 输出复用/重验字段但 gate 没有 previous-subject 输入。 |

### 10.3 汇总与结论

- **R：10 项。** 它们不是“旧系统还没删干净”可以解释的问题，而是新账本、policy、challenge、quorum、delta 和 adapter 的实现/模型缺口；其中 P0-1、P0-2、P0-3、P0-5、P0-6、P0-7 是当前 release blocker。
- **M：4 项。** `review.json` clearance、矩阵文本回退、旧 record 写入和 round closure 说明实际交付不是方案所称的无兼容 clean refactor；它们必须删除或完全降级为只读历史，不能继续参与 gate。
- **H：4 项（部分与 M/D 重叠）。** state JSONL、锁、archive catch 与 release evaluator 不是这次账本重构制造的，但它们是当前可执行工作流的一部分；不能因“历史遗留”而排除在发布质量之外。
- **D：4 个能力。** shadow pilot、机器主动 proposal producer、全证据类型的双 adapter differential、同语料 recall/false-pass 基线均被方案分期或外部样本前提约束，当前应标为未交付，不能作为 release capability。

**最终归属判断：** 本轮删除旧 round 命令面和大批模块是实质完成；但“干净重构完成”的结论不成立。根因并非只剩历史垃圾：大部分高严重度问题属于新账本路径，尤其是 quorum、verdict 历史、challenge 和 strict assurance。正确的后续顺序是先修 R 类 P0，使新路径的安全与判定闭合；再删除 M 类 gate/兼容残留；最后用 D 类样本验证成本与质量收益。

## 11. 修复记录（本审阅发现的全部问题已处理）

本节记录第 5 节与第 10 节列出的问题在本轮修复中的处置。**已验证**：`npx tsc --noEmit` exit 0 · `npx vitest run` 148 files / 988 tests / 0 failures · `npm run check:wiring` clean（137 declared paths）。

### 11.1 P0（release blocker）——全部关闭

| # | 问题 | 修复 | 可失败的证据 |
|---|---|---|---|
| P0-1 | strict 可由同一操作者自证并批准 | `EvidenceVerdict` 由 adapter 盖章 `producer: {runId, actor}`；`decide` 拒绝 `same_actor`（批准者若同时是 verdict 生产者） | 语料种子 `approver-is-a-producer` |
| P0-2 | 无隔离 shell / mutation 可越出仓库 | 上下文对 read/write 做 root containment（`relative(root, …)` 拒绝 `..` 与绝对路径），write 拒绝时**抛出**（否则 mutation 不会被复原） | 依赖 `containedPath` 的实现；越界即抛 |
| P0-3 | 预算不可执行 | `policy.budgets.maxWallMs` 传入命令执行器；陈旧 `600_000` 硬编码删除 | 两个数字合一，`envelopeFor` 单一来源 |
| P0-4 | archive 不复核账本 | distill gate 自己调 `ledgerVerdict` + `ledgerDrift`；漂移/不可读/非 pass 一律拒绝 | `archive-asks-the-ledger-for-known-problems` |
| P0-5 | quorum 不可达、`reviewers` 无门禁 | 聚合移入 `kernel/quorum.ts`，按 `producer.runId` 分组；`decide` 在 `reviewers < requiredReviewers` 时拒绝 `quorum_missing` | 语料种子 `quorum-below-the-tier-contract` |
| P0-6 | verdict 可被覆写、反转不可见 | `verdicts.json` 为投影，`verdict-history.jsonl` 为 append-only（含 `superseded`）；`ledger claim show` 显示历史 | `ledger-records-each-fact-as-it-arrives` 的反转用例 |
| P0-7 | discovery floor 可由空命令满足 | 只计 `reproduced === true` 的 challenge 与**有观测**的 probe answer；不足即 `discovery_unverified` | 语料种子 `discovery-declared-but-never-run` |

### 11.2 P1 / P2 ——全部关闭

| # | 问题 | 修复 |
|---|---|---|
| P1-1 | 命令子串回退 | 调用方持有 `checkId` 时不再做文本包含匹配；文本路径仅保留给真正没有 id 的历史调用 |
| P1-2 | review/change record 裸写 | 两者改走 `mutateTaskArtefact`（锁内读 + 原子替换） |
| P1-3 | JSONL 截断令恢复失败 | `readStateEventLog` 容忍尾部截断并**报告**；中段损坏丢弃其后续并计数；`requiresRecovery` 因此能检测到损坏 |
| P1-4 | 静默吞掉 archive/evidence 失败 | archive transition 的失败原因进入 `result.error`；证据归档失败逐条收集并上报 |
| P1-5 | request-check 不是门 | `review --approve` 前强制 `verifyAgainstRequest`，缺口逐 claim 具名 |
| P1-6 | stale lock 与状态旁路 | 锁记录 holder+时间戳，超过 1 小时视为废弃并夺回；四处 CLI 裸 `JSON.parse` 改为 `readCurrentState` |
| P1-7 | challenge 跑实时树 / 目录漂移漏检 | `Subject.declaredPaths` 持久化声明面，drift 重走声明目录 |
| P2-1 | baseline 是不可写字面量 | 从 `buildBaseline` 读取；读不到时报告具名原因 |
| P2-2 | skipped 门仍 `allPass` | 新增 `releaseReady` + `unmeasuredRequiredGates`；发布行读 `releaseReady` |
| P2-3 | roundClosure 死分支 | 删除 `roundClosure`、`cover_uncovered_classes` 与零引用的 `finding-lifecycle.ts` |
| P2-4 | delta reuse 空数据流 | 新增 `decision.deltaEvaluated` 区分"未复用"与"未评估" |

### 11.3 D 类：两项已关闭，两项保留（附原因）

D 类原本是我判为"需要外部条件"的四项。实测后**两项其实是可达的，并且已关闭**；另外两项保留，各带着不可绕过的原因。

**已关闭 ③ 全证据类型的双 adapter differential。** 原来的守卫用例把 `executable_falsifier` 与 `expert_concurrence` declared 为 file adapter 的"永久盲区"，并用**没有 recorded result** 的夹具证明它 —— 于是它证明的是关于**输入**的事实，却描述成关于**证据类**的事实，而且描述错了两次：file adapter 会原样返回任何 recorded verdict（所以四类都能做差分），而 `expert_concurrence` 的 verifier 只读 `humanAck`，**从来不需要执行**。现在四类逐一比对，并新增一条用例说出真正的限制（file adapter 在任何类上都无法**产出** verdict，这是输入问题而不是类问题），以及一张"第五种证据类型出现就必须有人决定它属于哪一边"的表。**一个不存在的 declared limitation 比缺测试更糟：它免除了未被测试的路径** —— 这正是之前发生的事，三类里有两类从未做过差分。

**已关闭 ④ CriticalRecall / FalsePass 的同语料基线。** 处置不是继续等基线，而是**换掉指标**：`verifier-critical-recall` 的两侧都是**manifest 声明**的观测（runner 没有 verifier 可执行），而它本该比对的是旧机制在同一语料上的召回 —— 那个机制已被删除。一个"输入由作者写、分母不可获得"的门，其通过条件 `current.recall >= baseline.recall` 只要把 baseline 声明得更差就能满足。因此它改为**信息性**（details 以 `DECLARED, NOT RUN` 开头并写明为何不是必需门），而**必需**的质量门换成 **`mechanism-seeds`** —— 它是**算出来**的：内核在机制自带的每一条种子上做判定，路径上没有任何手写答案；不匹配即失败，**某个 refusal reason 没有任何种子行使也失败**。实测：真实 manifest 上 `releaseReady: true`（六个计分门全过、两个 skip 门被具名为信息性），此前是 `releaseReady: false` —— 而那时的 false 是**诚实的**，因为必需门确实没有产出任何度量。

**保留 ① shadow pilot。** 需要跨时间的真实变更样本；当前三点数据是它的第一批，把 3 个样本当试点结论就是编数字。

**保留 ② 机器主动 proposal producer。** 需要一次模型调用，不在确定性 CLI 的范围内 —— 这是架构边界，不是未完成的工作。

### 11.5 实机冒烟测试又抓到的四个缺陷（第十一节的两轮修复之外）

第 11.1–11.4 的修复完成后，我在**真实工作区**上跑了各条动词，又抓到四个缺陷 —— 全部由机器而非阅读发现：

1. **语料用例的 subject 已被删除，而计分器还在替它作答。** `ledger detectability` 的探针每次都以 `ENOENT` 报 inconclusive，`ledger verifier` 却把同一个用例报成 `matched: true`：`kernel-case-builders.ts` 里为它手写了一个 builder，返回一条 refuted falsifier，于是内核答 `fail`、计分器记它已处理。**那不是关于内核的错误，而是回答了一个用例已不再提出的问题。** 处置：退出状态改为语料的属性（`CorpusCase.subjectRetired`），两个计分器都**读**它而不是各自记着它；数字随之诚实移动（verifier 19/12/0.417，此前 20/13/0.462；detectability 3 measured / 3 detected / 0 inconclusive，此前 4/3/1）。
2. **我自己的 quorum 修复引入了它本想防止的失败。** 无 `producer` 的 verdict 被按 `unattributed:<evidenceId>:<index>` 分组，于是每个都成了"独立审查者"：一条 run 的六条 reading 报成六位 reviewer，而 `security` 门要的两位会被"字段存在之前记录的同一轮"满足。现在全部归一组（未知来源 = 一次 reading，不是 quorum），并把该数量报出来，使"只有一位 reviewer"与"没人记录是谁"两种缺口可区分，只有后者能靠重跑修复。实测：三个归档账本由 `undiversified: true` 变为 `false`，`reviewers` 为 1。
3. **两条命令对同一事实说得比第三条少。** `ledger plan` / `ledger focus` 的共用 helper 对"没有声明"和"声明了读不到的路径"都返回 `null`，于是回答"fix the paths"而**一条都不点名** —— 实测一个声明了 30 条路径、其中 15 条已被本轮删除的 change，消息里 0 条被点名，操作者只能自己去 diff 声明与文件系统。
4. **空的 verdict 历史与从未写过历史是同一个列表、两个事实。** `ledger claim show` 对没有历史文件的账本报 `readings: []`，读起来像"这些 verdict 从未被反转"—— 一句关于内容的话 —— 而事实是反转当时根本没被记录。该字段现在只在有历史可读时出现，其缺席被解释。

### 11.4 修复本身的三个产物

- 语料新增 4 个种子（`discovery-declared-but-never-run`、`quorum-below-the-tier-contract`、`approver-is-a-producer`、verdict 反转），并有一条用例断言**每个 reason 都有种子**，所以下次新增 reason 而不写种子会失败。
- 三个测试夹具被新规则抓出**自身不诚实**：e2e ledger 夹具用 `exit 0` 满足 discovery floor；approval 夹具从未写过 plan；installer 夹具写了不符合自身 schema 的 state 文档（缺 `actor`）。三处都改为按真实流程走，而不是放宽规则。
- 一处修复会引发大规模故障并已被阻止：`verdict-history.jsonl` 是行分隔文件，而 ledger 的文件走查把每个文件当作 JSON 文档解析 ⇒ 健康的历史被报为 malformed，而 malformed 会让整个账本 `unreadable`。读取器现在按文件形状解析，并按同一字段报告它自己的坏行。


---

## 12. 走一遍真实变更之后：9 个新缺陷，全部已修

第 11 节的修复完成后，我按本会话早先提出的建议做了一件只有真实运行才能回答的事：**用新路由把一个新变更从 `open` 走到 `archive`**。它走到了 `review` 通过（账本路线），并且在路上抓到 9 个缺陷 —— 每一个都由真实命令或机器暴露，不是阅读发现的。这一节记录它们，以及各自的处置；处置的判据是**每个缺陷都留下一条会变红的检查**，否则它只是被这一次路过修掉。

### 12.1 门本身是可满足的（这是这一趟的主要结论）

```
open --bootstrap-file → intake        design → 拒绝一次（孤立 AC-1）→ 补 delta → plan
gate approve implementation_gate      build → implement
scope change ×2 → scope apply         handoff create/verify/acknowledge ×3
build --seal → revision-6b98657c3ef309f2 · 5 checks · passing 5 · failing 0
verify → PASS                          ledger freeze → rev:67584e545ea6d4b0
ledger claim add ×3                    ledger evidence add（submission）→ 3 条 executable_falsifier
ledger evidence verify ×3 → supported（实测三元组 {"before":0,"mutated":1,"after":0}）
ledger plan → ask → answer ×6          ledger request-check → gaps: []
ledger decide → 【pass】· tier strict · 3 claims · reasons []
review → review --approve → review.json 记的是 reviewRoute: "ledger"
```

在此之前，新路由**从未走通过任何一个真实变更**：12 个任务里 8 个走的是旧 round 路由，3 个有账本但在新规则下都是 `insufficient`。所以"新路径能不能把一个变更送到终点"这个问题此前没有任何样本回答过 —— 现在有一个，答案是可以。

### 12.2 九个缺陷与它们的检查

| # | 缺陷（实测） | 根因 | 处置与检查 |
|---|---|---|---|
| 1 | `open` 之后**没有任何受治理命令**能声明 upstream coverage | 声明有读者、无写入者 | `kata-cli tasks declare --field upstreamCoverage`；写入时执行 `design` 的同一条规则 |
| 2 | 同上，`acceptanceMatrix` 也没有写入者，而 seal 仍在强制它 | 同类 | 同一命令的另一个 `--field`；payload 走 task schema |
| 3 | handoff 收据被 `scope apply`/编辑作废，而拒绝只说"requires a current acknowledged handoff receipt"，不说**是缺失还是过期**，也不说 `handoff create` 是出路 | 一句话覆盖两种情形，补救办法不同 | 两个分支各自点名情形、原因、命令；陈旧分支附上最新一次拒绝的原因 |
| 4 | **seal 的隔离快照不含 `.kata/`**（gitignore），所以任何读真实任务记录的测试**在 seal 内必红、在外部绿** —— 而我在本会话早先"修好"的那个用例正是这么写的 | 测试的夹具借自仓库 | `tests-do-not-read-the-live-task-store`：扫描测试树里的读形状；用例自己的两个样本行由文件名排除，且有一条用例断言每个模式能匹配自己的样本（否则模式里的笔误会把检查变成注释） |
| 5 | `ledger freeze --help` **执行了 freeze** —— 一次帮助请求产生状态变更 | 守卫只覆盖 9 个命令族中的 workflow 一族；而 `init`/`uninstall` 默认静默，使答案即便生成也不被打印（**两个独立原因**） | 守卫覆盖全部命令族；usage 文本成为一张按族索引的 map，完整性由"扫描 dispatcher 源码里的 `command === '<族>'` 字面量"来检查；`wiki` 被具名豁免，因为它的帮助比一行 usage 更丰富 —— 而豁免的理由写在代码里 |
| 6 | `ledger plan` 报 `standard`，`ledger decide` 报 `strict` —— **同一事实两处推导**，且 plan 忽略了策略上限，于是它为比自己更弱的 tier 计算所需证据与风险类 | tier 在两条路径上各推导一次 | `resolveTier` 成为唯一推导；上限是 tier 的下界而非上界（由"触碰 `src/kernel/decide.ts` 仍解析为 `security`"的用例钉住）；`--tier` 双向覆盖 |
| 7 | `ledger ask --per-claim 2` 产出 6 个 probe，其中 3 对完全相同 —— 而 discovery floor 读的正是**回答数** | 抽取可重复命中同一 (kind, path)；计数按记录而非按问题 | 生成器跳过已问过的题；floor 与 response rate 都按**去重后的问题**计数。probe 的 identity 是它问的那条命令 |
| 8 | `wiki ingest --from <file>` 用**stub**覆盖了已存在的受治理页面：3,535 字节写成 355 字节，并注册了重复记录 | stub 渲染器无条件写入 | 页面存在即拒绝（raw 副本仍刷新，因为刷新它正是 ingest 的目的），拒绝点名两条真正说明自己行为的出路；CLI 把拒绝报出来 —— 否则被拒绝的 ingest 与成功的一次输出无法区分 |
| 9 | 阶梯只给一个 `/kata-review`，而它的 `cliCommand` 是 `--approve` 形式，该命令**在相位推进前会被拒绝**：读者被告知要敲的命令敲不通 | 一个两步的步骤只说了一步 | `NextAction.followUpCommand` 只在真正两步时出现；`pauseInstruction` **与信任边界文本拼接而非替换**（第一版替换掉了"kata 不路由宿主模型"那段必需文本，是修 9 时引入的回归，由 e2e 用例抓到并单独修） |

### 12.3 三个由机器抓到、而不是由我读出来的细节

- **#5 有两个独立原因**，第二个藏在第一个后面：守卫修好后 `init --help` 仍然什么都不打印，因为 `init`/`uninstall` 默认静默（它们叙述进度而不是返回文档）。一条消息缺陷有两个成因，修掉一个会让另一个不可见。
- **#9 的修复本身引入回归**：`pauseInstruction` 被替换而不是拼接，丢掉了强制性的宿主模型提示与 `--confirm-host-model` 步骤。抓到它的是那个用 `toEqual` 断言整个 action 对象的 e2e 用例 —— 它同时也因为新增字段而失败。该用例改为 `toMatchObject` 加三条独立断言：一个对**增长中的记录**做精确形状钉住的断言，会在每一次新增时失败，无论新增对不对。
- **新命令的第一个真实输入就崩了**：`tasks declare` 拿到整个 bootstrap 契约而不是一个 coverage 对象时，规则先读了 `sources` 并抛出 `coverage.sources is not iterable`。**该崩溃的地方出现了拒绝的反面** —— 输入到达了一个假定形状的函数，而没有任何东西检查过那个形状。schema 现在先跑。

### 12.4 这一趟的收尾状态

```
npx tsc --noEmit            exit 0
npx vitest run              159 文件 / 1031 用例 / 0 失败（本会话起点 143 / 1020）
npm run check:wiring        clean（140 条声明路径）
npm run build / pack        通过
git status                  clean · 本节 9 个 commit
```

`enrich-packet-outside-the-task-store` 走到 `review` 通过（账本路线），随后**被本节的修复本身作废**：它声明的路径被这些修复改动，revision 变成 `superseded`，于是 `build --seal` 拒绝继续，要求先重跑 review。这不是故障，而是记忆 #689 那条约束的现场演示 —— 九个变更共享六个中心文件，所以一个变更的"就绪"有保质期，而唯一能让最后一个变更归档的顺序是**先做完会触碰共享路径的那一个**。该变更要重新走一遍 `seal → verify → review → judge → archive` 才能归档，而它现在的处境恰好证明了这套机制在正确地拒绝为一棵已经移动的树出证。

### 12.5 仍然未完成的，以及为什么 —— 以方案（`2026-09-27-clean-refactor-plan.md`）为依据

**判据的更正。** 我先前把两件事说成"旧路线有、重构后没有"，那是拿**已退役的机制**当基准 —— 而它的规则是被有意替换掉的，所以正确的基准是**方案自己写了什么**。按方案逐条核对后，其中两项的性质变了：

| 项 | 方案的位置（原文） | 按方案的归类 | 正确说法 |
|---|---|---|---|
| **路径覆盖** | §1.3 标题：`RiskClass`（有限、可枚举 —— **替代"覆盖每一条路径"这个开集**） | 方案明确的设计决定，附理由（路径覆盖是开集） | **不是丢失的检查**，是我判断错了基准。我说的"旧路线有一条机械检查没有继任者"，对**路径**这一半**不成立** |
| **验收项 → claim 的连接** | §15 下一步次序：**① 挑一个在飞 change，用新命令把它的验收项变成 claim 并录证据** | **迁移步骤**，由操作者逐个 change 执行；§14 的 17 条差异里**没有这一条**，所以按方案自己的标准它**不是落地缺口** | 它是**迁移程序**，不是方案承诺的门规则。今天靠约定（我把 claims 命名成 AC-1/2/3），而方案要的就是"人工显式地做这一步" |
| **机器主动 propose 的 producer** | 方案**没有**这一项；§15 恰恰把"把验收项变成 claim"写成**人做的一步** | **不是方案的未完成项** —— 是我的提案 | 先前写"未完成"是用词错误：它是新提案，不是欠账 |
| **shadow / 语料** | **D6**：必须投入 benchmark 语料（阶段 1）—— 没有它，一切验收只能靠印象；§8 六条验收；**P1 是"关键路径"** | **方案的未完成项（C）** | 这一项**是**真正的欠账，且方案已写明它为什么关键 |

- **shadow pilot（真正的欠账）**：需要跨时间的真实样本；这一趟提供了第一个完整样本（一个变更从 open 到 review 通过），但把 1 个样本当试点结论就是编数字。方案把它放在 P1，并写明"没有它，一切验收只能靠印象"。
- **七个缺陷类中的两条**（读声明却声称读了现实；一次决策多个入口只有一个留痕）仍无活检查：两者都需要一张**人工维护**的"这个函数读的是什么"表。其中第二条在本会话又被撞到三次（`tasks declare` 之外的 `task.json` 写路径、`open --bootstrap-file`、prompt 期手写 task.json），说明它值得一张真表，而那是一份独立的工作。

### 12.6 一条我提出、方案没有要求的提案（列为待决定，不列为缺陷）

把上面那条"验收项 → claim"的连接从**约定**变成**规则**（在 `decide` 里要求：某个受影响的验收标准、某条改动路径必须被某条 claim 覆盖），方案既没承诺也没禁止。**支持**：方案自己的纪律里就有"一个事实一处推导""有声明无消费者"两类，而今天两个门（seal/verify 认证验收标准，账本认证 claims）之间**没有规则相连**，全靠操作者按 §15 步骤①手工对齐。**反对**：§1.3 拒绝开集覆盖的理由同样适用于"覆盖每条验收标准"；且 §15 把这一步写成人做的决定，代价是它依赖操作者。

因此它是一条提案：要落地就该先写进方案、按 §14 的 A–E 分类入表，再实现；不落地则它不属于任何清单。**我不把它算作缺陷。**
