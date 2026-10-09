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

## 4. 依赖顺序

A 先建立可表达、可重入的 review 状态；B 阻止失败遗留伪状态；C 消除协议复制；D 统一读取与 transfer 语义；E 最后保护 seal/map 消费点。它们共享部分文件，因此在一个 checkout 中串行实现；每个 slice 内先写最小 RED test、观察预期失败，再做最小 GREEN 实现与定向回归。

所有 slice 完成后：全量测试、TypeScript、falsifier 单点 mutation、自检声明面、只暂存本 change 路径、单次 seal/Verify/ledger。未完成任何 slice 前不得 seal 或发起独立 review。

## 5. 来源与审计

- `docs/superpowers/reports/2026-10-09-review-result-cannot-declare-empty-coverage.md`
- `docs/superpowers/reports/2026-10-09-review-phase-content-move-is-unrecoverable.md`
- `a-declared-directory-excludes-its-build-output` R13（原结果保存在 `tmp/dd-review-result-r13.json`）
- 已 `merged_into` 的 one-source、gate-input-integrity、change-lifecycle-reconciliation、finish-the-retired-answer-semantics、publish-every-unreadable-record，以及八个仅缺当前认证的旧 task。

关系保留旧工件；本设计不把缺失证书伪造成新的代码 defect，也不以 consolidated review 声称重写旧 revision 的审计结论。
