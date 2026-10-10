# Kata 反馈：`executable_falsifier` 无法表达「创建 / 删除文件」类变异，于是删除类不变量只能拿到较弱的见证

**日期**：2026-10-10
**状态**：Open — 结论由实跑输出与 schema 源码支撑；本报告**不包含**对 kata 源码的修改。
**范围**：Kata 0.2.0（容器内 `/app/kata`），HEAD `480d543`。
**复现 change**：下游 `zenmpai` 的 `thin-the-entry-layer-and-own-the-parameter-metadata`，tier `strict`。

## 摘要

账本里可执行证据的变异形状是固定的三元组：

```ts
// src/kernel/types.ts:224
mutation: { file: string; find: string; replace: string };
```

它能表达「把文件里某段文字换掉」，**不能**表达「创建一个文件」或「删除一个文件」。于是像

> 「参数注册表住在领域包，基础设施里**不再有**它」

这样的不变量，没法用 `executable_falsifier` 见证：它的自然变异是**把那个模块写回基础设施**（或把领域
里那份删掉），而这两种动作都不是 `find/replace`。

实测（本轮）：

```
E-CL2-location  verdict: inconclusive
  （变异要对一个「已删除」的路径做 find/replace ⇒ 文件不存在 ⇒ 变异不落上 ⇒ inconclusive）
```

最终改用 kata 支持的另一种证据类型才见证成功（6 条证据全部 `supported`，其中两条是 `static_witness`）：

```json
{"id": "E-CL2-location", "type": "static_witness",
 "ref": "packages/zenmpai-core/src/zenmpai_core/infrastructure/photo_observation/__init__.py",
 "assertion": "not-contains:parameter_registry"}
```

## 为什么「换个证据类型就好了」不够

`static_witness` 是**声明式**的：断言「这个文件里含 / 不含某个字面量」。而 `executable_falsifier` 由 kata
**亲自执行**变异、跑命令、再还原（`before:0 → mutated:1 → after:0`）—— 后者是「这条判据真的能变红」的
可执行证明，强度不同。删除/新增文件类的不变量今天只能拿到前者，而这恰恰是**重构（移动模块、拆包、改名）
最常产生的那一类**不变量：最需要强见证的地方拿到的是弱见证。

## 修复选项

* **A（推荐）**：把变异扩成带 `op` 的联合 —— `{"op": "edit" | "create" | "delete", file, find?, replace?, content?}`；
  执行器按 op 施加，并在事后**无条件还原**（create ⇒ 删除，delete ⇒ 从备份恢复）。
* **B**：允许 `executable_falsifier` 声明一个**前置动作**（例如 `git mv` 的等价形式），由 kata 执行、
  跑命令、再还原 —— 表达力最强，但它把任意动作引进了证据链，需要与 A 一起权衡。
* **C（最小）**：承认现状，但在 `inconclusive` 的文案里**指名**这是「变异形态不可表达」，而不是让作者
  自己去猜「是变异没落上、还是判据太弱」——本轮我就是靠手工施加变异才确认真因的。

## 必需回归

1. `op:"create"` 的变异：命令必须变红，且事后该文件**不存在**（不留残留）。
2. `op:"delete"` 的变异：命令必须变红，且事后文件**字节级还原**。
3. 正对照：`op:"edit"` 的既有行为逐字不变（三个退出码仍被记录）。
4. `op` 缺失时按 `edit` 处理（向后兼容既有的 `claims.json` / `evidence.json`）。

## 非主张

* 本报告**不主张** `static_witness` 有错 —— 它是本轮唯一可用手段，也确实见证成功。
* 本报告**不主张**放宽「证据必须能变红」这条标准；相反，这里要的是让**删除类**不变量也能拿到同等强度的见证。
* 未给出 kata 侧补丁；下游没有绕过门禁（该 claim 最终由 kata 判为 `supported`，只是换了一种证据类型）。
