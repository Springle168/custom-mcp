# 配置开发说明

本文记录 `custom-mcp` 的全局 workspace 索引、workspace 配置、显式选择、runtime snapshot、env override allowlist 和配置故障排查。`examples/config.json` 与 `examples/workspace-config.json` 分别提供两类配置模板。

---

## 配置文件模型

服务固定读取 home-level 全局索引：

```text
~/.custom-mcp/config.json
```

Windows 上通常展开为 `%USERPROFILE%\.custom-mcp\config.json`。全局索引只负责 workspace identity 与配置文件定位；完整运行配置保存在每个 workspace 自己的 JSON 文件中。

### 全局索引

完整结构见 [全局配置示例](../examples/config.json)。

- `version` 必须是 JSON number `2`。
- `workspaces` 必须是非空数组。
- 每项只允许 `id` 与 `configFile`。
- `id` 长度为 `1..64`，以小写字母或数字开头，只允许小写字母、数字、`-`、`_`，并且必须全局唯一。
- `configFile` 必须是无首尾 whitespace 的本地绝对路径。Windows 下要求 drive-absolute，不接受相对路径、UNC、namespace path、drive-relative、rooted-without-drive 或 `~` 展开。
- 全局索引解析只检查所有 `configFile` 的 lexical 路径语义，不读取、`stat` 或解析未选中的 workspace 文件。
- 不同 `id` 可以引用同一个 `configFile`；引用路径不做 lexical 或 realpath 唯一性检查。
- 顶层和 workspace reference 的未知字段都会失败。

### Workspace 配置

完整结构见 [workspace 配置示例](../examples/workspace-config.json)。

workspace 配置文件不包含 `id`；runtime workspace id 始终来自全局索引。文件名和扩展名没有额外要求，但被选中后必须存在、解析 symlink 后为普通文件、可读、能以严格 UTF-8 解码并包含合法 JSON object。UTF-8 BOM 合法。

workspace 配置的 `version` 必须是 JSON number `1`。

---

## 启动方式与加载管线

启动必须且只能使用分隔参数形式：

```text
custom-mcp --workspace <id>
```

以下形式不受支持：

```text
custom-mcp
custom-mcp --workspace=<id>
```

缺失、重复、空字符串、whitespace-only、首尾 whitespace 或 grammar 非法的 workspace 参数由 `parseCliArgs()` 以 `CliError` 拒绝。配置 loader 对直接调用传入的 `workspaceId` 执行同一 lexical grammar 的防御性校验。

`loadRuntimeConfigWithIdentity()` 的启动管线如下：

```text
parseCliArgs()
  - 必须解析 --workspace <id>
        │
        ▼
getDefaultGlobalConfigPath() + getDefaultGlobalLogsDir()
  - 固定解析 ~/.custom-mcp/config.json 与 ~/.custom-mcp/logs
        │
        ▼
读取并严格 UTF-8 解码全局 config.json
        │
        ▼
parseGlobalConfig()
  - 校验 version: 2、reference schema、id 唯一性与 configFile lexical 路径
  - 不读取任何 workspace configFile
        │
        ▼
selectWorkspaceReference()
  - 按显式 workspace id 选择唯一 reference
        │
        ▼
读取并严格 UTF-8 解码 selected configFile
        │
        ▼
parseWorkspaceConfig()
  - 校验 version: 1 与 selected workspace 的完整 schema/value/path policy
        │
        ▼
compileWorkspaceFileAccessPolicy()
  - 只读取并编译 selected workspace 的 ignore / deny 策略文件
        │
        ▼
createRuntimeConfigIdentity()
  - 记录 global/workspace 配置来源、id、rootDir、host、port
        │
        ▼
applyEnvOverridesToWorkspace()
  - 只读取 selected workspace allowlist 授权的 env var
        │
        ▼
buildRuntimeConfigSnapshot()
  - 校验 selected rootDir + otherRootDirs，构建并 deep-freeze snapshot
```

维护不变量：

- 未选中 workspace 文件不存在、不可读、JSON 损坏、schema 非法或策略文件失效，都不会阻止当前 workspace 启动。
- `id` 是唯一的全局 workspace 约束。不同 workspace 可以复用同一 `configFile`、`rootDir` 或 `port`。
- 同一个 workspace 内的 `rootDir + otherRootDirs` 仍必须满足 allowed-root 的 existing-directory、重复、嵌套与 realpath 安全约束。
- 多个进程同时使用同一端口时由操作系统端口绑定错误处理，不通过全局配置扫描预判。
- Env override 不参与 workspace 选择，也不能改变 `id`、`rootDir`、`host`、`port` 或 `otherRootDirs` 等边界。
- 配置与策略修改需要重启；`ConfigStore` 不提供 watcher、reload apply 或 snapshot mutation API。

---

