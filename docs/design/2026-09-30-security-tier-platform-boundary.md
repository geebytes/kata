# Security 档与宿主平台隔离边界

> 状态：待开 governed change 的设计输入
> 日期：2026-09-30
> 决策人：用户
> 上游：`docs/design/2026-09-29-executor-capability-properties.md`（已停止方案）、`docs/review2.md`、`docs/design/2026-09-29-verdict-readings-per-run.md`

## 1. 决策

Kata 不实现、探测或要求本地 `sandboxed` 执行器。运行证据命令的文件系统、网络、凭据与进程隔离是宿主 Agent 平台的风险边界；Kata 不对 OS、容器、CI 供应商或平台安全模型建立第二套机制。

保留 `security` 档。它继续表示“修改质量门自身的高风险 change”，并保留：

- 两名独立审阅者与 always quorum；
- `privilege`、`provenance` 连同已有风险类的覆盖；
- `same_actor`、分歧与不可读记录的 fail-closed 决策；
- `high` 风险地板对 `policy.ts`、`decide.ts`、`risk.ts` 的路径区分。

唯一移除的是 Kata 对本地执行过程隔离的 assurance 要求：`security.assuranceFloor` 改为 `observed`。

## 2. 根因与边界

此前 `security.assuranceFloor = sandboxed`，但 Kata 只有 `inline`（`observed`）与 `file`（`relayed`）适配器。于是任一触及内核门代码的 change 都会被提升到 `security`，却无法满足一个没有实现者的 assurance floor。

本地 sandbox 的确能降低执行任意测试、构建脚本或证据命令时的宿主风险；但这不是 Kata 需要重复承担的职责。宿主 Agent 平台已经决定命令在哪个权限模型、工作区与网络策略下运行。让 Kata 再通过 bwrap、Docker 或 OS 侦测实现一次，会：

1. 把是否可批准内核改动绑定到某个 OS、守护进程或容器镜像；
2. 让平台已经提供的风险控制变成两套可能不一致的政策；
3. 把 `security` 从高风险审阅门变成不可达的执行环境门。

Kata 的可验证职责止于：代码和声明面、可执行证据、审阅者独立性、读数来源、风险覆盖、以及决策记录。平台运行时隔离不进入 Kata 的 ledger，也不以一条可伪造的 adapter 字段替代平台能力。

## 3. 目标与非目标

### 目标

1. `security` change 在满足其审阅、quorum 与风险覆盖要求后，可由现有 `inline`/`observed` 证据通过 assurance 判断。
2. `security` 的额外审阅和风险语义完整保留；删除 assurance 地板不得将 `high` 降为 `strict`，也不得降低 review 计数。
3. 新写入的 policy、ledger usage、verdict 或 CLI 输出不再把 `sandboxed` 作为 Kata 可提供或可要求的机制。
4. 历史 artefact 含有 `sandboxed` 时仍可读取、报告并用于审计，而不是因词汇退休变成不可读。
5. 文档明确宿主平台负责执行隔离，Kata 不探测 OS、容器或平台安全能力。

### 非目标

- 不声明所有宿主平台都提供同一种隔离强度；平台风险隔离是部署/运行政策，不是 Kata 的可证明 claim。
- 不新增 host adapter、attestation、CI 集成、bwrap、Docker 或 `process.platform` 分支。
- 不削弱 revision 绑定、workspace/scope 检查、独立审阅、quorum、挑战、风险覆盖或 fail-closed artefact 读取。
- 不把 `signed` 解释为本地 sandbox 的替代；签名/外部见证是另一条信任边界。

## 4. 设计

### 4.1 保留 security，替换其 assurance floor

`policy.ts` 的 `security.assuranceFloor` 由 `sandboxed` 改为 `observed`。`high → security` 的风险路径映射不变；`security.reviewers = 2`、`quorumOn = always`、`privilege` 与 `provenance` 的要求不变。

因此差异仅是：Kata 不再为“证据命令在哪个 OS sandbox 中执行”作出或验证声明。它仍要求“两个独立 actor 的读数存在、证据与 claim 覆盖门代码真正触及的风险、读数和记录可读”。

### 4.2 退休 sandboxed 的写侧语义，兼容历史读侧

