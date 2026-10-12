# 统一收口：剩余完整性与工作流缺口

**日期：** 2026-10-09  
**Change：** `unify-the-remaining-integrity-and-workflow-gaps`  
**状态：** 已确认，实施中

## 1. 目标与边界

本 change 合并仍未关闭的 Kata 缺陷及其审计来源，但不改写旧 task 的 revision、review、ledger 或 gate 记录；每个来源都以 `merged_into` 关系保留。实现、局部 falsifier 和全量测试全部完成后才进行一次 seal/Verify；之后独立审查轮严格串行。

本 change 修复五类共同根因：

1. **结果状态空间不完整**：claim-less 账本无法诚实声明零 coverage。
2. **阶段可达性与导航分离**：review 中内容移动后，CLI 指向自己会拒绝的命令。
3. **同一事实的多重派生**：agent 定义、输入事实、生命周期边和阅读绑定分别由多处拼装。
4. **记录身份不足**：review 记录、seal content map、关系转移和 unreadable 记录没有在消费点保持其来源与语义。
5. **拒绝后仍写入**：参数、任务创建、evidence 关系或其它持久化路径可以在拒绝后留下状态。

不在范围内：取消 revision binding、允许任意 phase 重封、将 claim-less request 视为无效、放宽 `all-phase-ledger-repair-admission` 的「只由 ledger deficit 进入 repair」规则、用新的 task 记录覆盖旧 task 的历史。

## 2. 已确认的门禁语义

用户确认采用 **A**：

- claim-less ledger 可把显式 `declaredCoverage: []` 写入 review result；它与省略该键不同。
- `review` phase 中，若存在 superseded 的历史封存且 `currentRevisionId` 为 `null`，可进入重封路径；重封后仍必须 Verify、Review、Judge，旧 review 不会被延寿。
- repair admission 与 navigation 共用可执行性派生，不能再给出同次调用会拒绝的命令。
- 不采用报告 B：`ledgerDeficitRepairAdmission` 对 `pass` / 无 deficit 的拒绝语义不放宽。

## 3. 实现切片与验收映射

### Slice A — review 结果、phase 重入与导航

**AC：** 1、2、4、5、6、13、14。

- 将 coverage 校验写成依赖 ledger claim 集合的真值表：有 claim 时空 coverage 拒绝；无 claim 时显式空 coverage 合法；未知 claim 始终拒绝；缺失 coverage 仍保留为缺失。
- 让 empty findings 在 claim-less ledger 上可由 `declaredCoverage: []` 表达，而非靠沉默绕过。
- 提取 `review` 修复重入的单一授权谓词：仅历史 revision superseded、无 current revision、且该路径确实需要新 seal 时为真；既有 current-bound review 和真实 ledger deficit 分支不变。
- navigation 只输出该谓词已证明可执行的 command；错误文本和 askUser 复用同一派生。
- review record 存储「round actually reviewed」的 identity，而不是记录时恰好 current 的 revision；recurrence 是报告并路由的 signal，不改变 gate 强度。
- severity、failing evidence 和 acceptance/finding boundary 从各自唯一 derivation 读取。

**RED 证据：** claim-less 空 coverage、empty finding、superseded/no-current re-seal、current-bound refusal、deficit repair、输出命令可执行性、跨 revision round identity。

### Slice B — 所有拒绝必须在写入前发生

**AC：** 7、8、11、12、17。

- CLI dispatch 统一解析并拒绝未知 flag；调用者不能因 positional parsing 或 helper scope 漏掉 reset。
- `usage set`、`evidence add` 和 task open 的所有验证在任何持久化前完成；失败不写 usage/evidence/task-directory。
- `evidence replace` 要么原子地重绑所有引用，要么具名拒绝，不留指向被替换证据的 claim。
- input-integrity fixtures 使用独立 root 与声明的 `.gitignore`，不读取 live checkout；payload/branch/reason 都由真实输入派生。

**RED 证据：** 每个拒绝后的磁盘快照相等；未知 flag、负 usage、无效 bootstrap、过期 evidence id、fixture 假输入分别触发且不写。

### Slice C — 一份生成源，而非 marker/副本协议

**AC：** 15、16。

