# 执行者能力与性质：让 `sandboxed` 可以从任何平台取得（设计稿）

> 状态：设计稿（本文件是 governed change `executor-capability-properties` 的上游输入）
> 日期：2026-09-29
> 上游：`docs/design/2026-09-29-verdict-readings-per-run.md` §16（本 change 的账本停在这条地板上）、`docs/review2.md`（"artifact-only 不能证明全部执行过程安全"）、`docs/design/2026-09-27-clean-refactor-plan.md`（`high` 地板与 `security` 档的设计意图）

## 1. 问题（实测）

### 1.1 这条地板今天不可达，而批准路线只剩账本

- 阶梯：`ASSURANCE_RANK = { none: 0, relayed: 1, observed: 2, sandboxed: 3, signed: 4 }`（`src/kernel/types.ts`）。
- 实现：仓库只有 `file`(`relayed`) 与 `inline`(`observed`) 两个适配器——**没有任何代码路径能记录 rank 3**。
- 要求：`security.assuranceFloor = 'sandboxed'`（`src/kernel/policy.ts`），而 `high` 地板只覆盖三个文件（`src/kernel/policy.ts`、`src/kernel/decide.ts`、`src/kernel/risk.ts`）。
- 后果（`verdict-readings-per-run` 的实测）：一个只因为修了两处 `decide.ts` 而升到 `security` 的 change，其账本 `decide` 只剩**一条**原因 `assurance_below_tier: assurance observed is below the security floor of sandboxed`；而 `review --approve` 现在**只认账本**（拒绝原文："Review approval requires an evidence ledger"）。于是：**碰"门本身"的 change 无法被批准**。

### 1.2 机制层面的耦合：今天的"唯一可能实现"是 OS 专属的

`bwrap`／非特权 user namespace 是 Linux 专属。若把 bwrap 直接写进适配器，就把"能否批准内核类 change"绑到了 OS 上——这不是设计意图，是实现选择的副作用。

### 1.3 这条地板防的是什么（决定"能不能替代"）

`docs/review2.md`：*一个 agent 可以临时把敏感内容发到外部网络，再把 workspace 恢复成完全相同的 digest；内容未漂移不能证明"从未发生数据泄漏"*。所以这条地板防的是**过程**（外泄、越界写、影响宿主），而**不是**内容一致性（内容一致性已由冻结快照 + revision 绑定覆盖）。

**由此得出关键事实**：**"预防"没有任何可移植原语**。可移植的只有**检测**；检测能抓持久副作用，抓不到"瞬时外泄后恢复"。

## 2. 目标与非目标

**目标**
1. 让 `rank 3` 可以在**任何平台**上被取得——取得方式由部署方选择，内核不绑定任何机制。
2. 档位不再由执行者**自称**，而由它**证实的性质**推出；记录里写明"用了哪个执行者、证实了哪些性质"。
3. 失败**即拒**（fail closed），且拒绝要点名缺哪条性质并给出可执行下一步。
4. 可移植的性质用来**加强 `observed`（`strict` 档）**，**不降低**任何已有的门。

**非目标**
1. 不改变阶梯的顺序与档位表（Stage 2 才讨论 `policy.ts` 的表述；见 §6）。
2. 不引入任何"宿主平台探测"（Pi/Claude/… 与证据执行无关；本会话早先已把 host adapter 方案砍掉）。
3. 不替代审阅独立性、变更隔离、决策代码身份（三条各自独立的轴）。
4. 不自称可以替代"另一个主体"（`external-witness` 那一类是另一个叶子，不是本 change 的实现目标）。

## 3. 设计

### 3.1 三层抽象

```
抽象层  assurance 阶梯（内核词汇，不认识机制）
接口层  EvidenceExecutor { id; run(command, opts); demonstrate(): Promise<AssuranceProperty[]> }
叶子层  portable · bwrap · docker · (将来) sandbox-exec · remote/CI
判定层  档位 = deriveAssurance(properties)      ← 由性质推出，不由自称
```

### 3.2 性质清单：可移植 vs 机制专属

