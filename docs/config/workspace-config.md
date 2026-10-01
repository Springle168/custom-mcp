# Workspace 配置

workspace 配置定义一个 selected workspace 的运行参数、文件访问边界和工具策略。全局索引只负责提供 workspace id 与此文件的路径；其 schema 和选择方式见 [全局 workspace 索引](global-index.md)。两层配置的加载顺序见 [配置概览](../CONFIG.md)。

---

## 文件模型

workspace 配置文件名和扩展名没有额外要求。被选中后，文件必须存在、解析 symlink 后为普通文件、可读、可严格 UTF-8 解码，并且包含合法 JSON object；UTF-8 BOM 合法。

文件不包含 `id`。runtime workspace id 来自全局索引中被选中的 reference，workspace 文件不能定义或覆盖它。

完整模板见 [workspace-config.example.json](../../examples/workspace-config.example.json)。模板中的路径和值需要替换为本机有效配置。

只有 selected workspace 文件会被读取、解析、校验并编译 file access policy。未选中 workspace 文件的缺失、不可读、JSON 损坏、schema 无效或策略文件无效，不影响本次启动。

---

## 顶层 schema

`version` 必须是 JSON number `1`。顶层未知字段会导致配置失败。

| 字段 | 类型 | 必填 | 说明 |
|-|-|-|-|
| `version` | `1` | 是 | workspace schema 版本。 |
| `rootDir` | string | 是 | primary root；必须是已存在的本地绝对目录。 |
| `host` | IPv4 / IPv6 string | 否 | HTTP bind IP；缺省为 `127.0.0.1`，不接受 hostname。 |
| `port` | JSON number positive integer | 是 | 范围 `1..65535`。 |
| `lineEnding` | `"auto"` \| `"lf"` \| `"crlf"` | 是 | 文本写回策略。 |
| `logsDir` | string | 否 | 已存在的本地绝对日志根目录；缺省为 `~/.custom-mcp/logs`。 |
| `otherRootDirs` | string[] | 否 | additional allowed roots；缺省为 `[]`。 |
| `fileAccess` | object | 否 | primary / additional root 的 ignore 与 deny 策略文件。 |
| `android` | object | 否 | Android 构建配置；出现时字段必须完整。 |
| `envOverrides` | object | 否 | selected workspace 的字段级环境变量覆盖 allowlist。 |
| `rules` | object | 否 | request header compatibility rules。 |
| `tools` | object | 否 | workspace custom Tool definition reference 与 effective tool exposure。 |

不同 workspace 可以复用 `rootDir` 或 `port`。同一个 selected workspace 中的 `rootDir + otherRootDirs` 仍必须满足 allowed-root 的重复、嵌套与 realpath 安全约束。

---

## 通用字段策略

### Path-like 字段

以下字段必须是已存在的本地绝对目录：

- `rootDir`
- `otherRootDirs[]`
- configured `logsDir`
- `android.workspaceRoot`
- `android.javaHome`
- allowlisted path env override

默认 logs root `~/.custom-mcp/logs` 也必须预先存在。配置路径不做 trim 或 `~` 展开；Windows 下要求 drive-absolute path，不接受相对路径、UNC、namespace path、drive-relative path 或 rooted-without-drive path。

`rootDir` 是 primary root，`otherRootDirs` 是 additional roots。snapshot 构建时，二者形成文件工具的 allowed roots；这些 roots 在 lexical normalized path 与 realpath 层都不能重复或互相嵌套。`logsDir`、`android.workspaceRoot` 与 `android.javaHome` 不会加入 allowed roots。

文件工具中路径、glob、ignore / deny 和 symlink 的运行时语义见 [路径安全](../PATH-SAFETY.md)。

### Numeric 字段

配置文件中的 numeric 字段只接受 JSON number positive integer。numeric string、`0`、负数、小数和 unsafe integer 无效。`port` 额外限制在 `1..65535`。

### 行尾符

| 设置 | 已有文件 | 新建文件 |
|-|-|-|
| `auto` | 检测并保留原始行尾符 | LF |
| `lf` | 强制 LF | LF |
| `crlf` | 强制 CRLF | CRLF |

---

## `fileAccess`

`fileAccess` 只允许 `rootDir` 与 `otherRootDirs`：

