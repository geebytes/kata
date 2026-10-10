# Kata 反馈：seal 要求声明的路径，正是账本拒绝冻结的路径

**日期**：2026-10-10
**状态**：Open — 两侧判据均由源码行号与实跑输出支撑；本报告**不包含**对 kata 源码的修改，也未绕过任何门禁（绕行办法写在末尾，是流程顺序，不是判据放宽）。
**范围**：Kata 0.2.0（容器内 `/app/kata`，即宿主 `/data/work/ahaeureka/k2skills/kata` 的实时 bind），HEAD `480d543`。
**复现 change**：下游 `zenmpai` 的 `unified-photo-parameter-output`，tier `strict`，`ownedPaths` 44 条。

## 摘要

一个**把源文件改名**的 change 在账本阶段无法推进，因为两条 kata 自己的规则对同一个事实给出了排他的定义：

* **seal 侧**：`changedGitPaths` 对 rename/copy **同时 push 新名字与原名字**（注释原文：*"both names are paths the change touched"*），`undeclared-changes` 把它与 `ownedPaths` 做差 ⇒ **被删除的原路径必须出现在声明里**；
* **账本侧**：`ledger freeze` 重算 subject 时遍历**声明**里的路径，任何一个读不到即整体拒绝 ⇒ **声明里不能有读不到的路径**。

于是「seal 要求你声明的」正是「账本不许你声明的」。用到的绕行是**先把改名提交**，让工作树干净后该路径不再出现在未覆盖读数里 —— 也就是说这条死锁能否避开取决于**操作顺序**，而不是任何机制。

## 复现（实跑输出，逐字）

下游 change 把 `packages/zenmpai-app/src/zenmpai_app/observation_report.py` 改名为
`packages/zenmpai-app/src/zenmpai_app/photo_parameters.py`（同时改了内容），声明里只留新名字。

1. `kata-cli build --change unified-photo-parameter-output --seal` →

```
Build cannot run from hardVerify ... / success: False
error: The working tree holds 1 change(s) the declared surface does not cover, so a revision frozen now
would not be about them: packages/zenmpai-app/src/zenmpai_app/observation_report.py.
Declare them (`kata-cli scope change --change unified-photo-parameter-output --add <path>`, then
`kata-cli scope apply ...`).
```

2. 把被删除的原路径加入 `ownedPaths`（seal 的要求）后再跑同一命令 → seal 通过（32/32），随后

```
kata-cli ledger freeze --change unified-photo-parameter-output
{"ok":false,"command":"ledger freeze",
 "error":"the declared paths could not be frozen: these declared paths cannot be read, so they cannot be frozen",
 "unreadable":["packages/zenmpai-app/src/zenmpai_app/observation_report.py"]}
```

3. `kata-cli ledger run --change <id> --out tmp/request.json` → 同一拒绝（`ledger run` 内部走 `currentSubject`），因此**连 ReviewRequest 都生成不出来**。

4. 两个命令的**接口不对称**：`ledger freeze` 有逃生口，`ledger run` 没有。

```
$ kata-cli ledger freeze --change <id> --paths "<仅存在的路径>"      → {"ok":true,"revision":"rev:...","paths":44}
$ kata-cli ledger run --change <id> --out tmp/request.json            → 仍然拒绝（无 --paths 参数）
```

## 根因（两侧源码）

**seal 侧 —— 改名把两个名字都算成「变更」**（`src/core/git.ts:74-94`）：

```ts
export function changedGitPaths(root: string): string[] {
    const result = runGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    ...
    // The two-character status is followed by a space and the path. A rename or copy reports its source path in the
    // next token, and both names are paths the change touched.
    const status = token.slice(0, 2);
    const path = token.slice(3);
    if (path) paths.push(path.replaceAll('\\', '/'));
    if (status.includes('R') || status.includes('C')) {
        index += 1;
        const originalPath = tokens[index];
        if (originalPath) paths.push(originalPath.replaceAll('\\', '/'));   // ← 原路径也进入读数
    }
    return [...new Set(paths)];
}
```

`src/quality/undeclared-changes.ts:9-11` 说明这条读数的用途与失败形态：seal 的置信面是 `ownedPaths`
（逐个 digest 后称之为 revision），`verify` 读的是工作树，二者的差集由这里生产 —— 于是删除后的原路径
必须被声明，否则 seal 拒绝冻结。