`sandboxed` 不再是 Kata 的当前 assurance floor，也不再由任何 adapter、executor 或 CLI 选项写入。

历史 artefact 若携带该值，读取器必须继续接受并原样报告它，避免对已封存证据作回写或把它误判为损坏；但当前 policy 不再依赖它获得批准。新 policy/schema 的写侧枚举不得新增该值。

这把“删除运行机制”与“抹去审计历史”分开：前者是本 change 的目标，后者不是。

### 4.3 平台边界的文档契约

CLI/ledger 的用户可见文本必须说明：`observed` 表示 Kata 在宿主提供的运行环境中执行并观察到结果；Kata 不代表平台的网络、文件系统或凭据隔离能力作保证。需要更强运行时隔离的部署由平台配置、组织 CI 或执行环境政策承担。

不得以“平台应该隔离”作为 Kata 内部任何 gate 的 pass 条件，因为 Kata 没有通用、可信且不耦合平台的方式验证这句话。

### 4.4 一次性的自指迁移

该政策变更自身触及 `policy.ts`/`types.ts`，在旧 policy 下属于 `security`，并被退休中的 `sandboxed` floor 阻塞。它不能靠伪造一条 sandbox evidence 通过旧门。

迁移采用显式、一次性的人工政策授权：记录“用平台边界替换本地 floor”的理由、决策人、影响面和旧门无法在 Kata 内满足的事实。该授权只用于这次政策迁移；新 policy 落地后，后续 `security` change 仍必须通过 `observed`、双审阅、always quorum 与风险覆盖，不能继承该例外。

## 5. 验收标准草案

- **AC-1**：`security` policy 的 assurance floor 是 `observed`；一个 `observed` 账本不再产生 `assurance_below_tier`，但 `relayed` 仍然产生该理由。
- **AC-2**：触及 `high` 路径仍得到 `security`，并且 security 的 reviewer 数、always quorum、`privilege` 与 `provenance` 要求与变更前相同。
- **AC-3**：当前写侧没有 adapter、executor、CLI 选项、policy floor 或新 schema 输出把 `sandboxed` 当作可获得的 Kata assurance。
- **AC-4**：含历史 `sandboxed` assurance 的 artefact 仍能被读取和报告；读取过程不回写、更不把 artefact 判为 unreadable。
- **AC-5**：面向操作员的 assurance 文案明确平台负责执行隔离，Kata 的 `observed` 不声称网络、文件系统或凭据隔离。
- **AC-6**：本次人工政策迁移记录绑定到当前 revision；删除该记录或把 floor 改回 `sandboxed` 时，迁移验收变红。

## 6. 预期影响面

初步：`src/kernel/policy.ts`、`src/kernel/types.ts`、policy/review schema、ledger/CLI assurance 输出与对应单元测试、`docs/review2.md`、本设计文档。实际 ownedPaths 由开 change 后的 CodeGraph/测试定位确定。


## 7. 验证策略

每个 AC 各有独立 selector。重点负向变异：把 security floor 还原为 `sandboxed`、把 `high` 映射降为 `strict`、删去任一 security 附加要求、让旧 artefact 被 schema 拒绝、以及删除平台边界文案。全套测试与 `tsc --noEmit` 是最终证据；本次迁移的人工政策记录不能被测试冒充为 ledger pass。

## 8. Migration record

- Change: `security-tier-platform-boundary`
- Decision: user authorization
- Previous floor: `sandboxed`
- New floor: `observed`
- Scope: Kata retires its local execution-isolation claim; the host platform owns network, filesystem, process and credential isolation.
- Binding: this document is an owned path and is sealed with the policy change; deleting this record changes the revision surface.
- Limit: this authorization does not authorize any later change. Later `security` changes must satisfy the new `observed` floor plus the retained two-reader, always-quorum and risk-coverage requirements.

## 9. 审阅节点 I/O 修复（R-3/R-4）

`security-tier-platform-boundary` 的审阅修复确认：节点契约不能只渲染为 skill 文案，必须由 CLI 的真实读写面兑现。`kata-cli ledger run --out <path>` 将冻结计划派生出的 `ReviewRequest` 写入工作区内的指定路径；路径逃离工作区时拒绝。

