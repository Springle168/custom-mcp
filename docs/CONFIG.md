# 配置开发说明

本文记录 `custom-mcp` 的运行配置、全局 workspace 选择、runtime snapshot、env override allowlist 行为和配置相关故障排查。根目录 `config.example.json` 是全局配置示例模板；复制到 `~/.custom-mcp/config.json` 前需要检查并替换其中的路径、host、端口和 workspace id。

---

## 配置文件说明

运行配置文件位于用户 home 下的固定 dotdir 路径：

```text
~/.custom-mcp/config.json
```

在 Windows 上通常展开为 `%USERPROFILE%\.custom-mcp\config.json`。服务启动时只读取这个 home-level dotdir 配置文件。可以复制根目录 `config.example.json` 的内容作为模板。

运行配置使用 `version: 1` 全局 workspace schema。文件内容示例：

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
      "host": "127.0.0.1",
      "port": 3100,
      "logsDir": "E:/Logs/custom-mcp",
      "fileAccess": {
        "rootDir": {
          "ignoreFiles": ["C:/Users/username/.custom-mcp/policies/project.ignore"],
          "denyFiles": ["C:/Users/username/.custom-mcp/policies/project.deny"]
        },
        "otherRootDirs": {
          "E:/AnotherWorkspace": {
            "denyFiles": ["C:/Users/username/.custom-mcp/policies/additional.deny"]
          }
        }
      },
      "tools": {
        "disabled": [
          "android.testDebugUnitTest"
        ]
      },
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
          "logsDir",
          "android.javaHome"
        ]
      }
    }
  ]
}
```

### 启动期配置管线

配置加载的主入口是 `loadRuntimeConfigWithIdentity()`。启动期处理是线性管线：先建立受信配置来源，再校验全局 schema 和所有 workspace 的文件访问策略，再选择 workspace，再按 selected workspace allowlist 应用 env override，最后把 selected workspace 归一化为不可变 runtime snapshot。维护时应按管线阶段定位职责，不要在工具层重新读取或理解全局配置结构。

```text
parseCliArgs()
  - 解析 --workspace <id> / --workspace=<id>
  - 按 workspace id lexical grammar 校验参数值，不判断配置中是否存在该 workspace
  - 缺失、空字符串、whitespace-only、首尾 whitespace 或 grammar 非法时抛出 CliError
        │
        ▼
loadRuntimeConfigWithIdentity()
        │
        ├─► getDefaultGlobalConfigPath() + getDefaultGlobalLogsDir()
        │     - 固定解析到 ~/.custom-mcp/config.json 和 ~/.custom-mcp/logs
        │
        ├─► readConfigFile() + JSON.parse
        │     - 读取并解析受信全局配置文件
        │
        ├─► parseGlobalConfig()
        │     - 校验 version / workspaces / 未知字段
        │     - 严格解析每个 workspace 的 tools.allowed / tools.disabled exactly-one 策略
        │     - 按集中 value policy 校验 workspace id、host IP、lineEnding、allowlist selector 和 numeric 字段
        │     - 按 schema 规则处理 allowlist duplicate、forbidden、unknown、环境变量名误填和 Android base config 要求
        │     - 按配置 path policy 校验所有 path-like 字段是已存在目录
        │     - 校验所有 workspace 的 id / port 唯一性；host 允许重复
        │     - 校验所有 workspace.rootDir 存在且互不重复/嵌套
        │
        ├─► compileGlobalFileAccessPolicies()
        │     - 对所有 workspace（包括未选中项）读取并严格 UTF-8 解码策略文件
        │     - 按 root 与数组顺序编译独立 ignore / deny matcher
        │     - 只输出不含 matcher mutation API 的只读 query facade
        │
        ├─► selectRuntimeWorkspace()
        │     - explicit: 按 --workspace id 选择
        │     - cwd: process.cwd() realpath 必须等于某个 rootDir realpath
        │
        ├─► RuntimeConfigIdentity
        │     - 记录 config file、workspace id、rootDir、host、port、selection mode
        │     - 不受 env override 影响
        │
        ├─► applyEnvOverridesToWorkspace()
        │     - 只作用于 selected workspace 的 allowlist 字段
        │     - 只读取 selected workspace allowlist 授权的 env var
        │     - env var 不存在时不覆盖；存在但值非法时启动失败
        │     - 不允许覆盖 rootDir / host / port / otherRootDirs 等边界字段
        │
        ├─► buildRuntimeConfigSnapshot()
        │     ├─ createValidatedPathSafetyContext()
        │     │   - 校验 selected workspace 的 rootDir + otherRootDirs
        │     │   - 生成 canonical allowed roots
        │     │
        │     └─ 校验默认 logs root，写入 resolved logsDir / Android paths，克隆 toolExposure 并 deep-freeze RuntimeConfigSnapshot
        │
        ▼
createConfigStore()
  - 只读保存 initial snapshot 与 identity baseline
        │
        ▼
每次 tool call 开始
  - ConfigStore.getSnapshot() 读取一次 current snapshot
  - createToolRuntimeContext() 派生本次调用上下文
