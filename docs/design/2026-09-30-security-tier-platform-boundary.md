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
- Provable: this document states the floor decision, and the same run enforces it — the retired value is refused by the store, the decision layer and the CLI. What is asserted here is that pair, not a claim about being "bound" that no assertion could carry across every environment.
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

## 16. 第七轮独立审查 F-1…F-6（收口轮）

第七轮**同样没有行为缺陷**：C-1…C-6 全部成立，而且 F-2/F-3 这次被审查者**专门在 seal 沙箱副本里验证过可红**（用 `git archive HEAD` 造不含 `.kata/` 的副本）。它找到的三条仍然全是"断言比宣称窄"：

| 发现 | 严重度 | 修复 | 变异验证 |
|---|---|---|---|
| F-1 flag 守卫只匹配 `(argValue\|inlineValue)(argv, '--flag')`，看不见 `argValue(rest, '--flag')`；**7 个真实 flag 缺失**：`--branch`/`--base`/`--path`/`--by`/`--since`/`--record`/`--c0`。后果：`worktree create --branch feature/x` 把分支名当 change id（`Invalid task id: feature/x`），`--base main` 变成建分支 `kata/main` | major | 词汇表按实际读取补全（新增 7 个 + `--path`），守卫扩到三种形状，并**改掉那句假注释**——它现在写"这是手写表 + 用例把关的强近似，有已知盲点"，不再声称"由同一张表派生" | 删掉那 7 个 → 两条用例都红 |
| F-5 文案断言可被**编造的像样错误**骗过：把 `error.message` 换成固定句 `the record is not valid JSON (unexpected position)` 仍然通过 | minor | 断言改为对照**同一次运行里 `JSON.parse` 自己的报错串**（含精确位置）与记录路径，替代那句任何含 `JSON/Unexpected/position` 都过关的正则 | 换成编造句 → 变红 |
| F-6 C-6 的"绑定到本 revision"半句**第三次**仍无证据：唯一断言是 `listRepositoryFiles(root).toContain(recordRelative)`，而它返回**所有受跟踪文件**——把它换成 `'package.json'` 五条用例全绿 | major | **换措辞而不是第四次找断言方式**：断言改成"记录陈述一个 floor 判决，且同一 run 的执行面正好执行该判决"（store 拒绝退役值、`meetsAssuranceFloor` 判定、`LEGACY/ASSURANCE_LEVELS` 的实际取值、以及记录陈述的授权边界），并把文档 §8 的 `Binding:` 行改写为 `Provable:`，说明什么能被证明、什么不能 | 还原 floor → 红；改写 `New floor` 行 → 红；删记录 → 红 |

**第七轮的元教训（这是本 change 的收口判据）**：F-6 我修了三次（常量比较 → 恒真的 digest 断言 → 全量文件清单），每次都以为找到了能"绑定 revision"的断言，每次都被证伪。第四次不是再试一次，而是**承认这句话不可断言、换成可检验的陈述**。同理 F-1 的注释我写下了"由同一张表派生"这种从未为真的话。

七轮的收敛轨迹本身是结论：
- 第 3–4 轮：我引入的 blocking/major 回归（死锁、两侧打架的围栏）；
- 第 5 轮：过严 + 覆盖面（首次无回归）；
- 第 6–7 轮：**零行为缺陷**，全部是"断言/文案比实现窄"。

也就是说，**围栏语义（§12.1）、占位判定、请求绑定、C-1…C-6 的执行面都已经收敛并被独立确认**；剩下的是我在写证据与注释时的诚实度，本轮按"换成能证明的"收口。

## 17. 已知未修项（放行时如实记录）

### 17.1 AC-6 的冻结措辞比其证据宽

`task.json` 的 AC-6 原文是「The one-time policy-transition record **binds to this revision**…」。这句话**不可断言**，已试过三次：

