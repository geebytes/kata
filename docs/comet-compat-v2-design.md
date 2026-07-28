# Comet 兼容协议 v2（数据驱动透传）

> 目标：让 kata 仓库不再需要为 comet 每次 flag 变更发版本。
> 通过把"comet 接受哪些 CLI flag"做成轰炸式协议文件，kata 在 runtime 解析后决定透传哪些选项、是否提示用户选择。

## 一、问题背景

`@rpamis/comet` 是 kata 的硬依赖。历史上，[`kata/src/comet/install.ts:buildCometProjectInitInvocation`](../src/comet/install.ts) 硬编码 4 个 flag（`init + path + --scope + --language`），导致：

- comet 0.4.0 新增 `--workflow/--overwrite/--skip-existing/--root` 时，kata 没有透传，**用户截图里至少 5 次重复 prompt**（comet 自己的安装模式、4 个覆盖选择）
- comet 每次 patch 发版都可能新增 flag，kata 必须跟随发新版

## 二、协议规范

### 2.1 文件位置与发现顺序

kata 启动时按以下层级获取 `comet-compat.yaml`，**首次命中即用**：

| 层级 | 来源 | 适用场景 |
|------|------|---------|
| L1 | `comet compat --json`（runtime probe） | comet 已升级支持该命令 → 总是最鲜 |
| L2 | `@rpamis/comet/comet-compat.yaml`（npm 包根） | comet 已发版但未支持 compat 命令 → 离线可用 |
| L3 | `kata/comet-compat.yaml`（kata 自带 fallback） | 旧版 comet（没有 L1/L2）→ 验证基线 |

实施代码：[`kata/src/comet/compat.ts:loadCometCompatibilityAsync`](../src/comet/compat.ts)。

### 2.2 schema 字段（v2）

```yaml
version: 2
comet:
  minVersion: 0.4.0
  maxVersion: 2.0.0

  capabilities:        # 哪些命令可用
    init:    { minSince: "0.4.0" }
    status:  { minSince: "0.4.0" }
    next:    { minSince: "0.4.0" }
    doctor:  { minSince: "0.4.1" }
    ...

  flags:               # 每个命令的参数面
    init:
      workflow:
        type: enum
        choices: [native, classic, both]
        default: native
        minSince: "0.4.0-beta.7"
        prompt:
          messageEn: "Comet workflow"
          messageZh: "选择要初始化的 Comet 模式"
      overwrite:
        type: boolean
        conflictsWith: [skipExisting]
        minSince: "0.4.0"
      ...
      platforms:       # 预留：尚不可用
        type: list
        itemType: enum
        itemChoices: [codex, claude-code, opencode, ...]
        minSince: "0.5.0"
        preview: true  # ← 当前版本下不会被透传

  output:              # JSON 输出 schema
    init.json:
      fields: [projectPath, scope, status, results, failures]
      stableFields: [projectPath, scope, status]

breakingChanges:       # 主动缓解的破坏性变更
  - version: "0.5.0"
    field: "selectPlatforms(--yes) default"
    before: "only detected platforms"
    after:  "all platforms when none detected"
    mitigation:
      kataShouldPass: "platforms=<detected>"
      note: "kata will explicitly pass detected list"

boundary:
  invocation: public-cli
  jsonOutput: true
```

### 2.3 字段语义

| 字段 | 用途 | kata 行为 |
|------|------|----------|
| `comet.minVersion` / `maxVersion` | 当前兼容窗口 | 调用前校验，不满足抛错 |
| `capabilities[id].minSince` | 能力最早出现版本 | `isFlagSupported` / `assertCapability` 检查 |
| `flags.<cmd>.<flag>.type` | flag 值类型 | 决定 wizard 如何 prompt、如何 serialize |
| `  .choices` / `itemChoices` | 合法值枚举 | wizard 绘制选项；透传前过滤非法值 |
| `  .minSince` / `maxRemovedIn` | 引入与移除版本 | `isFlagSupported` 自动判断是否透传 |
| `  .conflictsWith` | 互斥 flag | `filterSupportedFlags` 自动消歧 |
| `  .scopeGuard` | scope 限制（如 `--root` 只 project） | 不匹配 scope 自动 drop |
| `  .preview` | 预留未发布的 flag | 永远不透传、永远不 prompt |
| `  .default` | 非交互场景默认值 | `--yes` 模式下自动应用 |
| `  .prompt.messageEn/messageZh` | 用户提示语 | 自动按 [plan.language](../src/init-wizard.ts) 选 |
| `output.<cmd>.fields/stableFields` | JSON 输出字段 | 测试断言、IDE tooling |
| `breakingChanges[].version` | 破坏性变更版本 | `isBreakingChangeApplicable` 判断当前 comet 是否落入 |
| `breakingChanges[].mitigation.kataShouldPass` | 缓解指令 | 主动透传抵消新默认 |

## 三、kata 实现概览

### 3.1 三模块分工

```
┌──────────────────────────────────────────────────────────┐
│ kata/src/comet/compat.ts                  协议解析层     │
│  - loadCometCompatibility (sync, v1 fallback)           │
│  - loadCometCompatibilityAsync (multi-layer discovery)  │
│  - parseCompatYaml (v1/v2 兼容)                          │
│  - isFlagSupported / isBreakingChangeApplicable          │
└──────────────────────────────────────────────────────────┘
                            ↓
┌──────────────────────────────────────────────────────────┐
│ kata/src/comet/install.ts                 透传层         │
│  - buildCometProjectInitInvocation                       │
│    · 接收 extras（用户选择） + compat + cometVersion     │
│    · filterSupportedFlags → 过滤 preview/conflict/scope  │
│    · serializeFlag → 拼装 argv                           │
└──────────────────────────────────────────────────────────┘
                            ↓
┌──────────────────────────────────────────────────────────┐
│ kata/src/init-wizard.ts                   收集层         │
│  - promptCometOptions                                    │
│    · 遍历 compat.flags.init                              │
│    · 按 spec 类型动态 prompt（enum/select/checkbox）     │
│    · 对 overwrite/skipExisting 一次性 prompt 互斥选择    │
└──────────────────────────────────────────────────────────┘
```