- `.pi/agents/*.md` 从 adapter 的受管模板渲染；`kata-cli update` 通过 `platformAgentPath`、manifest ownership 和现有 conflict 规则写入。
- 生成文件只含平台 metadata、tools/extensions、已测 isolation boundary 和 skill 指针；协议文字仅在 skill renderer。
- agent-definition guard 比较磁盘与 renderer，解析 pointer 并验证可到达 skill；删除有限 marker word-list。
- 保持 provider 能力：生成 implementer/reviewer definition 不设置 `isolated: true`，因为该 host 选项会禁用 extensions。

**RED 证据：** 手改、同义改写、错误 pointer、未受管既有文件、path owner 及 live-checkout fixture 均被相应断言捕获。

### Slice D — 记录、关系、生命周期与回答语义

**AC：** 3、9、18、19、20、21。

- revision/relationship readers 保留 edge identity；不存在的 child revision 为 `undetermined`，不是不存在或已验证。
- transfer/revalidation 绑定 successor revision 和 impact packet；closure 仅由 evaluator 产出。
- retired answer、expected fact、gap claim id、request value 与事实层一致；无效/空值不再作为答案或 coverage。
- 所有嵌套 record reader 遵循 `absent | usable | unreadable`：只有 ENOENT 是 absent；parse/schema 失败永远具名 unreadable。
- policy/never-content/statement-in-subject 的保留行为在设计和测试中写明边界，不用缩窄断言掩盖。


- **R1-F1 / R2-F1 repair — tier/quorum 是同一个 declared-subject 的事实**：高风险路径即使本轮未改动，只要仍在 normalized declared paths 中，也必须同时抬高 plan、ReviewRequest 和最终 verdict；`changedPaths` 只用于确定 reviewer 的 focus，绝不能用来降低 gate tier。三处通过同一个 resolver 得到 classification、tier 与 reviewer quorum。显式 `--tier` 是可审计的请求：它可以把 tier 上调，却**不能**降低 complete declared surface 或 policy ceiling 的 floor；较低请求保留在 `tierOverride`，而实际 `plan.tier`、request 与 verdict 都报告提升后的 tier。request 会重算并拒绝不一致的 plan，而不是把弱合同交给 reviewer。

- **R2-F1（独立复核，major）— 一份 plan 只发布一个 classification**：`plan.tier` 已由完整声明面派生，但同级的 `plan.risk` 仍是 `classifyRisk({ paths: changedPaths })`（`src/producers/planner.ts:78`）。当本轮 diff 没碰某个仍在声明里的 high-floor 路径时，同一份 plan.json 会同时写出 `tier: security` 与 `risk.tier: standard / floor: low / matched: []`。这个字段是**读者面**：`kata-design` 的 lane 规则正是让操作者去看 `plan.risk` 的 `tier`/`floor`/`matched`（`src/adapters/phase-guidance.ts:112`），而 review mode 决定 merge-blocking severity 集合与是否要 matrix——所以「changed paths 只决定 focus」这句话当时是假的。**决定**：plan 不再自行分类；调用方把 `ledgerTierForDeclaredPaths` 已经算出的 `classification` 传进来（该 resolver 的返回值此前被丢弃），`changedPaths` 只保留给抽样审计 `sampling.promoted`。无 resolver 的 fixture 退化为对**它声明的**路径集分类，而不是对 diff 分类。
- **R2-F2（独立复核，minor）— 同一个 flag 在两个命令上必须给同一个答案**：`plan --tier garbage` 按名拒绝，而 `decide --tier garbage` 把拼写直接交给 `resolveTier`，未知名字没有 rank，于是「要求提高档位」被静默丢弃且命令以 0 退出。**决定**：两个命令都问同一个 `tierOverrideFromPlan`；拒绝语句同时点出**操作者给的值**与**policy 自己声明的词表**（从 `Object.keys(policy.tiers)` 派生，不写第二份清单），并且不再声称这个值来自「stored plan」——因为操作者可能是敲了一个 flag。