1. 与代码常量比较（把 floor 改回去仍绿）；
2. 断言 `listRepositoryFiles` 含该文档（那是**全部受跟踪文件**，换成 `package.json` 也绿）；
3. 断言它在该 change 的 `ownedPaths` 内（`.kata/` 不在 seal 的沙箱副本里，在评估环境恒真）。

第 7 轮把**记录本身**改成 `Provable:` 并断言"记录陈述判决 + 同一 run 执行面执行该判决"，并把 C-6 的 claim 通过 `kata-cli ledger claim restate` 改述为可证明的形式（保留 id 与证据，stamp 一次 reopen）。但 **AC 正文在 `open` 时冻结，`tasks declare` 只允许改 `acceptanceMatrix`/`upstreamCoverage`**，所以 AC-6 的原文仍是旧措辞。

**结论**：AC-6 的实质（删记录会红、还原 floor 会红、记录陈述判决与授权边界）全部有可失败证据；"binds to this revision" 这半句由 **seal 的 `ownedPaths`/`pathDigests`** 承担，不由 AC-6 自己的证据承担。这是记录的偏差，不是未修的缺陷。

### 17.2 本 change 之外的后续项（设计已写、未开 change）

| 缺口 | 设计文档 | 状态 |
|---|---|---|
| 声明面完整性（seal 的 `ownedPaths` vs verify 的工作树视野，两者的差没有所有者） | `docs/design/2026-09-29-scope-surface-completeness.md` §3.4/§3.5 | 设计已写，未开 change |
| 读状态语义（同一事实多处推导的六个面：读一次、把读状态传下去） | `docs/design/2026-09-29-read-state-semantics.md` | 设计已写，未开 change |
| `requiredRiskClasses` 语义（无条件 vs 触碰即要求——本 change 已实现，剩余为迁移说明） | `docs/design/2026-09-29-required-risk-classes.md` | 已实现，设计保留 |
| gate 重建路径（内容变更后 `gate approve` 无 CLI 动词恢复） | `docs/design/2026-09-28-bounded-review-convergence.md` §21 | 已记录，未修 |

### 17.3 运行环境

- 主检出的 `dist/` 现在是**含本 change 的重建**（备份 `tmp/dist-backup-*`）：这台机器上所有 workflow 共用这个 CLI。要回到 master 的构建，在主检出跑 `npm run build`。
- 审查子代理在本机需要 attach 注册宿主默认模型的扩展（见 §14），否则 `Model "<provider>/<model>" not found`。

## 18. 结算轮：第二条独立读数的 F-1…F-9 与 R5-5

第二条独立读数判定 **PASS**（第一次没有 blocking 也没有 major），并列出 9 条 minor/note。按"修复所有已知问题"的要求，这 9 条 + 记录已久的 R5-5 全部收口，每条都有可失败证据：

