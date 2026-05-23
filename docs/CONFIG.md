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

- `rootDir`：文件类工具的工作根目录，必填。
- `otherRootDirs`：额外允许访问的其它工作根目录，可选。相对路径仍只基于 `rootDir`；访问其它工作区必须传入绝对路径。
- `lineEnding`：文本写回策略，支持 `auto` / `lf` / `crlf`。
- `port`：HTTP MCP 服务端口。

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
| `MCP_OTHER_ROOT_DIRS` | `otherRootDirs` |
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
- `MCP_OTHER_ROOT_DIRS` 使用系统路径分隔符分隔多个目录；Windows 下通常是分号（如 `E:/ProjA;E:/ProjB`）。
- 若 Android 配置缺失，服务仍可启动；只有调用 Android 构建工具时才会返回配置错误。

---

## 配置速查

### `config.json`

| 字段 | 类型 | 默认值 | 说明 |
|-|-|-|-|
| `rootDir` | string | 无（必填） | 主工作区根目录，也是所有相对路径的解析基准 |
| `otherRootDirs` | string[] | `[]` | 额外允许访问的其它工作区；必须使用绝对路径访问 |
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
| 工具调用返回 `Path outside workspace` | AI 传了所有允许工作区范围外的路径，或试图用相对路径访问 `otherRootDirs` | 检查目标路径是否在 `rootDir` 或 `otherRootDirs` 内；其它工作区必须使用绝对路径 |
| Android 构建工具返回配置错误 | 未配置 `android.workspaceRoot` 或 `android.javaHome` | 补全 `android` 配置段，或设置对应环境变量 |
| 环境变量没有生效 | 环境变量为空字符串或名称不匹配 | 确认变量非空，并使用本文列出的变量名 |
