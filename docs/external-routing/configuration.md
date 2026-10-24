# 外部路由配置

本页承接 External routing config、Processor registry、HTTP endpoint 与 MCP server 的字段和跨文件引用校验。加载时机和 binding 概览见 [External Routing](../EXTERNAL-ROUTING.md)；Tool config 与 Tool definition 的字段见[自定义 Tool 配置](../config/tool-config.md)。

## 文件版本与路径边界

所有配置外壳拒绝未知字段，`version` 使用 JSON number。

| 文件 | version | 职责 |
|-|-|-|
| Tool config | `2` | 引用 Tool definition，并可选启用 External routing config。 |
| External routing config | `2` | 将 custom-only definition reference 绑定到 HTTP 或 MCP route。 |
| Processor config | `2` | 提供可被多条 HTTP route 复用的 Processor definition registry。 |
| HTTP endpoint config | `1` | 定义 endpoint URL、HTTP exchange timeout 与静态 headers。 |
| MCP server config | `1` | 定义下游 Streamable HTTP URL、连接/调用 timeout 与静态 headers。 |

所有 config reference path 都必须是无首尾 whitespace 的本地绝对路径，引用文件不要求位于 workspace allowed roots 内。Windows 下只接受 drive-absolute 路径，拒绝相对路径、UNC / namespace 路径、drive-relative / rooted-without-drive 路径及 `~`。

引用文件的读取、JSON 或字段错误使启动失败。`ConfigError.configFilePath` 指向实际出错文件，字段错误同时携带 field path。route union、binding、重复 binding 与 Processor reference 错误归属 External routing config；workspace exposure selector 错误归属 workspace 配置。

## External routing config v2

顶层只允许下列字段：

| 字段 | 类型 | 必填 | 说明 |
|-|-|-|-|
| `version` | `2` | 是 | External routing config schema version。 |
| `processorConfigFile` | local absolute path | 否 | HTTP Processor config v2 registry。 |
| `routes` | object[] | 是 | 有序 route definitions；空数组合法。 |

`processorConfigFile` 出现时会完整校验，即使没有 stage 引用其中的 Processor，或 `routes` 为空。registry 可以包含未使用的 definition。

`routes: []` 表示已配置但没有执行 route，不创建 external admission runtime、Processor runner、HTTP Agents 或 MCP connection manager。其 external runtime `close()` 直接完成，custom-only Tool 保持 unavailable binding。

### Route union 与 binding 校验

`routes[]` 是以 `routingMode` 为 discriminant 的严格 union。

| 字段 | HTTP route | MCP route |
|-|-|-|
| `definitionId` | 必填 string，指向 Tool config `definitions[].id`。 | 同左。 |
| `routingMode` | 必须为 `"http"`。 | 必须为 `"mcp"`。 |
| `httpEndpointConfigFile` | 必填本地绝对路径。 | 禁止。 |
| `routingStrategy` | 必填 object。 | 禁止。 |
| `mcpServerConfigFile` | 禁止。 | 必填本地绝对路径。 |

`definitionId` 必须匹配 `^[A-Za-z0-9._-]{1,128}$`，在整个有序 `routes[]` 内唯一，并引用所属 Tool config 中的 definition reference。调用按唯一 `definitionId` 直接定位 route，声明顺序只用于稳定加载、诊断和启动日志，不提供 route 优先级。

Binding 不按 MCP Tool `name` 匹配。HTTP canonical request 与下游 MCP `tools/call` 使用 definition 的 `name`。MCP route 不调用 `tools/list`，不导入下游 Tool，也不映射 Tool name。

Route 只能引用 custom-only definition。definition 的 `name` 属于 built-in registry 时是 built-in override，保留内置 executor；为它声明 route 会使启动失败。custom-only definition 可以不配置 route，此时为 deterministic unavailable binding。

全部 definition、route 和引用 artifact 在 workspace exposure 过滤前加载和校验。隐藏 route 不绕过校验，也不绕过 exposure 到达 executor；调用隐藏 Tool 返回 `Unknown tool`。

HTTP endpoint snapshot 可按相同 config path 复用。MCP server config 成功读取后以 native real path 作为 server identity：相同 real path 共享冻结 snapshot 与 connection manager；不同 real path 即使 URL 相同也不合并。source metadata 保留配置中声明的绝对路径。

### HTTP `routingStrategy`

`routingStrategy` 是严格 object，恰好包含 `request-to-external` 与 `response-from-external`。两个字段都必须是数组，并且各自精确包含一个 stage；空数组、多 stage、缺少方向或额外字段都是配置错误。stage object 不含方向字段，方向由父级 key 表示。

| 方向 | `mode` | 额外字段 |
|-|-|-|
| request | `direct` | 无 |
| request | `canonical-filter` | `processor` |
| request | `body-encoder` | `processor`、`contentType` |
| response | `direct` | 无 |
| response | `canonical-filter` | `processor` |
| response | `body-decoder` | `processor` |

`processor` 必须匹配 `^[A-Za-z0-9._-]{1,128}$`，并存在于显式 `processorConfigFile` registry 中。direct stage 不引用 registry；多个 route 和两个方向可以引用同一个 Processor。`body-encoder.contentType` 必须是可安全写入 HTTP `Content-Type` header 的有效 media type。