```

| 阶段 | 主要入口 | 输出 | 失败含义 |
|-|-|-|-|
| CLI 参数 | `parseCliArgs()` | 可选 `workspaceId`，值为已验证 lexical token | 启动参数非法，例如重复、缺失、空值、首尾 whitespace 或 grammar 非法的 `--workspace`。 |
| 配置路径 | `getDefaultGlobalConfigPath()` / `getDefaultGlobalLogsDir()` | home-level dotdir config path / default logs dir | 进程没有可用 home 目录。 |
| 文件读取与 JSON 解析 | `readConfigFile()` / `JSON.parse` | 原始 JSON 对象 | 全局配置文件不存在、不可读或 JSON 语法非法。 |
| 全局 schema 校验 | `parseGlobalConfig()` | `ParsedGlobalConfig` | schema、typed value、host IP、配置 path-like 字段、allowlist selector、所有 workspace 的 `rootDir`、`id` / `port` 唯一性或未知字段非法。 |
| 全局文件访问策略 | `compileGlobalFileAccessPolicies()` | 所有 workspace 的 root-specific query facade | 策略文件路径、存在性、普通文件类型、可读性、严格 UTF-8 解码或 matcher 编译失败。未选中 workspace 的错误同样阻止启动。 |
| Workspace 选择 | `selectRuntimeWorkspace()` | selected workspace + `RuntimeConfigIdentity` | 已通过 lexical 校验的 `--workspace` 不存在，直接调用配置 loader 时传入非法 `workspaceId`，或默认 cwd 不能与某个 workspace root realpath 精确匹配。 |
| Env override | `applyEnvOverridesToWorkspace()` | 覆盖后的 selected workspace | selected workspace 的 allowlist 防御性校验失败，或被允许的 env 值为空、whitespace-only、含首尾 whitespace、grammar 非法、path 不存在或不是目录。 |
| Runtime snapshot | `buildRuntimeConfigSnapshot()` / `createRuntimeConfigSnapshot()` | frozen `RuntimeConfigSnapshot` | selected workspace 的 `rootDir + otherRootDirs` 无法构建 path safety context、默认 logs root 不存在/不是目录，或 direct snapshot seam 收到含首尾 whitespace 的 path-like 输入。 |
| 工具调用上下文 | `createToolRuntimeContext()` | `ToolRuntimeContext` | 不重新加载配置；工具只消费 snapshot 派生出的运行时能力。 |

维护不变量：

- `parseGlobalConfig()` 在 workspace 选择前运行，并校验所有 workspace；显式 `--workspace` 不会跳过未选中 workspace 的全局 schema / `rootDir` 校验。
- 默认 workspace 选择只接受 `process.cwd()` realpath 与某个 workspace `rootDir` realpath 等价；cwd 位于 workspace 子目录内会启动失败并提示显式选择。
- `RuntimeConfigIdentity` 是启动选择边界，来自配置文件中已验证的 selected workspace；env override 不参与选择，也不改变 identity。
- Env override 默认关闭；`envOverrides.allowedFields` 的基础 selector typed 边界由集中 value policy 读取，重复项、forbidden/unknown 字段、环境变量名误填和 Android base config 要求由 schema 覆盖所有 workspace 校验；env 值读取只作用于 selected workspace allowlist。env var 不存在表示不覆盖；env var 存在但为空字符串、whitespace-only、含首尾 whitespace 或 grammar 非法时启动失败。
- `rootDir`、`host`、`port`、`otherRootDirs` 等边界字段不能被 env override 覆盖，`android.*` override 也不能创建缺失的 `android` 配置段。
- `logsDir` 是服务日志根目录，默认值为 `~/.custom-mcp/logs`；默认值、selected workspace 配置的 `logsDir` 和 allowlisted `MCP_LOGS_DIR` 都必须是已存在的本地绝对目录。实际日志文件路径由 `Logger` 在该根目录下按 `YYYY/MM/DD/<workspace-id>_YYYY-MM-DD_HH-MM-SS.log` 创建，文件名前缀直接使用 selected workspace id。
- selected workspace 的 `rootDir + otherRootDirs` 会在 snapshot 构建阶段再次进入 path safety 校验，并以 canonical roots 写入 snapshot。
- `fileAccess` 在 workspace 选择前对所有 workspace 完整读取和编译；snapshot 只选择已编译策略，不重新读取磁盘文件。策略修改需要重启并成功构建新 snapshot 后才生效。
- selected workspace 的 `toolExposure` 会被完整克隆后写入 snapshot；snapshot 中的策略对象及非 `all` 策略的名称数组会被冻结，构建过程不冻结调用方对象。
- `logsDir` 不进入 `ToolRuntimeContext`，也不会加入文件工具 allowed roots。
- `ConfigStore` 当前只暴露只读 snapshot / identity / status；没有 watcher、reload apply 或 snapshot mutation API。
- 工具层只能通过 `ToolRuntimeContext` 消费配置能力，不应读取 `~/.custom-mcp/config.json`、解析全局 schema 或遍历 `otherRootDirs`。

### Workspace 选择

启动时会读取并校验 `workspaces` 中的所有 workspace，然后选择本次进程使用的 workspace：

- 显式选择：`custom-mcp --workspace <id>` 或 `custom-mcp --workspace=<id>` 的参数值先由 CLI parser 按 workspace id lexical grammar 校验，selection 阶段只判断该 id 是否存在于已解析 workspace；显式选择不要求当前工作目录与该 workspace 的 `rootDir` 匹配。
- 直接通过配置 loader seam 传入 `workspaceId` 时，selection 层会执行同一 workspace id lexical grammar 的防御性校验，并使用 `ConfigError` 报告非法内部输入。
- 默认选择：未提供 `--workspace` 时，`process.cwd()` 的 realpath 必须与某个 workspace `rootDir` 的 realpath 等价。
- 默认选择只接受 cwd 与 root 等价；cwd 位于某个 workspace 的子目录中不会被视为匹配。
- Windows 下大小写、路径分隔符和尾部分隔符差异不应影响默认匹配。
- 启动选择成功后会形成 `RuntimeConfigIdentity`，记录 config file path、workspace id、已验证/规范化的 rootDir、host、port 和 selection mode。
- Env overrides 在 workspace 选择之后才按 selected workspace 的 allowlist 应用；它们不参与 workspace 选择，也不改变 `RuntimeConfigIdentity`。

### Runtime snapshot

选中 workspace 后，配置层会构建 initial `RuntimeConfigSnapshot`，并用它创建 `ConfigStore`：

- initial `snapshotVersion` 为 `1`。
- snapshot 必含已验证的 `pathSafetyContext`，并以它和 selected workspace 已编译 root policy 构建 `fileAccessPolicyContext`；文件类工具通过 `ToolRuntimeContext.fileAccessPolicyContext` 使用统一上下文。
- snapshot 必含最终 HTTP `host` 和 `port`；未配置 host 时使用 `127.0.0.1`。入口层使用两者绑定 HTTP server，`ask_user` 使用同一 snapshot 生成表单 URL。
- snapshot 必含最终 `logsDir`；该值来自 allowlisted `MCP_LOGS_DIR`、selected workspace `logsDir` 或默认 `~/.custom-mcp/logs`，并表示已存在的日志根目录。
- snapshot 的 `rootDir` / `otherRootDirs` 来自 `pathSafetyContext` 中的 canonical roots，而不是保留原始输入字符串。
- snapshot 的 `logsDir` 和 Android path 写入 resolved runtime path，但不加入 `pathSafetyContext.allowedRoots`；文件工具 allowed roots 只来自 selected workspace 的 `rootDir + otherRootDirs`。
- snapshot 必含归一化后的 `rules`；未配置 request header rules 时写入 `{ requestHeaders: [] }`，只有 selected workspace 的规则进入 runtime snapshot。
- snapshot 必含 selected workspace 的 `toolExposure`；未配置 `tools` 时写入 `{ mode: "all" }`。snapshot 构造会克隆策略对象和名称数组，再随 snapshot deep-freeze。
- `createRuntimeConfigSnapshot()` 作为 direct test seam 时会拒绝 path-like 输入中的空值、whitespace-only 和首尾 whitespace，避免通过 path safety 的兼容性 trim 形成配置值语义旁路；调用方必须显式传入已归一化的 `rules` 和 `toolExposure`。
- snapshot、`android`、`toolExposure`、非 `all` 策略的名称数组、`rules`、`rules.requestHeaders`、每条 rule、`match` 数组、`enable` 数组、`otherRootDirs`、`pathSafetyContext`、`fileAccessPolicyContext`、root policy 容器、query facade、root 对象和 allowed roots 数组都会 deep-freeze。
- `ConfigStore` 只读保存 current snapshot 与 `RuntimeConfigIdentity` baseline；运行时 API 不暴露 watcher、reload apply 或 snapshot mutation 能力。
- 每次 MCP tool call 开始时从 `ConfigStore` 读取一次 current snapshot，并由该 snapshot 派生本次调用的 `ToolRuntimeContext`；request header policy 使用 snapshot rules 与 request-scoped strict header view 计算，不进入 `ToolRuntimeContext`；同一次工具调用期间不会再次读取配置。
- 启动日志会输出 bind address、endpoint、workspace id、selection mode、snapshot version、config file、canonical roots、lineEnding 和实际日志文件路径。IPv6 endpoint 使用方括号；通配绑定地址 `0.0.0.0` / `::` 的 endpoint 分别使用本机回环地址 `127.0.0.1` / `::1`。

---

## 源码与测试布局

配置实现由配置层负责解析、校验和选择 workspace，由运行时层把选中的 snapshot 稳定传递给工具调用。维护时优先按职责修改对应文件，不要在工具层重新读取或理解全局配置结构。

### 源码布局

```text
src/
├── cli.ts                       # CLI 参数解析，如 --workspace
├── config.ts                    # 运行配置加载 public facade
├── config/
│   ├── env-overrides.ts         # selected workspace 字段级 env override allowlist 与 env 值读取
│   ├── errors.ts                # 结构化配置错误
│   ├── file-access-policy.ts    # 策略文件校验、严格 UTF-8 读取、root-specific matcher 编译与只读 facade
│   ├── global-config-path.ts    # home-level dotdir 配置路径解析
│   ├── path-policy.ts           # 配置 path-like 字段本地绝对 existing-directory policy
│   ├── request-header-rules.ts  # workspace rules.requestHeaders schema、值语义和 runtime rules 类型
│   ├── runtime-snapshot.ts      # RuntimeConfigSnapshot 构建、canonical roots、rules 与 deep freeze
│   ├── schema.ts                # version: 1 全局 workspace schema 校验
│   ├── tool-exposure.ts         # workspace tools schema、strict exactly-one 校验与 runtime exposure 类型
│   ├── value-policy.ts          # typed/free-form 字符串、IP、token/selector、JSON/env positive integer reader
│   └── workspace-selection.ts   # 显式/cwd workspace 选择与 RuntimeConfigIdentity
└── runtime/
    ├── config-store.ts          # current snapshot 与 identity baseline 只读持有者
    ├── request-context.ts       # 单次 HTTP request 的 strict header view AsyncLocalStorage carrier
    ├── request-header-policy.ts # request header rules 纯匹配与 request policy 计算
    ├── request-header-view.ts   # 基于 Request.rawHeaders 构造 strict header view
    ├── tool-call-handler.ts     # 每次工具调用开始时读取 current snapshot 的 handler seam
    ├── tool-context.ts          # 工具 handler 消费的运行时上下文
    └── tool-result-adapter.ts   # request policy 驱动的 ToolCallResult 非破坏性适配
