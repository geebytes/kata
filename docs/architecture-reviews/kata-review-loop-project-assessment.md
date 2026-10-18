# Kata 项目级审查循环复盘：从产品设计到交付控制

**2026-10-17；范围：整个 Kata 项目的设计、代码、历史处理过程，不是某个 change 的第 N 轮审查。**

本报告是当前项目级判断。`2026-10-16-review-loop-nonconvergence-root-cause.md` 是当时八轮审查、实施前后的历史快照；其“尚无 lineage/终态/focused follow-up”的**现状句不再适用**，不能直接当成今天的代码事实。`2026-10-16-review-loop-optimization-code-alignment.md` 与 `2026-10-17-the-closure-obligation-cannot-be-satisfied.md` 记录了后来机制的实测与修正。本次只调查和写文档，未进入任一 change 的 phase，未改生产代码或 task 记录，也未宣称开放 finding 已修好。2026-10-17 补充核验官方方法论资料并重新讨论方案；2026-10-18 进一步核验人类 Code Review 和 PR 结束规则。**路线 A、正常 Done 边界及本项目级设计稿已获用户确认**（§6–§9）。这确认的是设计方向与文档，不证明拟议 CLI 路径已实现或可执行；实施规格、受保护 schema 改动、集成及归档均未获授权。

## 结论

项目并不是“测试太少”或“审查者过严”。Kata 把**安全性**（有证据、修订绑定、独立审查、人工信任边界）做得较强，但把**完成一个有限交付**所需的活性、变更控制、可执行协议和成本观测留在了不同层：设计写出有限 Review Ticket 与 RepairBatch，实现曾退化成开放式重审；后来补进 lineage / reviewKind / closure obligation，却又让新增的控制器成为新的被审对象。每轮修复扩大了状态空间和测试/文档/证据面，修订失效机制再迫使一轮独立审查；若“局部 correction”没有把同一事实的所有生产者和消费者收敛，下一轮会在**修复内**找到新的实例。即使当前终局路由已存在，目标尚不是一份可自动证明的有限、可执行、可定价的交付契约。

**改进方向不是放宽门禁或把未证实写成 PASS**：先冻结交付问题和决策权，再把完整的状态/转换/补救契约与结构化证据做成一个共用模型，用小范围真实工作流验证；审查把 certification、repair follow-up、RCA 分开，复发触发*停止自动重试*而不是自动放行；最后用可核算的轮次成本与可靠性来决定是否扩展这一机制。

## 1. 事实、口径与局限

对当前本地 `.kata/tasks/*/review-rounds.jsonl` 的**只读**汇总：31 个 task 有轮次记录，共 165 行；47 行内嵌了 finding，118 行没有内嵌 finding；内嵌 finding 共 246 条：166 条 `origin: repair`，34 条 `origin: original`，46 条未声明 origin；已声明 origin 的 200 条中 repair 占 **83%**。有 finding 的 task 为 9 个；7 个有 finding 的 task 达到至少 5 轮，最长一个 12 轮。类别出现最多的是 `instrument-unsound` 55、`one-fact-derived-twice` 35、`contract-semantics` 33、`refusal-cannot-be-executed` 26（另有 44 条未声明 class）。这些是**存储记录分布**，不是随机抽样的所有 PR，不说明项目全部变更都难收敛，也不等于发现率或逃逸率；特别是 `blockingCount: null` 有 52 行，绝不能和零相加或把 118 行认作通过。

一个贯穿前后机制的纵向样本是 `the-gates-can-be-repaired`：历史八轮共有 53 条 finding，其中 51 条标 `repair`，blockingCount 为 `5→2→3→1→2→1→null→2`，起止相隔 **70 小时 44 分**（日历经过时间，*不是*人员工时或 reviewer 运行时长；见历史报告 §2）。当前该 task 的 `review-rounds.jsonl` 为 9 行、58 条内嵌 finding；活动 `review.json` 另有第 10 轮 6 条 finding（3 major、2 minor、1 note），且 `batchClosure` 将前一轮 5 条均记为 closed。第 10 轮尚未成为该 rounds 文件的一行，不能把它悄悄当成历史文件的第 10 行。第 7 行 `blockingCount:null`、未嵌 finding，而当时产生的 result 仅在 `tmp/`：历史链质量会影响复发率与停线判断（历史报告 §2.2，缺陷队列 I-22）。

资源数据**缺失**：`src/quality/repair.ts` 的轮次模型/写入项记录 revision、blockingCount 和 findings，不记录每轮耗时、token、tool calls、重跑判据数与改动 LOC；历史报告记载单轮约 29 分钟 / 721k tokens 只是一次人工样本（缺陷队列 I-44）。本报告不能给出“项目总审查成本”或假装计算投资回报。最初浏览器因 `ERR_NO_SUPPORTED_PROXIES` 未核外部资料；随后通过只读 HTTPS GET 核验了 Google、GitHub、Google SRE、Kanban Guide、Scrum Guide 和 DORA 的官方页面（§4）。2026-10-18 进一步核验 NASA SWE-087/088、NIST SP 800-218 原版 PDF、CMU SEI ATAM、Fowler 的 CI 和 Deming 的 PDSA（§9）；NASA 在上一版**未**核验，现在已核，但其 Ver D 安全关键工程规则不自动成为 Kata 的法定义务。CMMI/ISO 原链接仍未核验，ACM SPACE 与 Lean Enterprise Institute 本次 HTTP 403，不据其提出新规则。项目数据和外部方法论须分别解读，不能用方法论倒推本仓库已实现。

## 2. 设计—实现—实施的失配链

| 层 | 原设计/工程原则 | 可复核的实际机制与现象 | 如何形成下一轮 |
|---|---|---|---|
| 需求/范围 | `docs/design/2026-09-28-skill-first-independent-review-protocol.md:32-36,233-251`：有限 Ticket、按严重度处置、一个 RepairBatch、focused delta review、不可用预算换 PASS | 一个广泛、跨 CLI/记录/文件形状/内容绑定的语义被多个 acceptance 与 claim 承担；修复时往同一 change 增加解释、仪器与新政策。部分属真实 dependency cone，部分已成新能力；历史报告 §4 的 RC-6 逐项辨别。 | 目标与判据随 revision 一同移动；每个新行为都需新测试、新声明、新审查。不能把“所有 finding 修完”简化为封闭任务。 |
| 架构 | 同一事实只派生一次，三个读态不混淆，所有拒绝都提供可执行出口 | gate 两种记录与复用/reset/CLI 曾各自回答绑定或形状；封印义务的 `effectivenessTest` 是自由文本，reader 试图推测 check；`src/quality/obligation-check.ts:133-156,177-232` 当前还存在“passing 匹配”和“是否点名 check”两个不同判据，以及 inventory 的宽松 token→存在路径规则（当前第 10 轮 F1/F2）。`src/workflow/orchestrator.ts:1091-1117` 消费它。 | 局部修补只收掉被指出的读取点，新的消费者、模式或文件形状产生邻接反例；新增的门禁代码也进入下一轮审查面。 |
| 活性/控制流 | 失败可恢复，复发停止自动环，由人决定重写/风险接受/放弃 | 旧实现按 current revision 计算 N=3 无进展，每次修复封新 revision 导致归零；曾把 escalation 再路由 `/kata-review`（历史报告 §3、§8bis）。**现在已修**：`repair-lineage.ts:220-287` 派生链/`reviewKind`，`navigation.ts:52-56,888-915,1112-1145` 提供终局与人工确认，`review-request.ts:91-121,242-249` 带 RepairBatch。但被拒的 seal 与 review 相位/入口曾组成“先要记录新结论才能 seal、先 seal 才能记录结论”的环（调查记录 §缺陷 2）。 | safety 条件各自成立，合成后却缺可走的恢复路径；“给出补救”未经原状态端到端运行，不是活性证明。 |
| 证据/仪器 | 红的 falsifier 与通过的验证证明宣称性质 | falsifier 证明所选 `find/replace` 能令所选 selector 红，**不**证明合法等价机制、未入 fixture 的输入类型或 CLI 真驱动本修订；历史出现语法错误红、dist 旧 bundle、失效锚点、检查只运行自造状态（历史报告 §2.3，缺陷队列 I-10）。上一批 31 个都观测 supported 后，新 reader 仍产生第 10 轮 3 major。 | 补一条例子/变异通常只补一个 cell；每补一个仪器本身又多一个可审对象。 |
| 数据/交接 | request、result、revision、round append 一致且可追溯 | `review-request.ts:91-121,406-435` 现在带 `reviewKind`、`requestId`、RepairBatch；`orchestrator.ts:2149-2209` 接受 result 并写活动 `review.json`；round 行另在批准/重入时追加（`:2527-2544`）。过去第 7 轮的结果只在 `tmp`，而 result 校验曾使整轮发现无法入库（历史报告 §2.2、§8bis）。 | 交接与历史不同步导致后续模型读到“未测/空”，或昂贵的审查须重新派发；**活动结果尚未 append 并不自动等于丢失**，必须按生命周期区分。 |
| 项目管理 | WIP 小、可归属、按收益调度 | 工作区当前至少 11 个已跟踪文件有改动、多个 `.kata/tasks/*` 未跟踪；核心路由/封印/证据模块被多项任务拥有。既有队列 I-40 记录某 change 声明 73 条路径、37 条因别的提交而漂移。尾部全量 falsifier 串行重跑和独立 reviewer 时间未入轮次成本字段。 | 并行多任务的 shared core 改动放大冲突与重新 seal/review 的次数；成本和产出不可比较，现场习惯“再来一轮”。 |

### 2.1 人与工具的交接也在制造循环

独立 reviewer 只负责找反例、不写修复，这是应保留的职责隔离；但当前实际批次常把 major、minor、note、仪器和文案全数送回实现者（历史报告 RC-7、缺陷队列 §4bis），于是每批的改动面比本轮阻塞项更大。交给下一位 reviewer 时，即使 `reviewKind` 已是 focused，新增代码与证明其正确的检查本身也成为必须审的依赖锥。没有“本批次关闭什么、哪些只是记录的债务、何时转成独立工作项”的 owner 决定，就会把可选维护工作伪装成 merge gate 的必要工作。

这里不能把“完整处理已证实的问题”当作循环根因：问题在于**未先界定什么是真 finding、什么是独立的新工作，以及为何需要再封一次**。推荐方案保留整批解决已知问题的要求，只是提前定归属、一次修完同批、对复发的机制问题停自动重试。

一次昂贵的独立审查若在**结果落库**前才发现 `requestId`/`batchClosure` 的输出形状不对，审查内容与交付协议又会分离；第 10 轮首次派发曾因这两个字段在结果落库前遗漏而再次派发（本会话记录），不是产品 bug，而是 dispatch 前缺机械 preflight 的过程成本。反过来，reviewer 找出一处可复现的流程缺陷后，作者若只让自己新增的局部 selector 红，而没有实跑**原入口→拒绝→打印补救→成功状态**，就是把工具和模型都用在了错误的验收层。管理上应在每批开工前固定问题、产物、复现命令与职责，并在独立审查之前由作者交付完整的廉价集成反证；绝不把最后的独立审查当作发现协议本身不可用的首次运行。

更精确的因果图是：**宽语义/多来源 → 局部修复 + 新仪器 → 变大且改变的候选 revision → 旧证明合法失效 → 新审查 → 修复点或仪器里的同类缺陷 → 再修**。其中“修订失效”与“独立审查”是应保留的安全要求；应去掉的是*无界的目标移动、重复派生和没有可执行恢复路径的自动重复*。项目不能承诺证明“再无 bug”；可以承诺：每一个有限批次在 PASS、明确的不足/不通过、具名人承担的例外或停止/重写之间**有限步退出**，且不把后三者伪装为 PASS。

## 3. 为什么已经实施的 circuit breaker 仍未解决整件事

10 月 16 日前的诊断不能原封不动复述成“今天仍无终态”：代码已有跨 revision lineage、三种 `reviewKind`、带找前批次 finding 的 `repairBatch`、`batchClosure` 验证、`closureObligation` 检查及 `ifRecursAgain` 到期时的人工路由（详见历史报告 §8bis、`navigation.ts:888-915`、`review-request.ts:242-249`）。这是**真实进展**，应保留。

但它们主要控制**路由与字段存在**，没有证明跨层契约：

1. `closureObligation` 的自然语言 `inventory/effectivenessTest` 被 seal reader 当作可机械证明的路径/check 名称；初次 reader 把真实 obligation 永久拒在门外，改成启发式后又会误认目录/无关 token，及两条分歧判据（调查记录、当前第 10 轮 F1/F2）。问题不是“多加一个例外”，而是**人写的诊断**与**机读的证据引用**没有分层。
2. 执行补救的可达性不是由一个路由表保证的：命令准入、phase 迁移、结果落盘三处都必须通，单改第一处后另外两处仍拒绝（调查记录 §“第一版答案是错的”）。第 10 轮 F3 又表明决定是否读取豁免记录的 `requiresMatrix` 与义务本身的判定没有同一适用范围（`orchestrator.ts:730` vs `:1091-1117`），新控制器重复了原类缺陷。
3. 轮次仍缺成本与覆盖边界的客观观测；`reviewKind` 缩小**必须读的**范围，不等于不允许发现范围外新 major。新 major 应记录并归属，但若每条都立即扩当前批次/合同，focused follow-up 又会退化成开放重审。
4. 完全同一类缺陷的历史归因受 `origin/class` 缺失及未持久化结果影响。终局路由是否被触发要实测当前的 **request→result→round→lineage→nextAction** 全链，而不能只看存在一个 `ifRecursAgain` 字段或一个路由分支。
5. Kata 还在审查**自己的工作流代码**：候选代码的仪器、CLI bundle 和产生/验证 review 结果的控制器可随返修改变。只要用候选自身的结果认证候选，就存在自证或旧 `dist` 判另一修订的风险（历史报告 §2.3）。必须区别冻结的被审 source revision、实际执行的构建产物和不由被审方伪造的独立 reviewer/运行回执；这不是加一个结果字段可以解决的。

