# 设计：声明面完整性（scope surface completeness）

**状态**：设计稿，待开 governed change 实施
**上游**：`docs/design/2026-09-28-bounded-review-convergence.md` §16（现象与建议设计）
**触发**：真实卡顿一次，见下

---

## 1. 问题

Kata 对"一次变更改了什么"有**两个互不相交的答案**：

| 读取者 | 它认为的"变更面" | 依据 |
|---|---|---|
| `build --seal` | `task.json.ownedPaths` 的内容 | 只遍历 owned 路径算 digest |
| `verify` | **工作区** | `workspaceDrift` 读 git/文件系统 |

两者之间的差额（owned 面之外、但确实被改动的 tracked 文件）**没有主人**。一次真实的卡顿：

```
scope change --add tests/unit/user-choice-gate.test.ts      # 只记录了测试
build --seal                                                 # 静默成功：源码在 owned 面之外
verify                                                       # workspaceDrift: ['src/workflow/verdict-binding.ts']
build --seal                                                 # 拒绝：declared manifest is unchanged
```

- `verify` 说"有漂移"，`build` 说"声明面没变、没有可修的 FAIL"——**两个阶段都不报错、也都不放行**。
- 若作者忽略那条 drift（它埋在 20 字段的 diagnostics 里），sealed revision 会**带着 owned 面之外的行为改动**进入 review/judge，而 `revisionStatus` 仍是 `current`。
- 根因不是"忘了加 scope"，而是**没有任何读取者拥有这个差额**：`scope change` 不提示、`seal` 不检查、`verify` 只事后报告。

**同一类事故发生了两次**，第二次的形态更说明问题：第一次漏的是"测试校验的源码"，第二次漏的是**两个与测试无关的文件**（为修别的问题顺手删掉死代码的位置）。所以规则不能写成"测试与源码配对"，只能写成**改动集与声明面的集合差**（见 3.4）。

## 2. 目标与非目标

**目标**

1. 让"声明面之外的行为改动"在**第一次**就能被拒绝，而不是在 seal 与 verify 之间卡住。
2. 保持单一事实来源：拒绝必须发生在**已经拥有该判定**的地方，不新增第二套 scope 语义。
3. 拒绝必须**指名缺席的路径**，而不是只报"漂移了"。

**非目标**

1. 不改变 `ownedPaths` 的语义（minItems 1、`scope change`/`scope apply` 的两步记录-应用分离保持）。
2. 不引入"测试与源码必须一一对应"的强耦合——测试可以校验多个模块，也可以只是集成测试。
3. 不覆盖 `verify` 已能发现的**owned 面内**漂移（那部分工作正常）。

## 3. 两条候选检查与取舍

### 3.1 A：写时拒绝（`scope change --add tests/…` 时检查 import）

解析新增测试路径的 import 图 → 取其中指向 `src/` 的模块 → 若**一个都不在** next-ownedPaths 内，拒绝并指名。

- **落点已存在**：`recordScopeChange`（`src/quality/scope-change.ts`）已经在做 `refused` 判定，`src/cli/scope.ts:88` 直接抛它的字符串。这条规则接在同一个出口，不需要新命令、不需要新状态。
- **可机械判定**：import 解析是静态的，测试通过 vitest/TS 的既有解析即可，无启发式。
- **已知边界（必须写进规则本身，不留在注释）**：
  - 只看**直接 import**。测试通过第三个夹具模块间接校验时看不见。
  - 只在**新增**测试路径时检查；`scope apply` 之后才出现的 import 不回溯。
  - 测试文件本身可以合法地不 import 任何 `src/` 符号（纯 fixture/快照测试），此时规则不适用。
- **代价**：一条拒绝规则 + 一组会红的用例；不改变任何既有 seal 行为。

### 3.2 B：封存时拒绝（`build --seal` 检查 owned 面之外的 tracked 改动）

worktree 里任何 **owned 面之外的 tracked 改动**都拒绝封存。

- **更全面**：它覆盖 A 看不到的所有情形（间接校验、脚本改动、配置改动）。
- **代价与风险**：
  - 需要一个"工作区改动集 ∩ ¬ownedPaths"的判定，并明确排除项：`.kata/**`（治理产物，本就被排除在 owned digest 外）、`tmp/**`（证据与工作区文件，本项目显式声明）、以及 `isIgnoredRepositoryPath` 覆盖的一切。排除项写错会让**正常封存**失败——这是把风险从"漏报"换成"误报"。
  - 与既有设计耦合：`changedGitPaths` 读 `git status --porcelain`，只反映未提交改动（见项目记忆 `#731`），因此这条检查对**已提交**的 owned 面外改动不可见。要真正完整，还得叠加 revision 的 `pathDigests` 对比——工程量显著大于 A。
  - 它改变的是**封存这个关键路径**的行为，而封存是 `#593` 两条不变式之一（gate 强度）所在的位置。

### 3.4 C：封存前的**集合差**检查（本文档推荐的主规则）

触发这条设计的不是一次，而是**同一类错误在同一个 change 里发生两次**：改动了一个文件却漏进声明面，两条现有检查的口径差把它变成"verify 报漂移、build 拒绝修复"的卡死。

而两次调查都指向同一句更宽、也更准的规则：

> **任何被改动的文件都必须进声明面——不只是"测试与被测源码配对"。**

第一次（§16）我把原因写成"加了测试却漏了它校验的源码"，那只覆盖了一对关系。第二次我漏掉的是**两个与测试无关的文件**（为修别的问题顺手删掉死代码的 `src/quality/review-ir.ts`、`src/quality/scope-change.ts`）。所以配对式的启发规则不足以覆盖，能覆盖的是**集合差**：