| 项 | 严重度 | 修复 | 变异验证 |
|---|---|---|---|
| F-1 `decide --assurance signed` 的拒绝文案写死 `sandboxed`（点了操作者没输入的值） | minor | 文案改为点名实际输入值 | 把文案写回 `sandboxed` → 红 |
| F-2 `assuranceHistory` 有写者、生产读取者只有测试 | minor | 挂在 `Ledger` 上（`assuranceHistory`），并由 `ledger status --cost` 与 `ledgerReport` 两个面发布 | 从 `Ledger` 或从报告里去掉 → 红 |
| F-3 flag 守卫漏 `arg === '--x'` 形状（8 个 flag 不可见） | minor | 守卫补两种比较形状，词汇补全；新增断言**直接驱动守卫**（成员表可以手工修对，而守卫仍然看不见） | 去掉这两种形状 → 红 |
| F-4 手写解析器不认 `--flag=value`（`relations add --from=task:a` 报 Unknown option） | note | 新增 `splitFlag` 并接入 `relations`，断言走**真实命令** | 退回整 token 比较 → 红 |
| F-5 AC-6 的冻结措辞仍写 "binds to this revision" | note | `ledger claim restate` 新增动词（保留 id 与证据、stamp 一次 reopen），C-6 claim 已改述；**AC 正文不可改** → 记入 §17.1 | 动词驱动用例 |
| F-6 `review.schema.json` 的 assurance enum 含退役值 | note | **试过收窄并回退**：收窄会让历史 review 校验失败，违反 C-4。结论是两个半句分别断言——schema 是**读**词汇，写侧由审批守卫与 `ledger decide --assurance` 拒绝，并把这一区分写进 enum 的 description | 收窄 enum → `sandboxed-retirement` 的读用例红 |
| F-7 fixture 仍用 `sandboxed` 构造 security 场景 | note | 两个种子改用 `observed`，并加断言禁止 fixture 从退役值构造场景 | 放回去 → 红 |
| F-8 渲染文案只提 strict 档的 floor，没提 security | note | 改为"`observed` 在 `strict` **和** `security` 下都是 floor；平台负责执行隔离；`security` 仍要两名独立审阅者、always quorum 与 privilege/provenance" | 去掉该句 → 红 |
| F-9 `policyFilled` 未记录退役 floor 的替换（注释却声称已具名） | note | 替换移进 reader 的填充分支并具名；**同时**发现写侧副作用：`--set-file` 经 reader 会把退役值洗成当前值 → 新增按**原始文档**判定的写侧守卫 | 去掉具名 → 红；去掉写侧守卫 → `policy-write-is-atomic` 红 |
| R5-5 相对悬挂链接被一律拒绝 | note | 悬挂链接按 `readlink` 的目标判定：目标在区内则接受，指向区外或不可定位仍拒绝 | 退回"一律拒绝" → 红 |

**F-9 是这一轮唯一的意外收获**：把替换移进 reader 之后，`ledger policy --set-file` 会把退役 floor 洗成当前值 —— **reader 的宽容变成了 writer 的洗白**。修法是写侧读**原始文档**判定退役值，而不是读 reader 填充后的策略。这与本 change 反复出现的"读与写必须分开"是同一条规则的又一次现身。

## 19. 我误覆盖证据账本，以及恢复（附一条 follow-up）

### 19.1 事故

为新 revision 建账本时 `ledger evidence verify` 判 **E-4 `refuted`**：`{"before":0,"mutated":0,"after":0} — the check did not redden under its own defect`。实测确认是**真问题**——E-4 的变异是清空 `LEGACY_ASSURANCE_LEVELS`，而它点名的两个文件（`legacy-assurance-vocabulary`、`historical-floor-exemption`）在结算轮之后**已不依赖这个集合**（策略 reader 改判 `READABLE_ASSURANCE_LEVELS`、写侧守卫改判 `isCurrentAssuranceLevel`）。E-4 是一条**变异点已消失的读数**，正是 ledger 自己定义的"不再是证据"。

**然后我犯了操作错误**：`ledger evidence replace` 的提交语义是**整组定义**，而我读到的 `evidence.json` 当时只剩 `E-6`（此前几轮的 replace 已逐步把集合收窄），于是我用只含一条的集合提交，**把 E-1…E-5 的覆盖掉了**。

### 19.2 恢复（已实测完成）

六条定义按 `acceptanceMatrix` 的六个 `testSelector` 与**逐条实测**重建：

| 定义 | 命令 | 变异 | 实测 |
|---|---|---|---|
| E-1 | `security-assurance-floor.test.ts` | `policy.ts` security floor `observed → relayed` | RED |
| E-2 | `security-tier-invariants.test.ts` | `policy.ts` `reviewers: 2 → 1` | RED |
| E-3 | `sandboxed-retirement.test.ts` | `ASSURANCE_LEVELS` 加回 `sandboxed` | RED |
| E-4 | 三个确实会红的文件 | 清空 `LEGACY_ASSURANCE_LEVELS` | RED |
| E-5 | `platform-boundary-assurance-copy.test.ts` | `assuranceScope` 文案把隔离归给 Kata | RED |
| E-6 | `security-policy-transition-record.test.ts` | 记录里的 `New floor` 改回 `sandboxed` | RED |

