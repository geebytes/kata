# the-workflow-layer-checks-what-it-claims

**change**：`the-workflow-layer-checks-what-it-claims` ｜ **9 条 AC** ｜ `current_worktree / tdd / strict`
**合并来源**：`only-paths-that-point-inside-the-repository-are-rewritten`（沙箱路径缺陷，已核实报告）＋ 步 2（复核环成本/分类可见性/I-10）＋ `the-lane-follows-the-classification`（车道规则，其第 1 轮查出两条 major）——三者以 `merged_into` 指向本 change，各自的 revision / Verify / 账本 / findings 记录保留。

---

## 1. 一句话根因

**机制会陈述关于自己输入与出路的事实，而没有人机械地检查它们。** 合并的依据不是"三件事都要做"，而是它们同一个根因的五张脸：

| 它陈述的事实 | 实际由什么决定 | 今天的实测 |
|---|---|---|
| 沙箱："这个参数指向仓库根" | 字符串中的根引用按段识别，但 `cwd` 与 `command`/`args`/`env` 曾因尾斜杠和混合值而各自失真 | `tests/application` → `tests/tmp/kata-seal-execution-XXXlication`；同一文件里 `mapRepositoryPath` 本来就是按前缀匹配的（**一问两答**） |
| 账本："这条 falsifier supported" | 写读数当时检查，**修复移动锚点后无人复查** | 今天 11 次锚点失配、盘上仍写 `supported`（**I-10**） |
| 拒绝："这条路能走" | 人写散文 | a4 的 R5–R13 九轮几乎全在此（**I-17 / I-20 / I-21**）；lane 的 R1-F1/F2 是同一类出现在**给 agent 读的文案**里 |
| 分类/车道："这单是 standard / 车道 std" | `classifyRisk` 的结果**不打印、不落盘**；`reviewers` 无消费者 | lane 自己 `risk.tier=standard` 而 `reviewMode=std`，无人提醒 |
| 复核轮："复核者在审" | 复核者 60–80% 工具调用在**重推**同一批规则 | 每轮 190–300k / 11–20 min |

本 change 不新增一层门禁，而是**把已有的陈述变成可证伪的**：能机械检查的给机械检查，不能的写成具名边界。

## 2. 九条 AC（每条一个**独立**选择器文件——本仓已三次被 `dedupeChecks` 折叠共用文件）

### A 组 路径（沙箱）

| AC | 属性 | 选择器 |
|---|---|---|
| **AC-1** | 仅**包含**仓库根作为子串的参数不被改写：`tests/application`、`packages/x/src/x/application`、`application` 原样到达（`command`/`args`/`env` 三处都断言） | `tests/unit/a-check-argument-is-not-rewritten-by-substring.test.ts` |
| **AC-2** | **正对照仍在**：`=/` 等于根、或以 `root/` 开头时仍被改写（`/app`、`/app/`、`/app/tests/support`、`/app/.venv/bin/ruff`）；相对值不动 | `tests/unit/a-check-argument-that-points-inside-is-rewritten.test.ts` |
| **AC-3** | **形态明确的判定**：所有值共享规范化的作者根；`cwd` 以整路径解析，`command`/`args`/`env` 按独立路径段映射（**引用**被映射、**长名字**原样通过）。端到端跑一条真命令由**检查自己**判定收到的是什么 | `tests/unit/the-executed-argument-is-the-one-the-check-declared.test.ts` |

