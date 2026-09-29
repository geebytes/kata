# 设计：gate 的输入完整性（gate input integrity）

**状态**：设计稿 + 变更契约（本 change 的 bootstrap 来源）
**上游**：`docs/design/2026-09-28-bounded-review-convergence.md` §16、§17、§20、§21，以及三份 follow-up 设计稿
**性质**：把同一族的残余缺口**合并为一个 change** 修完，而不是分三条
**profile**：`isolated_worktree / tdd / strict`

---

## 1. 为什么合并成一个 change

三份设计稿收的是**同一族的三个面**，全都关于 **gate 读到的输入**：

| 面 | 缺口的形状 |
|---|---|
| 读状态（read state） | 同一 artefact 在一次决策内被读多次；"读不出来"没有跟着数据传下去 |
| 声明面（scope surface） | `seal` 的信封面是 `ownedPaths`，`verify` 的事实地平线是工作区，**差额无人拥有** |
| 风险覆盖（risk coverage） | 要求与变更内容无关；拒绝不给可执行的下一步 |

它们在**同一个失败模式**上汇合：**gate 依据的输入与实际状态不一致，而没有任何检查要求二者一致。** 分成三条 change 会让每条都只修自己那一面，而它们的验收标准互相重叠（"拒绝必须可执行"在三条里都出现）。所以合成一条，用一份契约覆盖三个面。

## 2. 实施顺序（**前置约束，不可颠倒**）

改 `src/kernel/**` 会**触及 kernel**，因而触发 `strict.requiredRiskClasses` 的判定——也就是本 change 要修的那条。所以顺序是：

1. **先落地"触及判定"**（AC-6 的机制：`classifyRisk` 推出的 `touchedRiskClasses`）与**拒绝可执行化**（AC-8）；
2. **再改 `requiredRiskClasses` 的解释**（AC-6 的语义：`required ∩ touched ⊆ claimed`）；
3. 之后才动 `policy.ts` 的表本身（那时它已被新判定覆盖）。

**若在第 1 步之前就被 `uncovered_risk_class` 挡住**：按 `bounded-review-convergence` §21 的同样原则处理——**如实报告并请 change 所有者裁定，不硬绕**（不手写 `.kata` 产物，不硬造 claim）。

## 3. 验收标准

### 读状态

- **AC-1**：`openLedgerProblems` 与 `ledgerVerdict` 在**每一种** ledger 状态（无文件 / 有记录无 claims / malformed / policy 被拒 / 有 claims 无 subject / 有 claims 有 subject）上给出**相同的可读性判定**，且两者各自**只读一次** ledger。
  - 实现：抽出纯函数 `ledgerVerdictOf(ledger)`；`ledgerVerdict` 与 `openLedgerProblems` 都先读一次、再委派它。
  - 证据：状态遍历用例 + 插桩证明读次数为 1。
- **AC-2**：`readUpstreamSummary` 把它读到的 `sealedRead` 传给 `readBlockingProblems`／`readReviewRecord`；在"只让第二次读失败"的 double 下，router 报 `repair_unreadable_current_revision`（而不是 `unreadable_review_record`）。
- **AC-3**：`verify`／`judge` 的命令边界**从调用方已取的读取派生 identity**；把实现换回独立 re-read，用例必须变红。
  - 证据：`readFile` double 让第二次读失败 + `runCommand('verify'|'judge')` + 断言**写出的** `verify.json`／`judge.json` 的 `revisionId`。

### 声明面

- **AC-4**：`build --seal` 在封存**开始前**做集合差 `changed \ declared`（排除项与 `isIgnoredRepositoryPath` 同源）；非空即拒绝并**列出差集**。
  - 已知易错点（必须实现）：`git status --porcelain` 前两位是状态码（`XY<space>PATH`）；重命名 `R  old -> new` 需单独解析；未跟踪目录要展开；排除项写错会把漏报换成误报。
- **AC-5**：**每条 `reason → command` 路由在一个构造状态下可执行**：派发到该命令后返回结构化结果，而不是抛错。
  - 当前反例：`repair_unreadable_current_revision` → `/kata-build`，而 `build` 在同一状态下抛错。
  - 更根本的修法（本 change 采取）：CLI 命令**不以异常作为拒绝方式**。

