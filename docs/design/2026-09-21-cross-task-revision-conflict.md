# 已记录：共享 owned path 的并发 Kata change 会相互使 revision 失效

**状态：已记录，未修复。**

## 观察

在归档 `major-finding-closure` 与 `repair-obligation-deadlock` 时，两个 task 的 Judge、Review 和 Verify 都是 PASS，但它们已无法通过 distill gate：`revisionStatus` 都是 `superseded`，因此没有 current 的 passing test evidence。

`worktree-no-commit-message` 同期归档成功；它没有与前两个 task 重叠的 owned path。

## 可复现的机制

两个未归档 task 同时声明并修改了 13 个路径，包括：

- `src/cli/ops.ts`
- `src/quality/evidence.ts`
- `src/quality/finding-disposition.ts`
- `src/quality/repair-batch.ts`
- `src/quality/repair-obligations.ts`
- `src/workflow/orchestrator.ts`

`revisionStatus` 重新计算 task 的 `ownedPaths` manifest。任一 task 对共享路径完成 seal 后，另一 task 的旧 manifest 不再匹配，因而被标为 `superseded`。与此同时，seal preflight 的 ownership-conflict 规则拒绝两个 active task 再对同一组路径重新 seal，除非使用 `--allow-ownership-conflicts`。

这构成闭环：共享路径使旧 revision 失效，而使 revision 重获 current 状态的 seal 又被 ownership-conflict 拦截。

## 影响

- 任务在通过 Review/Judge 后仍可能无法进入 Kata 的 `distill`/`archive`，即使实现和硬验证本身完全通过。
- 当前 session 的两个 Kata task 保留在 `judge`；它们的 OpenSpec delta 已在 `openspec/changes/archive/` 手动归档，且合并后的 main specs 已通过 `openspec validate --specs`。
- 这不是一个只影响 archive 的显示问题：它暴露出“任务 revision 的内容身份”和“并发 ownership 的互斥策略”在共享修改场景下没有共同的完成语义。

## 明确未做的事

本次不改变 ownership 冲突策略，不自动使用 `--allow-ownership-conflicts`，不重写旧 revision，也不放宽 distill gate。它们会改变并发任务和证据绑定的语义，应该在单独的 governed change 中设计并验证。

## 后续 change 必须回答的设计问题

1. 对同一共享路径的相关 task，何种显式关系能使一个 task 的 seal 更新另一个 task 的可接受 revision identity？
2. `--allow-ownership-conflicts` 是否只能作为一次性人工决策，还是应该为相关 repair task 提供受审计的共享 scope？
3. archive/diff gate 是否可接受同一受信任 HEAD 的新 seal，还是必须保留原 revision 的字节身份？
4. 如何避免放宽规则后让无关并发 task 把彼此的证据误当作 current？

## 证据

- `findOwnershipConflicts` 对两个 task 各返回 13 项相互冲突的 owned file。
- `revisionStatus` 对 `major-finding-closure` 返回 `superseded`，其 computed manifest 为 `1e0a193b...`，封存 revision manifest 为 `7e2e20ed...`。
- `revisionStatus` 对 `repair-obligation-deadlock` 返回 `superseded`，其 computed manifest 为 `29c986e3...`，封存 revision manifest 为 `9a44e55f...`。
- `worktree-no-commit-message` 无 ownership conflict 且 revision 为 `current`，并已经由 `kata-cli archive` 转入 archive phase。