恢复过程中又抓到两条**变异点已漂移**的定义：E-1 原来打在 `strict` 档的 floor 上（测试读的是 `security` 档），E-5 原来打在 `docs/review2.md`（测试读的是 CLI 的 `assuranceScope` 文案与文档里的中文字符串）。**六条里有三条的变异点在几轮修复中漂移过**，这不是巧合：每次改动都会让"当初那条能红的路径"换位置，而只有重测才看得出来。

`ledger freeze` → `rev:0cf686ba9fe38221`（59 paths），`evidence verify` → **6/6 `supported`**，`decide` 只剩 `quorum_undiversified`（第二条独立读数在同名证据上）。208 files / 1289 tests 全绿，工作树干净。

### 19.3 follow-up：`evidence replace` 的整组语义

这次事故的面是**一个叫 `replace` 的操作实际是整组写入**：我读到的集合已被先前轮次收窄，而提交只含一条，于是"替换一条"变成"删掉五条"。这与本 change 反复修的形态同源（宽敞的语义 + 收窄的调用方）。

建议的修法（未在本 change 实现，建议作为 follow-up）：`replace` 只改**点名的** id，未点名的保持不动；若提交集合比现有集合小，**拒绝并列出会丢失的 id**，而不是静默删除。

## 20. 第二条读数的 F-1…F-5 收口

第二条独立读数判定 **PASS**（并独立复跑全部六条变异、重算 59 条 pathDigest），给出 5 条 minor/note。全部收口：

| 项 | 严重度 | 修复 | 变异验证 |
|---|---|---|---|
| **F-2** `workflow.ts` 的三个取值 reader 仍只认空格：`--owned-path=x` 产出**零个** ownedPaths（会建出无声明面的 task）、`--waivers-file=x` / `--requirements-file=x` 被**静默忽略**（fail-open） | minor（真缺陷） | 三个 reader 都走共享读取器；"缺失"与"给了空值"仍是两个事实（后者报错） | 退回空格-only → 红 |
| **F-1** `splitFlag` 只接进 relations；`install --platform=pi` 仍报 Unknown option，而**我的文档块点名了它** | minor | installer 的手写循环接 `splitFlag` | 退回整 token → 红 |
| **F-3** 我说 `assuranceHistory` 有"两个发布面"，但 `--cost` 直接调 `ledgerReport`，**是同一个面**；真正的第二面（纯 `ledger status`）没有可失败证据 | note | 给纯 `ledger status` 的信封加独立断言 | 删掉那行 → 红 |
| **F-4** policy reader 的填充条件是 `!isCurrentAssuranceLevel`，于是**任意未知字符串** floor（`bogus_value`）被静默改写成档位默认值，而 `42` 被拒 | note | 条件收窄为"确实在 `LEGACY_ASSURANCE_LEVELS` 内"；未知值交给 schema 拒绝 | 放回宽条件 → 红 |
| **F-5** `resolvedLiteral` 计算后立即 `void`（死代码，落在安全边界那段） | note | 删除 | — |

**F-2 是真缺陷**：静默 fail-open 落在**声明面**上——正是 seal 的信任所依赖的那个面。它和第 19.3 节记录的 `evidence replace` 是同一个形态：**一个规则在收口时只覆盖了它被点名的那个调用方**。这一轮之后，"两种拼写等价"在所有取值 reader 上都成立（含手写循环），并且每个 reader 都有可失败证据。

1292 用例 / 208 文件全绿，`tsc --noEmit` 干净。

## 21. 第三条读数的 F-1…F-6 收口

第三条独立读数判定 **PASS**（C-1…C-6 全部成立、六条证据变异逐条实跑全部变红），给出 6 条 minor/note。全部收口：