| 性质 | 含义 | 测量方式 | 可移植 |
|---|---|---|---|
| `frozen-inputs` | 从冻结 digest 的内容跑 | 比对 subject 的 `contentDigests` 与执行目录 | ✅ |
| `no-trace-outside` | 声明可写集**之外**的内容前后不变 | 执行前后对声明集合做 digest 比对 | ✅ |
| `replay-agreement` | 独立复跑得到同一结论 | 复用 `ledger replay` 的比较 | ✅ |
| `declared-inputs` | env/args 闭合，无隐式宿主输入 | 记录并比对实际 env/args | ✅ |
| `network-denied` | 进程无法联网 | 叶子自检：沙箱内尝试连接必须失败 | ❌（机制） |
| `process-isolated` | 无法影响宿主其他进程/文件 | 叶子自检：越界写必须失败 | ❌（机制） |
| `external-witness` | 由另一个主体/机器执行并留下可验证见证 | 见证产物 + 信任锚 | ❌（信任锚） |

### 3.3 判定语义（**决定 (i)**）

- **`rank 3`（`sandboxed`）要求至少一条机制专属性质**：`network-denied` ∨ `process-isolated` ∨ `external-witness`。
- 只有可移植性质 ⇒ 最高 **`rank 2`（`observed`）**，但比今天更强（今天 `observed` 只要求"本进程跑过"）。
- 语义不变式：**性质集合是档位的函数**（同一集合 ⇒ 同一档位，与执行者身份无关）。

### 3.4 记录

每轮的 verdict 携带 `executor: { id, properties: AssuranceProperty[] }`；`ledger status` 与 `decide` 的 diagnostics 能看到它；档位计算的结果写进 `usage.json`（沿用既有 `ensureAssurance` 的"取最强"语义，但**入参改为由性质推出**）。

### 3.5 失败语义

- 叶子缺失／自检失败 ⇒ 该性质**不产出**；若档位因此低于当前要求，`decide` 报 `assurance_below_tier` 并**点名缺的性质**（今天只点名档位名）。
- **绝不降级**：不因为"没有 bwrap"就报 `observed` 并让门通过。
- 拒绝必须给可执行下一步（`deficit` 里给出：换用一个能提供 X 的执行者、或该性质由人记录例外）。

### 3.6 叶子（本机两个都已实测）

| 叶子 | 提供的性质 | 实测 | 代价 |
|---|---|---|---|
| `bwrap` | `network-denied` + `process-isolated` | 越界写→`只读文件系统`；网络→不可达 | Linux-only；无守护进程、快 |
| `docker` | `network-denied` + `process-isolated` | `--network none`→不可达；`--read-only`+绑定可写 | 需守护进程与镜像；**mac/Win 上也有** |

叶子选择是**显式**的（`--executor <id>`），并且在缺省时按固定顺序探测（`bwrap` → `docker`），**不使用 `process.platform` 分支**（见 AC-8）。

### 3.7 与既有 `src/workflow/execution-sandbox.ts` 的关系

那里已有一种叫 sandbox 的东西：封存 check 跑在**一次性目录副本**里，作者树对它只读。那是**目录级**隔离，**不是进程级**（那个命令仍可联网、仍可写 `$HOME`）。本设计不合并两者，但必须消除命名混淆：本设计的产物叫 **executor / 性质**，不叫 "sandbox adapter"；`execution-sandbox.ts` 的性质对应本表里的 `frozen-inputs`。

## 4. 分层落地（受自指约束）

| 阶段 | 改动面 | 风险地板 | 档位 | 今天能否批准 |
|---|---|---|---|---|
| **Stage 1（本 change）** | `src/assurance/**`、`src/assurance/adapters/**`、`src/cli/ledger.ts`（委托与串接）、测试、本设计文档 | `medium`（`src/cli/**`） | **`strict`** | ✅ 能（`inline` 即满足 `observed`） |
| Stage 2（独立 change） | `src/kernel/policy.ts`：把 `assuranceFloor` 从标签改为**性质集合** | `high` | `security` | ❌ 需 Stage 1 先落地（否则 rank 3 仍不可达，改门者自指被门挡住） |

