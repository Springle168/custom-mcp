# 配置开发说明

本文记录 `custom-mcp` 的运行配置、全局 workspace 选择、阶段 5 env override allowlist 行为和配置相关故障排查。公开示例优先参考根目录 `config.example.json`；根目录 `config.json` 可能包含个人路径，当前运行时不再从仓库根目录读取它，除非明确需要，不应读取、泛化或覆盖。

---

## 配置文件说明

运行配置文件位于用户 home 下的固定 dotdir 路径：

```text
~/.custom-mcp/config.json
```

在 Windows 上通常展开为 `%USERPROFILE%\.custom-mcp\config.json`。可以复制根目录 `config.example.json` 的内容作为模板，但服务启动时只读取 home-level dotdir 的 `config.json`，不会读取仓库根目录或当前工作目录下的 `config.json`。

当前阶段已切换到 `version: 1` 全局 workspace schema。文件内容示例：

```json
{
  "version": 1,
  "workspaces": [
    {
      "id": "custom-mcp",
      "rootDir": "E:/YourWorkspace",
      "otherRootDirs": [
        "E:/AnotherWorkspace"
      ],
      "lineEnding": "auto",
      "port": 3100,
      "android": {
        "workspaceRoot": "E:/AndroidStudioProjects/YourProject",
        "javaHome": "E:/Android_Studio/jbr",
        "buildTimeoutMs": 900000,
        "maxErrorBlockChars": 2500,
        "maxLogTailChars": 4000
      },
      "envOverrides": {
        "allowedFields": [
          "lineEnding",
          "android.javaHome"
        ]
      }
    }
  ]
}
```

### Workspace 选择

启动时会读取并校验 `workspaces` 中的所有 workspace，然后选择本次进程使用的 workspace：

- 显式选择：`custom-mcp --workspace <id>` 或 `custom-mcp --workspace=<id>` 按 workspace `id` 选择；显式选择不要求当前工作目录与该 workspace 的 `rootDir` 匹配。
- 默认选择：未提供 `--workspace` 时，`process.cwd()` 的 realpath 必须与某个 workspace `rootDir` 的 realpath 等价。
- 默认选择只接受 cwd 与 root 等价；cwd 位于某个 workspace 的子目录中不会被视为匹配。
- Windows 下大小写、路径分隔符和尾部分隔符差异不应影响默认匹配。
- 启动选择成功后会形成 `RuntimeConfigIdentity`，记录 config file path、workspace id、已验证/规范化的 rootDir、port 和 selection mode。
- Env overrides 在 workspace 选择之后才按 selected workspace 的 allowlist 应用；它们不参与 workspace 选择，也不改变 `RuntimeConfigIdentity`。

---

## Schema 速查

### 顶层字段

| 字段 | 类型 | 必填 | 说明 |
|-|-|-|-|
| `version` | `1` | 是 | 配置 schema 版本；当前只接受数字 `1`。 |
| `workspaces` | object[] | 是 | workspace 数组，必须非空。 |

顶层未知字段会导致启动失败。

### Workspace 字段

| 字段 | 类型 | 必填 | 说明 |
|-|-|-|-|
| `id` | string | 是 | workspace 稳定标识；必须非空且全局唯一。 |
| `rootDir` | string | 是 | workspace primary root；必须是本地绝对路径、真实存在且为目录。 |
| `port` | positive integer | 是 | 该 workspace 的 HTTP 端口；范围 `1..65535`，且全局唯一。 |
| `lineEnding` | `"auto"` \| `"lf"` \| `"crlf"` | 是 | 文本写回策略。 |
| `otherRootDirs` | string[] | 否 | additional roots；缺省为 `[]`。选中 workspace 构建 snapshot 时会作为 allowed roots 校验。 |
| `android` | object | 否 | Android 构建配置；整段可选，但出现后字段必须完整。 |
| `envOverrides` | object | 否 | 字段级环境变量覆盖 allowlist；缺省为全部禁用。 |

workspace 未知字段会导致启动失败。

### `android` 配置段

`android` 配置段是可选的；未配置时服务仍可启动，但调用 Android 构建工具会返回配置错误。若出现，则以下字段全部必填，且正整数字段没有文件内默认值：

| 字段 | 类型 | 说明 |
|-|-|-|
| `workspaceRoot` | string | Android 构建工具的工作目录，应包含 `gradlew.bat`；是否存在 wrapper 仍在工具调用阶段检查。 |
| `javaHome` | string | 构建时注入的 JBR / JDK 根目录。 |
| `buildTimeoutMs` | positive integer | Gradle 进程超时时间。 |
| `maxErrorBlockChars` | positive integer | 失败结果中 `firstErrorBlock` 的最大长度。 |
| `maxLogTailChars` | positive integer | 失败结果中 `logTail` 的最大长度。 |

### 校验规则

配置加载阶段会执行严格校验：

- `version` 必须存在且为 `1`。
- `workspaces` 必须是非空数组。
- 未知字段会失败，不会静默忽略。
- workspace `id` 必须非空且全局唯一。
- workspace `port` 必须是 `1..65535` 的正整数且全局唯一。
- workspace `rootDir` 必须是本地绝对路径、真实存在且为目录。
- 所有 workspace `rootDir` 在 lexical normalized path 层不得重复或互相嵌套。
- 所有 workspace `rootDir` 在 realpath 层不得重复或互相嵌套。
- `lineEnding` 只接受 `auto` / `lf` / `crlf`。
- `otherRootDirs` 缺省为 `[]`；若提供，必须是非空字符串数组。
- `android` 若提供，必须是对象且字段完整。
- 所有正整数字段使用严格解析；`123abc` 和 `1.5` 都会失败。