read-only subagent 只接收该 request 文件，并返回 `{ "findings": [...] }` 的结构化结果。调用 skill 通过 `kata-cli review --result-file <path>` 记录结果：CLI 校验每个 finding 的 schema、把结果绑定到当前 revision，并以 `pending` 写入 `review.json`。结果记录与 `--approve` 是两个步骤，不能在同一调用中混合。

这一链路不记录或依赖平台、session、model、工具集，也没有 standalone `pi -p`、`nohup`、`setsid` 的 fallback。无法产出 request 或结果文件时，审阅拒绝而非退化为作者 brief 或手写审计状态。

## 10. 独立审查 F-1…F-9 修复

独立审查否证了第 9 节的修复：它加了"记录路径"，却没让记录能区分"审阅无发现"和"子代理没产出"；另外两条 AC 的证据只断言了源码文本。

| 发现 | 严重度 | 修复 | 可失败的证据 |
|---|---|---|---|
| F-1 迁移记录无自己的可失败证据 | blocking | 改为写盘再读回策略，并断言 floor 与 `meetsAssuranceFloor` 的判定 | `security-policy-transition-record.test.ts`；把 security floor 改回 `sandboxed` 时本文件变红 |
| F-2 两条 AC 只断言源码字符串 | major | `retired-assurance-cannot-authorize` 改为驱动审批面；`sandboxed-retirement` 改为用一个历史 `sandboxed` artefact 走 `validateArtefact` | 删除守卫分支变红；收窄 review schema 的 enum 变红 |
| F-3 不可解析的 `usage.json` 被默认值覆盖 | major | 三态读 `absent｜unreadable｜usable`，仅 ENOENT 算缺失，损坏则拒绝并具名 | `unreadable-usage-record.test.ts`；恢复"不可解析即默认"变红 |
| F-4 空 `findings: []` 被当作已记录结果 | major | 空集只有显式 `declaredCoverage` 才接受；任何同 revision 记录都阻断第二次记录 | `review-cli-io.test.ts`；去掉空集守卫变红 |
| F-5 `--result-file` 畸形值静默退化 | minor | 取值为另一 flag 或缺失时按畸形处理并具名失败 | 同上；恢复 `argValue` 的旧行为变红 |
| F-6 `quorumOn` 有声明无消费者 | note | 抽出 `quorumOnHolds` 与条件词汇表，`decide` 真正求值，未知条件在 `loadPolicy` 阶段具名拒绝 | `quorum-conditions-decide.test.ts`；让该函数恒真变红 |
| F-7 围栏只做字符串判断 | minor | `containedPath` 增加 realpath 级校验（不存在的路径经最近存在的祖先解析）；`ledger run --out` 与 `review --result-file` 共用同一条 | `review-cli-io.test.ts` 的符号链接用例；退回字符串围栏变红 |
| F-8 `kata-verify` 契约与自身 inputs/outputs 讲两套 I/O | note | 契约改为"命令 → 产物"的形式，并补上 `ledger run` 作为输出 | `node-contract-declares-io-and-interaction.test.ts` |
| F-9 渲染文本给出无消费者的 `--expect`；interaction 渲染成 `<boundary>` 占位 | note | `--expect` 改为真实读取的 `--fails-on`；interaction 的 boundary 从 `GATE_CREATED_BY` 读取真实取值 | 新用例断言渲染文本含全部四个 boundary 且不含占位符；退回占位符变红 |

**F-2 顺带量到两件事，都记在此处。**

1. **`policy.ledgerTierCeiling: 'strict'` 使第 9 节下游的退役值守卫不可达**：ledger 路径永不判到 `strict` 以下，而 `--tier` 覆盖只存在于 `ledger decide`，不在 `review --approve`。所以退役值总被更早的 `assurance_below_tier` 拦下，守卫是防御性代码而非承载结论的代码。`retired-assurance-cannot-authorize.test.ts` 把这两件事分开断言，未来若下调 ceiling 或扩展覆盖，该用例会变红并让守卫获得所有者。
2. **`sandboxed` 的排位必须保留**：历史记录仍要按 `ASSURANCE_RANK` 比较，而正是这个排位让一个无人能产生的值满足过 tier 的 floor。所以修复落在 `meetsAssuranceFloor` 的"必须是当前 write set 的值"，而不是改排位。

