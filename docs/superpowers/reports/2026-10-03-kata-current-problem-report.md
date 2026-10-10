# Kata 当前阻塞问题报告

**日期**：2026-10-03
**状态**：Open — 已有可复现证据；本报告不包含实现或测试修改。
**范围**：Kata 0.2.0 当前工作树、下游项目 `zenmpai` 对 `kata-cli update --force` 的实跑，以及新建的 `isolated_worktree` task。
**不把 Wiki / 设计稿当作代码正确性证明**：本报告中的「本次复现」均给出命令输出或生成文件；「既有未闭合」引用仍处于 `hardVerify` 的任务及其诊断文档。

## 摘要

Kata 目前有两类相互阻塞的问题：

1. **平台更新产物不安全或不便携**：`update --force` 可以破坏正文中的 `AGENTS.md` 文字，也可以生成只在安装者机器路径上工作的 Copilot hook。
2. **隔离 worktree 的记录、代码根与 revision 身份没有统一语义**：新 task 能创建 worktree，却不能通过 `orient`；已有修复任务也因 seal / 实际工作区对「什么内容变了」使用不同输入而停在 `hardVerify`。

因此，不应提交本次下游生成的 GitHub Copilot 配置，也不应通过绕过 `orient` 的方式修第 1 类问题。应先收敛第 2 类的根解析与 revision 语义，再以 TDD 修复平台生成器，最后在下游重新执行 `update --force`。

## 本次直接复现

| ID | 严重度 | 问题 | 影响 |
|---|---|---|---|
| F1 | major | 行内 STRATA marker 被当作托管边界 | `update --force` 把完整 contract 注入正常正文，留下第二个托管 block |
| F2 | blocking | Copilot hook 固化安装期绝对根路径 | 非 `/app` workspace 中 hook 读错 `.kata/` 后静默放行，写入 guard 实际失效 |
| F3 | blocking | 新 isolated worktree 无法 `orient` | Kata 无法用其声明的隔离 profile 执行自己的 generator 修复，只能违规绕过 guard |

### F1 — `mergeAgentsContract` 接受行内 marker

**复现。** 在下游 `zenmpai` 的 `AGENTS.md` 正文中出现行内文字 ``<!-- STRATA:BEGIN -->…<!-- STRATA:END -->``，同时文件末尾存在真实的独占行托管 block 时，运行：

```bash
kata-cli update --force
```

生成的 diff 显示完整 `Kata Agent Contract` 被插入该中文句子中；文件尾部的原托管 block 没有被替换，因而出现两个 block，且前者破坏正文。

**根因。** `src/adapters/ownership.ts:566-567` 的 `mergeAgentsContract` 先做宽松的 `includes` 判断，再以未锚定的 begin/end 正则替换。非贪婪匹配会选择正文中第一组 marker，而不是独占行上的实际托管边界。`--force` 在 `src/cli/installer.ts:323` 绕过冲突保护，使损坏可直接落盘。

**缺失的回归。** 现有测试覆盖更新 / 冲突 / 卸载，却没有「正文中引用 marker 字面量 + 文件末尾真实 block」的形状。

**关闭条件。**

1. 只把由空白包围的独占行 marker 当作边界；正文中的任何 marker 示例原样保留。
2. 新测试先证明旧实现会把行内示例替换，再断言修复后仅更新末尾 block。
3. 标准 install、update、uninstall 仍能识别真实 block。

### F2 — Copilot hook 把 `/app` 写入受版本控制的配置

**复现。** 从 devcontainer 路径 `/app` 对下游项目运行 `kata-cli update --force` 后，生成：

```json
// .github/hooks/kata-guard.json
"node \".github/hooks/kata-hook-guard.mjs\" --project-root \"/app\""
```

**根因。** `src/adapters/ownership.ts:277-305` 的 `writePlatformHookFiles` 在 :297 把安装期 `baseRoot` 写入 command。`src/policy/guard-script.ts:20` 优先使用 `--project-root`，只有未提供该参数时才用 `process.cwd()`；随后读不到 task 时在 :26 静默退出。因此同一份被提交的 `.github/hooks/kata-guard.json` 在另一个 workspace 根下看似安装成功、实际不实施 guard。

**缺失的回归。** `tests/unit/installer.test.ts:602-607` 只断言脚本名，`tests/unit/hook-policy-parity.test.ts:53-61` 总传固定 root；两者都没检查生成物是否携带安装者路径。

**关闭条件。**

1. 生成的 Bash / PowerShell command 是 `node \".github/hooks/kata-hook-guard.mjs\"`，不带 `--project-root`。
2. 安装于一个 root、在不同 root 执行生成 hook 的测试证明它基于调用时工作区解析 `.kata/`。
3. 仍保留脚本可选的显式 root 参数，供显式自动化调用，而非写入受版本控制的 platform config。

### F3 — task record root 与 code root 的耦合让隔离 task 不能开始

**复现。** 新建隔离 worktree 并打开 task：