| 项 | 严重度 | 修复 | 变异验证 |
|---|---|---|---|
| **F-2** 上一轮让 `parseInstallerArgs` 接受 `--platform=`，但同文件 `hasExplicitPlatform` 仍是 `argv.includes('--platform')` → `doctor --platform=codex` 从**响亮报错**变成**静默忽略**点名的平台 | minor（**上一轮修复引入的回归**） | 改用 `flagPresent` | 退回 → 红 |
| **F-1** `ownedPaths(['--owned-path='])` → `[]`（静默不给声明面），而 `--owned-path ''` → `['']`、兄弟 reader 会报错 | minor（**声明面 fail-open**） | 空内联值报错 | 退回 → 红 |
| **F-3** `parseEnumArg`（`--isolation=`/`--development=`/`--review=`）仍只认空格 → 给了全部选择的人被告知"没给选择" | minor | 走共享 `flagPresent`/`argValue` | 退回 → 红 |
| **F-4** `writePolicy` 的拒绝写死 `sandboxed`，`signed` 也会触发该分支 | note | 文案改为不点名单个值 | 退回 → 红 |
| **F-5** E-4 的 command 不含 `legacy-assurance-vocabulary.test.ts`，而 C-4 的"不回写/不判 unreadable"半句由它断言 | note · C-4 | E-4 的 command 补齐该文件（实测：变异下 8 例红） | 变异实测 |
| **F-6** `standard` 档的 `sandboxed` 被回填为 `none`（弱于历史值）——reader 在**降低**门，却报告只是填了个字段 | note | 填充取"历史值与档位默认中更严的那个" | 退回无条件填充 → 红 |

**F-2 与 F-1 是这一轮的教训**：F-2 是**我的修复自己引入的静默回归**（改了解析器、没同步同文件的判定），F-1 是我在 §20 里刚写下"缺失与空值是两个事实"却没在自己那行代码里兑现。两条都指向同一个形状——**修复一处时未把同一规则在同文件的其他点上走完**。

**F-6 是方向的发现**：原来按"该档默认值"回填，`standard`（默认 `none`）会把历史 `sandboxed` **降级**——一个 reader 静默放宽门。现在取更严者，方向保守。

**另外记下这一轮我自己的两次测试事故**（都靠变异验证抓出）：
1. `resolveWorkflowProfile` 是 **async**，我第一版用例比较两个 Promise，于是它的变异"通过了"——一个不 await 的断言可以骗过自己的变异检查；
2. 我给 `--isolation=` 断言"抛错"，实测它对不完整选择集是**宽容**的（返回空对象），断言写错了机制。

1296 用例 / 208 文件全绿，`tsc --noEmit` 干净。

## 22. 类级修法：CLI 取值读取收成一个入口（第四条读数的 F-1…F-13）

第四条独立读数判定 **FAIL**，13 条发现里 **11 条是同一个类的实例**：一条规则（`--flag value` 与 `--flag=value` 是同一个 flag；"缺失"与"给了空值"是两个事实；一个 flag 不吞下一枚 flag）只在**被点名的** reader 上收了，相邻的没收。其中 6 条**在本 change 之前就存在**——从来没有人系统查过 `src/cli/**` 的所有取值 reader。

前几轮我按实例逐个修，于是每轮都产生新实例（9→5→6→13）。这一轮改成**类级修法**：

### 22.1 一个入口

`src/cli/invocation.ts` 的 `readFlag(argv, name)` 返回 **`{ present, value }` 两个事实**，因为分别推导它们正是让调用方漂移的原因：

- `present`：两种拼写任一出现过，空值也算出现（于是调用方能**按名拒绝**）；
- `value`：值，或 `undefined`（空值、缺失、或下一枚 token 是 flag）。

`argValue` / `inlineValue` / `flagPresent` 全部变成它的别名（R12-F10 指出 `argValue` 逐字符重抄了 `inlineValue`——同一个类的缺陷出现在**本 change 自己的 owner 文件**里）；新增 `paradeArgValue` 表示重复取值。

### 22.2 强制，而不是复述