## 11. 第三轮独立审查 G-1…G-7 修复

这一轮的价值在于：审查的第一条**直接否证了第 10 节的修复**，而且是死锁。

| 发现 | 严重度 | 修复 | 可失败的证据 |
|---|---|---|---|
| G-1 enter-review 写下的占位记录阻断了所有后续 `--result-file` | blocking | 占位记录（无 `reviewRoute`）不再算"已记录结果"；同时把占位记录本身绑定到 revision（见下） | `review-cli-io.test.ts`；把守卫改回"任何记录都阻断"即变红。**这条用例第一次是假绿的**：fixture 没 seal，占位记录不绑定，守卫根本不会触发——变异验证抓到了 |
| G-2 悬挂符号链接可穿透围栏 | major | 围栏逐段 `lstat`，**不跟随符号链接**（`existsSync` 会跟随，对悬挂链接返回 false） | 删除 `isSymbolicLink` 判定即变红 |
| G-3 `declaredCoverage` 既不校验也不落盘 | major | 必须命名 ledger 中真实存在的 claim id，并写入 review.json；review schema 增加该字段（有写者必须有读者） | 去掉校验/落盘即变红 |
| G-4 请求指向的不是受审内容 | major | `buildReviewRequest` 用**当前内容**重算 subject 并比对，不一致就拒绝并具名；再由 seal 是否可读兜底 | 去掉漂移检查即变红 |
| G-5 `--result-file=path` 拼写被当作缺省 | minor | `flagValue`/`flagPresent` 同时接受 `--flag value` 与 `--flag=value` | 断言两种拼写等价 |
| G-6 被拒的策略写入已改动 claims.json | minor | 先 `writePolicy`（并把 store 的拒绝转成结构化 `ok:false`），成功后才写 floor claims | 恢复原顺序即变红 |
| G-7 "绑定到本 revision" 只有字符串匹配 | note | 增加断言：记录文档必须在 sealed revision 的 `ownedPaths` 内 | 从声明里移除该文档即变红 |

**两次量到的同一类事实，记在此处。**

1. **G-1 的根因比表面深一层。** 我最初的修复是在守卫处加"占位/结果"区分；变异验证显示它恒绿——因为 enter-review 写下的记录**完全没有绑定字段**（探针实测：`{"findings": [], "status": "pending"}`，无 `revisionId`/`manifestHash`），所以它本来就不绑定、守卫本来就不会命中。真正缺的是：占位记录也应当绑定，否则"为某个 revision 进入 review"在内容变更后仍是 `pending` 且未绑定——正是绑定要抓的那个状态。现在的修复同时做了两件事，并有用例断言 fixture 自身的前置条件（占位确实绑定），避免再次出现"用例绿在一条永不触发的路径上"。
2. **`freezeSubject` 的 `rev:` 与 seal 的 `revision-` 是两个派生**，`contentDigests` 只记录"封存时变动的路径"。所以"subject 与 sealed revision 是否一致"只能靠**当前内容**重算来回答 —— 这与 `ledger plan` / `ledger status` 已有的漂移测量是同一条，三处因此不会给出不同答案。

## 12. 围栏语义与第四轮审查 F-1…F-8

第四轮独立审查否证了第 11 节的两处修复（F-1、F-3 都是我引入的回归），并指出 F-1 与 F-7 是**同一个判定的两侧**：只修一侧必然再破另一侧。所以先把语义定下来，再改代码。

### 12.1 围栏回答什么问题

`containedPath(root, relativePath)` 回答的是：**这次读写最终落在哪里，而那个位置是否在工作区真实根之下。** 它不回答"这个拼写里有没有符号链接"——那是实现细节，不是语义。据此：