### 风险覆盖

- **AC-6**：`requiredRiskClasses` 解释为"**若被本次变更触及**则必须有 claim"；`decide` 的覆盖检查为 `required ∩ touched ⊆ claimed`。
  - `touched` 由 `classifyRisk` 已算出的 `matched` 模式集 + 一张"模式 → 风险类"映射机械推出。
  - 证据：只触及 `src/quality/**` 的变更**无** `failure_mode` claim 时通过；同变更加一条触及 `failure_mode` 模式的路径后**被拒绝并指名**该类。
- **AC-7**：**"模式 → 风险类"映射表的任何增删改都产生一条 `privilege` claim**，与既有 `policyFloorChangeClaims`（floor 表守卫）同形；变异：改表 → 用例红。

### 可执行性（横跨三面）

- **AC-8**：**任何拒绝必须给出可执行的下一步**——要么 `deficits` 非空，要么拒绝文本指名"哪个路径/模式推出了这个结论，因此需要什么"。
  - `deficits: []` 而 `reasons` 非空是**不允许的状态**。
  - 现状反例三处：`uncovered_risk_class` 的 `deficits: []`；`gate not bound` 不给重建路径；`evidence_below_strength` 在 stale verdict 存在时以**强度**措辞报告（真实原因是判定过期）。

## 4. 明示不覆盖（留给将来）

1. **证据强度语义**（`MIN_STRENGTH_BY_SEVERITY`、`autoEvidence`）：本轮无争议，不动。
2. **delta 复用判定**（`reusedEvidence`）：与读状态相邻，但它是"哪些证据可跨 subject 复用"的独立语义。
3. **平台无关的 reviewer skill 路线**（父设计里那条）：与本 change 的输入完整性无关。
4. **`.llmwiki` 的知识收口**：按本 change 的 profile 仍需一次 closure 决定，但不在验收面内。

## 5. 已知风险

1. **自指**：见 §2。这是本 change 唯一可能卡住自己的地方，已定好顺序与处置。
2. **规模**：`ownedPaths` 预计 20+ 条，跨 `kernel`／`store`／`workflow`／`quality`／`cli`。前一条 change 的经验是 12 轮对抗审查，每轮都带出新缺口；本 change 的 8 条 AC 里有 3 条是**命令级会红用例**（AC-2、AC-3、AC-5），这是比上一条更好的起点。
3. **AC-4 的排除项**：写错会让**正常封存**失败（把漏报换成误报）。实现时必须先有用例覆盖 `.kata/**`、`tmp/**`、已忽略路径三类。
4. **AC-6 的映射表完备性**：它不完备时只是"漏判"而非误判，但输出必须**如实说明"本判定基于模式表"**（不能假装完备）。

## 6. 交付判据

- 15 条 AC 各有会红的用例（§3 的 8 条 + 上一轮结束时登记的 7 条残余）；AC-1／AC-2／AC-3／AC-6／AC-7／AC-11 另有**变异验证**（把机制短路后必须变红，实测记录见各测试文件的 docblock）。
- 本 change 结束后：`ledger decide` 对**本 change 自己**给出 pass（这是 §2 顺序落地后的自证）。
- 三份 follow-up 设计稿在归档时标注为**已被本 change 覆盖**（或保留各自未覆盖的条目）。

**实施结果**：15 条 AC 全部落地，187 文件 / 1180 用例通过，`tsc --noEmit` 干净；封存为 `revision-4d9e2c9a9657d9da`（17 项证据）。§2 的自指顺序成立——AC-6 的机制先落地、再改 `src/kernel/**`，全程未被自己要修的那条判定挡住。

**实施中的两个自身缺陷**（记录以免重复）：

1. **AC-13 的守卫自己有行号 bug**：`codeOnly` 删块注释时一并删掉了其中的换行，于是 `slice(index-14, index+4)` 取到的是**十八行之外**的区域——一个就在写入行上的截断 payload 因此没被识别。改为"置空注释内容但保留换行"。
2. **AC-4 的检查当场抓住了作者**：26 个改动文件未声明，正是该 AC 描述的缺陷类；详见 §7.1 的用法修正。

