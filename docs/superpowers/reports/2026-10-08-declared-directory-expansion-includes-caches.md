# Kata 反馈：声明目录展开包含 `__pycache__`，`verify` 跑完测试后 `ledger run` 必然拒绝

**日期**：2026-10-08
**状态**：**修复中** — 报告在 `zenmpai` 的 strict change `guard-the-property-not-the-proxy` 上实跑复现（Kata `/app/kata` 0.2.0，commit `2468205`）；本仓库已按「一份判据、两个消费者」实现并封存（change `a-declared-directory-excludes-its-build-output`，封存 `revision-a3d29df0bf19c121`，Verify PASS），正在等它的独立审查轮；归档后本节改为「已修复」并补上提交号。

**修复要点（实测）**：账本**不再自己枚举**——声明目录的展开改由 identity 自己的走查（`listRepositoryFiles`）完成，规范化与「永不是内容」的判定与 seal 共用同一个派生（`normalizeDeclaredPaths` / `declaredContentPaths`），于是两条枚举无法再各自漂移。复现与反证：`ledger freeze`（`ownedPaths: ["src/pkg"]`）记的路径集合与 `computePathDigests` 逐条相等；改写 `.pyc` 不再移动冻结 subject；守卫以 **seal** 为参考而非「同一次走查」，并按**种类**携带 fixture（四种扩展名、显式声明的文件、第二条声明、git 忽略路径、超深路径、超出树哈希预算的文件、符号链接与哨兵）。
**影响**：只要 change 的 `ownedPaths` 里出现一个目录（例如测试目录），该目录展开后会把 `__pycache__/*.pyc` 计入 subject；而 `verify` 本身就要跑测试，跑测试就会改写这些 `.pyc`。于是「先 verify、再 review」的标准顺序**必然**让 subject 失效，`kata-cli ledger run` 每次都拒绝，**review request 产不出来、review 阶段进不去**。
**范围**：本报告只描述 Kata 工作流缺陷与源码依据，不改 Kata 源码，不引入绕过门禁的做法。

## 摘要

Kata 有**两套**路径枚举，规则不一致：

| 消费者 | 位置 | 是否排除 `__pycache__` |
|---|---|---|
| revision identity（封印） | `src/core/repository-identity.ts:25-38`（`ignoredDirectoryNames`） | **排除** |
| ledger subject（声明目录展开） | `src/store/ledger.ts:1107`（`walkFiles`） | **不排除** |

`walkFiles` 只跳过两个名字：

```ts
// src/store/ledger.ts:1112
if (entry.name === '.git' || entry.name === 'node_modules') continue;
```

而 `freezeSubject`（`src/store/ledger.ts:1068-1070`）对声明中的目录**无条件展开**：

```ts
if (stats.isDirectory()) {
    const walked = await walkFiles(join(input.root, path));
    for (const file of walked) digests[`${path}/${file}`] = hashContent(await readFile(join(input.root, path, file)));
    continue;
}
```

因此 `ownedPaths: ["tests/architecture", ...]` 会把 `tests/architecture/__pycache__/*.pyc` 写进 `subject.pathDigests`。

随后 `ledger run` 在发请求前**重新冻结并逐字节比较**（`src/store/review-request.ts:103-119`），任何差异都拒绝：

```text
the frozen subject describes content that has moved since it was frozen
(tests/architecture/__pycache__/_runtime_reach.cpython-312.pyc,
 tests/architecture/__pycache__/test_photo_observation_boundaries.cpython-312-pytest-9.1.1.pyc):
the request would brief a reviewer on content that is no longer the change.
Re-freeze with `kata-cli ledger freeze --change <id>` first
```

## 最小复现（实跑）

change：`guard-the-property-not-the-proxy`（strict tier），`ownedPaths` 含 `tests/architecture` 与 `tests/photo_observation` 两个目录。

```bash
kata-cli ledger freeze --change <id>     # rev:52056c0f8ab535e3（此时 .pyc 是 A 版本）
kata-cli verify --change <id>            # ← Kata 自己跑验收命令：uv run pytest … → .pyc 被改写成 B 版本
kata-cli ledger run --change <id> --out request.json
# ✗ the frozen subject describes content that has moved … (两个 .pyc 路径)
kata-cli ledger freeze --change <id>     # rev:edc220f700ec477e
kata-cli ledger run --change <id> --out request.json
# ✓ ok
```

即：**只要在 freeze 与 `ledger run` 之间有任何一次测试执行，请求就发不出去**；而 `verify` 就是一次测试执行，且它按文档位于 `ledger run` 之前。

同一机制的第二个可见后果在 **sampling**：`kata-cli ledger plan` 的 `sampling.seed` 直接来自声明展开，所以 `.pyc` 会进入采样面，并且实测**被 promoted 进复核者的提升名单**：