**规则（实现时按实测定稿，并更正过三次）**：**名字边界**，不是整值、也不是子串——根的某次出现，**左侧不接续一个名字**（值首，或前一字符既不是 `/` 也不是**名字字符**：任意文字的字母、组合记号、数字，加 `.` `_` `-`）、**且右侧紧跟 `/` 或字符串结束**才算引用（`/app/tests/support` 被映射；脚本参数里嵌的 `…file='/app/second-started'…` 也被映射，因为它的快照里存在同一路径）；**后面紧跟其它字符的不算**（`tests/application` 原样通过——`application` 不是 `app`）。第二处更正（复核第 5 轮实测）：名字类第一版写成 ASCII（`/[A-Za-z0-9._-]/u`），于是 `é<root>/x`、`数据<root>/x` 被当成引用改了写——长名不因为写在别的文字里就不是长名。第三处更正（复核第 6 轮实测）：**左侧的「前一个字符」必须按码点读**——`value[at - 1]` 取的是单个 UTF-16 码元，基本平面之外的字母（`\u{10400}` 一类）落在它前面时只留下一个落单的代理项，名字类对代理项答 `false`，于是它又被当成引用改了写：与 ASCII 那次是同一个缺陷，只是往外多了一个平面。现在左侧取的是「结束于该出现处之前的那个码点」（`precedingCharacter`）。

我第一版把"嵌入但不在开头"的值一律不改写（`--flag=/app/x`），**被既有 e2e 当场证伪**：`seal-cost-and-revision-identity` 的两条用例依赖"脚本参数里嵌的根路径被映射到快照"来串行/并发地对齐两个检查，我的版本让它们再也碰不到一起。两半都承重：去掉后者是报告实测的缺陷，去掉前者会破坏隔离。**AC-3 的措辞**有两处过宽：它写的「同一个 predicate」忽略了整路径 `cwd` 与可嵌入字符串的不同语义；「以及 `verify`」也不成立——`checksForExecutionSandbox` 只有**一个**调用者（封存的证据收集），`verify` 什么都不执行、只读已记录的读数。这两条边界当时写在按实测陈述的选择器与本文档里。**「冻结契约不能改写」这句话现在不再成立**：同一个 revision 的 AC-3 已由受管的更正入口 `kata-cli tasks amend-acceptance` 改写（记录在 `.kata/tasks/the-workflow-layer-checks-what-it-claims/acceptance-amendments.jsonl`，compare-and-swap、带理由、append-only），而该 revision 的认证随即被判 `contract-moved` 作废。契约可以改写，代价是旧认证必须当场失效——所以这两条边界仍然在这里按实测陈述，不把错误措辞扩展为实现承诺，但依据不再是"改不了"。

### B 组 falsifier 的读数（I-10）

| AC | 属性 | 选择器 |
|---|---|---|
| **AC-4** | **封存时只读校验锚点唯一**：每条 falsifier 的 `find` 必须在文件里恰好匹配一次，否则**按名拒绝**并给出重瞄命令（毫秒级、不跑测试、不做账本**判定**） | `tests/unit/a-falsifier-anchor-is-checked-at-seal-time.test.ts` |

**边界**：封存保证"锚点还指着东西"（必要），`evidence verify` 保证"它确实会红"（充分），互不替代；锚点唯一但被测代码被改写，机械检查看不出。

**实测更正（复核第 1 轮）**：本节早先写「不让封存依赖账本」，读起来像「账本坏了也能封存」，而实现是：检查**读**声明，声明读不出来时封存**按名拒绝**（`falsifierAnchorsUnreadable`，`src/workflow/seal-preflight.ts:318-330`），因为它说不出这些锚点还指着哪里。不依赖的是账本的**判定**（`decide` 的结论），不是它记录的那份声明。

### C 组 拒绝的出路（I-17 / I-20 / I-21）

| AC | 属性 | 选择器 |
|---|---|---|
| **AC-5** | 本 change 触及的每条拒绝都**点名一条从它触发的状态可执行的路**：把命令**抽出来在 fixture 里真的跑**，用法类拒绝记为失败（领域类拒绝正常）；命令不得含占位符（工具已有的值必须填真值） | `tests/unit/every-refusal-names-a-command-that-works-there.test.ts` |