## 7. 工具语义只在源码里（实施记录）

本轮实现中撞上三处**只存在于源码、任何输出都没有说明**的工具语义。它们不是缺陷报告，而是"下一个操作者会重复踩"的事实，因此记在这里而不是留在会话里。

### 7.1 `scope apply` 只应用**最后一条**记录

`kata-cli scope change --add <one>` 每次写一条记录，而 `kata-cli scope apply`（不带 `--id`）**只应用最后一条**该记录的 `scope`。而每条记录的 `scope` 是**记录时刻**的 `task.ownedPaths ∪ additions`——所以逐条 add、逐条 apply 时，每条记录的 scope 都是"旧的 34 + 这 1 条 = 35"，最后 apply 只让声明面从 34 涨到 35。

**实测**：连续 26 次 `scope change --add <单个路径>` 全部成功（exit 0），`scope-changes.json` 里 26 条记录各自的 `scope` 都是 35，最终 `ownedPaths` 仍是 35。

**正确用法**：**一条记录里重复 `--add`**（`valuesAfter(rest, '--add')` 收集所有出现），再一次 `scope apply`。实测一条记录带 25 个 `--add` 后，`ownedPaths` 从 35 涨到 60。

### 7.2 `--add` 不按逗号拆分，且会产生**无法被应用**的记录

`--add "a.ts,b.ts"` 被当作**一个**路径字符串记录（`added: ['a.ts,b.ts']`，`scope` 为空数组）。这条记录**不会**造成损害：`normalizeScopePaths([])` 以 `A scope change must leave at least one owned path: the task schema requires one, and a task with none cannot be read by any command, including the one that would add it back.` **构造性拒绝**——空 scope 记录在结构上无法被应用。

但记录本身留在 `scope-changes.json` 里（write-once），所以它是一段**只有读了源码才知道是惰性的**历史：`applied: false` 不会出现，因为没有人会去 apply 它。

### 7.3 声明面变化会**令 handoff 收据失效**，而封存**自己**也会改任务

`build --seal` 在有 handoff 收据的前提下被拒绝：`Cannot use invalid handoff packet: branch_mismatch`。原因是**上一次失败的 seal 本身改动了任务**（写入了 `change-record-*.json` 与 revision），而收据描述的是任务**当时**的样子，于是它被自己的封存动作作废。

**实测序列**：`scope apply`（改任务）→ `handoff create`+`acknowledge` → `build --seal`（失败，改任务）→ 再 seal 时收据已失效 → 重新 `handoff create`+`acknowledge` → seal 成功。

也就是说：**"改任务 → 重新签收据 → 封存"是一个必须紧邻的三步**，中间不能插入任何会写 `.kata/` 的命令，包括一次失败的 seal。

### 7.4 由本节引出的结论

这三处都不影响 gate 的正确性（没有任何一条让"应通过"变成"不通过"，也没有让"不通过"变成"通过"），但它们符合本 change 一直在修的那个形状：**一个事实只有一个可见入口**。§7.1 与 §7.3 都是"工具知道、操作者只能靠经验知道"的语义；§7.2 是"存在一条惰性记录，没有任何输出指出它"。

因此它们**不进入本 change 的验收面**（AC 文本在 `open` 时冻结，且这属于 CLI 表面而非 gate 输入完整性），而是作为**下一轮候选**记录在此。

## 8. 独立审查（第十轮）与修复批

第一次独立审查对 15 条 AC 的判决是**未通过**：9 条 finding，其中 6 条 blocking/major。**每一条都由我独立复现过**（探针在 `tmp/probe/`），并且它们的共同形状比单条缺陷更重要。

### 8.1 判决

