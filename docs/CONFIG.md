# 配置开发说明

本文记录 `custom-mcp` 的运行配置、环境变量覆盖规则和配置相关故障排查。公开示例优先参考根目录 `config.example.json`；根目录 `config.json` 是本地运行配置，可能包含个人路径，除非明确需要，不应读取、泛化或覆盖。

---

## 配置文件说明

运行配置放在根目录 `config.json`，也可通过环境变量覆盖部分字段：

```json
{
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
```

### 顶层字段

- `rootDir`：文件类工具的 primary root，必填；相对路径和相对 glob 永远基于它解析。
- `otherRootDirs`：文件类工具允许访问的 additional roots，可选；只能通过 drive-absolute path / glob 访问。
- `lineEnding`：文本写回策略，支持 `auto` / `lf` / `crlf`。
- `port`：HTTP MCP 服务端口。

`rootDir` 和 `otherRootDirs` 会在配置加载阶段集中校验：每个 root 必须是本地绝对路径、真实存在且为目录；所有 allowed roots 在 lexical normalized path 层和 realpath 层都不得重复或互相嵌套。root 本身可以是 symlink / junction，但 realpath 后仍必须满足唯一且互不嵌套。

### `android` 配置段

- `workspaceRoot`：Android 构建工具的工作目录，应包含 `gradlew.bat`。
- `javaHome`：构建时注入的 JBR / JDK 根目录。
- `buildTimeoutMs`：Gradle 超时时间，默认 `900000`。
- `maxErrorBlockChars`：失败时 `firstErrorBlock` 的最大长度，默认 `2500`。
- `maxLogTailChars`：失败时 `logTail` 的最大长度，默认 `4000`。

`android` 配置段是可选的；未配置时服务仍可启动，但调用 Android 构建工具会返回配置错误。

---

## 环境变量覆盖

支持以下环境变量：

| 环境变量 | 覆盖字段 |
|-|-|
| `MCP_ROOT_DIR` | `rootDir` |
| `MCP_LINE_ENDING` | `lineEnding` |
| `MCP_PORT` | `port` |
| `ANDROID_WORKSPACE_ROOT` | `android.workspaceRoot` |
| `ANDROID_JAVA_HOME` | `android.javaHome` |
| `ANDROID_BUILD_TIMEOUT_MS` | `android.buildTimeoutMs` |
| `ANDROID_MAX_ERROR_BLOCK_CHARS` | `android.maxErrorBlockChars` |
| `ANDROID_MAX_LOG_TAIL_CHARS` | `android.maxLogTailChars` |

覆盖规则：

- 非空环境变量优先于 `config.json`。
- 空字符串环境变量视为“未设置”，会回退到 `config.json`。
- 当前不支持 `MCP_OTHER_ROOT_DIRS`；`otherRootDirs` 只从配置文件读取。
- 若 Android 配置缺失，服务仍可启动；只有调用 Android 构建工具时才会返回配置错误。

---

## 配置速查

### `config.json`

| 字段 | 类型 | 默认值 | 说明 |
|-|-|-|-|
| `rootDir` | string | 无（必填） | primary root；相对 path / glob 的解析基准 |
| `otherRootDirs` | string[] | 未配置 | 额外允许访问的工作区根目录；相对路径不会基于这些目录解析 |
| `lineEnding` | `"auto"` \| `"lf"` \| `"crlf"` | `"auto"` | 文件写入时的行尾符策略 |
| `port` | number | `3100` | HTTP 服务器监听端口 |
| `android.workspaceRoot` | string | 无 | Android 构建工具工作目录，应包含 `gradlew.bat` |
| `android.javaHome` | string | 无 | Android 构建时注入的 JBR / JDK 根目录 |
| `android.buildTimeoutMs` | number | `900000` | Gradle 进程超时时间 |
| `android.maxErrorBlockChars` | number | `2500` | 失败结果中 `firstErrorBlock` 的最大长度 |
| `android.maxLogTailChars` | number | `4000` | 失败结果中 `logTail` 的最大长度 |

### 行尾符策略

| 设置 | 已有文件 | 新建文件 |
|-|-|-|
| `auto` | 检测并保留原始行尾符 | 使用 `\n` (LF) |
| `lf` | 强制 `\n` | 强制 `\n` |
| `crlf` | 强制 `\r\n` | 强制 `\r\n` |

---

## 故障排查

| 现象 | 可能原因 | 解决方案 |
|-|-|-|
| 启动报 `rootDir is not configured` | `config.json` 中 `rootDir` 为空 | 填入项目绝对路径，或设置 `MCP_ROOT_DIR` |
| 启动报 root 重复或嵌套 | `rootDir` 与 `otherRootDirs` 在 lexical 或 realpath 层重复/互相包含 | 拆分为互相独立的目录；不要把子目录配置为另一个 root |
| 工具调用返回 `Path outside workspace` | AI 传了所有 allowed roots 范围外的路径，或用相对路径试图访问 additional root | 检查目标路径和 root 配置；additional root 必须用 drive-absolute 路径访问 |
| Android 构建工具返回配置错误 | 未配置 `android.workspaceRoot` 或 `android.javaHome` | 补全 `android` 配置段，或设置对应环境变量 |
| 环境变量没有生效 | 环境变量为空字符串或名称不匹配 | 确认变量非空，并使用本文列出的变量名 |