```

`src/runtime/` 不完全属于配置层，但 `ConfigStore`、tool-call handler seam 和 `ToolRuntimeContext` 是 global workspace 配置进入工具层的边界。配置语义在本文维护；工具如何消费 `ToolRuntimeContext` 见 [docs/TOOLS.md](TOOLS.md)。

`src/utils/http-url.ts` 统一处理 IPv6 host:port 方括号、通配 bind host 的本机 endpoint 映射，以及 MCP / `ask_user` HTTP URL 生成。

`src/utils/file-access-policy.ts` 持有文件工具共享的 allowed-root、candidate、deny / ignore 与受控 glob 运行时策略；配置层只向它提供不含 matcher mutation API 的 root-specific query facade。

### 测试布局

```text
test/
├── config/
│   ├── file-access-policy.test.ts      # fileAccess schema、全 workspace 编译、严格 UTF-8、snapshot facade 与 env 禁止
│   ├── global-config-path.test.ts      # home-level dotdir config path
│   ├── value-policy.test.ts            # typed/free-form 值、IP、token/selector、JSON/env positive integer reader
│   ├── path-policy.test.ts             # 配置 path-like 字段 existing-directory policy 与 platform/filesystem seam
│   ├── global-config-schema.test.ts    # version: 1 schema、字段值语义、path-like 字段和 allowlist selector 校验
│   ├── workspace-selection.test.ts     # --workspace 与 cwd 选择
│   ├── env-overrides.test.ts           # selected workspace allowlist 与 env 解析
│   ├── request-header-rules.test.ts    # rules.requestHeaders schema、归一化、env override 禁止和 snapshot 接入
│   ├── runtime-snapshot.test.ts        # snapshot canonical roots、rules、deep freeze 和派生上下文
│   ├── tool-exposure.test.ts            # workspace tools schema、严格校验、snapshot 和 env override 禁止
│   └── load-runtime-config.test.ts     # loadRuntimeConfig 集成行为
├── runtime/
│   ├── config-store.test.ts            # ConfigStore、tool-call handler seam 与 ask_user host URL
│   ├── mcp-post-request-context.test.ts # POST /mcp request context seam
│   ├── request-context.test.ts         # request-scoped strict header view carrier
│   ├── request-context-concurrency.test.ts # request context 并发隔离和同 context 多次 tools/call
│   ├── request-header-policy.test.ts   # request header rules 匹配语义和日志 metadata
│   ├── request-header-view.test.ts     # rawHeaders strict view 构造
│   ├── tool-call-handler.test.ts       # tools/call 统一出口 request policy 适配和日志 metadata
│   └── tool-result-adapter.test.ts     # structuredContent wrapper 适配
├── logger/
│   └── request-header-rules-logging.test.ts # request header rules 响应日志格式和隐私边界
└── helpers/
    └── runtime-config.ts               # 测试用 ToolRuntimeContext / ConfigStore 构造 helper