```bash
kata-cli worktree create --change platform-update-portability
cd .kata/worktrees/platform-update-portability
kata-cli open --change platform-update-portability \
  --isolation isolated_worktree --development tdd --review strict
kata-cli orient --change platform-update-portability \
  --role designer --platform pi --task-kind security
```

最后一条命令稳定失败：

```text
Task-owned path must be inside the repository:
../../../.kata/tasks/platform-update-portability/task.json
```

`worktree create` 报告 task records 留在拥有 task 的主检出；`orient` 又把该主检出记录相对 linked worktree 的路径送入「必须在 repository 内」的校验。创建成功、首个必经命令失败，说明 `isolated_worktree` profile 在该形状下不能端到端执行。

**根因方向。** 这与已有诊断 `docs/design/2026-10-01-task-records-die-with-the-worktree.md` §10–§15 一致：代码根、记录根、worktree owner 与删除守卫存在多份独立推导，且 `resolveWorkspaceRootForTask` 曾被同时用于不应耦合的语义。F3 是该架构问题在当前 CLI 的新端到端证据，不应以在 worktree 内跳过 `orient` 掩盖。

**关闭条件。**

1. 从 linked worktree 运行 `orient`、`build --seal`、`verify` 时，task records 解析到唯一 records root，而受检代码路径仍属于 linked worktree。
2. records root 不会被转换为 escaping owned path。
3. 在真实 git worktree（`.kata/` 受忽略与 whitelist 两种形状）中测试；删除或移动 record root 的变异必须使测试变红。

## 已有且仍未闭合的前置问题

下列不是本次重新实现的猜测，而是现有 task / 诊断仍显示未闭合的事项；它们解释 F3 为什么不能以局部修补收尾。

| ID | 严重度 | 证据状态 | 阻塞效果 |
|---|---|---|---|
| P1 | blocking | `task-records-outlive-the-worktree` 当前 `hardVerify`，`verifyResult=FAIL`，3 个 `revision_superseded` | worktree record / guard 体系尚未有可信闭环 |
| P2 | blocking | 同诊断 §18 的 M1 | seal sandbox 与实际 workspace 对 declared surface 的 hash 输入不同，文档等路径可令 revision 自我 supersede |
| P3 | major | 同诊断 §18 的 M2 | 已提交的 declared path 从 scope 移除后，preflight 仍把它当作未声明变更，不能干净收窄任务表面 |

### P1–P3 的来源与处理边界

`docs/design/2026-10-01-task-records-die-with-the-worktree.md` 已记录两轮独立读数：早期「在 worktree 写记录」会让 archive 删除唯一审计记录；随后局部修复又暴露记录归属有多份独立定义、删除守卫按 task id 而非被删路径匹配、检测与 evidence 面不完整。文档 §15 明确结论是需要从**单一记录归属推导**重新收敛，不能继续枚举调用点打补丁。

该 task 目前的 `status --change task-records-outlive-the-worktree` 仍为：

```text
phase: hardVerify
next: kata-cli build --change task-records-outlive-the-worktree --seal
verifyResult: FAIL
failedVerifyAcceptance: 3 (revision_superseded)
```

诊断 §18 还记录了造成这个形状的两个未闭合机制：

- **P2 / M1**：`build --seal` 的临时执行副本只含 `src/`、`package.json`、`node_modules`；但 revision 新鲜度在真实工作区对完整 declared surface 重新 hash。于是 `docs/**`、`.gitignore`、`.agents/**` 可以改变真实 hash 而不改变 seal hash，导致刚 seal 的 revision 随即 `superseded`。
- **P3 / M2**：从 declared scope 移除一个已提交路径后，preflight 仍将该路径报告为未声明改动，阻止 task 收窄。

这两项必须以单一 manifest / 单一 content-identity 推导处理，不能靠重新 seal 或手改 task 记录掩盖。

## 修复顺序

1. **先恢复 records / code-root / revision identity 的单一推导（F3、P1、P2、P3）。** 复用并重做 `task-records-outlive-the-worktree` 已暴露的架构设计；不要仅执行它当前的 `build --seal` 就宣称闭合。
2. **然后以一个独立、严格、TDD 的 platform-update task 关闭 F1 与 F2。** 两项共享 `src/adapters/ownership.ts` 的 update 输出边界，但各自有独立红/绿回归。
3. **最后从干净下游重跑 `kata-cli update --force`。** 验证：行内 marker 不变、唯一实际 block 更新；GitHub hook 不含安装者绝对路径；`doctor` 的 manifest hashes 与写入文件一致；在非 `/app` root 下 guard 实际读到当前 task。
4. **仅在第 3 步通过后，提交下游平台生成物。** 当前 zenmpai 的生成结果是 F1/F2 的回归样本，不是可提交配置。

## 非目标与纪律

- 不在本报告中修改 `src/`、已有 `.kata/tasks/`、现有 active task 或其 handoff。
- 不把 `platform-update-portability` 的 `orient` 失败视为授权绕过 Kata guard 的理由。
- 不把已有设计文档的 PASS、Wiki 或人工摘要当作这些问题已经修好的证据。
- 在 records-root 前置问题关闭前，不将任何 `isolated_worktree` task 的 archive 视为可信完成。