- 每个 root policy 只允许有序的 `ignoreFiles`、`denyFiles` string 数组；两者都缺省为 `[]`。
- 配置数组的顺序和重复引用保留。每个 policy reference 必须是无首尾 whitespace 的受支持本地绝对路径。
- selected workspace 启动时，策略文件必须存在、可读、解析 symlink 后为普通文件，并可严格 UTF-8 解码。
- `fileAccess.otherRootDirs` 的每个 key 必须 lexical 关联本 workspace 的一个 configured additional root；primary root、未关联 key、仅 realpath 相等的 alias 或关联同一 additional root 的重复 key 都无效。
- 只编译 selected workspace 的策略。snapshot 保存不可变 query facade 与用于启动日志的 lexical policy file metadata，不暴露 matcher mutation API。

Ignore 只过滤自动发现的结果，literal 路径可以绕过 ignore；deny 始终应用。root-specific policy 的路径安全与匹配顺序见 [路径安全](../PATH-SAFETY.md)，启动时的 policy file 摘要见 [日志](../LOGGING.md)。

---

## `tools`

`tools` 控制 selected workspace 的自定义 Tool definitions 与 effective tool exposure。该 object 只允许 `toolConfigFile`、`enabled`、`disabled`：

| 字段 | 类型 | 说明 |
|-|-|-|
| `toolConfigFile` | string | 可选；指向 Tool config v2 的本地绝对路径，格式、加载规则与示例见 [自定义 Tool 配置](tool-config.md)。 |
| `enabled` | string[] | 可选；只暴露列出的 effective tool names。 |
| `disabled` | string[] | 可选；暴露未列出的 effective tool names。 |

规则：

- `tools` 缺失与 `tools: {}` 等价；两者都暴露全部 effective tools。
- `toolConfigFile` 可以与 `enabled` 或 `disabled` 并存；`enabled` 与 `disabled` 不能同时出现。
- `enabled: []` 表示不暴露工具；`disabled: []` 表示暴露全部 effective tools。
- selector 名称使用 `^[A-Za-z0-9._-]{1,128}$`，区分大小写且数组内不能重复。
- workspace 结构解析只校验 selector grammar。名称成员在 custom definitions 与内置 registry 合并成 effective catalog 后校验，因此 selector 可以引用 custom-only 工具。
- selector 成员不存在时，错误归属 workspace 配置的 `tools.enabled[i]` 或 `tools.disabled[i]`。

---

## `rules.requestHeaders`

`rules` 只允许 `requestHeaders`。`rules` 缺失、`rules: {}`、`requestHeaders` 缺失或空数组都会归一化为 `{ requestHeaders: [] }`。

每条 rule 只允许 `match` 与 `enable`，两者都必填：

- `match` 是非空 object。header name 通过 HTTP token grammar 校验并按 lowercase 保存；同一 rule 中 lowercase 后重复的 header name 无效。
- match value 是无首尾 whitespace 的合法 HTTP field value。配置错误不输出期望 header value。
- `enable` 是非空数组；只允许精确的 `structuredContentDup`，同一 rule 内重复 feature 无效。
- rule 间采用 OR，同一 rule 的条件采用 AND；请求中引用 header 缺失或重复时，对应条件不匹配。
- 只有 selected workspace 的 rules 进入 runtime snapshot。

请求 header 的 strict view、命中后的 `structuredContent` 返回值适配和日志隐私边界分别见 [工具返回结果](../TOOL-RESULTS.md) 与 [日志](../LOGGING.md)。

---

## Android 配置

`android` 可选。缺失时服务仍可启动，Android 工具调用返回归属 selected workspace 配置文件的配置错误。出现时以下字段全部必填：

| 字段 | 类型 |
|-|-|
| `workspaceRoot` | existing absolute directory |
| `javaHome` | existing absolute directory |
| `buildTimeoutMs` | JSON number positive integer |
| `maxErrorBlockChars` | JSON number positive integer |
| `maxLogTailChars` | JSON number positive integer |

`android.workspaceRoot` 是 Android 构建工具的工作目录；`javaHome` 是构建时使用的 JDK/JBR 根目录。工具调用阶段仍会校验项目可构建所需的文件与环境。Android 工具的参数、执行与结果语义见 [Android 构建工具](../tools/android-build.md)。

---

## 环境变量覆盖

Env override 默认关闭。只有 `envOverrides.allowedFields` 明确列出的 selected workspace 字段才读取对应环境变量：