```

这些脚本是配置相关回归入口；运行方式见 [docs/TESTING.md](TESTING.md)。

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
| `id` | string | 是 | workspace 稳定标识；必须全局唯一，长度 `1..64`，以小写字母或数字开头，且仅包含小写字母、数字、短横线 `-` 或下划线 `_`；日志文件名直接使用该 id 作为前缀。 |
| `rootDir` | string | 是 | workspace primary root；必须是本地绝对路径、真实存在且为目录。 |
| `host` | IPv4 / IPv6 string | 否 | HTTP 监听 IP；缺省为 `127.0.0.1`，不接受 `localhost` 或其他 hostname。host 可在不同 workspace 间重复。显式使用 `0.0.0.0` 或 `::` 会监听对应地址族的所有接口。 |
| `port` | JSON number positive integer | 是 | 该 workspace 的 HTTP 端口；范围 `1..65535`，且全局唯一；numeric string 非法。 |
| `lineEnding` | `"auto"` \| `"lf"` \| `"crlf"` | 是 | 文本写回策略。 |
| `logsDir` | string | 否 | 服务日志根目录；配置文件中提供时必须是已存在的本地绝对目录。缺省值为 `~/.custom-mcp/logs`，该默认日志根目录也必须预先存在且为目录。Logger 在该根目录下按 `YYYY/MM/DD/<workspace-id>_YYYY-MM-DD_HH-MM-SS.log` 创建日期子目录和实际日志文件。 |
| `otherRootDirs` | string[] | 否 | additional roots；缺省为 `[]`。每一项必须是已存在的本地绝对目录。选中 workspace 构建 snapshot 时会作为 allowed roots 集合校验，并在 snapshot 中保存为 canonical root 路径。 |
| `fileAccess` | object | 否 | 按 primary / additional root 配置持久 ignore 与 deny 策略文件；缺省为全部空策略。 |
| `android` | object | 否 | Android 构建配置；整段可选，但出现后字段必须完整。 |
| `envOverrides` | object | 否 | 字段级环境变量覆盖 allowlist；缺省为全部禁用。 |
| `rules` | object | 否 | workspace 级请求兼容规则；支持 `rules.requestHeaders` exact 匹配以启用 `structuredContentDup` 适配。 |
| `tools` | object | 否 | workspace 工具暴露策略；必须且只能配置 `allowed` 或 `disabled` 之一，缺省为暴露完整 canonical registry。 |

workspace 未知字段会导致启动失败。

### `fileAccess` 配置段

`fileAccess` 只允许 `rootDir` 与 `otherRootDirs`。每个 root 策略对象只允许 `ignoreFiles` 与 `denyFiles`，两者均为可选的有序 string 数组，缺省为 `[]`。数组顺序与重复引用均保留；每份文件使用 Gitignore 语法，后加载规则（包括 negation）可以改变先前结果。Primary root 策略不会自动继承给 additional roots。

```json
{
  "fileAccess": {
    "rootDir": {
      "ignoreFiles": ["C:/Policies/common.ignore", "C:/Policies/project.ignore"],
      "denyFiles": ["C:/Policies/project.deny"]
    },
    "otherRootDirs": {
      "E:/AnotherWorkspace": {
        "denyFiles": ["C:/Policies/additional.deny"]
      }
    }
  }
}
```

- 策略文件引用必须是无首尾 whitespace 的非空 string 和受支持的本地绝对路径；启动时必须存在、可读、解析 symbolic link 后为普通文件，并能以严格 UTF-8 解码。UTF-8 BOM 合法。
- `fileAccess.otherRootDirs` key 使用 workspace root 相同的绝对目录输入规则，并按 lexical canonical identity 关联同一 workspace 的某个 configured `otherRootDirs`。只在 realpath 层等价的 alias、primary root、未关联 key 或归一化后重复 key 均非法。
- 所有 workspace 的策略在选择 workspace 前读取并编译。未选中 workspace 的文件缺失、不可读、UTF-8 非法或 matcher 编译失败也会阻止启动。
- Runtime snapshot 的 `fileAccessPolicyContext` 为每个 allowed root 保存 canonical lexical / real root 和只读 ignore / deny query facade。原始第三方 matcher 及 `.add()` 等 mutation API 不会暴露；context、root 容器和 facade 随 snapshot deep-freeze。
- Ignore 只过滤自动发现结果，literal 显式路径可以绕过 ignore；deny 始终应用。具体文件工具路径、glob、symlink 与 mixed-result 行为见 `docs/design/file-access-ignore-deny-policy.md`。

### `tools` 配置段

`tools` 是 workspace 级可选对象，用于过滤该 workspace 的 `tools/list` definitions 和 `tools/call` 路由。未配置时归一化为 `{ mode: "all" }`，暴露完整 canonical registry。

```json
{
  "tools": {
    "disabled": ["android.testDebugUnitTest"]
  }
}
```

- `tools` 只能包含 `allowed` 和 `disabled`，并且必须且只能配置其中一个。
- `allowed` 表示只暴露列出的工具；`disabled` 表示暴露完整 registry 中未列出的工具。
- `allowed: []` 合法，表示不暴露任何工具；`disabled: []` 合法，表示暴露全部工具。
- 数组 entry 必须是无首尾 whitespace 的非空 string，并精确匹配 `src/tools/names.ts` 中的 canonical 工具名；名称大小写敏感，不接受宿主转换后的名称。
- 未知名称和重复名称会在启动期失败。配置解析覆盖所有 workspace，不因 workspace 未被选中而跳过。
- 新增工具会自动进入未配置 `tools` 或使用 `disabled` 的 workspace；使用 `allowed` 的 workspace 只有显式加入该名称后才会暴露新工具。
- selected workspace 的策略进入 runtime snapshot；策略对象和名称数组由 snapshot 克隆并冻结。该策略不进入 `RuntimeConfigIdentity` 或 `ToolRuntimeContext`。
- 工具是否具有运行时依赖不参与暴露过滤；例如缺少 `android` 配置不会自动隐藏 Android 工具。

### `rules.requestHeaders`

`rules` 是 workspace 级可选对象，只允许 `requestHeaders` 字段。未配置 `rules`、配置 `rules: {}`、未配置 `rules.requestHeaders` 或配置 `rules.requestHeaders: []`，都会归一化为 `{ requestHeaders: [] }`。

`rules.requestHeaders` 若出现，必须是 array。每条 rule 必须是 JSON object，只允许 `match` 和 `enable` 字段，且两者必填：

```json
{
  "rules": {
    "requestHeaders": [
      {
        "match": {
          "x-custom-mcp-client": "android-studio"
        },
        "enable": ["structuredContentDup"]
      }
    ]
  }
}
```

`match` 必须是非空 JSON object。key 是 HTTP header name，使用 ``^[!#$%&'*+\\-.^_`|~0-9A-Za-z]+$`` 校验，通过后按 lowercase 保存；同一条 rule 内 header name lowercase 后重复会失败。`mcp-session-id` 没有业务 denylist，作为普通 header name 参与 exact 匹配。