**边界（复核第 1、2 轮，以及第 5 轮实测后改写）**：只覆盖**被反引号包裹**的命令；驱动的家族是可扩展的白名单（`ledger`、`scope`、`tasks` 与 `build`，见测试里的 `drivePrintedAny`），遇到其它家族**抛错而不是跳过**；占位符规则只覆盖**工具已有的值**（`--change <` 会红），`<item.json>` / `<path>` 这类**操作者输入**的占位符按设计保留；散文里或 `;` 连接的命令、以及"该命令是否真的清除了它伴随的状态"、shell 层引号解析，均不在覆盖内。

**第 6 轮实测后的两处收紧**：① 源码扫描原来在第一个反引号处收尾，而 `src/workflow/seal-preflight.ts` 的 `scope change` 路带**嵌套模板**（`.map((path) => \`--add ${path}\`)`），扫描于是返回**碎片**、守卫驱动的正是那半个路；现在扫描按模板的写法跟踪嵌套，读不完整的模板**报错而不是半驱动**，这条路也第一次被完整驱动。② 覆盖从「fixture 触发的那几条」扩成两个来源 —— 这正是这类缺陷此前能活着的原因：① 它自己 fixture 触发的拒绝：封存路径的锚点/不可读声明/未声明变更，**加上 amendment 的 compare-and-swap 拒绝**（第 5 轮的 blocking finding 就是这条路的句子点名了一个没有任何解析器读的 flag）；② **从 change 的拒绝面**（测试里的 `REFUSAL_SURFACE`：`src/workflow/seal-preflight.ts`、`src/store/review-request.ts`、`src/quality/acceptance-amendment.ts`）**的源码文本里把每条背反引号的 `kata-cli …` 路抽出来直接跑**：模板洞与操作者占位符各折成一个 token，`--change` 的值换成 fixture 的，因此**不需要**任何触发 fixture。两个来源都覆盖不到的只有一件事 —— **又新增一个印路的文件** —— 这一点写在测试的注释里，不假装能看见。

**用法类拒绝的判据是解析器自己的句式表，并写下它做不到什么。** 三轮复核各自测出这张表漏了句子（先是 `is required`，再是 `unknown action` / `must be one of`，第三轮又九条，现都在表里）。**第 5 轮我自己的变异又测出两处**：`tasks` 家族的两句话（`Unknown tasks option: --expected-statement`、`Unexpected tasks argument: …`）不在表里 —— 后果是"把 amendment 的路换回不可执行的写法"这个变异在守卫里**跑绿了**；两句现已入表并钉成用例。第三轮还测出**替代判据是错的**：曾试过「点名 flag 即用法类拒绝」，而 `--file holds no item with id X, so there is nothing to re-aim` 是**领域**拒绝也点名 flag，会把一个照路办事的操作者判红；该反例已钉成用例（`isArgumentRefusal` 的第二个断言）。
不宣称完备：表可能对尚未写出的句式不全；上面写下的两个覆盖来源之外（尤其"新增一个印路的文件"）不在覆盖内。完备性被明确放弃，反例与被钉住的句子被保留。

### D 组 分类与车道

| AC | 属性 | 选择器 |
|---|---|---|
| **AC-6** | **分类与车道并排可见**：选择/报告车道处同时给出分类（`tier`/`floor`/`matched`/`riskClasses`）与车道（`reviewMode`），车道**低于**分类时**具名**（不改门禁语义） | `tests/unit/a-lane-below-its-classification-is-named.test.ts` |
| **AC-7** | **分类落盘并进 ReviewRequest**（tier/by/reasons/riskClasses/facts），使复核者能审这条判断本身；`classify --change` 为机制引入前已存在的 task 确定性补齐缺失记录 | `tests/unit/a-classification-is-recorded-and-carried.test.ts` |
| **AC-8** | **车道规则只点名存在的路**：① 说明分类在**哪个阶段**才可读（实测：`open` 时 change 还没有声明路径，`ledger plan` 拒绝 ⇒ 入口点读不到分类）；② 给出"分类高于车道"时**可执行**的路（开一个不高于其分类的后继 change，并以 `merged_into` 取代本 change）；③ 规则出现在**每个呈现车道决定的面**上（三个入口、design 面、README/README_ZH、CLI usage 行） | `tests/unit/the-lane-rule-names-only-roads-that-exist.test.ts` |