- **解析真实位置**：对路径的每一段，能 `realpath` 的就解析（对不存在的尾部段，沿最近存在的祖先解析）。**不因路径分量是符号链接而拒绝**，只要解析后的真实位置在工作区内（修 F-7）。
- **两侧同尺度比较**：解析后的位置与 `realpathSync(root)` 比较，而不是用未解析的 `probe` 去比已解析的根——否则工作区根自身含符号链接分量时，**所有已存在的合法路径都会被误拒**，而尚不存在的路径反而通过：围栏结果取决于文件是否已存在（修 F-1）。
- **指向区外的符号链接一律拒绝**：解析之后仍在区外就拒（G-2 的安全性保留）。
- **悬挂符号链接拒绝**：目标不存在时无法证明它落在区内，而 `writeFile` 会跟随它创建区外文件。这是唯一按"分量是不是链接"拒绝的情形，理由是**无法解析**而非"它是链接"。

一句话：**按解析后的位置判断，只有无法解析的位置才按拼写拒绝。**

### 12.2 两处推导必须合并

F-3：占位记录的判定出现在两处且互相矛盾——结果面用 `reviewRoute===undefined && findings 空 && 无 declaredCoverage`，enter-review 用 `findings 空`。对已落盘的"空 findings + declaredCoverage + reviewRoute"，再进一次 review 会把它改写成占位，于是 `--result-file` 不再被拦。修法是**一个判定函数、两处调用**，且 enter-review 的覆盖条件必须与之一致：占位可以被新的占位替换，**结果不能被无声降级**。

### 12.3 请求与结果的绑定必须同源

F-2：`buildReviewRequest` 只校验"subject 与当前内容一致"和"存在 seal"，从未比较**密封 revision 的内容**。所以"冻结→seal→改文件→再 freeze→run"能产出 `subjectRevision=rev:B`，而结果绑定来自 `currentRevisionIdentity`，仍是 revA。修法：请求生成时一并读取密封 revision 并断言其内容与当前内容一致（`revisionIsCurrent` 语义），不一致就拒绝并具名。

### 12.4 第 12 节的落地结果

| 发现 | 严重度 | 修复 | 变异验证 |
|---|---|---|---|
| F-1 工作区根含符号链接分量时**已存在**的合法路径一律被拒 | major（我引入的回归） | 逐段解析后与 `realpathSync(root)` **同尺度**比较（`insideWorkspace` 一处） | 退回"用未解析 probe 比已解析根"→ 变红 |
| F-7 工作区内合法符号链接也被拒（读静默失败、mutation 还原写抛错） | minor | 只按**解析后的落点**判定；仅悬挂链接按拼写拒绝（无法解析） | 退回"一律拒绝链接"→ 变红 |
| F-3 占位判定两处推导且矛盾 | major（我引入的回归） | 抽出 `isReviewPlaceholder`，结果面与 enter-review 写面**同一个函数** | 把写面改回"findings 为空即覆盖"→ 变红 |
| F-2 请求与结果绑定来自两个事实 | major | 请求生成时一并读密封 revision 的 `revisionStatus`，非 current 即拒绝并具名 | 去掉该检查 → 变红 |
| F-4 C-6 证据在被评估环境里恒真 | blocking | 证据改为"记录的声明 + 判决层在同一 run 内拒绝该值"，**不依赖 `.kata/`** | 把 security floor 改回 `sandboxed` → 本文件变红 |
| F-5 `--out=` 被识别为已给却按未给拒绝 | minor | `argValue`（共享读取器）同时接受两种拼写，所有 flag 受益 | 退回只认空格形式 → 变红 |
| F-6 `declaredCoverage` 只在空 findings 路径校验/落盘 | minor | 校验与落盘移出空集分支：只要声明就校验、就保留 | 非空 findings + 虚构 claim 现在被拒 |
| F-8 死导入 | note | `basename`/`dirname` 移除 | tsc |

**这一刻的教训（第五次同类）**：F-1 与 F-7 是同一判定的两侧，单独修一侧必然破另一侧——所以本轮先写 §12.1 的语义，再改代码；而 F-4 我连续三版都没有做出"在被评估环境里可失败"的证据（常量比较 → 恒真的 digest 断言 → 依赖 `.kata/` 的断言），第四次才落在"记录声明 + 判决层拒绝"这条与环境无关的耦合上。**可失败的证据必须在你实际评估它的那个环境里可失败**——这与"断言必须能红"是同一条，只是把"哪里"也纳入了条件。