- **R3d-F1（独立复核，major）— tier 必须读「声明的内容集合」，不是声明的**拼写**：`ledgerTierForDeclaredPaths` 之前把 `ownedPaths` **原样**交给 `classifyRisk`（`src/store/verdict.ts:214` 调 `declaredPaths`，后者在 `src/store/ledger.ts:1797` 直接返回 `ownedPaths`），而 subject 与 `plan.contentPaths` 用的是**规范化并展开目录**的 `declaredContentPaths`（`src/core/repository-identity.ts:391`，`src/cli/ledger.ts:1263`）。实测（scratch root 声明目录 `src/kernel`）：`freeze` 记下 `src/kernel/decide.ts` 与 `src/kernel/policy.ts`（策略里都是 `high`），而 `plan` 却发布 `tier: strict, reviewers: 1, risk.tier: standard, matched: []` ⇒ 一个 security-floor 的变更被按 strict 门禁，**双 reviewer quorum 永不触发**；`./src/kernel/decide.ts` 这种非规范拼写同形。这也说明 R2-F1 的修复把 `plan.risk` 接到了同一个**错误**来源上——两边现在「一致地偏低」。**决定**：resolver 改问那个唯一的内容枚举 `declaredContentPaths`（freeze 路径问的同一个函数），`input.paths` 仍保留给测试注入。**边界**：这条只声明「tier 读哪个路径集合」，不声明策略的 path floor 模式表是否完整。
- **R3d-F2（独立复核，note）— planner 自己的回退不能是 diff**：`planReview` 的 `input.contentPaths ?? input.changedPaths` 让「只传 diff」的调用者拿回 R2-F1 的形态，而参数注释写的正是相反的话。**决定**：回退改为 `contentPaths ?? []`——没有声明集合时得到空分类，而不是 diff 分类；`changedPaths` 只作用于 reviewer focus 与抽样审计。现有 4 个 fixture 只传 diff，实测它们不断言 `risk`，套件仍全绿。

- **R4-F1（独立复核，blocking）— 「没有旁路分支」才叫一处派生**：R3d-F1 的修复只规范化了 `input.paths` **缺失**的那一支（`input.paths ?? (await declaredContentPaths(...)).paths`），而**生产调用点** `src/store/review-request.ts:130` 恰恰把原始声明当 `paths` 传进来，于是同一份声明在 request 侧答 `strict`、在 plan 侧答 `security`，`buildReviewRequest` 因此拒绝，而它给出的补救（「重跑 `ledger plan`」）改变不了任何结果。这是 R3d-F1 命名的同一类缺陷**落在修复自身的另一个调用点**上，且无测试覆盖（request 的 fixture 只声明文件，从不声明目录）。**决定**：`input.paths` 也一律过同一个规范化——对已规范的集合是恒等，对目录 / `./` 拼写就是 subject 会记录的那个展开；**没有任何调用点能绕过**。新增用例覆盖 request 侧的目录声明形状。

