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