## 13. 第五轮独立审查 R5-1…R5-8

第五轮**未能否证围栏的安全性**：审查者用 120 组符号链接拓扑、1932 次"接受即真实写入并全域扫描"的模糊测试得 **0 次逃逸**；`root` 自身含链接分量、F-2 的第三种状态、F-3 的两侧调用、F-4 的环境无关性、F-6 的两条路径、F-8 的 `tsc` 也都被逐条证伪失败。它找到的是**过严**和**覆盖面被高估**：

| 发现 | 严重度 | 修复 | 变异验证 |
|---|---|---|---|
| R5-1 落点**恰为工作区根**的链接被拒（`relative(root,root)===''` 被读成区外）——本轮新语义自己引入 | minor | `insideWorkspace` 认定"根在根内" | 退回把空串当区外 → 变红 |
| R5-2 拒绝文案把 `RevisionStatus` 渲染成 `[object Object]`，且对 `declaration-moved` 硬编码"内容变了" | minor | 按状态判别分开措辞，并断言两个事实 | 退回对象插值 → 变红 |
| R5-3 §12.4 声称"两种拼写对所有 flag 一次解决"，实际只进了 `argValue`；`--root=`/`--change=`/`--review-evidence=`/`--reviewed-path=` 仍单拼写（`--root=` 属 fail-open，静默用错工作区） | minor | 规则移到共享读取器（`inlineValue` + `VALUE_FLAGS`），其余读取器改为调用它 | 退回单拼写 → 变红 |
| R5-4 C-6 的"bound to this revision"半句无可失败证据（从 task 声明里删掉文档，四个用例全绿） | minor | 证据改为断言 seal 副本**确实携带**的受跟踪表面（用 `listRepositoryFiles` 实测：`.kata/` 不在副本、本文档在） | 改写 §8 的 Binding 行 → 变红 |
| R5-5 相对悬挂链接被拒（落点其实可判） | note | 记录为 F-7 语义的已知取舍 | — |
| R5-6 `try` 内任何异常都无条件把记录覆盖成占位（对不可解析的 `review.json` 是 fail-open 覆写） | note | 只在非 ENOENT 时拒绝并保留原字节；"尚无记录"仍正常进入 | 退回无条件覆写 → 变红 |
| R5-7 第三处仍按 `findings.length` 推导"这是不是已记录轮次"（归档判据） | note | 改为调用同一个 `isReviewPlaceholder` | — |
| R5-8 `argValue` 与 `flagValue` 是两份逐字相同的实现（F-5 说是收口，实际是复制） | note | 删掉副本，`flagPresent` 与 `resultFileRequested` 只留一处 | — |

**这一轮的教训与上一轮相反，正好补全它**：第 12 轮我学到"可失败的证据必须在**你实际评估它的环境**里可失败"；这一轮学到同一句的另一半——**修复必须真的修在它声称的那个面上**。§12.4 写"对所有 flag 一次解决"，实际只改了 `argValue`；C-6 的证据"绑定到声明面"，而在评估环境里那个面根本不存在。两次都是**文案比代码走得远**，这在本 change 里已经是第四次（"历史 id 仍可复用"/"每个消费者都决定"/"窗口是整个函数"/"对所有 flag")。

**退出评估**：第四轮我曾说过若第五轮再出现同类形状就按约定收口。第五轮**没有**出现"修一处破另一处"的 blocking/major —— 它找到的是过严（R5-1/R5-5）、文案（R5-2）、覆盖面（R5-3）与证据强度（R5-4），合起来 4 minor + 4 note，且**围栏的安全性被 1932 次模糊测试独立确认**。方向已经从"每轮引入新缺陷"转为"收窄已知取舍"，所以继续推进是合理的；但 R5-3/R5-4 正是"宣称比实现宽"这一类，已按上面修掉并各配可失败证据。

## 14. 主机的 subagent 启动约束（写入生成器，不写进宿主机细节）

第五轮之后暴露一条**宿主环境事实**，它不属于 Kata 的判定面，但会让 review 轮根本起不来：