`match` value 必须先通过 typed string 语义：必须是非空 string，不能是 whitespace-only，也不能包含首尾 whitespace。随后执行 request header rules 专用 HTTP field value 校验：拒绝 ASCII control characters `U+0000..U+001F`，但允许内部 HTAB `U+0009`；拒绝 `U+007F`。合法 value 按原始字符串保存，内部空格和内部 HTAB 保留。配置错误消息不输出配置中的期望 header value。

`enable` 必须是非空数组。entry 使用 token 语义，合法值只允许精确 `structuredContentDup`，大小写敏感，同一条 rule 内不能重复。

HTTP `POST /mcp` 入口只从 `Request.rawHeaders` 构造 strict header view，不使用 `req.headers` 作为 request header rules 匹配输入。strict view 中，同一个 lowercase header name 出现多次会得到 `duplicate` 状态；只有 `single` 且 value exact match 的 header 条件才成立。rule 之间是 OR，同一 rule 内条件是 AND。duplicate 或 missing header 只使引用该 name 的条件失败，不影响其它 rule 未引用的 header。

命中 `structuredContentDup` 后，`tools/call` 统一出口返回非破坏性的 `structuredContent` wrapper；工具 handler、工具 definition、`ToolRuntimeContext`、MCP session、transport/server 不保存 request policy 或 strict header view。selected workspace 配置非空 request header rules 时，工具响应日志在状态行后输出 `Rules:` 行；命中时只记录 `rules.requestHeaders[n]` 相对规则位置和 enabled feature，未命中时记录 `Rules: no match`，未配置规则时不输出该行。响应日志不记录请求 header name/value、配置 header name/value 或匹配字符串。