## Workspace schema

| 字段 | 类型 | 必填 | 说明 |
|-|-|-|-|
| `version` | `1` | 是 | workspace 配置 schema 版本。 |
| `rootDir` | string | 是 | primary root；必须是已存在的本地绝对目录。 |
| `host` | IPv4 / IPv6 string | 否 | HTTP bind IP，缺省为 `127.0.0.1`；不接受 hostname。 |
| `port` | JSON number positive integer | 是 | 范围 `1..65535`；不同 workspace 可以重复。 |
| `lineEnding` | `"auto"` \| `"lf"` \| `"crlf"` | 是 | 文本写回策略。 |
| `logsDir` | string | 否 | 已存在的本地绝对日志根目录；缺省为 `~/.custom-mcp/logs`。 |
| `otherRootDirs` | string[] | 否 | additional allowed roots，缺省为 `[]`。 |
| `fileAccess` | object | 否 | primary/additional root 的 ignore 与 deny 策略文件。 |
| `android` | object | 否 | Android 构建配置；出现时字段必须完整。 |
| `envOverrides` | object | 否 | selected workspace 的字段级 env override allowlist。 |
| `rules` | object | 否 | request header compatibility rules。 |
| `tools` | object | 否 | workspace 工具暴露策略。 |

workspace 未知字段严格失败。typed string、numeric、IP、token、selector 和 path-like 值继续使用 `src/config/value-policy.ts` 与 `src/config/path-policy.ts` 的集中策略。

### Path-like 字段

以下字段必须是已存在的本地绝对目录：

- `rootDir`
- `otherRootDirs[]`
- configured `logsDir`
- `android.workspaceRoot`
- `android.javaHome`
- allowlisted path env override

默认 logs root `~/.custom-mcp/logs` 也必须预先存在。配置路径不做 trim 或 `~` 展开。

### Numeric 字段

配置文件 numeric 字段只接受 JSON number positive integer。numeric string、`0`、负数、小数和 unsafe integer 均非法。`port` 另限制为 `1..65535`。

### 行尾符

| 设置 | 已有文件 | 新建文件 |
|-|-|-|
| `auto` | 检测并保留原始行尾符 | LF |
| `lf` | 强制 LF | LF |
| `crlf` | 强制 CRLF | CRLF |

---

## `fileAccess`

配置结构见 [workspace 配置示例](../examples/workspace-config.json) 的 `fileAccess` 段。

- `fileAccess` 只允许 `rootDir` 与 `otherRootDirs`。
- 每个 root policy 只允许有序 `ignoreFiles`、`denyFiles` string 数组，缺省为 `[]`；顺序和重复引用保留。
- policy reference 必须是受支持的本地绝对路径。selected workspace 启动时要求文件存在、可读、解析 symlink 后为普通文件且可严格 UTF-8 解码。
- `otherRootDirs` key 必须 lexical 关联同一 workspace 的一个 configured additional root；primary root、未关联 key、alias-only match 或重复 key 非法。
- 只编译 selected workspace。Runtime snapshot 保存不可变 query facade 与用于启动日志的 lexical policy file metadata，不暴露 matcher mutation API。
- Ignore 只过滤自动发现结果，literal 路径可以绕过 ignore；deny 始终应用。完整路径语义见 `docs/PATH-SAFETY.md`。

---

## `tools`

`tools` 必须且只能配置 `allowed` 或 `disabled` 之一；结构见 [workspace 配置示例](../examples/workspace-config.json)。

- 缺省时归一化为 `{ mode: "all" }`。
- `allowed: []` 表示不暴露工具；`disabled: []` 表示暴露全部工具。
- 名称必须精确匹配 `src/tools/names.ts` canonical tool name；未知或重复名称失败。
- 只校验 selected workspace 文件中的策略；未选中 workspace 的非法工具策略不参与当前启动。
- selected 策略被克隆并随 snapshot deep-freeze。

---

## `rules.requestHeaders`

`rules` 只允许 `requestHeaders`。缺失或空数组归一化为 `{ requestHeaders: [] }`；结构见 [workspace 配置示例](../examples/workspace-config.json)。

- `match` 是非空 object；header name 通过 HTTP token grammar 校验并按 lowercase 保存。
- match value 是无首尾 whitespace 的合法 HTTP field value；配置错误不输出期望 header value。
- `enable` 是非空数组，当前只允许 `structuredContentDup`。
- rule 间是 OR，单条 rule 内条件是 AND；request duplicate/missing header 使对应条件失败。
- 只解析 selected workspace rules。请求匹配与日志隐私语义保持在 runtime request policy 层。

---

## Android 配置

`android` 可选；缺失时服务仍可启动，但 Android 工具返回指向 selected workspace 配置文件的配置错误。出现时以下字段全部必填：