- 子代理是**新进程**，父会话启动时注册的东西**不继承**（`pi --no-extensions`）。
- 宿主默认模型若由某个扩展注册（本机 `litellm-go/deepseek-v4.1-flash-go` 由 `@esuyo/pi-esuyo-custom-provider` 注册），
  子代理会以 `Model "<provider>/<model>" not found` 失败——**这句话读起来像拼写错误，其实不是**。
- 处置：dispatch 时把该扩展 attach 给子代理（空的 tool 列表，只为注册 provider），或改用子代理自己能解析的模型；
  两者都不可行时**据实停止并说明**——没起起来的轮次不算轮次。

落点：`src/adapters/phase-guidance.ts` 的 `ledgerReviewGuidanceFor`（生成器），因此**每个平台的副本都携带**；
`node-contract-declares-io-and-interaction.test.ts` 用 golden 断言锁住（把该句改成别的串即变红）。

**同时明确它不改变口径**：请求里依旧不带 platform/session/model，轮次怎么起属于组织流程而非被检查的判据；
这条引导管的是"轮次是否存在"，不是"Kata 认为它是什么"。宿主的具体 provider 名**不写进生成器**——那正是
`#1306`（只依赖 skill + subagent + kata-cli，不耦合平台接口）禁止的。

## 15. 第六轮独立审查 F-1…F-6

第六轮**没有一条行为缺陷**：C-1…C-6 全部成立，围栏安全性经 21 组拓扑确认无逃逸，四条点名 flag 的 `=` 拼写确实两种都认。它找到的全是**"我声称的比断言的多"**——写了两个事实只断言一个、写了分支没测、表没列全、文案宣称了没测量的原因。

| 发现 | 严重度 | 修复 | 变异验证 |
|---|---|---|---|
| F-1 `VALUE_FLAGS` 未含 `--review-evidence`/`--out`/`--result-file` 等；`review --review-evidence hello --change t1` 把 `hello` 当 change id（**选中错误的 task**）；`--root=` 仍 fail-open | major | 列表按源码实际读取补全，并新增 `cli-flag-vocabulary.test.ts` **从源码推导**该表并断言不缺项——表不能再靠手工跟步 | 从表里删一个 flag → 变红 |
| F-2 R5-2 的 `declaration-moved` 半句无可失败证据 | blocking | 补用例：声明加一个空目录 → freeze → run，断言 `declaration-moved` 且列出该路径、且**不含**"content changed" | 把文案塌成 content 措辞 → 变红 |
| F-3 R5-7 的归档分支零覆盖 | blocking | 补用例：空 findings + declaredCoverage 的已记录轮次在 revision 变更时被归档；占位则不归档 | 把判据退回 `findings.length` → 变红 |
| F-4 空格形式把下一个 flag 当值（`--root --change=c1` → `"--change=c1"`） | minor | 两个读取器的空格回退都加"下一 token 是 flag 则无值" | 断言两种畸形输入都返回 undefined |
| F-5 R5-6 的拒绝宣称了它没测量的原因 | minor | 文案改为报告实际捕获的失败，并给出记录路径 | 断言含 JSON 解析错误本身 |
| F-6 新增引导把宿主派发机制耦合进平台无关文本 | note | 改为只讲事实与后果（"此会话启动时注册的 provider 对新上下文不可见"、"没起起来的轮次不算轮次"），不含平台机制 | golden 断言不含 `extension list`/`empty tool list` |

**F-3 的排查过程本身值得记下，它是本 change 第五次"测试写在引擎到不了的状态上"**：我写了三次 fixture——

1. 无 evidence → `revisionIdForEvidence` 返回 `undefined`，守卫短路（分支永不进入）；
2. 手写 evidence 信封但字段不全 → schema 拒绝 → `readRecordedEvidence` 抛错 → `readTaskEvidence` 回退到"收集为空" → **同样是 `undefined`**；
3. 补齐 `log`（string）、`checkInput`/`diffHash`（64 hex）、`logBytes` 等字段后，分支才真正被走到并红了。

教训与第 12 节同一条但换了介质：**测试的输入必须是一个引擎真能读进去的记录**。一个 schema 不合法的 fixture 与"没有记录"在调用者眼里完全一样，而这正是这个 change 反复在修的那类混淆。