```
changed  = git status --porcelain 解析出的改动路径集合
declared = task.json.ownedPaths（或 next-ownedPaths，写时检查时）
missing  = changed \ declared  ∪  changed \ ignored(排除项)
if missing ≠ ∅ → 拒绝封存，并列出 missing
```

**为什么放在封存前**：那是 ownedPaths 真正生效的位置（`seal` 的信封面就是它），也是唯一能保证"revision 的 manifest 与工作区一致"的位置。写时（`scope change --add`）也可以做同一条检查的**弱形式**，但不能替代封存前的那一次。

**已知易错点（都是实测踩过的，必须写进实现）**：

1. `git status --porcelain` 的前两位是状态码，**解析时必须按 `XY<space>PATH` 切**——我在调查时用 `l[3:]` 切错了前导空格，切掉了路径首字符，产出一条假的 `ocs/design/...`。
2. 重命名是 `R  old -> new` 形式，需要单独解析；只取 `new` 会漏掉 `old` 的删除语义。
3. 未跟踪目录在 porcelain 里可能只出现为目录（`?? dir/`），需要用 `-uall` 或自行展开。
4. 排除项必须与 `isIgnoredRepositoryPath` 同源，否则会出现"漏报换成误报"——这正是 3.2 里 B 方案的风险。
5. 检查必须在封存**开始**时执行（内容快照冻结之前），否则检查自身产出的文件会进入改动集。

### 3.3 取舍

**推荐 C 作为主规则（封存前的集合差），A 作为它的写时补充；B 不单独做。**

理由：C 覆盖了 A 与 B 各自的盲区——它不依赖 import 图（A 的最大弱点），也不依赖"作者记得"；而它唯一的复杂度是排除项与 porcelain 解析，这两点已在 3.4 里逐条写明。A 仍有价值，因为它把失败提前到**写时**（作者还在编辑时就能得到提示），但它只能作为 C 的补充而不是替代：A 覆盖不到的改动（与测试无关的文件）正是第二次事故的形态。

理由：A 恰好覆盖**触发这次卡顿的那一类**（改测试+改源码时漏声明源码），落点已存在、不动封存路径、可机械判定；B 更全面但会引入排除项误报风险，且受 `changedGitPaths` 只读未提交改动的限制，需要先解决"已提交的改动如何被看见"这个独立问题。

A 的边界在 3.1 里明确写出，这样**规则自身的覆盖范围是被声明的**，而不是靠读者推断。

## 4. 验收标准（拟）

- **AC-1**：`scope change --add <test-path>` 在该测试直接 import 的 `src/` 模块一个都不在 next-ownedPaths 内时**拒绝**，并且错误信息**指名**那个（些）缺席路径。
- **AC-2**：同一命令在该测试至少 import 一个 owned 的 `src/` 模块时**接受**（不误报）。
- **AC-3**：该测试不 import 任何 `src/` 符号时**接受**（规则不适用于纯 fixture 测试）。
- **AC-4**：拒绝时**不写入**任何 scope 记录与 task 变更（与既有 `recordScopeChange` 的"拒绝则两处都不写"一致）。

每条 AC 需要一条会红的用例；AC-1 另需一次变异验证（把规则短路后用例必须变红）。

## 5. 影响面

| 文件 | 作用 |
|---|---|
| `src/quality/scope-change.ts` | 新拒绝规则的判定与措辞（现成的 `refused` 出口） |
| `src/cli/scope.ts` | 拒绝文本的透出（无需改动，已抛 `result.refused`） |
| `tests/unit/scope-*.test.ts` | 四条 AC 的用例 |
| `docs/` | 本设计 + 实施后的记录 |

不改：`build`/`seal` 路径、`ownedPaths` 语义、revision identity 派生。

## 6. 未决问题

1. import 解析用 TS 编译器还是正则/`es-module-lexer`？前者准但重，后者轻但会漏 `import type` 之类的形态。倾向 TS 编译器（仓库已有 `tsc` 依赖），并把"只看直接 import"写进规则。
2. 拒绝信息里要不要列出**测试侧的 import 全文**（便于作者判断）？倾向列路径而不是全文，保持错误信息可读。
3. 是否也给 `scope apply` 加一次同样检查（author 可能在 `--add` 之后才写 import）？倾向加，但作为独立 AC，因为它检查的时点不同。

### 3.5 D：路由的目标必须在同状态下可执行

第三次事故（第十二轮审查）暴露了这一类里最容易漏的一条：

`bounded-review-convergence` 新增了 `repair_unreadable_current_revision` 路由，指向 `/kata-build`。实测：pointer 损坏 → router 返回该路由 → 而 `build` 在 `attempt` 阶段**抛错**（`Build cannot run from review because the recorded review cannot be read as one`），因为它的拒绝路径 `authorizeReviewRepair → readBlockingProblems` 在**同一个损坏 artefact** 上先行拒绝。也就是说：**两条可能的路由都会抛。**

值得注意的是这不是"选错了路由"，而是**没有任何检查要求一条路由的目标在该状态下能运行**。规则：

> **每条 gate 路由（reason → command）都必须在一个构造出的状态下被验证：派发到该命令后它返回结构化结果，而不是抛错。**

- 落点：可以在 `suggestCandidateAction` 的路由表旁放一份"每个 reason 的可运行性用例"，或在 `verify`/`build`/`judge` 的 `attempt` 层把抛错改成结构化拒绝（后者更根本：**CLI 命令不应以异常作为拒绝方式**，第 16 节记录的 `verify`/`judge` 丢弃整次运行也是同一根因）。
- 与 3.4 的关系：3.4 保证"改动都有声明"，3.5 保证"路由都能执行"。两者都是**状态的集合差**类检查，但对象不同（声明面 vs 可执行面）。