**依据（lane R1-F1/F2/F3）**：F1 —— 入口点让 agent 去读 `ledger plan` 的分类，而那时无声明路径（实测拒绝）⇒ 只能取默认 `std`，正是要堵的洞；F2 —— 承诺"车道随时可升"而机制无任何路能升（`reviewMode` 唯一写者是 `createTask`，已存在 id 被拒）；F3 —— README/usage 呈现车道却无规则。机制引入前已经存在的 change 没有 classification writer；现在只能通过受控的 `kata-cli classify --change <id> [--classification-file <path>]` 从既有声明面重新派生并用唯一 writer 落盘，绝不接受手改记录。**修 F2 的取向与机制既有立场一致**：`tasks declare --field acceptance` 实测拒绝改写已冻结的验收契约（"A task's acceptance criteria are its contract and are not rewritten here"）⇒ change 的身份（含车道）在 `open` 时固定，**要更强就开后继 change**，而不是在就地改写身份。


**AC-7 那条记录自己的溯源（复核第 5 轮 wl-r5-F7 实测）**：`.kata/tasks/the-workflow-layer-checks-what-it-claims/classification.json` 的 mtime 是 **2026-10-13T15:52:06Z**，而"给既有 task 补齐分类"的唯一命令 `kata-cli classify` 到 **2026-10-14T00:23:20Z** 才随 `61ed8dc` 提交，`open` 又按 `createTask` 拒绝既有 id ⇒ 写它的只能是**当时尚未提交的同一条命令**（工作树里的副本），或者它被放在了唯一 writer（`writeTaskClassification`，`src/core/task.ts:339`）之外。记录的内容与受控派生（`taskClassificationRecord`）的输出逐条相符，`facts.declaredPaths` 与当时的 33 条声明面也一致；但**记录里既没有时间戳也没有写入者字段**，所以"哪一次运行写的"无法从记录本身证明 —— 能证明的是内容，不是来源。本条按 note 记录（无验收影响），并把"分类记录应带上写入时间与来源，使来源本身可审"作为机制缺口交队列（补字段会触及已落盘记录与它的校验，属独立决策）。
### E 组 复核轮的成本

| AC | 属性 | 选择器 |
|---|---|---|
| **AC-9** | 复核轮交付**机械可读包**：关系清单 + 轴矩阵 + 声明表 + falsifier 表（id → 文件 → find → 它该打红哪条），随 `ledger run` 输出一并给出，使复核者**审**而不是**重推** | `tests/unit/a-review-round-gets-a-delivered-package.test.ts` |

**边界**：包**不含**作者的推理（那是自证）；只含可机械核对的事实。本 change **只做交付，不砍复核上下文**（压缩上下文会降质：今天实测每轮 13–26 个不同文件、60–80% 调用是重复触碰）。

### 回归钉（来自被合并的 change，已 PASS）

- `tests/unit/the-lane-may-not-be-lower-than-the-classification.test.ts`、`tests/unit/both-profile-surfaces-carry-the-lane-rule.test.ts`（lane 的 AC-1/AC-2，已封存并 PASS ⇒ 本 change 作为回归钉保留，同时由 AC-8 收紧其措辞）。

## 3. 单点变异（每条先确认"真的落上"再采信读数）