- **R5-F1（独立复核，major，`one-fact-derived-twice`）— 只取 `.paths` 会把「被点名的路径」从分类面上抹掉**：`declaredContentPaths` 同时回答两件事（**覆盖了哪些内容** `.paths`、**哪些声明读不到** `.unreadable`），而 R4-F1 的修复只取了 `.paths`。于是**声明里已删除的高 floor 路径静默消失**：`freeze` 与 `plan` 对同一份声明**按名拒绝**，而 `ledger decide` 却发布 policy ceiling —— `tier: strict`、**1 个复核者**，而不是 security floor 的 **2 个**；在本次规范化存在之前，原始拼写仍能匹配 `src/kernel/**`，所以**这是修复引入的降档**。**决定**：分类面 = **声明点名 ∪ 覆盖内容**（`new Set([...declared, ...covered.paths])`）。这个并集**只可能抬高**档位：策略不认识的拼写贡献零匹配，读不到的拼写贡献它自己隐含的 floor —— 也正是操作者仍以为变更携带的那条路径。新增用例：声明的高 floor 路径删除后，tier 必须仍是 `security`。
- **R5-F2（独立复核，minor，`contract-semantics`）— 拒绝必须是值，不是异常**：让 `input.paths` 也过规范化，使这条调用能触到 `declaredContentPaths` 规范器**对越界声明抛错**的路径，而 `buildReviewRequest` 没有包裹它 ⇒ `ledger run` / `ledger request-check` 从「返回具名拒绝」退化成**抛错出命令**（被 `src/cli.ts:507` 的裸处理器打到 stderr，无 `{ok:false}` 信封）。**决定**：包上并返回具名拒绝（原因里带原始消息，含那条路径）。新增用例：声明 `../outside.ts` 时 `buildReviewRequest` 返回 `ok:false` 且 `why` 含该路径。
- **R5-F3（独立复核，note）— 具名派生被就地重写 3 处**：`declaredSubjectRevision`（`src/store/ledger.ts:1002`）自己的注释写着「每个新鲜度问题都问这个函数」，而 `verdict.ts:147`、`verdict.ts:466`、`review-request.ts:243` 三处把 `subjectAsDeclared?.revision ?? subject.revision` 又写了一遍。**决定**：四处都问具名函数。**边界**：独立复核对三处**构造不出分歧**，所以这条是「重复」而非现行缺陷。
- **类级守卫（本轮按「类优先」而非「实例优先」加的）**：新增 `tests/unit/every-consumer-of-the-declared-surface-says-what-it-does-with-unreadable.test.ts` —— 它**枚举 `src/` 下每一个调用 `declaredContentPaths` 的模块**，要求每个都在一张记录表里给出「它拿 `.unreadable` 怎么办」（`refuses-on-unreadable` / `classifies-the-union` / `paths-only`）与非空理由；**新增读者会被打红**，直到它回答这个问题。它只做清单与理由，**行为**由各自的用例钉（resolver 在 `one-tier-derivation.test.ts`、request 侧在 `review-request-preserves-its-named-facts.test.ts`、freeze 的拒绝在账本自己的用例）。实测该守卫**非空**：从表里删掉一个消费者 ⇒ 立刻打红。这也是独立复核 `classClosed.note` 点出的「重新打开此类的条件：任何保留 `.paths` 而另一消费者按 `.unreadable` 拒绝的读者」的机械化。
- **R4-F2（独立复核，major，`instrument-unsound`）— 「变异真的落上」还不够，还要「变异后源码仍然可解析」**：声明里的 E13 其 `find` 只覆盖多行调用的**首行**，`replace` 却是整个调用，`String.replace` 之后原参数行残留 ⇒ `src/cli/ledger.ts` 语法错误（esbuild: `Expected ";" but found ":"`）⇒ 测试文件加载失败而「变红」，红的原因与它命名的性质无关，却被 `ledger evidence verify` 记为 `supported`（before 0 / mutated 1 / after 0）。C-13 把 E13 当作一半证据，这一半什么都没测。**决定**：① 把 E13 的 `find` 改成**整个调用表达式**（实测唯一匹配），并实测该变异的源码可解析、红在它命名的断言上；② 本 change 的变异自审脚本在采信读数前**先解析变异文本**；③ 我**逐个解析了本 change 声明中的 18 条 falsifier 的变异文本**，除已修的 E13 外无一不可解析。**边界（写清，不假装）**：机制侧仍**没有**解析守卫——`locateAnchor` 只拒绝「锚点缺失/歧义」，`src/producers/verifiers.ts` 应用变异时不解析结果，所以「变异把文件改坏」依旧会被记成红。这条是**证据验证机制**的属性，属 I-10 那一族（封存时重验锚点），其设计文档已写好；本 change 只保证**自己声明的 18 条**不再有该形状。
- **R4-F3（独立复核，note）— 两处「同一 walk 的两个包装」**：subject 的集合来自 `computePathDigests` → `feedOwnedTree`，resolver 的集合来自 `declaredContentPaths`；两者当前相等**只因都委派给 `listRepositoryFiles`**（独立复核对七种声明形态实测相等：目录 / 文件 / `./` 前缀 / 被 git 忽略的目录 / 被 git 忽略的文件 / 尾斜杠 / 不存在）。**决定**：不假装它们是同一个函数——把 resolver 的注释改成「实测相等、但单侧改动 walk 就会重开这个缺陷」，并记录为潜在结构重复而非现行缺陷。
**RED 证据：** 伪造 parent/child、缺 revision、迁移后 stale impact、空事实/错误 id、嵌套 malformed JSON 各有最小失败测试。

### Slice E — seal 内容确实属于该 declaration

**AC：** 22、23，加上 migrated caches R13-F1–F3。