---

## 环境变量覆盖

字段级 env override 默认禁用。只有当前选中 workspace 的 `envOverrides.allowedFields` 中列出的字段会读取对应环境变量。

### Allowlist 语义

- 没有 `envOverrides`：全部字段级 env override 禁用。
- `allowedFields: []`：全部字段级 env override 禁用。
- 只有 selected workspace allowlist 中的字段会读取 env；未选中 workspace 的 allowlist 不影响当前 snapshot。
- 环境变量值为 `""` 时视为未设置，回退到配置文件值。
- 环境变量非空但非法时，启动失败。
- Env override 在 workspace 选择之后应用，不参与 cwd 匹配或 `--workspace` 选择。
- Env override 不改变 `RuntimeConfigIdentity`；`rootDir`、`port` 等边界字段始终来自配置文件中已验证的 selected workspace。
- `android.*` allowlist 要求该 workspace 已经显式配置完整 `android` 段；env override 不能创建缺失的 Android 配置。

### 允许覆盖的字段

| 字段 | 环境变量 |
|-|-|
| `lineEnding` | `MCP_LINE_ENDING` |
| `android.workspaceRoot` | `ANDROID_WORKSPACE_ROOT` |
| `android.javaHome` | `ANDROID_JAVA_HOME` |
| `android.buildTimeoutMs` | `ANDROID_BUILD_TIMEOUT_MS` |
| `android.maxErrorBlockChars` | `ANDROID_MAX_ERROR_BLOCK_CHARS` |
| `android.maxLogTailChars` | `ANDROID_MAX_LOG_TAIL_CHARS` |

### 禁止覆盖的字段

这些字段不能出现在 `envOverrides.allowedFields` 中：

| 字段 | 原因 |
|-|-|
| `version` | schema 版本不能由 env 改变。 |
| `workspaces` | 全局结构不能由 env 改变。 |
| `id` | workspace identity 不能由 env 改变。 |
| `rootDir` | primary root 和 workspace 选择边界不能由 env 改变。 |
| `port` | 端口唯一性、启动端口和 runtime identity 不能由 env 改变。 |
| `otherRootDirs` | additional roots 会扩大文件访问边界，不能由 env 改变。 |
| `rules` | 请求规则结构复杂且影响请求行为，不能由 env 改变。 |
| `MCP_ROOT_DIR` | 旧环境变量名不属于新模型。 |
| `MCP_PORT` | 旧环境变量名不属于新模型。 |

未列在允许字段或禁止字段表中的 allowlist 项会作为未知字段导致启动失败。

---

## 行尾符策略

| 设置 | 已有文件 | 新建文件 |
|-|-|-|
| `auto` | 检测并保留原始行尾符 | 使用 `\n` (LF) |
| `lf` | 强制 `\n` | 强制 `\n` |
| `crlf` | 强制 `\r\n` | 强制 `\r\n` |

---

## 故障排查

| 现象 | 可能原因 | 解决方案 |
|-|-|-|
| 启动报 `Global config file does not exist` | `~/.custom-mcp/config.json` 不存在 | 创建该文件；仓库根目录 `config.json` 不会作为运行配置读取。 |
| 启动报 `version must be the number 1` | 仍在使用旧 flat schema，或 `version` 缺失/错误 | 将配置迁移为 `version: 1` + `workspaces` 数组。 |
| 启动报 `Unknown config field ...` | 配置包含 schema 未定义字段 | 删除未知字段，或等待对应功能实现后再使用。 |
| 启动报 workspace `id` 或 `port` 重复 | 多个 workspace 使用了同一 id 或端口 | 为每个 workspace 配置唯一 id 和端口。 |
| 启动报 root 重复或嵌套 | 多个 workspace `rootDir` 在 lexical 或 realpath 层重复/互相包含 | 拆分为互相独立的目录；不要把子目录配置为另一个 workspace root。 |
| 启动报 selected workspace allowed roots 错误 | 当前选中 workspace 的 `rootDir` / `otherRootDirs` 无法构建 path safety context | 检查该 workspace 的 allowed roots 是否都是存在的绝对目录，且互不重复/嵌套。 |
| 启动报 `envOverrides.allowedFields contains forbidden field ...` | allowlist 试图覆盖边界字段或旧环境变量名 | 从 allowlist 移除该字段；`rootDir`、`port`、`MCP_ROOT_DIR`、`MCP_PORT` 不能通过 env 覆盖。 |
| 启动报 `envOverrides.allowedFields contains unknown field ...` | allowlist 包含未支持字段 | 改为允许字段表中的字段，或删除该 allowlist 项。 |
| 启动报 `ANDROID_* must be a positive integer` | allowlist 允许了 Android 数值字段，但对应 env 非空且不是正整数 | 修正 env 值，或设为空字符串回退配置文件值。 |
| 启动报 Android allowlist 但 `android is not configured` | workspace 允许了 `android.*` env override，却没有配置 `android` 段 | 补全该 workspace 的 `android` 段，或移除 `android.*` allowlist 项。 |
| 工具调用返回 `Path outside workspace` | AI 传了 selected workspace allowed roots 范围外的路径，或用相对路径试图访问 additional root | 检查目标路径和 root 配置；additional root 必须用 drive-absolute 路径访问。 |
| Android 构建工具返回配置错误 | 当前选中 workspace 没有 runtime Android 配置 | 在该 workspace 中补全 `android` 配置段；`ANDROID_*` 只能覆盖已有 `android` 配置，不能创建它。 |
| 环境变量没有生效 | 对应字段未列入 selected workspace 的 `envOverrides.allowedFields`，或 env 值为空字符串 | 添加允许字段，或设置非空且合法的环境变量值。 |