### `android` 配置段

`android` 配置段是可选的；未配置时服务仍可启动，但调用 Android 构建工具会返回配置错误。若出现，则以下字段全部必填，且正整数字段没有文件内默认值：

| 字段 | 类型 | 说明 |
|-|-|-|
| `workspaceRoot` | string | Android 构建工具的工作目录，必须是已存在的本地绝对目录；是否存在 `gradlew.bat` 仍在工具调用阶段检查。 |
| `javaHome` | string | 构建时注入的 JBR / JDK 根目录，必须是已存在的本地绝对目录。 |
| `buildTimeoutMs` | JSON number positive integer | Gradle 进程超时时间；numeric string 非法。 |
| `maxErrorBlockChars` | JSON number positive integer | 失败结果中 `firstErrorBlock` 的最大长度；numeric string 非法。 |
| `maxLogTailChars` | JSON number positive integer | 失败结果中 `logTail` 的最大长度；numeric string 非法。 |

### 校验规则

配置加载阶段会执行严格校验：

- `version` 必须存在且为 `1`。
- `workspaces` 必须是非空数组。
- 未知字段会失败，不会静默忽略。
- typed string 使用 `String.prototype.trim()` 检测空值和首尾 whitespace；空字符串和 whitespace-only 使用稳定错误片段 `must be a non-empty string`，首尾 whitespace 使用 `must not contain leading or trailing whitespace`；检测后保留原始合法值，不使用 trim 后的值继续解析。
- workspace `id` 必须全局唯一，长度 `1..64`，以小写字母或数字开头，且仅包含小写字母、数字、短横线 `-` 或下划线 `_`；首尾 whitespace 会以 whitespace 错误失败。
- workspace `host` 缺省为 `127.0.0.1`；显式配置时必须是无首尾 whitespace 的 IPv4 或 IPv6 地址，不接受 hostname。host 不要求全局唯一。
- `lineEnding` 只接受精确的 `auto` / `lf` / `crlf`，不做大小写宽容。
- 配置文件 numeric 字段只接受 JSON number positive integer；numeric string（包括 `"3100"`、`" 3100"`、`"3100 "`）、`0`、负数、`1.5` 和 unsafe integer 都会失败。
- workspace `port` 必须是 JSON number positive integer `1..65535`，且全局唯一。
- `rootDir`、`otherRootDirs[]`、configured `logsDir`、默认 logs root、`android.workspaceRoot` 和 `android.javaHome` 必须是已存在的本地绝对目录；Windows 下必须是 drive-absolute path，不支持相对路径、UNC、namespace path、drive-relative path、rooted-without-drive path 或 `~` 展开。
- 所有 workspace `rootDir` 在 lexical normalized path 层不得重复或互相嵌套。
- 所有 workspace `rootDir` 在 realpath 层不得重复或互相嵌套。
- selected workspace 的 `rootDir + otherRootDirs` 集合安全由 runtime snapshot / path safety 继续校验。
- `android` 若提供，必须是对象且字段完整。
- `rules` 若提供，必须是对象且只允许 `requestHeaders`；`rules.requestHeaders` rule 的 header name、header value、feature token 和重复项会在 schema 阶段校验，所有 workspace 都参与校验。
- `tools` 若提供，必须是对象并严格满足 `allowed` / `disabled` exactly-one；名称数组中的非字符串、空值、首尾 whitespace、未知名称和重复名称都会在 schema 阶段失败，所有 workspace 都参与校验。
- `envOverrides.allowedFields[]` 是 selector token；基础 typed 边界由 `readSelectorToken()` 读取，schema 继续校验重复项、forbidden field、unknown field、环境变量名误填和 Android base config 要求。