各 mode 的输入输出、filter 不变量、response representation 与 HTTP status 规则见 [HTTP route](http-route.md#stage-与-http-exchange)。

## Processor config v2

顶层只允许两个必填字段：

| 字段 | 类型 | 说明 |
|-|-|-|
| `version` | `2` | Processor config schema version。 |
| `processors` | object[] | 有序 Processor definition registry；空数组合法。 |

每个 `processors[]` object 只允许：

| 字段 | 类型 | 约束 |
|-|-|-|
| `name` | string | 匹配 `^[A-Za-z0-9._-]{1,128}$`，在 registry 内唯一。 |
| `executable` | object | 下表所示严格 union。 |
| `arguments` | string[] | 原样作为 subprocess argv 传入。 |
| `workingDirectory` | existing local absolute directory | Processor 工作目录。 |
| `timeoutMs` | positive integer | `1..2147483647`。 |

| `executable.resolution` | 其余字段 | 约束 |
|-|-|-|
| `absolute-path` | `path` | existing local regular file 的本地绝对路径。 |
| `path-search` | `command` | 不含 `/`、`\` 或 Windows drive prefix 的 bare command name，由操作系统 PATH 搜索。 |

Registry 不拥有 endpoint 或 routing strategy。进程 environment、保留变量、stdio 限制和终止行为分别见 [HTTP Processor 边界](http-route.md#processor-输入输出与环境)与[运行时资源](runtime.md)。

## HTTP endpoint config v1

顶层只允许下列字段：

| 字段 | 类型 | 必填 | 约束 |
|-|-|-|-|
| `version` | `1` | 是 | endpoint config schema version。 |
| `url` | string | 是 | absolute `http://` 或 `https://` URL，必须有 hostname；拒绝 credentials 和 fragment，允许 query。 |
| `timeoutMs` | positive integer | 是 | `1..2147483647`，覆盖该 endpoint 的完整 HTTP exchange。 |
| `headers` | object | 否 | static request headers；value 必须是 string，并通过 Node.js HTTP header 校验。 |

Header name 按大小写不重复。禁止配置以下 transport-owned 或 hop-by-hop 字段：

- entity / negotiation：`Content-Length`、`Content-Type`、`Content-Encoding`、`Accept-Encoding`；
- connection：`Host`、`Connection`、`Keep-Alive`、`Transfer-Encoding`、`TE`、`Trailer`、`Upgrade`；
- proxy：`Proxy-Authenticate`、`Proxy-Authorization`、`Proxy-Connection`。

Transport 为每次请求生成 `Content-Type` 与 `Content-Length`。HTTP endpoint 与 MCP server 的 header 禁止集合不同，不应合并使用。

HTTPS 使用 Node.js 默认 TLS 行为，仅信任运行环境认可的服务端证书。配置不提供自定义 CA、客户端证书、mTLS、TLS cipher/version 或关闭证书校验的能力，也不会把 `https://` 降级为 HTTP。

## MCP server config v1

`mcpServerConfigFile` 指向严格 JSON object，只允许下列字段：

| 字段 | 类型 | 必填 | 约束 |
|-|-|-|-|
| `version` | `1` | 是 | MCP server config schema version。 |
| `url` | string | 是 | absolute `http://` 或 `https://` Streamable HTTP URL，必须有 hostname；拒绝 credentials 和 fragment，允许 query。 |
| `timeoutMs` | positive integer | 是 | `1..2147483647`，用于 initialize、连接 deadline 与每次普通 `tools/call`；progress 不重置 timeout。 |
| `headers` | object | 否 | 所有下游 MCP HTTP 请求使用的静态 headers。 |

Header name 按大小写不重复，value 必须是 string 并通过 Node.js header 校验。允许业务认证 header，但拒绝：

- entity / negotiation：`Content-Length`、`Content-Type`、`Content-Encoding`、`Accept`、`Accept-Encoding`；
- connection：`Host`、`Connection`、`Keep-Alive`、`Transfer-Encoding`、`TE`、`Trailer`、`Upgrade`；
- proxy：`Proxy-Authenticate`、`Proxy-Authorization`、`Proxy-Connection`；
- MCP-owned：`Mcp-Session-Id`、`MCP-Protocol-Version`、`Last-Event-ID`。

下游使用 Node.js 默认 HTTPS TLS 行为，不提供自定义 CA、mTLS 或关闭证书校验的配置。Streamable HTTP 请求禁止 redirect，避免转发静态认证 header。配置只在启动期读取，不通过下游 `tools/list` 自动发现或校验 Tool。

## 配置示例与引用检查

`examples/` 提供独立片段，覆盖 direct HTTP、Processor 编解码 HTTP 和 MCP route；使用前替换本地绝对路径和值：

- [Tool config](../../examples/tool-config.example.json)与 [Tool definition](../../examples/tool-definition.example.json)；
- [External routing config](../../examples/external-routing-config.example.json)；
- [Processor registry](../../examples/processor-config.example.json)；
- [HTTP endpoint config](../../examples/http-endpoint-config.example.json)；
- [MCP server config](../../examples/mcp-server-config.example.json)。

核对跨文件引用时，沿 `Tool config definitions[].id → route.definitionId` 查 binding，沿 `stage.processor → processors[].name` 查 HTTP Processor。下游实际 Tool name 来自 definition，不来自这两个引用名称。若配置中存在未暴露 route 或未使用的显式 registry，也必须确保其 artifact 全部有效。