### 3.2 接线点：[`kata/src/cli.ts:runInitWizardCommand`](../src/cli.ts)

```ts
async function runInitWizardCommand(argv, defaultRoot) {
  // ... kata 已有 platform / scope / language 选择 ...
  const cometBinary = await resolveCometPath();
  const cometVersion = cometBinary ? await getCometVersion(cometBinary) : null;
  const cometCompat = await loadCometCompatibilityAsync({ cometBinary: cometBinary ?? undefined })
                          .catch(() => loadCometCompatibility());   // fallback

  const cometExtras: CometExtraOptions = useAuto
    ? collectAutoCometExtras(cometCompat)        // 自动模式：用 default
    : await promptCometOptions({                  // 交互模式：按 spec 提问
        compat: cometCompat,
        scope: plan.scope,
        language: plan.language,
        cometVersion,
      });

  const cometInit = await initCometProject({
    root, scope, language,
    extras: cometExtras,
    compat: cometCompat,
    cometVersion,
  });
}
```

## 四、五种 comet 升级场景的自动处理

| 场景 | 处理 |
|------|------|
| comet 新增 flag（如 0.4.5 加 `--platforms`） | comet 仓库加上 `flags.init.platforms` 块；kata **无需改动**：下次 `loadCometCompatibilityAsync` 即读到，自动加入 wizard + 透传 |
| comet 改名 flag（如 0.5 把 `--overwrite` 改 `--force`） | `maxRemovedIn: "0.5.0"` 标旧名；新名 `minSince: "0.5.0"` + `aliases: ["--overwrite"]`；kata 自动选对的 |
| comet 新增可选依赖 | 在 yaml 加 `optionalDependencies` 块；kata 加进 wizard |
| comet 改变默认行为（不改 flag） | 在 yaml 加 `breakingChanges[]` + `mitigation.kataShouldPass`；kata 主动透传抵消 |
| JSON 输出 schema 变 | `output.<cmd>.fields` 更新；kata 测试自动跟随 |

## 五、向后与向前兼容

### 5.1 向后（kata 兼容旧 comet）

旧版 comet 没有 `comet compat` 命令、也没在包根放 yaml：L1 / L2 都失败，自动回退到 L3（kata 自带 yaml）。即便 L3 缺失或者损坏，[`comet/src/comet/compat.ts:parseCompatYaml`](../src/comet/compat.ts) 检测到 `version: 1` 时**自动升级**为 v2 schema：保留 minVersion/maxVersion/capabilities（旧式布尔），flags/output 字段留空。

### 5.2 向前（kata 兼容未来 comet）

`version: 9` 等更高版本：parseCompatYaml `unknownFieldsHandled = true` 标志；已知的字段（capabilities / flags / output）继续解析；未知字段忽略不报错。

## 六、测试覆盖

新加 [`kata/tests/unit/comet-compat-v2.test.ts`](../tests/unit/comet-compat-v2.test.ts) 共 20 个用例：

- v1 → v2 upgrade 路径
- v2 capabilities/flags/output 解析
- flag spec 字段（choices / conflictsWith / scopeGuard / preview / itemChoices）
- breakingChanges 与 mitigation
- future schema 容忍
- `isFlagSupported` 4 种边界（unknown / preview / minSince 满足 / minSince 不满足）
- `isBreakingChangeApplicable` 版本边界
- `buildCometProjectInitInvocation` 9 种透传行为（drop unknown / preview / scope guard / enum value 校验 / boolean 序列化 / conflict 消歧 / 无 compat fallback / `--yes --json` 顺序）

旧 [`kata/tests/unit/comet-compat.test.ts`](../tests/unit/comet-compat.test.ts) 改 2 处 fixture 适配新 schema（v1 解析升级返回包含 `version: 2 + source`）。

## 七、上游提案（待推进）

放 [`/app/tmp/comet-evolution.md`](../../tmp/comet-evolution.md) 的协议规范正式化后，会在 [rpamis/comet](https://github.com/rpamis/comet) 上游发起 PR：

1. comet 仓库根目录新增 `comet-compat.yaml`，每次发版自动更新
2. comet 实现 `comet compat --json` 命令——把 package.json 版本号与内部 selectPlatforms / installMode 等 prompt 的当前行为 reflect 出来
3. 修订 CONTRIBUTING：新增 flag 时必须同步更新 yaml

一旦 PR 合入，**kata 仓库永久不需要再追踪 comet 每次 flag 变更**。

## 八、参考

- 协议设计完整文档：[`/app/tmp/comet-evolution.md`](../../tmp/comet-evolution.md)
- 实现位置速查：
  - 解析器：`src/comet/compat.ts`
  - 透传层：`src/comet/install.ts:buildCometProjectInitInvocation`
  - 收集层：`src/init-wizard.ts:promptCometOptions`
  - 接线：`src/cli.ts:runInitWizardCommand` + `collectAutoCometExtras`
- 测试：`tests/unit/comet-compat-v2.test.ts`