| id | 级别 | AC | 事实 |
|---|---|---|---|
| R-1 | **blocking** | AC-13 | fixture 守卫只认"文件名与写动作同一行"。`tests/unit/review-artefact-read-state.test.ts:100` 躺着一条**活的**手工 revision（路径在 `join(…)` 一行、写入在上一行、载荷在下一行）→ 守卫报零；同一记录写成一行则被报。**守卫漏掉了它存在的理由那一类，实例就在本 change 自己的测试文件里。** |
| R-2 | major | AC-13 | 白名单仍读文本：`const note = 'the corrupt fixture';` 一句字符串即可给伪造记录开白名单（我堵了注释，没堵字符串）。 |
| R-3 | major | AC-12 | `ledgerClosure` 有声明（:96）与两处写入（:313/:330），**生产代码零读者**。历史诊断更清楚：`becfbf7` 用 ledger 分支替换了唯一读它的分支（`if (phase === 'review' && upstream.roundClosure)`），**并在同一个 diff 里删掉了读者**，只留下字段与一段"仍在报告"的注释。**处置：删除**——它的问题已由 ledger 分支与 `ledger.deficits` 回答，而它是同一事实的第三个面。 |
| R-4 | major | AC-8 | 五处活的拒绝是"`reasons` 非空 + `deficits: []`"且不指名路径：`discovery_floor`、`discovery_unverified`、`quorum_disputed`、`quorum_undiversified`、`quorum_missing`。实测 `reasons ["discovery_floor"] deficits 0`。 |
| R-5 | major | AC-15 | 前半句（"每个分支都记录自己的理由"）**既没实现也没检查**：函数内 26 个分支只有 6 个有注释，且 `/^\s{2}if \(/` 看不见嵌套分支。我的用例只断言了否定方向。 |
| R-6 | major | AC-9 | 逃逸扫描漏掉 `x as never as T`（条款点名的形态）与裸 `as unknown`。 |
| R-7 | minor | AC-11 | 畸形 round **仍被计入**（push 占位），而 `navigation` 无论 kind 都把它喂给 `reviewProgress`。用例自己写着长度 3（含一行 `{}`）。 |
| R-8 | minor | AC-4→AC-6 | 已**提交**的未声明改动两个面都看不见（`committed: []`）。AC-4 措辞是"working tree"，故不算伪造；连锁后果是 AC-6：已提交未声明路径的风险类永不被要求。 |
| R-9 | minor | AC-5 | 用例在 `if (!command) return;` **静默跳过**两条路由，报"通过"而只覆盖 5/7 skill。 |

审查**试过但未能伪造**：AC-1（`readLedger` 把坏文件收进 `malformedFiles` 而不抛，"一边抛一边返回 unreadable"不可达）、AC-7、AC-10（用 vitest JSON 报告取真值：同文件重名标题 0）、AC-14。AC-2/AC-3 只能有 mock 证据——pointer 只有一个入口，无 double 时无法构造"第二次读失败"。这是证据强度的诚实上限。

### 8.2 共同形状：**守卫比它宣称的窄**

R-1／R-2／R-5／R-6／R-9 是同一件事的五次出现：**用一个"我恰好想得到的写法"的正则，去证明一条全称条款**。行窗口（R-1）、注释 vs 字符串（R-2）、两级缩进（R-5）、正则的字面边界（R-6）、缺项的映射表（R-9）——每一条都让"通过"只覆盖作者想到的那一半。

判据（写入本 change 的教训）：**一条全称条款的守卫，必须把它看不见的写法写成断言**，否则它通过时说不出自己覆盖了什么。

### 8.3 修复批（一次收口）

