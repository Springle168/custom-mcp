# 配置开发说明

本文记录 `custom-mcp` 的运行配置、阶段 3 全局 workspace schema、当前阶段桥接行为和配置相关故障排查。公开示例优先参考根目录 `config.example.json`；根目录 `config.json` 可能包含个人路径，当前运行时不再从仓库根目录读取它，除非明确需要，不应读取、泛化或覆盖。

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
      }
    }
  ]
}
```

### 当前阶段桥接

阶段 3 只实现全局 schema 与多 workspace 校验，尚未实现阶段 4 的 workspace 选择：

- 启动时会读取并校验 `workspaces` 中的所有 workspace。
- 当前 runtime snapshot 临时使用数组中的第一个 workspace。
- `--workspace <id>`、基于 `cwd` 的默认匹配和 `RuntimeConfigIdentity` 会在阶段 4 实现。
- `envOverrides.allowedFields` 目前只做 schema 形状校验，实际 allowlist 应用会在阶段 5 实现。

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
| `otherRootDirs` | string[] | 否 | additional roots；缺省为 `[]`。当前阶段会校验数组形状，选中 workspace 构建 snapshot 时还会作为 allowed roots 校验。 |
| `android` | object | 否 | Android 构建配置；整段可选，但出现后字段必须完整。 |
| `envOverrides` | object | 否 | 阶段 5 allowlist 的配置位置；当前阶段只接受 `allowedFields` 字段并校验其为 string[]。 |

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

阶段 3 仍保留旧环境变量覆盖行为作为兼容桥接，但只作用于当前临时选中的第一个 workspace。阶段 5 会替换为 `envOverrides.allowedFields` allowlist 语义。

| 环境变量 | 当前覆盖字段 |
|-|-|
| `MCP_ROOT_DIR` | selected workspace `rootDir` |
| `MCP_LINE_ENDING` | selected workspace `lineEnding` |
| `MCP_PORT` | selected workspace `port` |
| `ANDROID_WORKSPACE_ROOT` | selected workspace `android.workspaceRoot` |
| `ANDROID_JAVA_HOME` | selected workspace `android.javaHome` |
| `ANDROID_BUILD_TIMEOUT_MS` | selected workspace `android.buildTimeoutMs` |
| `ANDROID_MAX_ERROR_BLOCK_CHARS` | selected workspace `android.maxErrorBlockChars` |
| `ANDROID_MAX_LOG_TAIL_CHARS` | selected workspace `android.maxLogTailChars` |

覆盖规则：

- 非空环境变量优先于 `~/.custom-mcp/config.json` 中当前临时选中 workspace 的字段。
- 空字符串环境变量视为“未设置”，会回退到配置文件值。
- 当前不支持 `MCP_OTHER_ROOT_DIRS`；`otherRootDirs` 只从配置文件读取。
- 环境变量中的正整数同样使用严格解析。
- 这套默认开启的覆盖规则是迁移期兼容行为；阶段 5 会替换为 allowlist，并禁止边界字段覆盖。

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
| 启动报 `Unknown config field ...` | 配置包含 schema 未定义字段 | 删除未知字段，或等待对应阶段实现后再使用。 |
| 启动报 workspace `id` 或 `port` 重复 | 多个 workspace 使用了同一 id 或端口 | 为每个 workspace 配置唯一 id 和端口。 |
| 启动报 root 重复或嵌套 | 多个 workspace `rootDir` 在 lexical 或 realpath 层重复/互相包含 | 拆分为互相独立的目录；不要把子目录配置为另一个 workspace root。 |
| 启动报 selected workspace allowed roots 错误 | 当前临时选中的第一个 workspace 的 `rootDir` / `otherRootDirs` 无法构建 path safety context | 检查第一个 workspace 的 allowed roots 是否都是存在的绝对目录，且互不重复/嵌套。 |
| 工具调用返回 `Path outside workspace` | AI 传了 selected workspace allowed roots 范围外的路径，或用相对路径试图访问 additional root | 检查目标路径和 root 配置；additional root 必须用 drive-absolute 路径访问。 |
| Android 构建工具返回配置错误 | 当前临时选中的 workspace 没有 runtime Android 配置 | 在该 workspace 中补全 `android` 配置段，或使用迁移期 Android 环境变量覆盖。 |
| 环境变量没有生效 | 环境变量为空字符串、名称不匹配，或字段不在当前阶段兼容列表中 | 确认变量非空，并使用本文列出的变量名；阶段 5 后需改用 allowlist。 |