---

## 环境变量覆盖

字段级 env override 默认禁用。只有 selected workspace 的 `envOverrides.allowedFields` 中列出的字段会读取对应环境变量。allowlist selector 的基础 typed 边界由 value policy 读取，duplicate、forbidden、unknown、环境变量名误填和 Android base config 等领域规则由 schema 覆盖所有 workspace 校验；env value 按目标字段 value policy 解析。

### Allowlist 语义

- 没有 `envOverrides`：全部字段级 env override 禁用。
- `envOverrides` 出现时，`allowedFields` 必填且必须是数组；`allowedFields: []` 合法，表示全部字段级 env override 禁用。
- `allowedFields[]` entry 必须是非空 string，且不能包含首尾 whitespace；空字符串和 whitespace-only 使用 `must be a non-empty string` 错误片段。
- `allowedFields[]` duplicate entry 会失败。
- `allowedFields[]` 必须写配置字段 selector，不能写环境变量名，例如写 `logsDir` 而不是 `MCP_LOGS_DIR`。
- forbidden field、unknown field 和环境变量名误填会在 schema 阶段失败；该校验覆盖所有 workspace，不跳过未选中 workspace。
- `android.*` allowlist 要求同一个 workspace 已经显式配置完整 `android` 段；env override 不能创建缺失的 Android 配置。
- 只有 selected workspace allowlist 中的字段会读取 env value；未授权 env var 即使存在也不会参与 snapshot。
- 环境变量只有不存在时表示不覆盖；存在但值为 `""`、whitespace-only、含首尾 whitespace 或 grammar 非法时启动失败。
- `MCP_LINE_ENDING` 使用 `auto` / `lf` / `crlf` token grammar；`MCP_LOGS_DIR`、`ANDROID_WORKSPACE_ROOT` 和 `ANDROID_JAVA_HOME` 必须指向已存在的本地绝对目录；Android numeric env var 必须精确匹配十进制正整数字符串 grammar。
- Env override 在 workspace 选择之后应用，不参与 cwd 匹配或 `--workspace` 选择。
- Env override 不改变 `RuntimeConfigIdentity`；`rootDir`、`host`、`port` 等边界字段始终来自配置文件中已验证的 selected workspace。

### 允许覆盖的字段

| 字段 | 环境变量 |
|-|-|
| `lineEnding` | `MCP_LINE_ENDING` |
| `logsDir` | `MCP_LOGS_DIR` |
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
| `host` | HTTP 监听地址和 runtime identity 不能由 env 改变。 |
| `port` | 端口唯一性、启动端口和 runtime identity 不能由 env 改变。 |
| `otherRootDirs` | additional roots 会扩大文件访问边界，不能由 env 改变。 |
| `fileAccess` / `fileAccess.*` | 文件访问策略及其规则顺序不能由 env 新增、删除、替换或重排。 |
| `tools` / `tools.*` | 工具暴露边界不能由 env 改变。 |
| `rules` / `rules.*` | 请求规则结构复杂且影响请求行为，不能由 env 改变。 |