```json
"seed": "…,tests/architecture/__pycache__/__init__.cpython-312.pyc,
         tests/architecture/__pycache__/test_photo_observation_boundaries.cpython-312-pytest-9.1.1.pyc,
         tests/photo_observation/__pycache__/test_dependency_contract.cpython-312.pyc,
         tests/photo_observation/__pycache__/test_exiftool_metadata.cpython-312-pytest-9.1.1.pyc:57",
"rate": 0.2,
"promoted": ["tests/architecture/__pycache__/__init__.cpython-312.pyc",
             "tests/architecture/__pycache__/test_photo_observation_boundaries.cpython-312-pytest-9.1.1.pyc",
             "tests/photo_observation/__pycache__/test_dependency_contract.cpython-312.pyc",
             "tests/photo_observation/__pycache__/test_exiftool_metadata.cpython-312-pytest-9.1.1.pyc"]
```

也就是说：**编译缓存既让 subject 无法保持新鲜，又被当成值得复核的内容推荐给复核者。** 这不是排版问题 —— 它把「这个 change 的代码是什么」这个问题指向了构建产物。

## 为什么这不是使用者漏了一步

- `verify` 是 Kata 自己的阶段命令，它执行验收矩阵里的 `uv run pytest …`；跑 pytest 必然写 `.pyc`（除非进程设了 `PYTHONDONTWRITEBYTECODE`，而 Kata 的命令串里没有，也不该要求作者去改验收命令）。
- 文档化顺序是 `verify` → `review`，而 `ledger run` 位于二者之间。
- 「声明一个目录」是**被支持并且被鼓励**的形式：`freezeSubject` 的注释明确说「Task declarations name directories (`openspec/changes/<id>` is one)」，即目录声明是合法用法。
- 诊断只说「Re-freeze … first」，没有说明「这次失效的原因是构建缓存，且它会在每次跑测试后再次发生」——照着做的人会以为重冻一次就稳了，实际上紧接着的任何测试执行都会再次触发。
- 唯一能让整套流程走通的操作顺序（**在最后一次测试执行之后才 freeze，且 freeze 之后不再跑任何测试**）在任何文档与诊断里都没有出现。

## 建议修复（需要 Kata 维护者选择其一）

### 方案 A（推荐）：展开目录时复用 identity 的「非内容」表，让两处枚举共用一个判据

`walkFiles` 现在只跳过 `.git` / `node_modules`；identity 侧已经有一张经过实测的表（`src/core/repository-identity.ts:25-38` 的 `ignoredDirectoryNames`，含 `__pycache__`、`.pytest_cache`、`.mypy_cache`、`.ruff_cache`、`.coverage`、`node_modules`、`dist` 等，以及同文件的 `ignoredPathPrefixes`）。把这张表抽成一个共享谓词，两处都调用它。

这是最贴合问题性质的修法：**「声明一个目录」的意思是「我拥有这里的源码」，而缓存不是源码** —— 同一个事实现在有两份互相冲突的实现，正是本项目自己反复记录的那类缺陷。

### 方案 B：让 drift 只对「内容」成立，并在诊断里说清原因

若两套枚举有意不同，那么在比较时把非内容文件排除出 drift 计算（并在 `ledger plan` 的采样面里也排除）。同时诊断必须区分两类失效：

- 「文件内容真的变了」→ 现在这句是对的；
- 「只有构建产物变了」→ 应当说明是缓存，并给出「在最后一次测试执行之后重新 freeze」的完整顺序。

### 方案 C（仅作 A/B 的补充）：给 `ledger run` 增加显式重新冻结

当唯一移动的路径全部落在非内容集合内时，允许 `ledger run` 自动重新冻结并继续，而不是把顺序约束推给使用者。单独用这一条不解决问题（采样面仍会包含 `.pyc`），因此只能作为配套。

## 必需回归测试

1. 一个 `ownedPaths` 含测试目录的 change：`ledger freeze` → 跑一次 pytest（或任何会写 `.pyc` 的命令）→ `ledger run` **必须成功**（或在 A/B 未采用时，给出明确区分「缓存漂移」的诊断）。
2. 断言 `subject.pathDigests` 的键集合里**不含**任何 `__pycache__`、`.pytest_cache`、`.mypy_cache`、`.ruff_cache` 路径。
3. 断言 `ledger plan` 的 `sampling.seed` 与 `promoted` 里**不含**非内容路径。
4. 反例夹具：真删掉一个被声明的源文件时，still 必须报 drift（排除缓存不得顺手把真实内容变更也放过）。

## 非主张

- 本报告不主张放宽 drift 检查 —— 「verdict 不得比它读过的内容活得更久」这条规则是对的，问题只在**哪些东西算「它读过的内容」**。
- 本报告不主张把 `ownedPaths` 里的目录改成叶子文件来规避：目录声明是被支持的用法，而且本 change 的验收矩阵按 `tests/architecture` 这样的目录路径声明 `testPaths`，改成叶子会连带要求改验收项 —— 那不是使用者的义务。
- 本报告不主张 `PYTHONDONTWRITEBYTECODE=1` 之类的进程级规避：它要求作者改写 Kata 自己的验收命令串，属于把机制的缺陷转成使用者的纪律。