| 字段 | 环境变量 |
|-|-|
| `lineEnding` | `MCP_LINE_ENDING` |
| `logsDir` | `MCP_LOGS_DIR` |
| `android.workspaceRoot` | `ANDROID_WORKSPACE_ROOT` |
| `android.javaHome` | `ANDROID_JAVA_HOME` |
| `android.buildTimeoutMs` | `ANDROID_BUILD_TIMEOUT_MS` |
| `android.maxErrorBlockChars` | `ANDROID_MAX_ERROR_BLOCK_CHARS` |
| `android.maxLogTailChars` | `ANDROID_MAX_LOG_TAIL_CHARS` |

`envOverrides` 出现时必须包含 `allowedFields` 数组；空数组合法，表示不允许任何字段覆盖。

规则：

- allowlist 写配置字段 selector，不写环境变量名。duplicate、unknown、forbidden selector 都无效。
- `android.*` selector 要求同一 workspace 已配置完整 `android` 段；环境变量不能创建缺失的 Android 配置。
- 环境变量缺失时不覆盖。已授权环境变量存在但为空、含首尾 whitespace 或不满足目标字段 grammar 时，启动失败。
- `rootDir`、`host`、`port`、`otherRootDirs`、`fileAccess*`、`tools*`、`rules*` 等边界或复杂结构禁止覆盖。
- Env override 不参与 workspace 选择，也不改变 `RuntimeConfigIdentity`。

`MCP_LOGS_DIR` 的日志目录约束和日志文件布局见 [日志](../LOGGING.md)。

---

## Runtime snapshot 与配置来源

`RuntimeConfigIdentity` 记录以下稳定 identity：

- `globalConfigFilePath`
- `workspaceConfigFilePath`
- `workspaceId`
- `rootDir`
- `host`
- `port`

`RuntimeConfigSnapshot` 保存 canonical roots、logs root、line ending、Android 配置、request rules、file access facade 与 policy file metadata。snapshot 与内部容器通过 deep-freeze 保持不可变。工具 definitions、validators、executor bindings 与 exposure 由独立的 compiled workspace tool catalog 持有。

snapshot 在 selected workspace 的 schema、file access policy 和 env override 处理后构建。每次工具调用从 `ConfigStore` 读取一次 snapshot，再派生本次调用的 `ToolRuntimeContext`；调用期间不重新读取配置。

selected workspace 文件的读取、JSON、schema、path、env override 和 policy 错误归属该文件。全局索引 reference、id 与选择错误归属全局 `config.json`，见 [全局 workspace 索引](global-index.md)。

---

## 源码与测试

| 区域 | 职责 |
|-|-|
| `src/config/schema.ts` | `version: 1` workspace schema、path-like 字段、Android 与 env override allowlist。 |
| `src/config/file-access-policy.ts` | selected workspace policy 文件的验证、读取、编译与只读 facade。 |
| `src/config/env-overrides.ts` | selected workspace allowlist 与环境变量读取。 |
| `src/config/runtime-snapshot.ts` | canonical roots、runtime snapshot 与 deep-freeze。 |
| `src/config/request-header-rules.ts` | `rules.requestHeaders` schema 与 runtime rules。 |
| `src/config/tool-exposure.ts` | `tools` 外壳、tool config path 与未决 exposure selector。 |
| `src/config/strict-utf8-file.ts` | 配置文本共享的同一 descriptor 普通文件检查、读取与 strict UTF-8 边界。 |
| `src/config/json-file.ts` | 全局、workspace 与 referenced JSON 的解析和 JSON-oriented 诊断边界。 |
| `src/runtime/application/startup-runtime.ts` | snapshot 与 tool catalog 的启动期组合。 |
| `test/config/load-runtime-config.test.ts` | 两层配置加载集成行为。 |
| `test/config/file-access-policy.test.ts` | selected-only policy 编译与 file access schema。 |
| `test/config/env-overrides.test.ts` | allowlist、值 grammar 与选择边界。 |
| `test/config/runtime-snapshot.test.ts` | canonical roots、snapshot 与 immutable graph。 |
| `test/config/request-header-rules.test.ts` | request header rules schema 与 snapshot 接入。 |
| `test/config/tool-exposure.test.ts` | workspace `tools` 结构、path、selector grammar 与重复项。 |
| `test/runtime/startup-runtime.test.ts` | selected-only 加载、启动期 catalog 组合与运行期不重读。 |

测试组织和命令见 [测试](../TESTING.md)。