| 字段 | 类型 |
|-|-|
| `workspaceRoot` | existing absolute directory |
| `javaHome` | existing absolute directory |
| `buildTimeoutMs` | JSON number positive integer |
| `maxErrorBlockChars` | JSON number positive integer |
| `maxLogTailChars` | JSON number positive integer |

---

## 环境变量覆盖

Env override 默认关闭。只有 selected workspace `envOverrides.allowedFields` 中明确列出的字段才读取对应环境变量。

| 字段 | 环境变量 |
|-|-|
| `lineEnding` | `MCP_LINE_ENDING` |
| `logsDir` | `MCP_LOGS_DIR` |
| `android.workspaceRoot` | `ANDROID_WORKSPACE_ROOT` |
| `android.javaHome` | `ANDROID_JAVA_HOME` |
| `android.buildTimeoutMs` | `ANDROID_BUILD_TIMEOUT_MS` |
| `android.maxErrorBlockChars` | `ANDROID_MAX_ERROR_BLOCK_CHARS` |
| `android.maxLogTailChars` | `ANDROID_MAX_LOG_TAIL_CHARS` |

规则：

- allowlist 写配置字段 selector，不写环境变量名。
- duplicate、unknown、forbidden selector 失败。
- `android.*` selector 要求同一 workspace 已配置完整 `android` 段。
- env var 不存在表示不覆盖；存在但为空、含首尾 whitespace 或 grammar 非法时启动失败。
- `rootDir`、`host`、`port`、`otherRootDirs`、`fileAccess*`、`tools*`、`rules*` 等边界或复杂结构禁止覆盖。
- Env override 不改变 `RuntimeConfigIdentity`。

---

## Runtime snapshot 与配置来源

`RuntimeConfigIdentity` 和 `RuntimeConfigSnapshot` 分别记录：

- `globalConfigFilePath`
- `workspaceConfigFilePath`
- `workspaceId`
- `rootDir`
- `host`
- `port`

snapshot 另外包含 canonical roots、logs root、line ending、Android 配置、tool exposure、request rules、file access facade 与 policy file metadata。snapshot 及其内部容器全部 deep-freeze。

配置错误按来源归属：

- 全局版本、reference schema、重复 id、非法 `configFile`：指向全局 `config.json`。
- selected workspace 文件读取、JSON、schema、path、env、policy：指向 selected workspace 配置文件。

启动日志分别输出 global config file 与 workspace config file，不再输出 selection mode。

---

## 源码与测试布局

```text
src/config.ts                          # 双层配置加载 public facade
src/config/global-config-path.ts       # ~/.custom-mcp 固定位置
src/config/global-config-schema.ts     # version: 2 workspace reference schema
src/config/workspace-selection.ts      # 显式 id reference 选择与 runtime identity
src/config/schema.ts                   # version: 1 workspace schema
src/config/file-access-policy.ts       # selected workspace policy 编译
src/config/env-overrides.ts            # selected workspace allowlist/env 读取
src/config/runtime-snapshot.ts         # canonical roots 与 immutable snapshot
```

主要回归入口：

```text
test/config/global-config-schema.test.ts
test/config/workspace-selection.test.ts
test/config/load-runtime-config.test.ts
test/config/file-access-policy.test.ts
test/config/env-overrides.test.ts
test/config/runtime-snapshot.test.ts
test/config/request-header-rules.test.ts
test/config/tool-exposure.test.ts
```

验证命令见 `docs/TESTING.md`。

---

## 故障排查

| 现象 | 处理 |
|-|-|
| 缺少 `--workspace` | 使用 `custom-mcp --workspace <id>`；不支持无参数和 `--workspace=<id>`。 |
| `version must be the number 2` | 将 home-level 全局索引改为 `version: 2` + `id/configFile` references。 |
| workspace `version must be the number 1` | 将 selected workspace 文件改为独立 `version: 1` schema。 |
| workspace id 不存在 | 从全局索引选择一个已配置的 lowercase id。 |
| `configFile must be an absolute local path` | 使用已展开的本地绝对路径；Windows 使用 drive-absolute。 |
| selected workspace file 不存在/不可读 | 创建 reference 指向的文件或修正全局 `configFile`。 |
| selected workspace JSON/schema 错误 | 按错误中的 `Workspace config file` 与 file-local `Field` 修复。 |
| 未选中 workspace 配置损坏但当前仍能启动 | 这是按需读取的预期行为；启动该 workspace 时才会验证。 |
| `Selected workspace allowed roots are invalid` | 修复 selected workspace 的 `rootDir + otherRootDirs` 重复、嵌套或 realpath 冲突。 |
| 端口已占用 | 不同 workspace 允许复用配置端口；停止冲突进程或修改当前 workspace `port`。 |
| 环境变量未生效 | 检查 selected workspace allowlist 和 env value grammar。 |