**Stage 1 交付后**，`verdict-readings-per-run` 的账本可以用一个能提供机制专属性质的叶子重跑证据复验，从而跨过它现在唯一的那条原因——这是本 change 的端到端验收（AC-7）。

## 5. 验收标准（草案；每条一个测试文件——封存按 selector 生成证据，一条 selector 只能喂一条标准）

- **AC-1** 执行者必须逐条**证实**它声明的性质：无法证实的性质不进入该轮记录，且档位不因声明而上升。
- **AC-2** 档位由性质推出：同一性质集合用不同执行者产出得到同一档位；自称 `sandboxed` 而只证实可移植性质的执行者，记录为 `observed`。
- **AC-3** `rank 3` 必须含至少一条机制专属性质（`network-denied` ∨ `process-isolated` ∨ `external-witness`）；纯可移植集合封顶 `observed`。
- **AC-4** 可移植性质在**没有**任何 OS 机制的路径上也能被证实，并且**确实发生越界写时** `no-trace-outside` 必须失败（用真实执行者驱动，不以内存构造代替）。
- **AC-5** 执行者缺失或自检失败 ⇒ **结构化拒绝**，点名缺的性质并给出可执行下一步；**不得降级**通过。
- **AC-6** verdict 与账本报告携带 `executor.id` 与该轮证实的性质集合，且该信息对决策可见（`decide` 的 reasons/diagnostics）。
- **AC-7** 端到端：用本机可用的机制叶子执行**整轮**证据复验 ⇒ 档位为 `sandboxed`，且 `decide` 不再报 `assurance_below_tier`（若本机两种叶子都不可用，用例**失败**并如实说明，而不是跳过）。
- **AC-8** 通用化本身可执行断言：核心（接口 + 判定 + 账本串接）**不含** OS 名称与 `process.platform` 分支；每个叶子的可用性探测只出现在该叶子内部。

## 6. 影响面（ownedPaths 草案）

```
docs/design/2026-09-29-executor-capability-properties.md
src/assurance/executor.ts            （接口 + 性质类型 + deriveAssurance）
src/assurance/adapters/property-executor.ts （可移植性质的测量）
src/assurance/adapters/bwrap-executor.ts
src/assurance/adapters/docker-executor.ts
src/cli/ledger.ts                    （--executor 串接 + 报告字段）
tests/unit/properties-are-demonstrated-not-declared.test.ts  （AC-1）
tests/unit/the-level-follows-the-properties.test.ts          （AC-2）
tests/unit/mechanism-property-is-required-for-rank3.test.ts  （AC-3）
tests/unit/portable-properties-detect-and-prove.test.ts      （AC-4）
tests/unit/executor-refuses-rather-than-downgrades.test.ts   （AC-5）
tests/unit/executor-is-recorded-in-the-round.test.ts         （AC-6）
tests/unit/a-round-can-reach-the-sandboxed-floor.test.ts     （AC-7）
tests/unit/core-does-not-branch-on-the-platform.test.ts      （AC-8）
```

## 7. 风险与开放问题

1. **AC-7 依赖本机叶子可用**（bwrap/docker 已实测可用）。设计上它必须**失败而不是跳过**——否则这条证据是空的。若将来在无叶子的机器上运行，它会红，这是正确行为（该机器确实买不到这条地板）。
2. **`docker` 叶子需要镜像**：镜像从哪来、是否允许网络拉取，需要一个明确决定（候选：使用本机已有的镜像，或在用例中用一个最小镜像；**不允许**为了测试而联网拉取）。
3. **`external-witness` 不在本 change 范围**：它是 `signed` 方向的第一步，需要一个信任锚（CI 见证/签名密钥），属于独立 change。
4. **Stage 2 的性质集合表述**：`security` 档最终该要求哪些性质（`network-denied ∨ external-witness`？是否还要求 `replay-agreement`）需要在 Stage 1 落地后、以可实测的方式重新讨论；本设计只固定"由性质推出档位"这个机制。
5. **命名**：`execution-sandbox.ts` 与新词汇并存，需要在文档与注释里持续区分（§3.7），避免又出现"一个词两个含义"。