**账本侧 —— 声明里的路径必须都能读**（`src/cli/ledger.ts:186-217`）：

```ts
async function currentSubject(input: LedgerCommandOptions): Promise<...> {
    const paths = await declaredPaths(input.root, input.changeId);        // ← 从**声明**取路径
    if (paths.length === 0) return { ok: false, why: 'no paths are declared on this task, ...', unreadable: [] };
    const frozen = await freezeSubject({ root: input.root, paths, ... });
    return frozen.ok ? { ok: true, subject: frozen.subject }
                     : { ok: false, why: frozen.error, unreadable: frozen.unreadable };
}
```

同一文件 `:186-191` 的注释说明这条拒绝是**有意设计**，而且是量过的：

> *"It returned `null` on both 'nothing is declared' and 'a declared path cannot be read', so `ledger plan`
> answered 'declare ownedPaths or fix the paths' without saying which … Measured: a change whose declaration
> holds **fifteen deleted paths** got a message that named none of them."*

因此本报告**不建议**放宽这条拒绝；要修的是两条规则对「声明里出现已删除路径」这件事的**定义不一致**。

## 为什么重要

1. **卡在流程中段**：改名是常规重构手段（本次复现的 change 里发生过 1 次：`observation_report.py` → `photo_parameters.py`），而这一阶段既不能 seal、也不能 freeze、也生成不出 ReviewRequest，`nextAction` 会把操作者送去重建 gate / 重新 verify（都无效）。
2. **可绕过与否取决于顺序**：先提交改名即可避开，但那意味着**判据的稳定性依赖操作顺序**——同一份内容，先提交就能走、没提交就走不过。
3. **逃生口只在一侧**：`freeze --paths` 的存在说明「显式指定可冻结子集」是被认可的用法，`run` 却无法享受同一出口。

## 修复选项

* **A（推荐）**：seal 的「未覆盖」读数对 rename/copy 只认**新名字**。`git.ts:87-91` 已经把原路径单独 push，可以带上来源标记（例如 `{ path, origin: 'rename-source' }`），由 `undeclared-changes` 决定是否把它排除。理由：`ownedPaths` 描述的是**这个 change 产出什么**，而「原路径已删除」是需要记录的**动作**，不是需要声明的**产出**。
* **B**：账本在冻结时**跳过**声明里已不存在的路径，但把它**记进 subject**（新增字段如 `deletedPaths`），让「声明了删除」成为可审计事实。代价：subject 形状变更会影响所有比较点（`toProtobuf`/`subjectDigest`），需要一次性迁移处理。
* **C**：给 `ledger run` 补上与 `freeze` 相同的 `--paths`，让逃生口在两侧一致。只治症状，但改动最小、可立刻解卡。

## 必需回归

1. 一个 change 声明 `[R-new, R-old]`、其中 `R-old` 已删除：`build --seal` **通过**（选项 A）或 `ledger freeze`/`run` **通过并记录** `deletedPaths`（选项 B）。
2. 同一 change 的 `ledger run` 能产出 ReviewRequest；`ledger freeze` 与 `ledger run` 对同一份声明给出**一致**的判定（方向：**两边都拒绝**，或**两边都接受**）。
3. 纯粹的删除（无新名字）仍必须被声明：删掉 `ownedPaths` 里的被删路径后 seal 必须**仍然拒绝**（防止 A 把「删除需要声明」整体抹掉）。
4. 正对照：声明里只有存在的路径时，`freeze`/`run` 全绿且不支持 `--paths` 的调用方式不报错。

## 非主张

* 本报告**不主张**放宽 `ledger freeze` 对不可读路径的拒绝 —— 那是由可读性读数驱动的正确保守行为，注释里已有的测量支持保留它。
* 本报告**不主张**「删除不需要声明」。选项 A 只针对 rename/copy 读数的**原名字**，纯删除仍应声明。
* 未在本报告中给出 kata 侧的补丁；下游 `zenmpai` 侧**没有**绕过任何门禁：用到的只是「先把改名提交，再继续 seal/账本」这一流程顺序。