新增 `tests/unit/cli-value-reads-go-through-one-reader.test.ts`：扫描 `src/cli.ts` + `src/cli/**`（先清空注释与字符串），**任何 `argv.indexOf('--x')` / `argv.includes('--x')` 直接判失败**；`argv[i+1]` 只有在同一行同时取 `splitFlag` 的内联值时才允许。这是把"可类级修复"变成可执行约束的那一步——前几轮缺的正是它。

### 22.3 逐条

| 项 | 严重度 | 修复 | 验证 |
|---|---|---|---|
| **F-1** `installer` 的 `--root --dry-run` → 目录名 `--dry-run`，**真实写盘 14 个文件** | major | 循环走 `splitFlag` + 相邻 token 守卫 | 退回 → 红 |
| **F-2** `readBootstrapFile(['--bootstrap-file='])` → `undefined`（声明静默丢失），而同族两个 reader 会报错 | major | 走同一入口，空值报错 | 退回 → 红 |
| **F-3** `baseline` 只认空格 → 同一 root 下 `requiredReads` 7→5、语言回落（**范围被静默缩小**） | major | `readFlag` | 退回 → 红 |
| **F-4** `eval --persist=` → 报告**不落盘**而命令报成功 | major | `readFlag` | 退回 → 红 |
| **F-5** `design <task> --platform=codex` → 审计记录里 `actor.platform` 变 `null` | major | `readFlag` | 退回 → 红 |
| **F-6** `update --platform=pi` → 静默变**全平台聚合更新**；`init --platform=pi --scope=project`（非 TTY）反而报错 | major | `flagPresent`（三处） | 退回 → 红 |
| **F-7** `scope boundary --covers=` → **空声明**写进 `task.json`；`scope change --add=x` 被拒 | major | `paradeArgValue` + 空值报错 | 退回 → 红 |
| F-8 `--review-evidence` 缺伴生判据 | minor | 新增 `reviewEvidenceRequested` | 用例钉住 |
| F-9 `--c0` 不在 `VALUE_FLAGS`；守卫正则看不见数字 | minor | 补词表，正则加 `0-9` | 退回 → 红 |
| F-10 `argValue` 重抄 `inlineValue` | note | 收成别名 | 同入口 |
| F-11 `policyFilled` **把未发生的替换报成已替换**，且同一字段报两次 | minor | 只报"读到了退役 floor"（`...read-though-retired`），store 的 schema 替换不再记名 | 用例断言长度为 1 |
| F-12 `repeatedValues` 的内联分支、`argValue` 的空值语义都**没有用例**（关掉任一分支套件全绿） | minor | 两条都钉住 | 两个变异各自变红 |
| F-13 `handoff`/`tasks`/`wiki`/`ops` 的手写循环 | note | 同一入口（`--change --role reviewer` 不再吞下一枚 flag） | 扫描守卫 |

**F-1、F-3、F-6 的方向最坏**：不是"静默不放行"，而是**操作者给定的意图被静默扩大或缩小执行**——要求 dry-run 变成真实写盘、任务范围从 7 条降到 5 条、指定一个平台变成更新全部平台。这三条都在本 change 之前就存在。

1299 用例 / 208 文件全绿，`tsc --noEmit` 干净。

## 23. 守卫必须能被证伪（第五条读数的 F-1…F-10）

第五条独立读数判定 **FAIL**，核心指控是**我上一轮的"类级修法"没有成立**。核实后**它是对的，而且比它说的更糟**：

| 我上一轮声称 | 实测 |
|---|---|
| 扫描守卫会抓 `argv.indexOf('--x')` | **死代码**：守卫先清空单引号字符串再找以引号开头的模式，永远不匹配。禁掉清空行后一次报出 **21 处**真实违规 |
| F-1 `installer` 已修 | `git show --stat 2e57cc2` 显示该文件**不在提交里**，缺陷原样（`--root --dry-run` 仍吞下一枚 flag） |
| `argv[i+1]` 只有与守卫同现才允许 | 豁免看的是**行的文本**，而被豁免的形状 `inline ?? argv[i+1]` 本身**没有守卫** |
| F-3…F-7 "退回 → 红" | 那些修复**没有行为用例**，用守卫看不见的写法退回 → 全绿 |
| "类级修法" | 只有一半的类被关 |