## 4. 一手方法论核验：哪些原则可移植，哪些不能照搬

2026-10-17 与 2026-10-18 通过只读 HTTPS GET 实际取得下列**发布者自己的页面**（HTTP 200）。以下为原文的窄义陈述及针对 Kata 的推论，不将外部实践说成 Kata 已经实现，也不把它们当作一个统一的行业标准。

| 一手资料 | 核实到的原意 | 对 Kata 的可用启发与边界 |
|---|---|---|
| [Google Engineering Practices — The Standard of Code Review](https://google.github.io/eng-practices/review/reviewer/standard.html)、[Small CLs](https://google.github.io/eng-practices/review/developer/small-cls.html)、[Review Comments](https://google.github.io/eng-practices/review/reviewer/comments.html) | 审查应提升整体 code health，不以“完美”阻滞进展；小而**概念完整**的变更更易及时、彻底审查，逻辑与相关测试应同批；用 `Nit` / `Optional` / `FYI` 标明非强制意见。 | 分开**经验证的缺陷**与非强制改进建议，避免一句随想直接生成一轮返修；小批次是垂直闭合的行为和测试，不是拆到 reviewer 无法理解的新 API。Google 的可选意见**不能**推导出本项目可以默认延期一个已确认的 finding，更不能覆盖 Kata 的安全与证据门。 |
| [Google Engineering Practices — CL Descriptions](https://google.github.io/eng-practices/review/developer/cl-descriptions.html)、[What to look for](https://google.github.io/eng-practices/review/reviewer/looking-for.html)、[Handling Comments](https://google.github.io/eng-practices/review/developer/handling-comments.html)、[Handling Pushback](https://google.github.io/eng-practices/review/reviewer/pushback.html)、[Speed](https://google.github.io/eng-practices/review/reviewer/speed.html) | 作者须说明改了什么、为什么、读者需要的上下文；reviewer 优先看设计、功能、复杂度、测试和周边语境。对疑问优先澄清代码，对分歧用技术理由协作或升级；快速响应的目的在于让作者有下一步，不是以速度压倒质量。 | ReviewRequest/变更说明要供独立阅读者理解意图、边界和已测事实；把可复现缺陷与问题/建议分开。Google 的“一工作日内初次响应”是该组织实践，不是 Kata 的法定审核时限或自动 PASS 条件。 |
| [GitHub Docs — Pull request reviews](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/about-pull-request-reviews)、[Protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)、[Merging a pull request](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/merging-a-pull-request) | PR 的 comment/approve/request-changes 不等价；仓库可配置 required approvals、status checks、conversation resolution、推新 diff 后撤销旧批准，合并须满足该分支的实际保护规则。conversation resolution 表示意见已处理或确认，**不证明代码已修**；stale approval 撤销是可配置项，不是 GitHub 默认必然行为。 | Kata 的 Review result、Review approval、Judge、Archive 与 Git 集成/发布分别命名；本项目的 revision 绑定不应退化成可选的 stale-approval 设置。不能凭对话已 resolved、Judge PASS 或 task archive 宣称已合并/交付。 |
| [Kanban Guide 2025.5 — Definition of Workflow](https://kanbanguides.org/the-kanban-guide/2025.5/) | 显式定义**价值单元**、开始/完成边界、流程状态、WIP 控制、流转政策、带概率的 SLE；用 WIP、throughput、work item age、cycle time 看流动。 | Kata 的价值单元应是达到约定验收的交付切片，不是“做了一轮 review”或“生成一个 finding”。对会碰同一 shared-core 的任务控制 WIP；有真实历史数据后再给 SLE。指南不要求任意固定的 WIP=1，更不允许用时间上限强制 PASS。 |
| [Scrum Guide 2020 — Product Backlog / Definition of Done](https://scrumguides.org/scrum-guide.html) | Product Backlog 是渐进、有序的产品工作表；Definition of Done（DoD）规定 Increment 所需质量状态；未达到 DoD 的条目不能发布为完成。 | 把**完整产品雄心**与当前交付切片分开：分期是排序而非删减目标；每片的验收/质量门在执行前写清。新增需求回到有 owner 的优先级决策，不在修复中偷偷改变 DoD；重大证据缺口不能按时间盒变成完成。Kata 不必引入 Scrum 的全部角色、仪式或 Sprint。 |
| [Google SRE — Postmortem Culture](https://sre.google/sre-book/postmortem-culture/) | 显著不良事件触发无责复盘；弄清 contributing causes，留下有效预防措施；postmortem 本身有成本，应预先定义触发条件，跟踪并审阅 action items。 | 同类故障跨轮复发或修复使 gate 无法运行时才触发**单独的机制级纠正行动**，记录 owner、覆盖面、验证、到期；不对每条 nit 启动 RCA。SRE 讨论的是运营事故，不能将一次代码审查 finding 自动当成事故。 |
| [DORA — Software Delivery Performance Metrics](https://dora.dev/guides/dora-metrics/) | 分开衡量部署的 throughput 与 instability（包含 change fail 和 deployment rework），并追踪恢复时间；这是软件**交付到生产**的度量。 | Kata 可借鉴“效率与稳定性成对看”，但 `review rounds`、falsifier 运行次数、pre-merge finding **不是** DORA 的部署指标。项目内部需另定义 slice lead time、返修来源、逃逸重大缺陷、被拒状态可恢复率等；不能为减少轮次而降低证据门。 |

归纳为三个**有出处但属于本项目设计选择**的原则：① 定义能“完成”的最小价值单元及其非降级 DoD；② 将可选意见、交付缺陷、系统性纠正行动分在不同的工作队列；③ 同时观察流动成本与安全后果。外部页面没有给出 Kata 的 schema、相位机或 stop-line 阈值；那些必须由本项目先设计、再实测。

## 5. 工作流方案比较（不预设需要再加多少门禁）

| 方案 | 怎样做 | 首期成本/长期维护/模型升级 | 最大风险与适用条件 |
|---|---|---|---|
| **A. 交付切片 + 独立机制纠正行动（已选）** | 用既有 Verify、独立 Review、RepairBatch、focused follow-up 交付一个完整切片；当发现**工作流本身**的复发性失效，启动关联但独立的机制级任务，当前切片按依赖停住；把同一类跨模块事实提升为覆盖全部相关读写点的版本化协议与真实路径测试，不以每个反例新增局部例外。 | 中等一次性成本：先整理工作单元/归属/结果协议，再按试点结果逐个收敛重复派生；每轮少做无关重审。稳定 schema 后宿主模型升级通常无需改确定性判据，但审查质量与提示模板仍要验证。 | 双队列和依赖关系须明确，机制修复不能靠“另开任务”让当前切片假通过；若两任务修改同一 core，需隔离并在回填后重验对应 revision。 |
| **B. 在当前单 change 循环中继续局部加防护** | 对 r10 等 finding 补对应条件、instrument、文案和例外，沿原有 seal→verify→review 运行。 | 单例修复最快，但每新增 reader/例外都加审查面；随着轮次重封、重跑、重审，成本以历史 repair 比例和实际耗时决定，不能预估为零。模型变更仍可能改变 prose reader 的判定。 | 没有分清交付与机制修复；同类问题会在相邻消费者和 profile 中反复出现。只适合真正局部、可举证无共享语义的新缺陷。 |
| **C. 一次性重写全套治理引擎** | 重新设计所有 phase、record、ledger、assurance、store 与 CLI 的统一状态机。 | 最高迁移和验证成本；短期推迟所有交付，触碰 legacy records、用户信任边界和自举验证。理论上可统一接口，但全面模型变更会引入自己的大量新审查面。 | 只有方案 A 的真实试点证明现有分层无法保证关键安全/活性契约，才值得立项；不得因为连续几轮难收敛就预先假定全量重写更安全。 |

已选定的 **A** 是治理问题的分层，而不是“换个名字继续循环”。B 是修具体小 bug 的工具，不能成为项目级方案；C 留作有失败证据的备选。这里的高/中/低是**设计复杂度排序，不是测得工时**。在没有阶段成本数据前不报“省 X%”或指定触发几轮的任意门槛。

## 6. 路线 A：双工作单元的操作契约（设计稿已确认，未批准实施）

### 6.0 与现有实现的接口审计：有图，没有 task 级依赖门

| 现有事实 | 源码 | 设计后果 |
|---|---|---|
| Kata 已有 `task/change` 端点、`blocked_by`、`repairs`、`depends_on` 关系；图 v2 的 edge ID 在同边重写时稳定，lifecycle 写入可拒绝环 | `src/core/relations.ts:9-44, 192-290` | **复用同一关系图**，而不是另建 work-item 数据库；依赖边必须有稳定 ID、同类去重与无环检查。 |
| 普通 `relations add` 只写关系类型与文本 reason；带 `policy: blocks` 的 `lifecycle attach` 服务于 **Initiative→task**，其检查只阻止 Initiative closure，且只看 edge 上的 `blocks` policy、不核 C 已返回 | `src/cli/relations.ts:83-115`、`src/cli/lifecycle.ts:91-115`、`src/core/initiative-lifecycle.ts:377-404` | 现有 `blocked_by` **不阻止 task 的 seal/verify/review/judge/archive**；不能写一句 relation 就宣称恢复安全。Initiative 的 `blocks` 关系也不能原样借来作为 task 的解锁机制。 |
| `orient --task-kind` 只回显本次参数；task schema 是 `additionalProperties:false`，没有持久化的 `workUnitKind` | `src/cli/tasks.ts:645-659`、`schemas/task.schema.json:1-20` | 不能把 orient 参数当正式分类。若需要机读的双单元类型/返回凭证，须设计**版本化扩展**并另获受保护 schema 的修改授权；本次没有授权。 |
| 原有路由能在复发后建议人工出口，但未读取 task→task 依赖 | `src/workflow/navigation.ts:888-915`、`src/workflow/lifecycle-reconciliation.ts:200-245` | 下一步建议与 CLI 真正准入必须读**同一依赖决策**；单改 status 文案不足以阻止直接调用命令。 |

因此路线 A **不是**现成功能的配置开关，而是利用已有 task lifecycle/关系图、补一个受限的 task 依赖协议。分类/图/返回凭证各只保留一处权威记录；不要并行写 `.kata/tasks/<id>/task-relations.json`、task.json 和图（历史上这种三处派生已失败，见 `src/core/relations.ts:390-411`）。

### 6.1 单元、入口与 DoD

**Delivery（交付切片）** 是既有 Kata task：它是完整产品目标的一段**可交付能力**，不是把产品需求拆没。Ready 应明确上游目标、当片验收与风险等级、可执行用户路径、受影响面、测试/证据选择器、owner 和非降级 DoD；进入 Build 前将这份合同固定。独立 Verify/Review/Judge 是候选认证，**不是正常 Done**：正常 Done 还须用户指定目标上的实际集成及产物重验、archive_gate 明确批准、安全归档并留存记录（§8.5）。未集成的状态是 `approved_awaiting_integration`，历史 `null` 或 recorded gap 不能被换算成 PASS。

**Corrective action（机制纠正行动）** 也是**普通受管 Kata task**，走同一 `intake→design→implement→hardVerify→review→judge→archive`，而非旁路“修门禁”快捷通道。入口条件是可证实的项目机制缺陷：跨 revision 复发的同一不变量、拒绝后的补救不可执行、同一权威事实的两个读者冲突，或独立审查/证据有效性受到破坏。仅仅多了一条局部 bug 或一条可选意见不够。其 Ready/DoD 必须载明：`classKey`（不变量+边界，而不只是字符串标签）、来源 finding/request/revision、producer/consumer **全站点清单**、原流程可复现反例、整改动作、能因撤销修复而失败的有效性测试、owner 和失效/升级条件。前置核准仍由人负责。C 的独立 Judge PASS 只满足 D 返回重验的**必要条件**；C 自身也须经用户授权进入其指定目标、在目标重验并安全归档，才是 C 的正常 Done。D 的依赖是否解除仍按同一 `DependencyDecision` 与 D 的新证据判定，不因 C 归档自动 PASS。

**关系**只有一个方向：只有可复现证据把机制缺陷连到 D 的验收或认证路径，才说 D 依赖 C；不能因为 C 活跃或两者都碰 shared-core 就自动挂靠。若 Delivery D 的判定确实依赖 corrective task C，记录 `D --blocked_by--> C`，附该 edge 的稳定 ID、来源 finding/类、受影响假设/路径、required return。C 可以阻塞多个 D；边不能形成环；同一 D、同一 classKey、同一不变量在未解决期间只认一个纠正行动，不因新 reviewer 再报而复制工作。无需另写反向 `repairs` 边造成双来源。记录边的动作必须在原 finding 尚阻止向前时完成；若边写入中断，finding 仍未闭合，status 报告不一致而非偷偷放行。旧的纯文本 `blocked_by` 边不自动升级成“已满足”，必须由 owner 归类后再用于门禁。

`workUnitKind`、typed dependency 和 return evidence 是**提议的协议字段，不是当前 schema**。为避免禁止改 schema 与无类型旁路的两难：先在设计/fixture 确定字段、兼容读取与保护边界，再由 owner 单独批准受保护 schema 的最小版本演进；不通过在 task title 或 reason 里塞隐形可机读标记实现。

### 6.2 一份决定、两个正交身份

概念上只需要如下稳定输入与纯决策（字段名称是**拟议契约**，非现有 API）：

```text
DependencyInput = {
  edgeId, parentTask, correctiveTask, classKey, sourceFindingIds,
  affectedPaths, requiredReturn: revalidation,
  parentRevisionIdentity, correctiveApprovedRevision,
  integrationIdentity, returnEvidence
}
Decision = absent | pending(reason, runnableRoad)
         | undetermined(reason, ownerRoad)
         | ready_to_revalidate(scope, nextLegalCommand)
         | revalidated(boundIdentity)
```

**不要将内容身份与依赖身份混为一个哈希。** 原 `revisionId/manifestHash` 仍只描述代码内容；另计算 `dependencyIdentity`，绑定稳定 edge ID、C 被独立 Verify/Review/Judge 接受的 revision、确已进入 D 工作树的集成提交/受影响路径摘要、D 的当前 revision 以及参与判断的协议版本。D 的候选代码字节未变，不得靠改写其 revision ID 伪造“新内容”；但 dependency edge/C revision/集成状态任何一个变化，旧的 D Review/Judge 结论**必须失效或进入具名需重验**。`.kata/**` 仍不进入内容 revision，关系作为治理证据另行绑定。既有 `candidateFreezeSha256`/`codeManifestHash` 对 D 声明外改动的校验不能被新字段取代。

决策只基于关系图中 D 的相关边和两个 task 的已认证记录、集成快照，不因 status 顺手扫描全仓。图读取损坏、旧边没有必需字段、C 的记录损坏、集成摘要不能判定时为 **undetermined**，不默认为无依赖；没有边且没有待关联的机制 finding 才是 absent。结果作为一次快照提供给 status、前进门禁及 ReviewRequest，绝不在各动词内重新推导“C 是否完成”。涉及 task 锁与 repo 关系图锁的跨记录写入须有确定顺序、可重试的幂等步骤和混代读的拒绝/恢复策略；不要假定两次独立写入天然原子。

### 6.3 有限状态的阻塞与返回路线

| D 观察到的状态 | 允许的工作 | 不允许的结论及应打印的出路 |
|---|---|---|
| `absent` | 按原 Kata lifecycle | 无新增门；旧任务**不会**仅因不存在 A 字段而变 blocked。 |
| `pending`：C 未独立通过，或通过但未集成到 D | D 可调查、写测试、修补当前候选；C 按自己的生命周期前进 | D 的新 seal/认证准入与 Judge/Archive 均不得放行，既有 seal 只作历史证据、不代表新依赖身份；显示 C、owner、当前可执行的后续命令和为何还没有集成。若原 finding 是机制可信度缺口，std/strict 都不得绕过。 |
| `undetermined`：边/记录不可读、字段不兼容、无法确认集成 | 只读诊断和具名修复 | 与 pending 一样不允许新 seal、Review 批准或 Judge/Archive，不可判 satisfied；打印**真实可走**的修复记录或 owner 裁决入口，不许建议当前 phase 无法进入的 Review。 |
| `ready_to_revalidate`：C 独立通过且已由 owner 明确集成 | D 通过**现有合法 repair/return 入口**重新 seal、Verify、按现有审查契约执行独立 Review（允许 focused follow-up）；将 C 的影响路径/假设纳入审查请求 | 不能凭 C 的 PASS 直接宣告 D 的旧 PASS 有效，更不能从 `implement` 直接跳 `review`。若 D 在某 phase 无合法返回入口，先补状态机及端到端测试，再启用依赖协议。 |
| `revalidated`：D 对新的依赖身份和当前内容完成所需证据/审查 | 按原 Judge 与人工确认，再由用户选定目标集成、在目标复核，最后经 archive_gate 安全归档；不能用此状态直接称 Done | C/边/集成字节/D 候选任一漂移，退回 `ready_to_revalidate` 或 `undetermined`；只保留审计历史，不删除边伪装从未阻塞。 |

路由提示与真实命令准入问同一个 `DependencyDecision`；必须验证**直接 CLI 调用也不能绕过**，而不是仅在 status 推荐上显示 blocked。独立 reviewer 仍只收冻结的 ReviewRequest，父子关系的引用是机械生成并纳入它的阅读面，不另送作者写的背景简报。C 先独立认证（Verify/Review/Judge）、后由人授权集成，再 D 重验：不得由 C 自称“我已修好”签发自己的 return receipt。返回不额外等待 C 的 Archive 才能开始 D 重验，但 C 自身不因此算 Done；Archive 仍由用户在其原信任门决定。C 若修改了 Kata 的认证器或 reviewer 入口，须以独立于候选的执行/审查来源核验候选实际构建产物及其 revision；尚无可信评价器或受认可的启动链时，C 的批准资格是 `undetermined`，不能由它自己发行一张 PASS 来解锁 D。对于跨仓工具，集成身份是可复核的工具版本和实际运行产物，而不是将共享代码复制到 D 的仓库。

### 6.4 finding 归属、停线和人的权责

每轮先做证据复核：实 bug/伪阳性/信息不足/非强制建议分开；`ReviewRequest.probes` 是完整 reviewer 义务，不能把历史 withheld 内容加进当前责任面。**属于 D 或其依赖锥的所有已确认 finding**（含 minor、仪器和文案问题）一次性编入同批处置，独立非缺陷建议才可以写 `Optional` 而非强制造新 revision。确属系统性机制问题时登记 C 及 `blocked_by`，但 D 的重大风险仍 open，直到 C 回来且 D 在新身份上完成验证。区分修了什么与谁批准了什么：owner 可拒绝错误 finding（附反证）、决定依赖或放弃；无法证实时保持 `insufficient`；任何风险接受都具名、注明影响与期限并保持 gap/非 PASS，不把 `deferred/accepted/routed` 算成 `fixed`。

沿用现有 `reviewKind`、跨 revision lineage、`ifRecursAgain` 和人工升级出口；它们负责判断何时**停止自动再试**，而不是在 C 的名称变化时清空历史。若同一不变量在一次已验证的 corrective action 后仍复发，停止再新开 C，报 root-cause action ineffective：由人选机制重写、风险承担或放弃。新且不同的不变量单独审，不用同一粗分类一概压掉。四个信任边界 `implementation/review/judge/archive` 不自动跨越。归档仍需人的决定；C 的批准与集成不是 D 的归档批准。

### 6.5 源码可验证的不变量、成本和兼容策略

* **安全**：没有 C 的独立结果、可核对的集成和 D 的后续重验，D 不得取得“无依赖”的结论；任何未完成边及其大影响 finding 均在状态中具名；失败的 seal 不发布孤儿 revision；实际运行的 CLI/artifact 必须与所审 revision 对齐，候选不能用自造 receipt 背书。
* **活性**：对于 D 各个可达 phase × std/strict/security × 关系状态，拒绝消息要么给出在**该 phase**可执行的命令链直到下一合法状态，要么明确要求 owner 的外部动作；同一拒绝重复执行不得生成无限新 C 或无限 re-seal。
* **高风险变更的场景权衡**：仅在修改关卡准入、状态转换、证据协议、审查/归档入口等项目治理机制时，设计阶段先列出至少一个合法成功路径、一个无证据/损坏记录的拒绝路径、一个真实补救/恢复路径及其成本假设；同时写明各场景从哪个 phase、profile 和实际产物起步。独立 reviewer 从冻结 ReviewRequest 核对这些声明与原 CLI 路径，不读作者私写的背景简报；这是一项风险比例化的验收设计，不增加一轮必经审查。完整 ATAM 的会议流程不移植到普通 D。
* **兼容**：现有无边 task 沿现有路走；旧 `blocked_by` 含义不明时标 `legacy-undetermined`，由 owner 明确标注/迁移，不能默认“已经解决”；历史记录原样可读。首次正式实现前需单独授权 protected schema 变更并确认有效版本读取策略。不能为兼容而保留两套相互竞争的边读写器。
* **成本**：当前 `relations add` 仅建图、没有 task gate；开发量集中于最小 typed link/return、同一依赖决策的 status+门禁消费、原 CLI 全路径测试及旧数据兼容，并非仅改 prompt。增量审查按 D 的改动边/证据 digest 复用**未受影响且仍绑定的**检查；不能凭“以前绿”免跑受影响 falsifier。审批门次数不增加，但父子各自的独立审查是明确成本；模型升级在契约稳定时不应强迫代码变更，却仍要抽检 reviewer 输出质量。轮次、时长、token 的真实节省只在试点后报告，不做现在无法证实的 ROI 承诺。

**管理边界**：D 与 C 若声明重叠的 shared-core 路径，先用独立工作树和单一集成 owner 隔离改动，再按依赖次序集成；只有证据证明路径独立才并行，同一仓库分支的未提交代码不能由另一个工作树直接取作返回凭证。看板分别记录 D/C 的开始与完成、blocked 原因/年龄、吞吐、阶段成本、同类缺陷再犯与高风险逃逸；SLE 在有足够历史周期时间后设带概率的预测，不定一个“超时就过门”阈值。这里不是 DORA 的生产部署指标。

**符号化成本下界**：方案 A 至少新增 `C 的完整受管周期 + 一次明确集成 + D 的返回重验`；对仅影响一个 D 的普通局部缺陷，通常比在 D 内直接修更贵，应走普通 RepairBatch。A 只有在同类机制风险会影响多个 D、或继续用现有门会产出不可信认证时才值得；预期节省来自避免多次 `repair→seal→independent review` 的重复/错误返修，而目前缺逐阶段样本，不能作金额或百分比承诺。

**收益估计的边界与回本式（尚非实测 ROI）**：把同一机制在未来受影响的 D 上本来会产生的重复修补、重封、Verify、**完整**独立 Review 等工作量记为 `A_i`；新增 C 的完整受管周期（设计/实现/验证/独立审查/裁决/安全归档）记为 `C`，C 的授权集成与目标复核及后续维护记为 `I+M`，每个 D 因依赖而额外发生的重封/重验/独立返修审查及必要目标检查记为 `R_i`。只有 `Σ(A_i - R_i) > C + I + M` 时，方案 A 才可能在**总人力/工具消耗**上回本；若某 D 的 `A_i <= R_i`，该 D 不贡献节省。这里对比的是**同等验收与证据标准**下的反事实，不能把过去未完成集成/归档的早停状态当成更快的 Done。对单个局部缺陷，通常 `C+I+M` 纯属额外成本；跨多个 D 复用一项纠正行动才有摊销空间。C 串行阻塞 D，也可能让某个 D 的日历交付时间上升，即使总工作量下降。

**预计的非轮次数收益**：发现同类站点和真实补救路径应降低缺陷逃逸/假 PASS 与不可恢复死锁的风险；结构化依赖和明确的未集成状态减少“已审”冒充“已交付”。这些是试点要检验的方向，不是已证明的概率改善。聚焦返修可降低单轮阅读范围，但 C 自己必须独立受审，故**总 Review 轮数可能不降反升**。不能拿历史 `origin: repair` 的 166 条全当 `A_i`：其是否同根因、是否可提前发现、产生与修复成本都尚未逐项归因。先量每项任务的 reviewer 主动时长、排队时长、token、重跑检查与集成后失败，再按质量不退化的约束计算工作量和关键路径；缺任一必要数据只报告区间/unknown，不给节省比例。

## 7. 可行性试点、验收与继续设计的决策口

**先证明能力，不先大规模修改现有 change。** 基于隔离 fixture 做一个 D、一个 C、一个边，使用前述第 10 轮 profile/obligation 死锁及旧 `dist` 判错 revision 作为对抗样本；对每条证明修复前可复现、去掉修复会红、修复后在**用户实际 CLI**上成功。试点只对正在试的 typed edge 启用新协议，其他任务不发生隐式路由改变；不伪造 reviewer、judge、CI 或“全仓已迁移”。

1. **基线与单元入口**：从 2 条历史复杂链和 1 条普通任务记录可复算的价值单元、已有成本与未知字段；D/C 明确 Ready/DoD/owner、最小影响面。试点**启动前**写下可证伪预测与采用/否决条件：合法路能否到达正常 Done、无证据是否仍拒绝、原 finding 与同类站点能否闭合，以及总等待/主动审查/重复运行成本不劣于预设上界；缺测指标标 unknown，不补编历史基线。保护 `schemas/task.schema.json` 等受控路径在授权前不编辑。
2. **依赖决策垂直切片**：先测 `blocked_by` 现在不阻止 task seal（红）；实现唯一投影后用同一份场景表测试：pending/undetermined 直调 CLI 均拒绝（安全），旧无边 task 和修好后的 D 能走到**合法成功路径**（活性），环/重复类被拒绝，拒绝后从原 phase、原 profile 按打印道路能抵达下一合法入口（恢复）；每条同时核对实际构建产物而非旧 `dist`。若任何 phase 只有拒绝没有可执行补救，停止试点回设计，而不是放宽 phase。
3. **返回与重新认证**：C 的独立 Verify/Review/Judge → 用户授权集成并在指定目标复核产物 → D 的范围/内容/依赖重新 seal/Verify/按现有审查契约执行的独立 Review → D Judge → 用户授权将 D 集成至指定目标并运行目标检查 → D Archive；C 自身也须经独立的 archive_gate 与安全归档才是正常 Done，而 C 归档不使 D 自动通过。这个先后次序须先在隔离 fixture 证明**现有 phase 真能走通**，否则先修合法返回路线，不能为过门把归档提前或偷用旧审查；不集成但 C 已 PASS、集成后 C 修订改变、D 修订改变、边被重写、记录损坏均应使旧回执失效。新旧 profile 对同一机制依赖同答；用户取消/中断留下可恢复状态。
4. **同类再犯及成本评估**：人为重现已纠正类，验证只有人工出口而非继续派新 reviewer；比较 per-stage wall time/token/重跑 selector、旧问题关闭数/新重大缺陷、实际补救成功率。将实测值逐项与步骤 1 的**事先预测**比较：合法 Done 不可达、无证据通过、原失败不再红、残余 finding 被假关闭、相同不变量再次复发或出现不可恢复状态，任一项即否决推广并报 owner；成本超过预设上界则暂停扩大试点、复核经济性，而不是削弱门禁。历史缺测保留 unknown；样本不足时仅报告不确定，不以轮次数下降代替质量。

**本设计稿已获用户确认，不等于批准写代码/修改 schema/改历史治理记录。** 后续若用户另行授权实施，须先同步既有 review 目标设计和正式 `docs/` 规格，细化 typed edge/return 最小字段、风险 owner 与迁移策略，再单独审批受保护 schema 变更及分片实现；若试点证明旧生命周期没有可达返回路径，则先把状态机改造列为明确前置工作，不以 waiver 越过闸。

## 8. 从人类 Code Review 到正确结束 Change（2026-10-18 讨论补充）

### 8.1 审查的工作是判断“这份改动能否进入代码库”，不是穷举所有缺陷

Google 的 [Review Standard](https://google.github.io/eng-practices/review/reviewer/standard.html) 以长期 code health 和团队进展的平衡为准：改善整体健康的 CL 不须达到抽象的“完美”，但确定使代码库退化的改动不能因此通过。[What to look for](https://google.github.io/eng-practices/review/reviewer/looking-for.html) 把总体设计放在首位，再看功能、复杂度、测试、周边上下文。这是**人的判断职责**，不是让模型凭通过的 selector 宣称“代码库无其他 bug”；Kata 仍须额外满足自己已约定的 acceptance、独立审查、revision 与保证等级门槛。

对 Kata 的改进：ReviewRequest 从冻结候选修订、当前验收与声明的阅读面生成；作者提供面向独立读者的“改了什么、为什么、有哪些替代方案、用户可执行路径、变更/依赖边界、测试与未测风险”，不是授意 reviewer 接受结论的作者简报。reviewer 先读整个**概念完整的 diff** 及必要上下文，再优先沿架构边界、状态/错误路径、数据一致性、契约兼容、测试有效性追查反例；审查既不能退化为只重跑 falsifier，也不应为证明无穷未知缺陷扫描全仓。工具负责 lint/类型/可复现测试、请求和结果形状预检；独立 reviewer 负责判断选择的证据是否相关、能否被等价合法输入反驳、代码健康是否改善。高风险门禁自身变更须跑真实 CLI 路径和候选产物，不能运行旧 `dist` 代替本修订。

审查前由作者做一次廉价、可见的自检：固定最小可评 diff 与验收合同；审阅自己的 diff、测试和文档；核对变更实际覆盖的 producer/consumer；标出由内容改变而失效的旧证据；预检 ReviewRequest/result 的必填字段与独立子代理能否启动。**预检不是附加的一整轮 reviewer**；失败时直接退回作者，省掉第 10 轮首次派发那种读完才发现 `requestId`/`batchClosure` 缺失的高价返工。Google 的小 CL 原则是“小而自洽”，不能把某个不变量的两端拆开以缩小行数。

### 8.2 每条意见都有类型、证据、责任人与可审计结局

人的评审并非只产生 severity。建议把反馈分为：① **可复现的 D 内缺陷**（含测试/证据失效、门禁不可达）；② **与 D 的可信验收相连的机制缺陷**（进入 §6 的 C，D 仍阻塞）；③ **未证明的问题/假设**（要求最小复现或澄清，不伪造 finding）；④ **经反证不成立的意见**（附反证关闭）；⑤ **非缺陷的可选改进**；⑥ **经证实但独立于 D 的旧问题**（转有 owner 的单独队列，记录为何不影响 D）。reviewer 提供触发状态、期望/实际、路径/修订、影响及能证明什么的测试；作者应先修清代码使未来读者明白，再回应，不应机械照单修改，也不能以一句“不同意”抹去反例。[Google 的评论处理与分歧指南](https://google.github.io/eng-practices/review/developer/handling-comments.html) 支持对事实澄清、技术理由与必要时升级；这是协作而非 reviewer 多数票决定真伪。

**标签不改变事实**：`Nit`、`Optional` 和 `FYI` 是反馈期望的表达方式，不能把已确认的范围内 bug 改名 `Nit` 以绕门。属于 D 的所有已确认缺陷按同一 RepairBatch 完整处置：修复并由后续独立证据确认，或者进入明确的**非正常完成**决策；`routed/deferred/accepted` 不能冒充 `fixed`。若是 C，须有真实 D→C 阻塞、集成和 D 返回重验，不能只把评论标为“resolved”。GitHub 的 [conversation resolution](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches) 也只是意见被处理或确认，**不保证代码修复**。有争议时先交换可复现证据，仍无法决定则具名 owner 做范围/风险决策，保存 reviewer 的异议；owner 可以选择停止或承担非 PASS 风险，不能改写测试事实。

当前实现须特别区分“仍 open”与“拦当前 profile 的批准”：`src/quality/review-ladder.ts:30-47,112-145` 只有 `fixed` 关闭 finding，`src/kernel/types.ts:115-119` 的 `std` 只以 `blocking` 拦批准，`strict/security` 拦 `blocking` 和 `major`；`src/workflow/orchestrator.ts:2250-2280` 只拒绝本 profile 达门槛的 open problem。**因此 `review approved` 不是“所有范围内问题已消失”的证明**。路线 A 建议增加的是统一的**正常完成条件**（看全部相关 confirmed defect），不是私自把 std 的 major 升格成 blocking、再造一套冲突的 severity ladder；若现有审查批准与完成政策不一致，结果诚实命名为“批准但尚未完成”，并显示未了项。

### 8.3 让反馈循环有焦点，也有停线

首次 `certification` 负责整个冻结候选及完整交付意图；作者集中回复上一轮所有明确的 defect 与问题，提交**一个可读的 RepairBatch**。修订后测试原反例在旧行为下红、新行为下绿，并覆盖同一不变量的合法等价情形；`focused_followup` 独立检查每个旧 finding 的 `closed/open`、修补代码、仪器和真实依赖锥。未受影响的证据只有在内容/依赖身份仍绑定时可复用，不能以“已看过”作豁免。第 10 轮前批次全闭合而新门禁出现 major，就是新反例必须认真处理的例子，也不意味着重扫以前整片是正确答案。

reviewer 可报告焦点之外发现的严重问题，但要写清它与当前 D 的因果关系：影响验收/认证的就进入本批或 C；确属独立工作则单列、保留原 finding 的来历，不让这次 review 自行扩成无限的新能力开发。若一个整改使同一 class 再犯或自己的检查是假阴性，按现有 `reviewKind=root_cause` / lineage / `ifRecursAgain` 停止自动排新一轮普通审查，交 owner 选择重写机制、明确非 PASS 风险出口或放弃，不因改 finding ID、换模型或重封 revision 重置次数。**停止自动循环不是给当前 change PASS；只是停止用重复 reviewer 成本替代设计决策。**

人的 review 何时算结束：候选内容和审查边界明确，所有 *required* 意见各有可验证处理，所有当前验收/声明证据有效，重大新反例已处理或明确阻断，独立 reviewer 对当前 revision 做出可追溯结论；仅剩清楚标为可选的建议可不生成下一 revision。不要求“全世界再无 bug”或“下一轮发现零条”这种不可证明的终止条件。Google 的快速响应建议在这里仅意味着拒绝时给作者可执行下一步，**不是**设置到点自动通过的审查 SLA。

### 8.4 四种容易被说成“做完了”的不同事实

| 事实 | 能证明什么 | **不能**证明什么 |
|---|---|---|
| Review result 已记录（`review.json` pending） | 独立 reviewer 对某请求/修订报告了发现、覆盖和批次处置 | Review 已批准、所有 finding 已修或可归档；`src/workflow/orchestrator.ts:2174-2188` 会将 result 写为 pending。 |
| Ledger/Verify PASS、Review approved | 声明的证据条件和本 profile 的审查批准，绑定相应内容/请求；`distill-gates.ts:77-128` 复核 | D 的全部已确认范围内非阻塞缺陷必然 fixed；集成目标已验证、代码已合并。 |
| Judge PASS | 对当前验收标准逐项有合格证据，且 Judge 使用接受的证据（`src/workflow/distill-gates.ts:133-173`） | 审查清单以外一切风险归零，或用户已授权 merge/publish/archive。 |
| `kata-cli archive` 返回 phase `archive` | 经 archive_gate 的治理归档；知识/证据应保存，可能清理工作树（`src/workflow/orchestrator.ts:3080-3160,3230-3325`） | Git commit/merge/push 或产品发布已发生；`worktreeCleanup.kept` 也不能说工作区已清干净。 |
| 基线分支/发布目标有明确集成证据及该目标的测试 | 本片确已进入选定交付位置 | Kata 的 Judge/Archive 因而可以跳过，或无需检查是否改变了被审内容。 |

**两类终点不能混名**：正常交付完成（建议命名 `delivered_and_archived`）、已认证但尚未集成（`approved_awaiting_integration`，仍在途）、主动终止/放弃（`stopped_not_delivered`）、由人记录风险缺口（`human_waived_with_gap`，**不是 PASS**）。**已选定：只有集成目标复核通过且治理记录安全归档，才称正常 Done。**这些名称是**拟议的管理结论**，不是当前 `schemas/task.schema.json` 的状态，也不是建议立刻增加四个 engine phase。主动终止或非 PASS 风险出口可以关闭治理事务，但不能称 `delivered`；尚未独立判断的 open major/minor 不能因 std 审查批准就消失。

### 8.5 已选定的正常 Done 判据与待验证执行路径

1. **冻结候选**：验收/范围/风险及内容 revision 可读；作者交最小自洽 diff、测试/文档和风险说明。所有范围内 confirmed finding 有逐项处置，独立纠正行动的阻塞边也列全；不能靠改名或缩小声明删掉问题。
2. **独立审查与裁决**：Verify/ledger 的当前证据、Review 批次和结果、Reviewer 批准、Judge 逐 AC PASS 按既有信任边界走；遗留 `unknown/null`、结论缺失、仅 `routed/deferred` 或未返回 C 不构成正常完成。Reviewer 只判断，不写被审代码或代作者补测试。
3. **由用户决定集成目标及动作**：保留分支、合并、推送、发布是不同操作，均先报告实际改动范围和受影响的其他提交；不要从 Judge PASS 推导用户同意 merge/push。若选集成，须能在目标分支核对**同一候选内容和实际运行产物**，重跑目标环境必要检查；合并引入冲突、集成后的实际字节或外部依赖身份改变，则回到合法修复/重验入口，不偷用旧 reviewer 结果。C 的修复须先真实进入 D 才能让 D 重验并结案。
4. **证据保存、归档和安全清理**：保留 task/review/judge/ledger 的独立可读记录，完成 wiki closure；经过 archive_gate 的明确人工决定再归档。`archive` 可能从 `judge` 先进入 `distill`、后因未支持 claim、未承接的 waiver 或 wiki 缺口而返回 blocked（`orchestrator.ts:3130-3205`），所以只认**最终 phase 与诊断**，不以调用过命令为完成。清理前核对 worktree 是否含唯一治理记录或未提交工作，拒绝时保留并上报，绝不 `--force` 擦除。当前 `.kata/tasks/**` 默认不随 Git 提交/推送：若要求外部审计可见，必须逐 change 明确选择并核对记录交付方式；本报告不暗中纳入全仓 task 目录。

**已选定的正常 `Done` 判据（实现仍待设计与验证）**：`当前候选/合同可读且匹配 ∧ AC 当前 Verify/ledger 充分且 Judge PASS ∧ 当前 revision 上有合格独立 Review ∧ 本 D 所有已确认范围内 defect 逐项 fixed/经证据推翻 ∧ 必需 C 已独立认证、授权集成且 D 返回重验 ∧ 用户指定目标已集成并在目标复核 ∧ archive_gate 人工批准、最终 phase=archive、记录仍可读`。其他路径有自己的真实名称，不把“人接受风险”“暂停”“已讨论”“已有审批”简写成 DONE。对于仅做文档的 change，“集成”也指内容进入约定目标而非生产部署。

**此顺序是待验证的设计，不是当前 CLI 已有的一键路径**：现有 Archive 可能清理子工作树，而相同 task 的治理记录可能只存在于该工作树。必须先在隔离 fixture 测 `Judge→用户选目标→安全集成/迁移记录→目标重验→Archive` 对所有可达 phase 可执行；如果记录无法随集成保留、或者目标重验必须改变已认可的 revision，先补合法返回机制并重新取得证据，不许把文件手搬/跳状态/调低验证当成“收尾”。用户若选择“保留分支不集成”，停在 `approved_awaiting_integration`，明确告诉用户它尚未交付；不要为了清看板催 archive。

### 8.6 最小反证与成本检验（不是新增一套全量审查）

试点以真实 CLI/目标分支的双向反证为准：① std 下有 open 且属 D 的 major，即使 review approval 可达也不能发布 `delivered_and_archived`；② 评论 resolved 或 finding 仅 `routed/deferred`，无修复证据不能变 `fixed`；③ C Judge PASS 但未集成、C 变更后的身份漂移、D 外部依赖/代码漂移，各不能复用 D 旧 PASS；④ archive 在 `distill` 拒绝、或 worktree 保留治理记录时，不谎称归档/清理完整；⑤ 合并到目标后真实检查失败，保留分支和证据、停止完成；⑥ 恢复原失败行为或旧 bundle，所宣称的补救测试必须红。每条都测**应当准入的正常路**，不能做成“所有东西都拒绝”的假安全。查看一条路线拒绝后打印的道路是否从那个 phase 真能走到终点。

指标分开记录作者返修时间、reviewer 主动时间/等待时间、每轮 token/重复执行、已确认 defect 的修复比例、集成后失败/回滚；把非缺陷建议从缺陷数中剔除，但不得剔除被批次证实的错误。人类 review 的速度建议可指导降低排队与上下文切换，不可拿“轮次少”或“意见 resolved 数”单独衡量质量。由于现有记录缺逐阶段成本和发布后失败样本，这些是**拟议的可观测性/试点标准**，不是本报告已验证的节省结论。

**产品语义已选 A**：正常 `Done` 只指代码/文档已进入指定集成目标、在目标重验并且 task 已安全归档；`approved_awaiting_integration` 不算 Done，也不为清看板提前 Archive。若用户另行明确选择终止或非 PASS 风险承担，那是有不同名称与审计结果的**非正常退出**，不能记作 `delivered_and_archived`。下一步需验证这条执行路线与记录保存/工作树清理能否在现有 CLI 上成立；若不成立先修机制，不以豁免或手搬记录假造完成。本节仍只讨论设计，不授权修改 task schema、放宽 gate、合并或发布。

## 9. 补检的五类方法论：哪些真正改变工作流（2026-10-18）

这是对 §4 的**增量**检索，不重新发明一套生命周期。搜索结果只是发现线索；以下命题均回到发布者原文核对：NASA 的 Handbook Ver D 页面、NIST 的 SP 800-218 v1.1 原版 PDF、CMU SEI 的 ATAM 方法页、Martin Fowler 自己的 CI 文章和 Deming Institute 的 PDSA 页面均通过只读 HTTPS GET 获取（HTTP 200）。NASA 页面是该版本的说明，不主张它就是今天对 Kata 有约束力的标准；NIST 的安全实践也不能无条件套在所有非安全缺陷上。

| 方法与一手出处 | 这次核对到的原意 | 给 Kata 增加了什么 | 不照搬什么 |
|---|---|---|---|
| [NASA SWE-087：同行评审/检查](https://swehb.nasa.gov/spaces/SWEHBVD/pages/102695472/SWE-087+-+Software+Peer+Reviews+and+Inspections+for+Requirements+Plans+Design+Code+and+Test+Procedures)、[SWE-088：清单、准入与跟踪](https://swehb.nasa.gov/spaces/SWEHBVD/pages/102695473/SWE-088+-+Software+Peer+Reviews+and+Inspections+-+Checklist+Criteria+and+Tracking) | Ver D 的 SWE-087 §5.3.2 要求对计划所指定的需求、计划、设计、代码、测试规程开展并报告评审；SWE-088 §5.3.3 要求用 checklist 或正式阅读技术、预定义 readiness/completion、追踪 review action 至解决。SWE-087 的指导示例还有入口/成功条件以及返修后的 follow-up 复核。 | 对**会改治理判断本身**的候选，独立 reviewer 的输入不仅是代码，还包括准入材料、评审视角和成功条件；每项 action 有归属、处置和后续复核。现有 RepairBatch/`batchClosure` 是一个起点，缺的是在派发前证明输入完整、在返回后验证**原失败路径和同类站点**，而非再加无主的 checklist 字段。 | NASA 面向任务与安全关键软件，正式检查的人力/会议成本高；不对每个文档改字执行全套仪式。该 Ver D 页面提到非主要缺陷可随成本/进度安排，**不能**据此把 Kata 已确认、属于本片的缺陷默许为 fixed。 |
| [NIST SP 800-218 v1.1：SSDF](https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-218.pdf) | PDF 的 PW.7.1 先决定何时做人工 review、何时做自动代码分析；PW.7.2 要求按安全编码规范执行并将发现的问题/建议记录、分诊到工作流；RV.3.1–3.3 分别识别根因、跨时间找模式、主动检视其他同类漏洞。 | 当 Kata 的变更触及安全相关读写器、依赖与信任边界时，从“修报告里的一个实例”转向“用一个清楚的不变量检索所有同类站点”，并把同类反例和验证效果交给独立审查。一般的 `one-fact-derived-twice` 也可**类比**这种系统性纠正思路，但应称流程/正确性缺陷，而非自动升格为漏洞。 | SSDF 不是要求每个非安全 minor 都开一次安全 RCA，更不是开了 C 就能让 D PASS。`record and triage` 也不等于可悄悄关闭已验证问题。 |
| [CMU SEI：ATAM 架构权衡分析](https://www.sei.cmu.edu/library/architecture-tradeoff-analysis-method-collection/) | 原页以组织目标对应的质量属性为准，由 stakeholders 提出具体场景，分析架构决定的风险、敏感点、权衡点及风险主题；它明确说明完整评估通常需 3–4 天和多方参与。 | 在修改状态机、关卡或证据协议**之前**，轻量写出 3 类可运行场景和可观察成功条件：合法路径可达（活性）、无证据不能通过（安全）、每轮/每批成本可接受（效率）；检验一处修改能否同时满足三者，而不是只让一个拒绝测试绿。与 §6 的 D/C 依赖、§8 的 Done 可达性共同构成评审输入。 | 不给每个 Kata change 照搬九步 ATAM 或开 3–4 天会议；取其按场景呈现冲突的分析方法，不能以“架构评估”取代 CLI 实测、独立 review 或 owner 决策。 |
| [Martin Fowler：Continuous Integration](https://martinfowler.com/articles/continuousIntegration.html) | CI 是团队将变更频繁集成到版本控制主线，每次由包含测试的自动构建核验；文章还强调主线、自检构建、及时修复失败构建和小步集成。 | 路线 A 已选的 `Done` 不可停在“隔离 worktree 中被审并 Judge PASS”：要能指出**集成目标上实际运行的字节/产物及其检查**。缩短大修订长期漂在分支上的时间，比无休止叠加封印和重审更可能减少整合时的新缺陷；按小而自洽的 D 切片集成、目标失败就停，不消耗旧认证。 | Fowler 的“每天提交主线”不是让未经 Kata 的信任边界和用户授权的半成品自动 merge，也不意味着通过构建就可跳独立 review、Judge、Archive；Git 集成 ≠ 生产发布。 |
| [Deming Institute：PDSA](https://deming.org/explore/pdsa/) | Plan 先确定目标、理论与成功指标；Do 实施试验；Study 对结果与假设比较；Act 决定调整方法、重拟理论或扩大使用。 | §7 的 D/C 试点应事先写**预测与采用条件**：能否从原拒绝状态走到合法完成、确认缺陷是否真的关闭、共享模块是否再次复发、审查主动/等待成本及集成失败率。对照现有流程做一小批代表性任务；未同时改善可靠性和可恢复性时不推广，不以“减少轮次”单指标宣布成功。 | 三个 fixture 的绿灯不能证明项目级收益；PDSA 不是证明所有新行为安全的测试替代物，也不能把不满足 DoD 的试点当已交付。 |

**与既定路线 A 的关系**：NASA 帮助定义高风险 review 的入场与退出，NIST 提醒按问题类别搜寻相似实例，SEI ATAM 让安全、活性与成本的权衡有具体场景，CI 补足“经审候选→主线目标”的实际闭合，PDSA 约束改造是否值得扩展。五者回答的是**不同问题**，不能拼成“每轮必须多开五道门”。推荐先只调整作者自检/独立评审的材料与结论格式，再用一个真实受管 D/C 试点检验 §8 的 Done 道路；是否新增字段或状态机仍须通过原信任边界和受保护 schema 的单独批准。

**对既有设计的实际调整（不是新增五道门）**：§6.1/§6.3 统一了 D、C 的正常 Done 定义（集成目标复核后安全归档；C 的认证不自动完成 D）；§6.5 为改治理机制的切片补了安全、可达性、恢复与成本场景；§7 将试点预测和否决条件前置，并要求正反路径在真实 CLI/实际产物上都可执行。独立审查、revision 绑定、四个人工信任门与已选路线 A 保持不变。这些调整是**已确认设计稿的一部分，尚未实施**；尤其 `Judge→目标集成/重验→Archive` 的合法 CLI 次序及记录保存仍需在 fixture 核实；不宣称当前 Kata 已提供这个能力。

**尚未可靠核验**：本次检索尝试了 ACM Queue 的 SPACE 原文和 Lean Enterprise Institute 的 value-stream 页面，均收到 HTTP 403；搜索引擎摘要不能代替论文或出版者页面，故不据它们声称新的测量准则。CMMI、ISO/IEC 同样不以未取到的条款作本设计依据。若日后取得可核原文，再判定是否增加了区别于既有 Kanban/DORA 与本节的真实信息。此次更新仅是项目级设计讨论，未启动 governed change、变更代码或放宽任何门禁。

## 10. 方法论的应用层次核对（2026-10-18；状态说明，不修改已确认设计）

“已检索”“已写入设计”“已在 Kata 的真实流程中运行”“已证实产生收益”是四级不同的主张，不能相互替代。本文 §4/§9 的一手来源已核验；§6–§8 把其中可移植的内容转成项目设计，但本次讨论**没有**执行 D/C 试点，也没有更改 Kata 的治理代码或受保护记录。以下为设计与已核代码事实的对照，不将关键词未检索到当作全面的不存在证明：

| 方法群 | 已在现有流程中看到的部分 / 已写进设计的约束 | 尚未应用或证明的部分 |
|---|---|---|
| Google/GitHub 人类 Review | Kata 已有独立 Review、`reviewKind`/focused follow-up、revision 绑定与 review/judge 分离；§8 区分 defect、争议与 Optional，并区分批准和真实交付。 | §8 的统一正常 Done、廉价派发前预检和范围内 finding 完整处置，不是本轮已通过 CLI 实测的新增门禁；GitHub 的配置功能也未自动等价为 Kata 功能。 |
| Kanban/Scrum 的价值单元与 DoD | §6 的 D/C 两种受管工作单元、可观察 WIP/阻塞年龄以及 §8 的正常 Done 已形成设计契约。 | **依赖门本身已在真实 CLI 上跑通（§11）**；仍未落地的是 `workUnitKind` 分类、目标集成/复核、归档记录保存与成本采集，所以仍不能报 D/C 双工作单元已上线。 |
| SRE/NIST 的类级纠正 | 已有跨 revision lineage、复发出口和部分 closure obligation；§6 规定 C 的同类站点清单、有效性反证、owner 与 D 返回重验。 | 没有证据证明新 D→C 依赖协议已强制生效；安全领域的 SSDF 只为适用范围内的类级扫描提供方法，不是所有 review finding 的新政策。 |
| NASA/SEI ATAM 的评审准入与场景权衡 | §6.5/§8 规定高风险机制变更先覆盖合法成功、拒绝、补救与成本；已有独立评审可承担核验。 | 本轮未把这一设计接入派发 preflight，也未运行所有 phase/profile 的正反路径；不声称完成了 NASA 正式检查或完整 ATAM。 |
| Fowler CI 与 Deming PDSA | §7/§8 已写明目标分支产物复核、试点前预测、否决条件及经济性比较。 | **“集成目标复核”已落地为可机读证据（§12）**：commit 必须在目标历史中、目标检查当场运行并记退出码。仍缺的是到 `delivered_and_archived` 的完整路径实测、阶段耗时/token 与交付失败基线，PDSA 的 Do/Study/Act **尚未发生**，收益也未证实。DORA 在此只是配对观察质量/效率的启发，不是已采集的部署指标。 |

本次对 `src/` 的字面检索没有命中拟议名称 `DependencyDecision`、`workUnitKind`、`dependencyIdentity`、`ready_to_revalidate` 或 `delivered_and_archived`，只见 `blocked_by` 出现在关系模块；这与 §6.0 的“有图、无 task 门”一致。**该检索发生在 §11 落地之前**：依赖决策现已实现（`src/workflow/task-dependency.ts`，名称 `TaskDependencyDecision`），`workUnitKind` 与 `delivered_and_archived` 仍未实现。ACM SPACE/Lean 页未取得可核原文，**未作为新契约应用**。所以准确结论是：**部分原则已存在于旧 Kata；新增方法论已被筛选并落到已确认设计稿；路线 A 的新机制未实施、未验证收益。**

## 11. 第一个垂直切片的落地记录（2026-10-18；已实施并实测）

§7 第 2 步（“依赖决策垂直切片”）已按用户“直接落地、不走 kata 治理流程”的指示实现。**这一节取代 §10 中“typed task 依赖尚未在真实 CLI 上打通”的表述**：该行描述的是落地前的状态，现在依赖门已在真实 CLI 上跑通，其余各行的结论不变。

**落地的机制**（`src/workflow/task-dependency.ts`、`src/cli/dependency.ts`、`schemas/task-dependency.schema.json`）：

| 事实 | 权威记录 | 消费者 |
|---|---|---|
| 拓扑：D 被 C 阻塞 | 既有关系图 `.kata/relations.json`（`blocked_by`/`depends_on`，task→task） | 依赖决策读取，不另写拓扑 |
| 返回凭证：C 的哪个 revision 已集成、D 当时的 revision | 新增 `.kata/tasks/<D>/dependencies.json`（不重复端点，按 edge id 键） | `dependency status/record`、依赖决策 |
| 一个决策 `absent/pending/undetermined/ready_to_revalidate/revalidated` | 纯函数 `decideTaskDependencies`（无时钟、无文件系统） | seal/verify/review/judge/archive 准入、`gate approve`、`status` 路由、`dependency status` |
| 集成是否真的在树里 | 按 C 的 ownedPaths 现算 `computeManifestHash` 与记录比对 | 决策；漂移即 `undetermined` |

**实测证据**（不是断言）：

- `npx tsc --noEmit` 退出 0；全量 `vitest run` **368 文件 / 2261 用例全绿**（落地前基线 367 / 2238，新增 23 例）；`npm run check:wiring` 退出 0（11 条既有 findings，未新增）。
- 新用例 `tests/unit/a-blocked-task-cannot-cross-its-gate.test.ts`（23 例）分两层：纯决策的 8 个状态、以及真实命令（`runCommand` 的 seal、`runGateCommand` 的批准、`runDependencyCommand` 的写入与状态）。
- **反证**：把 `runCommand` 的准入断言、`dependencyRefusal` 的抛出、`gate approve` 的断言三处同时停用后，3 条命令级用例转红；恢复后 23 例全绿。即“去掉修复就会红”。
- **真实 CLI 端到端**（`dist/cli.js`，重建后与源码一致；隔离 fixture）：`relations add` 建边 → `dependency status` 报 `pending`、road = `kata-cli status --change corrective` → `build --seal` 以同一句拒绝 → 补上 C 的 revision/judge 记录后状态转 `pending(return_not_recorded)`、road 变为 `kata-cli dependency record …` → **执行该 road 成功**（写入集成哈希）→ 状态 `ready_to_revalidate`：`seal/verify/review` permitted，`judge/archive` 仍被拒并说明要先重验 → `status` 的 `upstream.taskDependency` 同时发布 state、逐入口结论与 blocker。

**为不重复既有缺陷而做的三处修正**（都是本轮实测发现的）：

1. 状态输出最初把 `describeTaskDependency`（async）未 await 就展开，`status` 打印了 `{}` 而门禁照常工作——即“读到的不是发布的那份”。改为一次读取后由 `summarizeTaskDependency` 发布。
2. 返回记录省略 `subjectRevisionId` 时读回是 `null`，与 `undefined` 比较会把“未重验”误判成 `revalidated`，从而放行 `judge`。改为两侧统一归一化。
3. `ready_to_revalidate` 没有 blocker，若只发布 state 就会在 `judge` 被拒的同时显示“无阻塞”。故 summary 与 `dependency status` 共用 `dependencyEntryReport`，逐入口发布结论（单一派生）。

**仍然没有落地的**（不得据此宣称已完成）：§6 的 `workUnitKind` 类型化与 D/C 双工作单元的 CLI 入口、目标集成/复核与 archive 记录保存（§8.5 的第 3–4 步）、派发前预检、成本采集与 PDSA 试点、以及 §7 第 3–4 步。依赖门目前只覆盖 task→task 的 `blocked_by`/`depends_on`；`gate approve` 的门禁映射按边界判定，尚未覆盖所有 profile。本轮**未**提交、未推送、未归档，也未改动任何既有 schema（新增 `schemas/task-dependency.schema.json`，未修改既有文件）。

## 12. 第二片落地：正常 Done 的判据（2026-10-18；已实施并实测）

§8.5 第 3 步（“由用户决定集成目标及动作”）与“已认证 ≠ 已交付”的命名已实现。**这一节取代 §10 中“目标集成/复核尚未打通”的表述**，并把 §8.5 的 Done 判据从设计推进到可机读状态。

**新增**（`src/workflow/completion.ts`、`src/cli/completion.ts`、`schemas/task-completion.schema.json`、`kata-cli completion status|integrate|stop|waive`）：

| 状态 | 判据（全部由证据推导） |
|---|---|
| `uncertified` | 无当前 revision，或当前 revision 上没有绑定它的 Judge PASS |
| `approved_awaiting_integration` | 已认证但没有指明该 revision 的集成证据；**在途，不是完成** |
| `delivered_and_archived` | 集成证据指向当前 revision、记录的 commit 确实在目标历史中、且治理事务已关闭（phase=archive） |
| `stopped_not_delivered` / `human_waived_with_gap` | 具名的人工决定（reason / reason+impact），**明确不是 PASS** |

**集成记录是证据而不是声明**：commit 必须解析到目标 ref 且是其后代（SHA 对 SHA + 退出码，不解析 git 的措辞），`--check` 指定的命令**当场运行**并记录退出码，非零即拒绝且不写入。目标 ref 在本仓库不存在时报 `commit_unverifiable`——**“查不了”绝不报成“已集成”**。`stop`/`waive` 拒绝覆盖已存在的交付证据。

**实测证据**：`tsc --noEmit` 退出 0；全量 **369 文件 / 2278 用例全绿**（第二片前 368/2261，新增 17 例）；`check:wiring` 仍是既有 11 条 findings，无新增。**反证**：把 `commitReachesTarget` 改成恒真（即相信操作者的声明）后 3 条用例转红；恢复即绿。**真实 CLI 端到端**（重建后的 `dist/cli.js`）：已认证未集成 → `approved_awaiting_integration` + road；目标不存在 → 拒绝；`--check false` → 拒绝且不写入；正常集成 → 记录成功、状态转 `archive_not_reached` 并给出 `kata-cli archive` 这条 road；`status` 的 `upstream.completion` 发布同一事实。

**本轮未做**：§8.5 第 4 步（归档前核对 worktree 是否含唯一治理记录、记录保存与清理）尚未与本状态串联；`archive` 仍**不**因缺少集成而被拦（按已确认设计：用户选择保留分支时应停在 `approved_awaiting_integration`，不催归档）；`workUnitKind` 与 D/C 双工作单元入口、派发前预检、成本采集与 PDSA 试点仍未落地。到 `delivered_and_archived` 的完整路径（wiki closure + ledger + review + judge → archive）未端到端驱动，其归档那一半由纯决策用例与既有 archive 用例覆盖。依赖门与完成状态都**未提交、未推送、未归档**。

## 13. 第三片落地：派发前预检（2026-10-18；已实施并实测）

§8.1 的自检已实现，且是**唯一一片直接冲着减少审查成本去的**：它消灭的是“花掉最贵的一步之后才发现请求不完整”。

**新增**（`src/workflow/review-preflight.ts`、`kata-cli review --preflight`、kata-review skill 第 2 步的一段）：

| 输出 | 内容 |
|---|---|
| `blockers` | 已注定白跑的派发：请求回答的是另一个 revision、请求声明的路径不存在、`focused_followup` 没有 batch、probe 没有命令、phase 不可评审、当前 revision 不可读、**工作树已不是被冻结的那份内容** |
| `handoff` | 机器可读的“要交什么、结果必须回什么”：`requestId`、`reviewKind`、`mustEcho`、**每个 batch finding 的 id**（`batchClosureIds`）、声明面、probe 数 |
| `briefState` | `absent / usable / unreadable`——区分“这一步还没做”与“这一步做坏了” |

**关键设计点（本轮实测出来的边界）**：预检**不能**拦“进入 review 阶段”的那次调用——按 CLI 打印的阶梯（`verify` → `gate approve` → `review`），那一刻还没有 brief，拦它就把流程打断；而真正浪费 reviewer 的动作（作者自己去派 subagent）根本没有 CLI 调用。所以：`--preflight` 是只读报告（不消费任何 gate/phase），入口只在**已存在且不合格的 brief**上拒绝，且发生在 `requireUserChoiceGate` **之前**（否则一次批准的 gate 会被这次拒绝花掉——本轮实测到这条顺序约束）。

**实测证据**：`tsc --noEmit` 退出 0；全量 **370 文件 / 2287 用例全绿**（本片新增 9 例）；`check:wiring` 仍是既有 11 条。**反证**：让预检对“请求回答另一个 revision”失明后 2 条用例转红（含入口那条），恢复即绿。**真实 CLI**：`--preflight` 打印 `mustEcho` 与 `batchClosureIds`（正是第 10 轮实测到的缺口）；把请求改成回答另一个 revision 后，`review` 在**消费 gate 之前**以两条具名 blocker + 两条 road 拒绝。

**仍未做**：§8.5 第 4 步、`workUnitKind`、成本采集与 PDSA 试点；预检不覆盖“作者写给 subagent 的散文 brief”（机制看不到它，只能把要求变成可复制字段）；本片未提交、未推送、未归档。

**过程记录（本轮实测到的两个坑，供后续复用）**：① kata-review 的 skill 文本是**生成物**（源在 `src/adapters/phase-guidance.ts`，渲染到 `.agents/skills/*`，由 `generated-assets-are-current` 守卫），直接改渲染文件会失败；`kata-cli update` 只在 `dist/cli.js` **已重建**后才会发现漂移——先跑 update 得到“写入 0”是因为 dist 还是改动前的（本轮先犯了这个错，重建后写入 2）。② 预检若拦“进入 review 阶段”的那次调用会打断 CLI 打印的阶梯，因此只拦**已存在且不合格**的 brief。

## 14. 第四片落地：归档前的记录保存核对（2026-10-18；已实施并实测）

§8.5 第 4 步的核心已实现：**“治理记录安全归档”从假设变成被核对的事实**。你选定的正常 Done（A）= 已集成并重验 **+** 治理记录已安全归档；本片补的是后半句。

**新增**（`src/workflow/completion.ts` 的 `RecordsHome` + 第五个状态）：

| 事实 | 来源 |
|---|---|
| `recordsHome: primary \| worktree_only \| undetermined` | **复用归档删除守卫已经在问的同一个检测器** `uniqueCopies`（“这个 worktree 消失会丢什么”），所以“交付声明”与“删除决定”不会对同一批文件给出两个答案 |
| 新状态 `delivered_records_elsewhere` | 已集成 + 已归档，但任务记录只存在于 `.kata/worktrees/<id>`（正是 archive 会删除的目录）——**不算正常 Done** |
| 两个具名 reason | `records_only_in_a_worktree`（含文件数与持有 worktree）、`records_undetermined`（枚举不了就是“不知道”，不报成安全） |

**实测证据**：`tsc --noEmit` 退出 0；全量 **370 文件 / 2290 用例全绿**（本片新增 3 例）；`check:wiring` 既有 11 条不变。**反证**：把 `uniqueCopies` 的结果强制为空后，worktree-only 用例转红，恢复即绿。**真实 CLI 端到端**：把某任务的 `review.json` 只放在 worktree 里 → `completion status` 报 `delivered_records_elsewhere` 且 road = `kata-cli worktree recover --change held` → **按打印的 road 原样执行**，`movedCount 1` → 状态转为 `delivered_and_archived`。用例里同样跑了这条往返（状态 → 跑 road → 状态）。

**本片实测到并修掉的两个缺陷（都是“打印的 road 不成立”这一类）**：① 我最初打印的 road 是 `kata-cli recover --change <id>`，而 `recover` 是**另一个**命令（状态重建），真正搬记录的是 `kata-cli worktree recover`；按原样执行时它把状态重建成了 `intake`——正是本仓库反复出现的“拒绝信息指了一条做不到它所说之事的命令”。已改为真实命令并实测。② `worktree` 的 usage 行从未列出 `recover`（实现了却不在文档里），已补。**未作为结论的观察**：`kata-cli recover` 在 fixture 里把 phase 从 `archive` 重建成 `intake`，但那是因为 fixture 手写了 `current-state.json` 而没有对应的事件日志（真实任务不会有这种状态），故不报告为产品缺陷，也未进一步调查。

**仍未做**：`.kata/tasks/**` 不随 Git 提交/推送这一事实仍未解决（要外部审计可见，必须逐 change 明确选择记录交付方式——本报告不暗中纳入全仓 task 目录）；`workUnitKind` + D/C 双单元入口、成本采集与 PDSA 试点仍未落地；本片未提交、未推送、未归档。

## 15. 第五片落地：纠正行动的声明与“一类一主”（2026-10-18；已实施并实测）

§6.1 的 C 侧（纠正行动）此前**没有任何表示**：没有记录说“这个任务是因为某个 class 而存在”，于是同一个 class 被新一轮 reviewer 再报一次时，开一个新任务完全不受阻拦——设计里“同一 class 在未解决期间只认一个纠正行动”只是一段话。本片把它变成机制。

**新增**（`src/workflow/corrective-action.ts`、`src/cli/corrective.ts`、`schemas/corrective-action.schema.json`、`kata-cli corrective status|declare`）：

| 规则 | 实现 |
|---|---|
| **一个未解除的 class 只有一个 owner** | `declare` 在**全仓**枚举 `corrective-action.json`，同 `classKey` **且同 invariant** 且未解除时拒绝，拒绝里点名现有任务与 owner，并给出“把 finding 转过去，或先解除那个任务”的处置 |
| class 契约**复用审查循环自己的词汇** | obligation 由 `closureObligationOf`（recurrence packet / repair declarations / seal 已经在用的七字段 reader，本片把它导出）校验——不是第二套 class 定义 |
| **解除** = 该任务当前 revision 上有绑定它的 Judge PASS | 与依赖门的判据同一个，两处不会对“修好没有”给出两个答案 |
| 标签不是 class | 同 `classKey` 但 invariant 不同**不**拦（`instrument_unsound` 是一族，不是一类），避免用标签当事实 |

**实测证据**：`tsc --noEmit` 退出 0；全量 **371 文件 / 2298 用例全绿**（本片新增 8 例）；`check:wiring` 既有 11 条不变。**反证**：把“一主”查找结果强制为 `undefined` 后 2 条用例转红（含 CLI 那条），恢复即绿。**真实 CLI 端到端**：`corrective declare` 成功 → 第二个任务声明同一 class 被拒绝并点名 owner → `corrective status --all` 报 `open 1 / discharged 0` → 给 C 一个绑定当前 revision 的 Judge PASS 后 `discharged true` → **同一 class 可以被再次声明**（前一次纠正行动已花掉，复发是新行动而不是重复）。

**顺带修掉的**：`src/cli/invocation.ts` 的 `VALUE_FLAGS` 缺 `--finding`（由 `cli-flag-vocabulary` 守卫抓到），并把本片与前几片新增的值旗标一并补进该词表——否则 `parseChangeArg` 会把其中某个值读成任务 id。

**仍未做**：`.kata/tasks/**` 不随 Git 提交/推送这一事实仍未解决（要外部审计可见须逐 change 明确选择记录交付方式）；`workUnitKind` 作为任务自身的机读分类、成本采集与 PDSA 试点仍未落地；本片未提交、未推送、未归档。

## 16. 第六片落地：成本与代价的度量面（2026-10-18；已实施并实测）

§7 第 4 步与本文档反复强调的“没有可信成本数字就不宣布收益”此前**没有读取面**：`Σ(A_i − R_i) > C + I + M` 的每一项其实都已在记录里（轮次、revision、返修次数、依赖边、class 声明），但没有任何东西把它们读出来，所以这个不等式只能靠争论。

**新增**（`src/workflow/metrics.ts`、`src/cli/metrics.ts`、`kata-cli metrics --change <id> | --all`）：

| 读数 | 来源（复用既有 reader） |
|---|---|
| 每个 change：phase、完成状态、依赖状态、`revisions.count`、`rounds.count` + 逐轮与总 span、`repairs.entries`、逐阶段占用 | 状态事件日志、`review-rounds.jsonl`、`revisions/` 目录；返修次数用**阶段机自己的 `isRepairReturn`**，状态来自 `completion` / `task-dependency` / `corrective-action` 三个 owner 模块，度量不可能与它所度量的门禁给出两个答案 |
| 每个 class（`A_i` 形状）：owner、是否已解除、**有哪些 change 依赖它**（`blocked_by`/`depends_on` 边）、声明之后源 change 又走了多少轮（`R_i` 形状） | 纠正行动声明 + 关系图 + 轮次记录 |

**诚实边界写进输出本身**：时延是**两次记录事件之间的日历时间**（含人的注意力、模型延迟与全部停顿），不是工时、不是 token——kata 不做模型调用，看不到它们；不可观测的项在 `unmeasured` 里**具名列出发布**，而不是留成隐含的 0。

**实测证据**：`tsc --noEmit` 退出 0；全量 **372 文件 / 2304 用例全绿**（本片新增 6 例）；`check:wiring` 既有 11 条不变。**反证**：把返修计数换成“所有进入 implement 的转换”后 1 条用例转红，恢复即绿。**真实 CLI 读本仓库自身**：`metrics --all` → `openClasses 0 / discharged 0 / classes>1 change 0`（尚无任何 class 被声明——这正是此前算不出经济性的原因）；`metrics --change the-gates-can-be-repaired` → `phase review`、`revisions 16`、`rounds 9`、`repairs 14`、**首末轮之间 103.1 日历小时**、末段 `review` 已占用 14.26h。这些数字首次让 §6.5 的不等式可以用实测值而不是估计值来讨论。

**顺带修掉的**：`metrics.ts` 里的 `argv.includes('--all')` 被 `cli-value-reads-go-through-one-reader` 守卫抓到（手写旗标判断），改用共享的 `flagPresent`——两个拼写同一个开关是这条守卫存在的理由。

**仍未做**：`.kata/tasks/**` 不随 Git 提交/推送这一事实仍未解决；`workUnitKind` 作为任务自身的机读分类仍未落地（当前可由 `corrective-action.json` 的存在派生，未发布为字段）；PDSA 试点需要真实使用数据（本片只是让数据可读）；本片未提交、未推送、未归档。

## 17. 第七片落地：让“已解除”可否证（2026-10-18；已实施并实测）

§6.1 的 C 侧还缺一半：C 声明了“这个 class 已关闭”，但**没有任何东西能证伪它**。本片把这条接上，且是**在 change 内部那条同类机制上往外推一层**，不是新造一套。

**新增**（`src/workflow/corrective-action.ts` 的 `normaliseClassKey`/`ownedClassRecurrences`，`readUpstreamSummary` 的 `correctiveActionRecurrence`，路由 `escalate_corrective_action_did_not_hold`）：

| 事实 | 判定 |
|---|---|
| C 声称关闭的 class，在依赖它的 D 里**又出现了** | D 的依赖边指向的任务有声明 + D 自己的轮次里出现同一 class（**要求出现在多于一轮**——一次出现不是复发，这正是 class reader 的既有语义）→ 路由到 `/kata` 交 class owner 决策，而不是在 D 里再修一遍 |
| 匹配的诚实边界 | 名字折叠大小写与 `_`/`-`；**再不同的命名不匹配**——这是漏报（安全方向），不是错报，已写在代码注释与文档里 |
| 顺序 | 位于依赖路由**之后**：仍未返回的 D 先听到 `blocked_by_unreturned_dependency`（那才是让它停下的原因），已返回并重验后才轮到本路由 |
| 成本 | 只读**本 change 依赖边指向的任务**的声明，不做全仓扫描；声明不可读则跳过（不归因），不猜 |

**实测证据**：`tsc --noEmit` 退出 0；全量 **373 文件 / 2310 用例全绿**（本片新增 6 例）；`check:wiring` 既有 11 条不变。**反证**：把该路由关掉后 1 条用例转红，恢复即绿。**真实 CLI 端到端**：建 D→C 边 + C 声明 class + C 已认证 + 记录返回 → D 的两轮里同一 class 复发 → `status` 的 `nextAction` 为 `escalate_corrective_action_did_not_hold` → `/kata`，并发布 `classKey`/owner/两轮的 `at`/两个 finding id。

**过程中修正的两处判断（都是实测）**：① 我最初以为单轮出现即可触发；class reader 要求**多于一轮**，这在语义上是对的（“复发”），测试与文档已按此修正。② 我原先给依赖路由的 priority 是 2000，在文件里排在 2150/2185 之前，读起来不降序；本片把它改为 2180，新路由 2160，使文件顺序与数值一致（这只影响报告标签，不影响路由顺序）。

**仍未做**：`.kata/tasks/**` 不随 Git 提交/推送；`workUnitKind` 未发布为字段；PDSA 试点仍需真实使用数据；本片未提交、未推送、未归档。

## 18. 修掉一条既有缺陷：拒绝信息打印的“决定路”在 std 下走不通（2026-10-18；已复现并修复）

这是第 10 轮独立审查的 `gate-r10-F3`（class `refusal-cannot-be-executed`，**停线候选类**）——不是新功能，是**我自己参与建立的机制里的缺陷**，因此直接修，不再往下传一轮。

**缺陷**：当一个 closure 契约的 `effectivenessTest` 写的是一句话而不是一个 check 名，机制无法验证它，seal 拒绝并打印**唯一的两条路**之一：“记录一个决定，命名 `obligation:<class>`，附理由与批准人”。而 `seal-preflight.ts` 只在 `if (matrixRequired)` 分支里读取这些决定——**std profile 下那条路永远走不通**：操作者按拒绝信息原话记录了决定，同样的拒绝原样返回，无限循环。

**复现（先红后修）**：新用例 `tests/unit/a-recorded-decision-is-read-on-every-profile.test.ts` 在同一 fixture 上跑 **std 与 strict 两个 profile**，同一契约、同一决定：

| profile | 修复前 | 修复后 |
|---|---|---|
| strict | 通过（决定被读取） | 通过 |
| std | **拒绝**，且 unmet 原文就是要求记录决定的那句话 | 通过，并发布 recorded gap（`Decided by the-owner`），**不**声称测试跑过 |

**修复是“读”，不是新门禁**：把“读取 + 合并 + 校验记录的决定”移出 `matrixRequired` 分支（矩阵专属的 path coverage / CodeGraph 候选仍留在里面），并让决定在**任何 profile** 下都被持久化（`if (waivers.length > 0) await writeWaivers(...)`）——否则第一次 seal 认了、下一次又忘，那不叫“记录”，叫“每次都要重给”。**决定永远是 gap，不是 PASS**（`recordedGaps` 携带批准人与理由，`satisfied` 里不出现“effectiveness test ran and passed”）。

**实测证据**：`tsc --noEmit` 退出 0；全量 **374 文件 / 2313 用例全绿**（本片新增 3 例）；`check:wiring` 既有 11 条不变。**反证**：把读取放回 `matrixRequired` 分支后，std 的两条用例立刻转红（strict 仍绿——正是“同一契约在不同 profile 下答案不同”的实测形态），恢复即绿。**真实 CLI 未单独驱动**：本片走的是 `runCommand` 与真实 fixture（git 仓库 + 真实 seal 检查），与既有 closure-contract 用例同一层面。

**仍未做**：`.kata/tasks/**` 不随 Git 提交/推送；`workUnitKind` 未发布为字段；PDSA 试点仍需真实使用数据；本片未提交、未推送、未归档。

## 19. 第 10 轮 findings 一次处置完：F1/F2/F4/F5/F6（2026-10-18；已复现并修复）

按“同类问题一轮内全部处置、不传下一轮”的原则，把第 10 轮剩下的 findings 一起修完——它们全在同一个 reader（`src/quality/obligation-check.ts`）和它的文档/仪器里。**一手依据是审查结果文件本身**（`tmp/g-review-result10.json`），不是我对它的转述。

| finding | class | 缺陷（原文要点） | 修复 |
|---|---|---|---|
| `gate-r10-F1` | `one-fact-derived-twice` | “这个声明是否指了 seal 跑过的某个 check”由**两条互相矛盾的规则**回答：`envelopeNamesCheck`（整字段双向子串、无长度过滤）决定 `satisfied`，`declarationNamesACheck`（≥8 字符标识符出现）决定“是否可能匹配”。实测：**带反引号的声明**对着它所指那个 check 的通过证据，被报成“指了某个 check 但它没跑或没过”；**短 id 的失败 check** 被报成“根本没指 check”，而该状态恰好是**可被决定豁免**的那条路——于是 seal 已经判过的事实可以被豁免 |
| `gate-r10-F2` | `instrument-unsound` | `inventoryPathOf` 取“第一个在磁盘上存在的 token”，**目录也算**：`...used to exist in src was removed...` 解析成 `src`、`...was in package.json and nowhere else...` 解析成 `package.json`，inventory 被判 satisfied |
| `gate-r10-F5` | `contract-semantics` | 设计文档把 `satisfied` 规则写成**另一条规则**（≥8 字符标识符），与代码不符 |
| `gate-r10-F4` | `contract-semantics` | 修订说明称“只扩大、不移出”，但实际还把“无法验证的契约”从**拒绝**变成**被许可的状态** |
| `gate-r10-F6` | `instrument-unsound`（note） | **读者自己的边界规则没有声明仪器**：6 个用例只覆盖一个分支，四条边界规则（子串规则、8 字符阈值、token 解析、profile 可达性）无人测——这正是同类复发的机制 |

**修复方式（三处代码 + 两处文档 + 一处仪器）**：

1. **一条规则**：新增 `normaliseDeclaredTest`（去反引号/引号、去 `:line`、折叠空白）与唯一的 `envelopeSpeaksFor`；**删除** `declarationNamesACheck`。分支只剩两种可能：“有 envelope 为它作答且通过 → satisfied”，否则“**有** envelope 为它作答但未通过 → 报出是哪几个 check”，否则“**没有** envelope 为它作答 → 命名的不可验证状态 + 决定路”。后者不再能被决定豁免。
2. **只认写路径的位置与常规文件**：token 只有在“入口首 token / 被反引号或引号包裹 / 含路径分隔符”且 `statSync(...).isFile()` 时才解析为入口所指的文件——目录、FIFO、socket 一律不算。
3. **仪器**：`an-obligation-is-read-as-the-round-wrote-it.test.ts` 增加 3 组边界用例（装饰声明两侧、短 id 通过/失败/豁免三向、inventory 的两种失败形态 + 三种合法写法）。
4. **文档**：设计文档的 “What is repaired” 改为陈述实际规则（并标注 2026-10-18 的更正）；修订说明补上“它把拒绝变成了一种被许可的状态”。

**实测证据**：`tsc --noEmit` 退出 0；全量 **374 文件 / 2316 用例全绿**（本轮新增 3 例边界仪器）；`check:wiring` 既有 11 条不变。**反证（逐个规则）**：把 8 字符阈值加回唯一规则 → 短 id 用例转红；把“只认写路径的位置”关掉 → inventory 用例转红；恢复即全绿。**边界用例自身的修正**：第一版短 id 用例用 `test` + 命令 `vitest run`，而 `'vitest'.includes('test')` 为真——它在阈值被改回时**不红**，即“为错误的理由通过”；改成全字段皆短的 `lint` 后才真正钉住该规则。**对真实数据的复核**：把修好的解析器对着本仓库 `the-gates-can-be-repaired` **已封印的契约**跑一遍——12 条 inventory 条目**全部**是“首 token = 真实常规文件”，`effectivenessTest` 也以选择器路径开头，因此收窄后的规则**不拒绝任何一条真实条目**（不是把检查改成拒绝诚实工作）。

**一处诚实的范围说明**：本片在 `runCommand` + 真实 fixture 层面验证（与既有 closure-contract 用例同层）；真实 `dist/cli.js` 端到端 smoke 被 handoff 守卫挡在 seal 之前，**没有**单独驱动，故不声称 CLI 层证据。

**仍未做**：`.kata/tasks/**` 不随 Git 提交/推送；`workUnitKind` 未发布为字段；PDSA 试点仍需真实使用数据；本片未提交、未推送、未归档。

## 20. 设计稿对照代码的完整性审计（2026-10-18；审计，不是总结）

问题：“前面那轮优化设计是否都已实施？”**答案是否。** 下面是逐条对照（依据是设计稿 §6–§8 的原文与当前代码事实），分“已实施”与“未实施/部分实施”。审计只读代码与实测命令，不改任何东西。

### 已实施（每条给出位置或实测）

| 设计条款 | 事实 |
|---|---|
| §6.2 一份依赖决策、各动词不得重新推导 | `readTaskDependency` 是唯一投影：`src/workflow/orchestrator.ts:231`（seal/verify/review/judge/archive 五个动词经 `governedEntryFor`）、`:472-479`（`gate approve` 映射四个信任边界）、`src/workflow/navigation.ts:614`（status）、`src/workflow/metrics.ts:123` |
| §6.3 五个状态 | `absent / pending / undetermined / ready_to_revalidate / revalidated` 全部存在；`pending` 允许修补、拒绝 seal/verify/review/judge/archive；`undetermined` 同样拒绝；`ready_to_revalidate` 放行 seal/verify/review、拒绝 judge |
| §6.3 直调 CLI 也不能绕过 | 用例直接调 `runCommand`（`tests/unit/a-blocked-task-cannot-cross-its-gate.test.ts`），不是只测 status 推荐 |
| §6.3 返回不必等 C 的 Archive | `recordDependencyReturn` 只看 C 的认证与集成，不看 C 的 phase |
| §6.4 同类再犯停止自动新开 | `escalate_corrective_action_did_not_hold` + `escalate_declared_repair_did_not_hold`；class 的 `ifRecursAgain` 由既有机制消费 |
| §6.4 一个未解除 class 只有一个 owner | `kata-cli corrective declare` 全仓枚举后拒绝第二个 owner |
| §6.5 活性（依赖拒绝路径） | **实测**：被依赖门拒绝的 seal 前后 `revisions/` 计数均为 **0**，连续两次拒绝仍为 0（`/tmp/liveness-probe`，真实 `dist/cli.js`） |
| §8.1 预检先于派发 | `review --preflight` 已实现并写入 usage（`src/cli/usage.ts:21`），且只拦“已存在且不合格”的 brief |
| §8.4/§8.5 认证 ≠ 交付 ≠ 归档 | `src/workflow/completion.ts` 五个状态 + `kata-cli completion`；记录只存在于 worktree 时报 `delivered_records_elsewhere`，其 road 实测可走 |
| §8.5 记录保存守卫是活的 | 删除守卫在 `src/workflow/worktree.ts:297-300` 用 `uniqueCopies` 判断“删掉会丢什么”（`check:wiring` 报的 `archiveRemovalTargets` 是另一处既有的死引用） |
| §7 步骤 1 的事前预测与否决条件 | 已写入本文档 §7（采用/否决条件），但**试点本身未跑**（见下） |
| §6.5 成本可读 | `kata-cli metrics`（轮次/revision/返修/阶段占用/class 与其影响的 change），并具名发布不可观测项 |

### 未实施（每条给出可复现的依据）

| # | 设计条款 | 现状与依据 |
|---|---|---|
| 1 | §6.2 `dependencyIdentity`（边 ID + C 被接受的 revision + 集成提交/受影响路径摘要 + D 当前 revision + 协议版本），且任一漂移必须使 D 的旧 Review/Judge 结论失效或进入具名需重验 | **完全未实现**：`grep -rn dependencyIdentity src/` → **0 处**。今天只有返回记录里的一个 `subjectRevisionId`，状态在读取时派生；没有任何身份被写进 D 的 review/judge 记录，漂移只会拒绝下一次进入，**不会**使已记录的结论失效 |
| 2 | §6.3 父子关系的引用“机械生成并纳入”独立 reviewer 的阅读面 | **未实现**：`grep -n dependen src/store/review-request.ts` 只命中散文注释；ReviewRequest 的构造从不读 `readTaskDependency` |
| 3 | §6.3 C 须先独立认证（Verify/Review/**Judge**），不得自己签发 return | **部分**：`readDependencyReturns` 只读 `judgePath`（`src/workflow/task-dependency.ts:2,375`），**不要求 C 有独立 Review 批准**——只有 Judge PASS 的 C 也能被返回 |
| 4 | §6.3 C 若修改认证器/reviewer 入口，其批准资格须为 `undetermined`（须以独立来源核验候选产物） | **未实现**：代码中无任何相关判断 |
| 5 | §6.5 旧 `blocked_by` 含义不明时标 `legacy-undetermined` 由 owner 迁移，不得默认已解决 | **未实现**：`grep -rn 'legacy-undetermined' src/` → **0 处**；旧边被直接当作依赖边读 |
| 6 | §6.5 管理边界：看板记录 blocked 原因/年龄、吞吐 | **部分**：`metrics` 有 phase/轮次/revision/返修，**没有** blocked 原因年龄（`grep age src/workflow/metrics.ts` → 无） |
| 7 | §6.5 失败的 seal 不发布孤儿 revision / 同一拒绝重复执行不得无限 re-seal | **部分**：依赖门路径已满足（上面实测 0）；但 **obligation 拒绝路径不满足**——既有用例自己写着 “The refused seal already minted its revision”，每次重试都会新增 revision |
| 8 | §6.2 跨记录写入须有确定顺序、可重试幂等、混代读的拒绝/恢复策略 | **部分**：返回写入取了仓库 artefact 锁，但没有“代”（generation）概念，也没有混代读的拒绝策略，更无对应用例 |
| 9 | §6.5 受控 schema 变更须单独授权并确认有效版本读取策略 | **部分**：本工作**只新增**三个 schema 文件（`schemas/task-dependency|task-completion|corrective-action.schema.json`），未修改受保护的 `task.schema.json`；但新增记录**没有**版本读取策略，也未经单独授权流程 |
| 10 | §8.2 ①–⑥ 的反馈分类与“`routed/deferred/accepted` 不得冒充 `fixed`” | **部分**：只有既有的 `disposition`（`fixed` 关闭 finding，`isOpenFinding`）；没有 `Optional`/`insufficient` 之类的 finding 处置词汇，也没有“非缺陷建议”这一类 |
| 11 | §7 步骤 1–4 的试点（真实 D/C、正反路径、成本对比、采用/否决） | **未执行**：没有在真实 change 上跑 D/C 试点；成本只是**可读**，没有任何对照测量，故 §6.5 的回本式仍无实测值 |

### 结论

设计稿的**机制骨架**已落地并各有实测反证：依赖决策与门禁、完成状态、派发前预检、纠正行动声明与一类一主、类级再犯路由、度量面，以及本轮修掉的 closure reader 缺陷。**但“全部实施”不成立**：上面 11 条里有 4 条（#1 `dependencyIdentity`、#2 ReviewRequest 引用、#4 认证器变更的 `undetermined`、#5 `legacy-undetermined`）是**完全没有**实现，其余 7 条是部分实现。其中最该先补的是 **#3**（C 的返回只要求 Judge，不要求独立 Review——这正好是设计里“不得自己签发 return receipt”的那条）与 **#7**（obligation 拒绝路径会不断产生 revision，与设计要求的活性相反）；**#11**（试点）不是代码工作，需要真实使用数据。

本审计只是阅读与实测，未修改代码、未提交。

## 21. 审计后的第一批修复：#3 已实施、#7 已实测（2026-10-18）

按第 20 节自己列出的优先级，先补 **#3**（返回只认 Judge）并**实测 #7**（失败的 seal 与孤儿 revision）。

### #3 已实施：C 的返回要求它自己的独立审查

| 事实 | 实现 |
|---|---|
| C 的认证是它自己的三道门，不是一道 | `readCorrectiveFacts` 新增 `reviewedApproved`：读 `review.json`，要求 `status === 'approved'` **且**用共享的 `bindsToRevision` 绑定到 C 的当前 revision（身份来自**已有的一次读** `currentRevisionIdentityFrom`，不二次读那个非原子指针） |
| 缺的是哪一步就说哪一步 | 新增具名 reason `corrective_not_reviewed`（有 Judge PASS 但没有绑定的独立审查批准），road 指向 `kata-cli review --change <C>`；原有的 `corrective_not_certified` 仍负责“连 Judge 都没有” |
| 写回执的那道门也拦 | `recordDependencyReturn` 在写回执前先拒绝，错误信息点名“its result is not yet independent of its author”，并给出要跑的命令 |

**实测证据**：`tsc --noEmit` 退出 0；全量 **374 文件 / 2317 用例全绿**；`check:wiring` 既有 11 条不变。**反证**：把读侧判断或写侧判断任一处关掉，`a-blocked-task-cannot-cross-its-gate.test.ts` 的对应用例立刻转红（两次分别验证），恢复即绿。

**这次改动暴露的两件事（都已修，值得记录）**：

1. **两个既有 fixture 把“已 Judge”当成“已认证”**：`a-blocked-task-cannot-cross-its-gate` 与 `a-discharged-class-is-falsifiable` 的 fixture 只写 `judge.json`。门禁变严后它们转红——这不是测试坏了，而是它们**一直在建模一个工作流到不了的状态**（`kata-cli review` 本应在 judge 之前）。两个 fixture 都补上了绑定的批准审查记录。
2. **我自己写的 `review as never` 被仓库自己的守卫抓住**（`no-type-escapes-in-source`）。按仓库规则改成按 `VerdictBinding & { status?: string }` 读取——修类型而不是加断言。

### #7 已实测：失败的 seal 会推进 current 指针，但不会无限重封

| 问题 | 实测（真实 fixture + `runCommand`，`/tmp` 内） |
|---|---|
| 失败 seal 会发布孤儿 revision 吗？ | **会**：被 obligation 门拒绝后 `current-revision.json` 从已认证的 revision 变成新铸的、**没有任何 seal 证据**的 revision（`certified=revision-eb9ce6… now=revision-ba8da4… advanced=true`） |
| 会无限 re-seal 吗？ | **不会**：连续三次**内容不变**的拒绝，revision 计数 `[1,2,2,2]`、指针三次相同——第二次起**复用**同一 revision。设计担心的“同一拒绝重复执行生成无限 re-seal”在危害意义上不成立 |
| 未认证的 current revision 能被别的门放行吗？ | **未证实**：`verify` 在探针里因 wiki closure 缺失先拒绝，`review --preflight` 因信任边界先拒绝，所以“读者会因缺证据而拒绝它”这个假设**没有得到验证**，不能当作无害的理由 |

**修复成本与建议**：真正的修法是把“铸 revision”与“发布指针”拆开（`revision.ts:188,236` 在铸的时候就写指针），而那个文件带着明确的锁纪律注释（review commit 会在锁内重读指针并拒绝描述不一致的写入），改动面广、测试面大。我的建议是**先记录、不现在改**：危害形式（无限重封）实测不成立，而“指针 = 内容快照、不是认证”这一定位与其它 reader 的证据要求并不冲突——但上面第三行**未证实**，所以这条建议是**有条件的**：若要彻底消除，应作为独立一片做，并同时给出“未认证 current revision 各门行为的场景表”。

### 第 20 节其余缺口未变

#1 `dependencyIdentity`、#2 ReviewRequest 依赖引用、#4 认证器变更的 `undetermined`、#5 `legacy-undetermined`、#6 blocked 年龄、#8 跨记录写入的“代/混代读”、#9 新 schema 版本读取策略、#10 §8.2 反馈分类、#11 试点，均**仍未实施**。

本批已提交（未推送）。