`envOverrides.allowedFields` 必须写配置字段 selector，而不是环境变量名。环境变量名、边界字段、未知字段和重复字段都会导致启动失败；允许覆盖的字段以“允许覆盖的字段”表为准。`tools`、`rules`、`fileAccess` 及其子 selector 均在 schema 阶段按 forbidden field 失败，不会读取任何 env value。

`logsDir` 的 env override 使用字段名 `logsDir` 进入 allowlist。`MCP_LOGS_DIR` 不存在时不覆盖；存在时必须是非空、无首尾 whitespace、已存在的本地绝对目录，错误字段定位到 selected workspace 的 `logsDir`。

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
| 启动报 `Global config file does not exist` | `~/.custom-mcp/config.json` 不存在 | 创建该文件，可先复制 `config.example.json` 并检查其中的路径和值。 |
| 启动报 `version must be the number 1` | `version` 缺失或不是数字 `1` | 将配置调整为 `version: 1` + `workspaces` 数组。 |
| 启动报 `Unknown config field ...` | 配置包含 schema 未定义字段 | 删除未知字段，或等待对应功能实现后再使用。 |
| 启动报 workspace `id` 或 `port` 重复 | 多个 workspace 使用了同一 id 或端口 | 为每个 workspace 配置唯一 id 和端口。 |
| 启动报 `host must be an IPv4 or IPv6 address` | workspace `host` 使用了 hostname、带端口的地址或非法 IP | 改为纯 IPv4 / IPv6 地址；仅本机使用时可删除该字段以采用 `127.0.0.1`。 |
| 启动报 `--workspace` 参数非法 | CLI 参数缺失、重复、为空、包含首尾 whitespace，或不符合 workspace id lexical grammar | 使用 `--workspace <id>` 或 `--workspace=<id>`，并传入配置中存在的 lowercase workspace id。 |
| 启动报 root 重复或嵌套 | 多个 workspace `rootDir` 在 lexical 或 realpath 层重复/互相包含 | 拆分为互相独立的目录；不要把子目录配置为另一个 workspace root。 |
| 启动报 `must be a JSON number positive integer` | 配置文件 numeric 字段使用了 numeric string、`0`、负数、`1.5` 或 unsafe integer | 将字段改为 JSON number，例如 `3100`，不要写成 `"3100"`。 |
| 启动报 `must be an absolute local path` 或 `does not exist or cannot be accessed` | 配置文件中的 path-like 字段、默认 logs root 或 env path override 使用了相对路径、UNC、namespace path、`~`、Windows 非 drive-absolute path，或目录不存在 | 改为已展开的本地绝对路径，并提前创建配置文件中写入的 `rootDir`、`otherRootDirs[]`、`logsDir`、默认 `~/.custom-mcp/logs` 和 Android 目录。 |
| 启动报 `Selected workspace allowed roots are invalid` | selected workspace 的 `rootDir + otherRootDirs` 集合无法构建 path safety context | 按错误中的 `Field` 修复对应 root；allowed roots 必须互不重复/嵌套。 |
| 启动报 `envOverrides.allowedFields contains forbidden field ...` | allowlist 试图覆盖边界字段 | 从 allowlist 移除该字段；`rootDir`、`host`、`port`、`otherRootDirs` 等边界字段不能通过 env 覆盖。 |
| 启动报 `envOverrides.allowedFields contains unknown field ...` | allowlist 包含未支持字段 | 改为允许字段表中的字段，或删除该 allowlist 项。 |
| 启动报 `envOverrides.allowedFields contains environment variable name ...` | allowlist 写了 `MCP_LOGS_DIR`、`ANDROID_JAVA_HOME` 等环境变量名 | 改写为配置字段 selector，例如 `logsDir` 或 `android.javaHome`。 |
| 启动报 `ANDROID_* must be a positive integer` 或 `ANDROID_* must be a non-empty string` | allowlist 允许了 Android 数值字段，但对应 env 为空、包含首尾 whitespace、不是十进制正整数或超过 safe integer 范围 | 修正 env 值，或从 `envOverrides.allowedFields` 移除对应字段。 |
| 启动报 Android allowlist 但 `android is not configured` | workspace 允许了 `android.*` env override，却没有配置 `android` 段 | 补全该 workspace 的 `android` 段，或移除 `android.*` allowlist 项。 |
| 工具调用返回 `Path outside workspace` | AI 传了 selected workspace allowed roots 范围外的路径，或用相对路径试图访问 additional root | 检查目标路径和 root 配置；additional root 必须用 drive-absolute 路径访问。 |
| Android 构建工具返回配置错误 | 当前选中 workspace 没有 runtime Android 配置 | 在该 workspace 中补全 `android` 配置段；`ANDROID_*` 只能覆盖已有 `android` 配置，不能创建它。 |
| 环境变量没有生效 | 对应字段未列入 selected workspace 的 `envOverrides.allowedFields`，或 env var 不存在 | 添加允许字段，并设置合法的环境变量值。 |