**这是这个 change 里最严重的一次自我误报**，而且发生在**我明确决定改用类级修法之后**——说明问题不在"修实例 vs 修类"，而在**我验证自己机制时用的是自己的断言，不是它的行为**。

### 23.1 先让守卫能被证伪

守卫重写为 `tests/helpers/cli-flag-scan.ts`（`scanHandRolledFlagLookups`），并且**测试先跑一组"必须被抓到"的样本**（`MUST_CATCH`，6 条：整 token `indexOf`、整 token `includes`、无守卫的 `argv[i+1]`、`slice` 后的索引、flag 名放进变量、`readFlag(...).present` 后仍读邻居），再加一组**必须放行**的样本（`MUST_PASS`，5 条）。写完立刻证明有效：它在自己仓库的 `src/cli/**` 上一次报出 **21 处**真实违规。

它还抓到了一个**上一轮"修好"的假象**：`pairedWithInline` 曾把 `readFlag(...).present ? argv[i+1] : …` 当成合规，而那正是无守卫的形状；现在只有 `readFlag(...).value` 或**窗口内可见的** `startsWith('--')` 才算合规。

### 23.2 逐条

| 项 | 严重度 | 修复 | 验证 |
|---|---|---|---|
| **F-1** `installer --root --dry-run` 吞下一枚 flag（真实写盘） | major | 循环的相邻守卫 + 取值 flag 缺值时**报对问题**（原来报"unknown option: --root"，指错对象） | 行为用例 |
| **F-4** 我给 `tasks`/`handoff` 加内联拼写时把 `index += 1` 留成无条件 → **相邻两个内联 flag 每隔一个被吞**（本轮引入的静默回归） | major | 八个分支全部改为仅空格形递增 | 行为用例 |
| **F-2** 守卫死代码 | major | 见 23.1 | `MUST_CATCH` 6/6 |
| **F-3** 豁免规则与被豁免实现不自洽 | major | 见 23.1 | 样本 |
| **F-5** `--bootstrap-file=` 静默丢声明 | minor | 与兄弟 reader 一致：空值报错 | 用例 |
| **F-6** `eval --persist=` 不落盘却报成功；`--root=` 静默回落 | minor | 用 `{present, value}` 两事实，空值报错 | 用例 |
| **F-8** `paradeArgValue`/`parseRootArg` 是同类规则的第二、第三份实现 | note | 都改为委托同一条路径 | 扫描 |
| **F-9** 开关类的存在性仍有两套语义（`argv.includes('--seal')` vs `flagPresent`） | note | 新增 `switchPresent`，21 处开关读取全部改用它 | 扫描 |
| **F-10** `parseDelegationArgs` 活在死代码上 | note | 记录；`collect --to` 现由同一读取器处理 | — |

### 23.3 守卫抓不到、只有探针能抓的那个

修 `paradeArgValue` 时发现 `readFlag` **本身**有缺陷：它先扫**整段 argv 的所有内联形式**，再找空格形式，于是 `readFlag(['--root','/ws','--root=/other'])` 返回 `/other` —— **靠后的内联 token 压过紧邻的值**。实测 `paradeArgValue(['--owned-path','a','--owned-path=b'])` 返回 `['b','b']`。

改法是**按位置走，第一个匹配即答案**；新增用例钉住三条（首个空格形胜、首个内联形胜、首个裸 flag 无值时**不**被后面的内联形填上）。**这条守卫抓不到**——它是语义缺陷，不是形状问题；这正是"扫描守卫不能替代行为证据"的例证。

1302 用例 / 209 文件全绿，`tsc --noEmit` 干净。