- **R-1**：守卫改为按**语句**判定——用括号配平找出写入语句的跨度，写动作测试施加于整条语句，载荷用 `argumentAfterPath` 按平衡提取（不再被第一个逗号截断），标识符载荷在其赋值窗口内解析。同时**修掉活实例**：`review-artefact-read-state.test.ts` 改为用 `createTaskRevisionIfChanged` 让引擎产生身份。控制用例新增三种形态（三行布局／同语句里的 corruption 字符串／引擎产出的身份）。
- **R-2**：分类只看**载荷**；注释与字符串在扫描视图里被置空（保留换行）。代码不再能给代码开白名单。
- **R-3**：删除 `ledgerClosure`（声明、两处写入、描述它的注释），并把 `one-derivation-of-claim-support` 的断言移到真正决定事情的两个面（问题列表与 ledger verdict）。
- **R-4**：五处各带一条可执行 deficit；AC-8 的用例改为**遍历内核词汇**，并把实测触达的 10 个 reason 写成断言（我原本"不可达"的三个判断被这次运行推翻）。
- **R-5**：补齐 18 条分支注释；扫描改为**断言存在**（任意缩进），并单独用例证明嵌套分支会被看见。
- **R-6**：模式放宽到任意位置的 `as never` 与 `as unknown as T`；字符串同样置空。**裸 `as unknown` 有意不禁**——全仓 13 处都是 `JSON.parse(…) as unknown`，那是在**移除** `any`；禁掉它会把作者推向"断言到一个没人校验的类型"，比它替换掉的 `any` 更糟。判据写进了测试的 docblock。
- **R-7**：畸形行**只计为损坏**，不再 push 占位 round；用例的计数期望从 3 改为 2。
- **R-8**：`undeclaredChanges` 接受上一 revision 的 `pathDigests`，封存前把**已提交**的未声明路径一并点名。
- **R-9**：skill→命令的映射表补全，并断言"未映射的 skill 会失败而不是被跳过"；两条不属于 `runCommand` 的路由（wiki closure、archive）改用各自宣称的命令单独驱动。

### 8.4 修复中另发现的两处（本 AC 之外，记录不修）

1. `kata-cli wiki orient` 在 wiki store 不存在时抛 `ENOENT … .llmwiki/SCHEMA.md`，而不是回答"还没有 wiki"。该路由**宣称**的命令是 `wiki closure …`（它结构化回答），`orient` 是同一族的另一个动词，前置条件是 `wiki init`——所以 AC-5 成立，但这是同族的一处毛边。
2. `runCommand('archive', <不存在的 task>)` 抛裸 `ENOENT`（`current-state.json`）。路由永远不会指名一个不存在的任务，所以不在 AC-5 之内；但"命令用值拒绝、不用异常拒绝"这条纪律在若干命令上仍只覆盖到已有的任务。

## 9. 批准阶段发现的两件事（修复批之后）

把 change 推到 `review --approve` 时，两道关卡各暴露了一件事。**第二件由本次变更自己引入，且只有"真的把流程跑一遍"才会看见。**

### 9.1 CLI 解析到的是**主检出的 `dist/`**，不是本 worktree 的源码

```
which kata-cli → /home/work/.nvm/.../bin/kata-cli → /data/work/ahaeureka/k2skills/kata/dist/cli.js
```

也就是说：这一路以来的 `verify`/`review`/`seal`/`ledger` 行为来自**主检出 `master` 的构建产物**，而本 change 的代码在 `.kata/worktrees/gate-input-integrity/src/**`，只被**测试**驱动。对本 change 尤其重要——它改的正是 CLI 自己的输入面（封存、路由、账本），所以：

- **验收面（15 条 AC）由测试证明**，那些断言驱动的是 worktree 的源码；
- **治理流程的行为仍滞后于源码**，直到有人重建 `dist/`；
- 由此还得到一个诊断上的好处：**9.2 是被这次"工具与产物版本不一致"照出来的**。

**处置**：我把重建 `dist/` 视为需要用户授权的环境动作（重建会改变**这台机器上所有工作流**所用的 CLI），所以不自行执行，只记录并提交给用户决定。

### 9.2 存储策略的 `riskFloors` 形状不兼容（本次变更引入，已修）

**实测**：流程用已安装的 CLI 写出 `policy.json`，其中

```json
{ "src/quality/**": "medium" }
```

而本 change 之后的 `loadPolicy` 拒绝它：

```
riskFloors["src/quality/**"] must be an object carrying floor and riskClasses
```

**后果**：**现存的每一份 `policy.json`（都是旧形状）都会变成不可读** → 账本 `unreadable` → review 批准、distill 门、修复入口全部拒绝。这是"一个改动弄坏了它自己要治理的状态"，比之前任何一条 finding 都严重。

**根因**：AC-6/AC-7 把两种答案合并进一个条目（`{floor, riskClasses}`），却只改了写入侧，没有给读取侧留迁移。独立审查没有抓到——它的靶子是 AC 的条款，而条款只描述新形状；我的套件也没有"读一份旧策略"的用例。