| AC | 变异 | 期望 |
|---|---|---|
| AC-1 | 还原 `replaceAll` | 红 |
| AC-2 | 改成"从不替换" | 红 |
| AC-3 | 只修 `command`、`args` 仍用旧规则 | 红 |
| AC-4 | 去掉唯一性检查（用一条真实失配锚点构造） | 红 |
| AC-5 | 把一条拒绝的补救改成**它点名的家族不读的 flag**（第 5 轮实测的正是 `--expected-statement`），或把一条印在源码里的路改成不可执行 | 红（fixture 触发的拒绝 + **源码里读出的每条路**，两个来源各有一条 falsifier：E17 / C5 的两个 citation） |
| AC-6 | 去掉「低于分类就具名」（E6），或把 `laneBelow` 的比较换成**包含式的 `<=`**（E13）——后者把「车道等于分类」也判成低于分类 | 红（第 6 轮实测：原先那条词法扫描用例只认源码里出现 `TIER_RANK` 这个词，把 `TIER_RANK` 留在注释里的手写排序就能骗过它；已换成值层面的用例——车道层级等于分类层级时不判低于） |
| AC-7 | 分类不落盘 / 不可读的记录被填成默认 tier（E12）/ legacy task 由第二条路补齐分类（E19，`classify` 拒写已有记录那一行被摘掉） | 红 |
| AC-8 | 让规则重新点名一条走不通的路（如重新写回 `ledger plan` 作为入口点的读法） | 红 |
| AC-9 | 包不随输出给出 | 红 |


### 复核第 4 轮的直接修复边界（2026-10-13）

本轮修正了可由源码与选择器承重的事实：作者根规范化（含尾斜杠）、双侧边界、同一参数中真实根引用的逐次映射、scope 驱动不再带外补 `--change`，以及 legacy task 的受控 classification 补齐入口。`kata-cli classify --change <id>` **只**接受 classification 缺失的 task；已有或损坏记录均按名拒绝，不把“补遗”变成改写历史。

E2 已通过窄形式 `ledger evidence replace --id E2` 重瞄为真正的「从不映射」变异；C3 也已通过审计化的 `ledger claim restate` 收窄为两种输入语义各自真实的命题，随后重冻并重验。唯一仍不可在直接模式中伪造关闭的是冻结 AC-3 的「同一个 predicate」措辞：它与真实的两种输入语义相矛盾，不能手改 task artefact。源码、claim 与本文档已按真实边界收口；若要让该 AC 本身可认证，必须先建立并授权一个受控的 frozen-contract correction 路径。
## 4. 范围与代价

- **落地面（预计 6 源文件 + 9 选择器 + 2 回归钉）**：`src/workflow/execution-sandbox.ts`（A）；`src/workflow/seal-preflight.ts`（B）；`src/store/review-request.ts`、`src/workflow/orchestrator.ts`、`src/cli/workflow.ts`（C/D/E）；`src/adapters/phase-guidance.ts`（D 文本面）；`README.md`、`README_ZH.md`、`src/cli/usage.ts`（AC-8 的面）。
- **刻意不动**：`src/kernel/risk.ts`（floor 是 `high` ⇒ 整包会被抬到 security：2 复核者 + always quorum，不值）、`src/kernel/policy.ts`（改门禁强度需单独决策）。**AC-6/AC-7/AC-8 都不改门禁语义**（只让既有事实可见/可读/可信）。
- **代价**：实现 5–7 h（切片 1 = A 组，最快落地）；封存/Verify/账本 ≈15 min；一轮复核 ≈25–30 min / ≈300k。
- **顺序**：**切片 1 = A 组（正确性修复）** → B → C → D → E。

## 5. 边界（写清楚，不假装覆盖）

1. AC-4 只保证锚点**唯一**，不保证它**仍然会红**（那是 `evidence verify` 的职责）。
2. AC-5 只覆盖反引号命令、且只覆盖它自己 fixture 触发的那几条拒绝（见 C 组边界）。
3. AC-6 只**具名**，不**拒绝**（改门禁语义是独立决策，未纳入）。
4. AC-8 修的是**文案的诚实性**，不是给车道加写者（就地升车道仍不可用；后继 change 是路）。
5. AC-9 只交付，不压缩复核上下文。
6. 合并本身的取舍：门禁/封存/复核只买一套（省约 1 轮 ≈250k / 25 min），代价是正确性修复随整包封存落地——故 A 组排切片 1。