- `freezeSubject` / 最终写入门验证 seal map 不只是「曾由某次 seal 产生」，而是**当前 normalized declared paths**产生的那一份 map；完整 declaration 不得接受 sealed subset map。
- `WeakSet` module-private provenance、冻结和 null-prototype 仍用于防止未经 enforcer 修改的伪造；最终 write gate 也重复 identity/declaration 验证。
- C2/C4 和 tests 只声称机制实际保证的边界：有限 fixture 是 witness，不是「所有种类」的完备证明；修改 trusted enforcer 或共享 traversal 是声明的边界，不能被假装成 guard 自证。

**RED 证据：** X14（完整声明 + subset sealed map substitution）拒绝且不写；合法 map 成功；命名 boundary 的 mutation 要么被对应 witness 捕获，要么显式落在设计边界外。

### Slice F — 声明与守卫的诚实边界（AC-22）

**AC-22 的边界是在两处写下来的，而它是这个 change 自己的主题在它自己身上的一次应用**：一个声称「保证」的机制，必须说清它保证到哪。

- **强制的是「一处派生 + 运行时拒绝」**：ledger 记录的是 seal 返回的那个 map，而不是自己重新派生的一份；拒绝发生在运行时，且**不看**它拦的是哪一类分歧 —— 它**不枚举**，所以「没人写过 fixture 的扩展名」被拦下的方式与「写过 fixture 的那一类」完全相同。冻结 + 模块私有 WeakSet 身份登记使就地过滤在写入处抛错、复制件失去登记。
- **不强制「遍历完整性」**：有限生成器只是**见证**（representative kinds：扩展名、命名形状、嵌套、点文件、空文件与边界大小文件）。生成器没覆盖的种类是**保证上的洞**，不是通过的用例。声称「所有种类都被覆盖」是夸大；诚实的说法是「一处派生、运行时拒绝、代表性种类见证」。

这条边界同时决定了这**不是**一次数字守卫的升级：前三轮各加一张名单（`.rs`、`.pyc`、语句形状），每张都被名单之外的种类绕过 —— 而种类无界，所以任何名单都注定失败。真正承重的是「不许第二次派生」这条结构性规则，与「拒绝发生在不知道种类的情况下」这一运行时事实。

### A-4 不在这个 change 里（实测）

A-4（队列 D-1，用户 2026-10-10 选定甲）**不能**作为一个 AC 加进来：`kata-cli tasks declare` 只写
`upstreamCoverage` 与 `acceptanceMatrix`，并明确拒绝改写验收契约 ——

```
$ kata-cli tasks declare --change unify-... --field acceptance --file <json> --reason probe
Unknown declaration field 'acceptance'; this command writes upstreamCoverage or acceptanceMatrix.
A task's acceptance criteria are its contract and are not rewritten here.
```

所以它按**独立 change** 走（`a-removed-name-is-not-an-undeclared-change`，设计见
`docs/design/2026-10-10-a-removed-name-is-not-an-undeclared-change.md`）。本 change 的 23 条 AC 不动。

## 4. 依赖顺序

A 先建立可表达、可重入的 review 状态；B 阻止失败遗留伪状态；C 消除协议复制；D 统一读取与 transfer 语义；E 最后保护 seal/map 消费点。它们共享部分文件，因此在一个 checkout 中串行实现；每个 slice 内先写最小 RED test、观察预期失败，再做最小 GREEN 实现与定向回归。

所有 slice 完成后：全量测试、TypeScript、falsifier 单点 mutation、自检声明面、只暂存本 change 路径、单次 seal/Verify/ledger。未完成任何 slice 前不得 seal 或发起独立 review。

## 5. 来源与审计

- `docs/superpowers/reports/2026-10-09-review-result-cannot-declare-empty-coverage.md`
- `docs/superpowers/reports/2026-10-09-review-phase-content-move-is-unrecoverable.md`
- `a-declared-directory-excludes-its-build-output` R13（原结果保存在 `tmp/dd-review-result-r13.json`）
- 已 `merged_into` 的 one-source、gate-input-integrity、change-lifecycle-reconciliation、finish-the-retired-answer-semantics、publish-every-unreadable-record，以及八个仅缺当前认证的旧 task。
- A-4（队列 D-1）按独立 change 走，见上面的说明。

关系保留旧工件；本设计不把缺失证书伪造成新的代码 defect，也不以 consolidated review 声称重写旧 revision 的审计结论。