**修法**（与该项目既有的"读者填补它之前就存在的部分并报告"同一模式）：`loadPolicy` 遇到字符串 floor 时，从默认表取该模式的类；默认表不认识的模式则填**所有 tier 的必需类**（保守方向，需求至少和当初一样宽）；并把 `riskFloors` 记入 `policyFilled`，使替换可见而不是静默。用例落在 AC-6 的证据文件里：整份默认文档降级为旧形状后必须仍可读、`filled` 必须包含 `riskFloors`、且默认表不认识的模式拿到多于一个类。

**教训**：改了**存储形状**就等于改了**已存记录**的可读性；写入侧的测试全绿说明不了任何事。

## 10. 批准阶段的账本墙：四个原因，两个来自改动的**旧**代码

把 change 推到 `review --approve` 需要账本 pass。账本已按要求建好（6 claim / 6 executable falsifier，`evidence verify` 全部 `supported`），但 `decide` 返回 `insufficient`，四条原因：

| 原因 | 来源 | 是否可解 |
|---|---|---|
| `assurance_below_tier`：`observed` 低于 security 的 `sandboxed` | 本 change 触及 `src/kernel/policy.ts`／`decide.ts`（floor `high`）→ 自身档位是 **`security`** | **本机不可解**：内联适配器记录 `observed`，沙箱化运行是宿主能力缺口（父设计已登记的 `#722`／`#728`） |
| `uncovered_risk_class`：`no claim covers: failure_mode` | **`dist/` 里 master 的 `decide`**，用 `required` 全量判定 —— 而本 change 的改动正是把它改成 `required ∩ touched` | **本 change 自己修的就是它**（重建 `dist/` 后即消失）。实测：本 change 的 `touched = [consistency, privilege, state_transition]`，`required ∩ touched` 已被 C-1／C-4 覆盖 |
| `discovery_floor`：没有独立 challenge | master 的判定（security 档要求） | 可解：跑一次独立审查并记录 |
| `quorum_missing`：security 要 2 名独立 reviewer，现有 1 | 同上 | 可解：第二位独立审查者 |

`deficits: []` 而 `reasons` 非空 —— 这**不是**本 change 的缺陷：那四条可执行 deficit 就在 worktree 源码里（§8.3 R-4），而运行的是 master 的 `dist/`（§9.1）。**这条输出本身就是 §9.1 那条漂移的第三个证据。**

### 10.1 结论

- **档位是被动抬升的**：改内核策略文件 → `security` → 该档要求 2 名 reviewer 与沙箱保证。其中沙箱保证在本机无法提供，因此**本 change 无法由账本自己 pass**，只能由人放行——与上一轮 §21 同类，但原因不同（上一轮是风险类判定，这一轮是**过程保证**）。
- **同族第四次出现**：一条在全量判定下必然为真的要求，作用在一个无法满足它的主体上。上一轮记的是 `strict` 的 `failure_mode`，这一轮记的是 `security` 的 `sandboxed`。差别值得写清楚：前者是**代码可修的**（AC-6 已修），后者是**宿主能力**，只能靠适配器或换执行环境。
- **`failure_mode` 那条不是缺陷而是证据**：它恰好证明了本 change 的 AC-6 在旧代码下会拒绝一个它应该接受的变更——也就是本 change 存在的理由。

### 10.2 交给用户的三条路

1. **重建 `dist/` 后重跑流程**（推荐）：只有这样才能让流程的判定来自本 change 的**自己的代码**，也才能端到端验证它（§9.2 的 R-10 正是"真的跑一遍"才发现的）。重建会改变**这台机器上所有工作流**使用的 CLI，因此需要授权。重建后仍需人工放行 `assurance_below_tier`（本机无沙箱），但 `uncovered_risk_class` 会消失，`discovery_floor`／`quorum_missing` 可由一次独立审查补齐。
2. **不重建，直接人工放行**（与上一轮 §21 同形）：账本 `insufficient` 与四条原因如实记录，审批准予人为判断，缺口登记为 follow-up。
3. **补一条 `failure_mode` claim**：能把 master 判定下的类要求补上，但 `assurance_below_tier` 仍然拒绝，所以仍需人工放行——修的是症状而非墙。
