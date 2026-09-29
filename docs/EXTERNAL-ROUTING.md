# External Routing

External routing 为 selected workspace 中的 custom-only Tool 提供两种执行 route：

- HTTP endpoint；
- 下游 MCP Server。

Tool config v2 以 definition reference `id` 连接到 External routing config v2。
每条 route 通过 `routingMode` 选择协议，并共享 workspace 范围的容量、生命周期和资源所有权。

本机制不为 built-in Tool 增加 external route，也不改变同名 custom override 的内置 executor。
HTTP route 面向已配置且受信任的本地 Processor 与 HTTP endpoint。
MCP route 作为独立的 MCP Client 调用已配置的下游 Server。
运行期不重新读取 route 配置文件。

---

## 配置关系与启动期加载

入口位于 selected workspace 的 `tools.toolConfigFile`。引用关系如下：

```text
workspace tools.toolConfigFile
  └─ Tool config v2
       ├─ definitions[]: id + toolDefinitionFile
       └─ externalRoutingConfigFile
             └─ External routing config v2
                  ├─ processorConfigFile (optional)
                  └─ routes[]
                       ├─ routingMode: http → httpEndpointConfigFile + routingStrategy
                       └─ routingMode: mcp  → mcpServerConfigFile
```

启动期按以下顺序完成加载与校验：

1. 读取并编译 Tool config 与全部 Tool definition；
2. 读取 External routing config 和显式 Processor registry；
3. 读取每条 route 引用的 HTTP endpoint 或 MCP server config；
4. 校验 definition binding、Processor reference 和 workspace exposure。

纯配置与 catalog 校验成功且至少存在一条 route 后，创建共享 admission runtime。
HTTP route 按需创建 Processor runner 和专用 HTTP transport。
MCP route 按 server identity 创建 connection manager。

配置加载和 runtime 构造不发送下游请求。
HTTP listener 成功监听并输出启动摘要后，非阻塞 warm-up 各 MCP server identity 一次。
连接失败只记录安全 diagnostic，不阻止 listener 或其它工具工作。

引用文件的读取、JSON 或字段错误会使启动失败：

- `ConfigError.configFilePath` 指向实际出错文件；
- 字段错误同时携带 field path。

修改任一引用配置后需要重启服务。

所有 config reference path 都必须是无首尾 whitespace 的本地绝对路径。
Windows 下只接受 drive-absolute 路径，不接受：

- 相对路径；
- UNC 或 namespace 路径；
- drive-relative 或 rooted-without-drive 路径；
- `~`。

引用文件不要求位于 workspace allowed roots 内。

---

## Schema 版本与文件职责

所有配置外壳拒绝未知字段。
版本字段使用 JSON number。

| 文件 | version | 职责 |
|-|-|-|
| Tool config | `2` | 引用 Tool definition，并可选启用 External routing config。 |
| External routing config | `2` | 将 custom-only definition reference 绑定到 HTTP 或 MCP route。 |
| Processor config | `2` | 提供可被多条 route 复用的 Processor definition registry。 |
| HTTP endpoint config | `1` | 定义一个 endpoint 的 URL、timeout 与静态 headers。 |
| MCP server config | `1` | 定义一个下游 Streamable HTTP endpoint、timeout 与静态 headers。 |

Tool config 的完整字段、definition schema、路径 policy 和 exposure 见 [自定义 Tool 配置](config/tool-config.md)。

---

## External routing config v2

External routing config 顶层只允许下列字段：

| 字段 | 类型 | 必填 | 说明 |
|-|-|-|-|
| `version` | `2` | 是 | External routing config schema version。 |
| `processorConfigFile` | local absolute path | 否 | HTTP Processor config v2 registry。 |
| `routes` | object[] | 是 | 有序 route definitions；空数组合法。 |

`processorConfigFile` 出现时会在启动期读取并完整校验，即使没有 stage 引用其中的 Processor，或 `routes` 为空。
Processor registry 可以包含未被 route 使用的 definition。

`routes: []` 表示 routing config 已配置但没有执行 route。
此状态不创建以下资源：

- external admission runtime；
- Processor runner；
- HTTP Agents；
- MCP connection manager。

application `close()` 直接完成，custom-only Tool 保留 unavailable binding。

`routes[]` 是以 `routingMode` 为 discriminant 的严格 union。HTTP route 只允许下列字段：

| 字段 | 类型 | 必填 | 说明 |
|-|-|-|-|
| `definitionId` | string | 是 | Tool config `definitions[].id` 的 binding identity。 |
| `routingMode` | `"http"` | 是 | 使用 HTTP canonical protocol。 |
| `httpEndpointConfigFile` | local absolute path | 是 | 此 route 使用的 endpoint config v1。 |
| `routingStrategy` | object | 是 | request 与 response 的单 stage strategy。 |

MCP route 只允许：

- `definitionId`；
- `routingMode: "mcp"`；
- 必填的本地绝对路径 `mcpServerConfigFile`。

MCP route 不允许 HTTP endpoint 和 routing strategy。
HTTP route 不允许 MCP server config。
完整的 HTTP 与 MCP route 配置见[配置示例](#配置示例)。

`definitionId` 必须：

- 匹配 `^[A-Za-z0-9._-]{1,128}$`；
- 在整个有序 `routes[]` 内唯一；
- 引用所属 Tool config 中的一个 definition reference。

binding 不按 MCP Tool `name` 匹配。
HTTP canonical request 与 MCP `tools/call` 都使用 Tool definition 的 `name`。
MCP route 不调用下游 `tools/list`，也不导入下游 Tool 或映射 Tool name。

route 只能引用 custom-only definition。
definition 的 `name` 属于 built-in registry 时，该 definition 是 built-in override，并保留 built-in executor。
route 引用 built-in override 会在启动期失败。

custom-only definition 可以没有 route，此时保持 deterministic unavailable binding。
被 workspace exposure 隐藏的 route 仍在启动期完成加载与校验。
调用隐藏的 Tool 会返回 `Unknown tool`。

HTTP route 的 endpoint snapshot 可按相同 config path 复用。
MCP server config 成功读取后，以 native real path 作为 server identity：

- 相同 real path 共享冻结的 server snapshot 与 connection manager；
- 不同 real path 即使 URL 相同也不合并。

source metadata 使用配置中声明的绝对路径。
声明顺序用于稳定加载、诊断和启动日志。
调用通过唯一 `definitionId` 直接定位 route，不存在优先级。

### `routingStrategy`

`routingStrategy` 必须是严格 object，且恰好包含：

- `request-to-external`
- `response-from-external`

两个字段都必须是数组，并且在 External routing config v2 中都必须精确包含一个 stage。
空数组、多个 stage、缺少任一方向或额外字段都是配置错误。

request stage 位于 `request-to-external[0]`：

| `mode` | 额外字段 | 行为 |
|-|-|-|
| `direct` | 无 | 直接发送 canonical request UTF-8 JSON。 |
| `canonical-filter` | `processor` | Processor 输入与输出都是 canonical request。 |
| `body-encoder` | `processor`、`contentType` | Processor 将 canonical request bytes 编码为最终 HTTP body。 |

response stage 位于 `response-from-external[0]`：

| `mode` | 额外字段 | 行为 |
|-|-|-|
| `direct` | 无 | endpoint body 必须是 canonical response JSON。 |
| `canonical-filter` | `processor` | 先校验 endpoint canonical response，再由 Processor 返回替换后的 canonical response。 |
| `body-decoder` | `processor` | Processor 将 raw endpoint body 转换为 canonical response。 |

stage object 不含方向字段，方向由父级 key 表示。
`processor` 必须匹配 `^[A-Za-z0-9._-]{1,128}$`。
`body-encoder` 的 `contentType` 必须是可安全写入 HTTP `Content-Type` header 的有效 media type。

Processor stage 要求配置 `processorConfigFile`，并且名称必须存在于该 registry。
direct stage 不引用 registry。
多个 route 与两个方向可以引用同一个 Processor。

### 配置示例

`examples/` 提供相关配置的独立参考片段。
这些片段覆盖 direct HTTP route、经 Processor 编解码的 HTTP route 和 MCP route：

- [Tool config](../examples/tool-config.example.json)
- [direct custom-only Tool definition](../examples/tool-definition.example.json)
- [External routing config](../examples/external-routing-config.example.json)
- [Processor registry](../examples/processor-config.example.json)
- [direct HTTP endpoint config](../examples/http-endpoint-config.example.json)
- [MCP server config](../examples/mcp-server-config.example.json)

---

## Processor config v2

Processor config 顶层只允许两个必填字段：

| 字段 | 类型 | 说明 |
|-|-|-|
| `version` | `2` | Processor config schema version。 |
| `processors` | object[] | 有序 Processor definition registry；空数组合法。 |

每个 `processors[]` object 只允许下列字段：

| 字段 | 类型 | 约束 |
|-|-|-|
| `name` | string | 匹配 `^[A-Za-z0-9._-]{1,128}$`，且在该 registry 内唯一。 |
| `executable` | object | 见下方 executable union。 |
| `arguments` | string[] | 原样作为 subprocess argv 传入。 |
| `workingDirectory` | existing local absolute directory | Processor 的工作目录。 |
| `timeoutMs` | positive integer | 范围为 `1..2147483647`。 |

`executable` 是严格 union：

| `resolution` | 其余字段 | 约束 |
|-|-|-|
| `absolute-path` | `path` | existing local regular file 的本地绝对路径。 |
| `path-search` | `command` | 不含 `/`、`\` 或 Windows drive prefix 的 bare command name；由操作系统 PATH 搜索。 |

registry 不拥有 endpoint 或 routing strategy。
registry 或 Processor definition 可以不被 route 使用，但显式引用的 registry 仍会在启动期完整校验。

---

## HTTP endpoint config v1

endpoint config 顶层只允许下列字段：

| 字段 | 类型 | 必填 | 约束 |
|-|-|-|-|
| `version` | `1` | 是 | endpoint config schema version。 |
| `url` | string | 是 | absolute `http://` 或 `https://` URL，必须有 hostname；不允许 credentials 或 fragment。query 可以存在。 |
| `timeoutMs` | positive integer | 是 | 范围为 `1..2147483647`，覆盖该 endpoint 的完整 HTTP exchange。 |
| `headers` | object | 否 | static request headers；每个 value 必须是 string 并通过 Node.js HTTP header 校验。 |

`headers` 的名称按大小写不重复。
不能配置以下 transport-owned 或 hop-by-hop 字段：

- entity 与 negotiation：`Content-Length`、`Content-Type`、`Content-Encoding`、`Accept-Encoding`；
- connection：`Host`、`Connection`、`Keep-Alive`、`Transfer-Encoding`、`TE`、`Trailer`、`Upgrade`；
- proxy：`Proxy-Authenticate`、`Proxy-Authorization`、`Proxy-Connection`。

transport 为每次请求生成 `Content-Type` 与 `Content-Length`。

HTTPS 使用 Node.js 默认 TLS 行为，只信任运行环境认可的服务端证书。
配置不支持自定义 CA、客户端证书、mTLS、TLS cipher/version 或关闭证书校验。
配置不会把 `https://` endpoint 降级为 HTTP。

---

## MCP server config v1

MCP route 的 `mcpServerConfigFile` 指向严格 JSON object，只允许以下字段：

| 字段 | 类型 | 必填 | 约束 |
|-|-|-|-|
| `version` | `1` | 是 | MCP server config schema version。 |
| `url` | string | 是 | absolute `http://` 或 `https://` Streamable HTTP URL；须有 hostname，拒绝 credentials 与 fragment；允许 query。 |
| `timeoutMs` | positive integer | 是 | 范围 `1..2147483647`，用于 initialize、连接 deadline 和每次普通 `tools/call`；progress 不重置 timeout。 |
| `headers` | object | 否 | 所有下游 MCP HTTP 请求使用的静态 headers。 |

Header name 大小写不重复，value 必须是 string 并通过 Node.js header 校验。
业务认证 header 可以配置，但拒绝：

- entity 与 negotiation：`Content-Length`、`Content-Type`、`Content-Encoding`、`Accept`、`Accept-Encoding`；
- connection：`Host`、`Connection`、`Keep-Alive`、`Transfer-Encoding`、`TE`、`Trailer`、`Upgrade`；
- proxy：`Proxy-Authenticate`、`Proxy-Authorization`、`Proxy-Connection`；
- MCP-owned：`Mcp-Session-Id`、`MCP-Protocol-Version`、`Last-Event-ID`。

HTTP endpoint 与 MCP server 使用各自的 header 禁止集合。

下游使用 Node.js 默认 HTTPS TLS 行为。
配置不提供自定义 CA、mTLS 或关闭证书校验的能力。
Streamable HTTP 请求禁止 redirect，避免转发静态认证 header。
MCP server config 只在启动期读取，不通过下游 `tools/list` 自动发现或校验 Tool。

---

## Catalog binding 与调用边界

catalog 以 Tool config definition reference `id` 接收 route-bound external executor：

- 未覆盖的 built-in Tool 使用 built-in definition、executor 与 implementation contract。
- built-in override 使用 custom definition 的对外 schema，但保留 built-in executor 和 implementation contract。
- custom-only definition 有 route 时绑定对应 external executor；没有 route 时绑定 unavailable executor。

所有 definition、route、显式 Processor registry、HTTP endpoint 和 MCP server artifact 都在 exposure 过滤之前加载与校验。
随后 compiler：

1. 构建 effective catalog；
2. 校验 workspace `enabled` / `disabled` selector；
3. 派生 exposed catalog。

隐藏 Tool 不会绕过 exposure 到达 external executor。
被隐藏的 MCP route 仍参与对应 server identity 的启动后 warm-up。

external invocation 只接收 invocation call id、Tool name、已校验 arguments 和 caller `AbortSignal`，不接收 `ToolRuntimeContext`、workspace roots 或本地文件访问能力。

---

## HTTP canonical protocol 与 stage 编排

HTTP route 的每次有效调用被构造成一个单调用 canonical request。
route 的 request stage 产生最终 HTTP request entity。
HTTP `POST` 交换使用该 route 的 endpoint snapshot。
response stage 将 endpoint result 转换为项目标准 `ToolCallResult`。
MCP route 不使用 canonical wrapper 或 Processor stage。

canonical request 是只含一个 call 的 JSON object：

- `calls` 是长度为一的数组；
- call 包含 `id`、`name` 和 object 类型的 `arguments`；
- 可选 `extensions` 只接受非空、非 `custom-mcp` namespace 的 object 值。

`id` 使用 MCP invocation call id，`name` 使用 Tool definition 的 MCP name。
`definitionId` 不进入 canonical protocol。

canonical response 只允许两种形状之一：

- `results`：长度为一的数组，result 的 `id` 必须与原 call id 相同，`status` 为 `completed`、`failed` 或 `cancelled`，并有 string `message`；
- `error`：有 non-empty string `code` 和 string `message`。

Canonical request 示例：

```json
{
  "calls": [
    {
      "id": "call_opaque-id",
      "name": "external_echo",
      "arguments": {
        "message": "Hello from custom-mcp."
      }
    }
  ]
}
```

Canonical completed response 使用相同的 call id：

```json
{
  "results": [
    {
      "id": "call_opaque-id",
      "status": "completed",
      "message": "Hello from the external endpoint."
    }
  ]
}
```

Endpoint 拒绝请求时可以返回 canonical error：

```json
{
  "error": {
    "code": "invalid_request",
    "message": "The request could not be processed."
  }
}
```

HTTP transport 始终使用 `POST`，不自动解压 response entity，也不跟随 redirect。

response stage 的 representation 规则如下：

- `direct` 与 `canonical-filter` 要求有效的 `application/json` content type。
- charset 必须缺省或为 UTF-8，content encoding 必须缺省或为 `identity`。
- `body-decoder` 可根据经校验的 response representation metadata 处理 body。

HTTP status 规则如下：

- `2xx` 可以携带任一合法 canonical response；
- `4xx` / `5xx` 只能携带 canonical `error` response；
- `3xx` 和其它状态范围不会产生确认结果。

canonical JSON 使用严格 UTF-8，Processor canonical output 不允许 BOM。
所有 canonical message 拒绝未知字段、非 JSON 值、循环结构、accessor、symbol 与非标准 prototype。
filter 输出不会补回它省略的 extensions。

---

## MCP route 与下游会话

External runtime 按不同 MCP server config real path 维护 workspace-owned connection manager。
一个 manager 共享一个 MCP Client、Streamable HTTP transport 和下游 session。
多个 route、调用和上游 MCP session 可以复用同一个 manager。
上下游 request ID、session ID、initialize 与能力协商相互独立。

下游调用只发送：

- 本地 Tool definition 的 `name`；
- 已校验的 `arguments`。

下游调用不发送 definition ID、本地 call ID、上游会话、workspace roots、请求 headers 或 canonical wrapper。

HTTP listener listening 且启动摘要写出后，每个 server identity 都会接受一次非阻塞 warm-up。
Manager 采用 single-flight initialize，并检查下游是否声明 `tools` capability。
Manager 不调用 `tools/list`。

连接失败后：

- manager 回到 idle，并输出安全 diagnostic；
- 后续 Tool 调用可再次按需连接；
- 同期 waiter 共享同一次连接；
- 单个 waiter 取消不会终止共享 initialize。

Transport 或 session 无效后废弃连接，后续调用建立新 session。
已发送的调用不自动重试。

下游合法 `CallToolResult` 保留项目支持的字段。
支持的字段包括 text/image content、annotations、`_meta` 与 `structuredContent`。
省略的 `isError` 归一化为 `false`，下游 `isError: true` 保持为业务结果。

JSON-RPC、timeout、连接、transport 或协议错误会成为本地稳定的 `isError: true` Tool result。
audio、resource、resource link 和其它不满足项目统一 text/image 结果边界的内容不会被截断，也不会被转成文本返回。

结果仍经过统一验证、request policy 和 Tool-call/result logger。
下游 raw error data 不进入新增 MCP diagnostic。

MCP `tools/call` 使用独立下游 request ID。
Caller cancellation 通过 route-owned signal 触发 SDK cancellation notification。
取消通知不复用上游 ID，也不会重试调用。

已结算的调用继续占据 active slot。
对应的 request-specific HTTP body 和 cancellation notification 完成 HTTP lifecycle drain 后，active slot 才会释放。
MCP connection manager 的 transport close 提供 shutdown 时的最终 drain barrier。
上游单个 session close 只取消该 session 的调用。
该操作不会关闭 workspace-owned 下游 session。

---

## 共享资源、容量、失败与取消

有至少一条 route 时，workspace 创建一个共享 external runtime：

- HTTP 与 MCP route 共用最多 8 个 active exchange 和 64 个 FIFO pending exchange；第 65 个 pending 调用返回 `external_capacity_exceeded`，不会启动外部工作。
- active slot 直到 exchange 的 `drained` 完成后释放，而不是 caller-visible result `settled` 时释放。
- HTTP route 具有 immutable endpoint snapshot 和 stage adapter，HTTP route 共用一组 owner-scoped HTTP/HTTPS Agents；不使用或关闭 process-global Agent。
- 使用 Processor stage 时创建共享 Processor runner 和显式 registry。
- runner 进入 degraded cleanup state 后会拒绝后续 Processor admission；direct route 与 MCP route 不调用该 runner。
- MCP route 按 server config real path 共享 connection manager、MCP Client 和下游 session，但不与 HTTP route 共享 transport resource。
- Tool 调用触发的 connect 位于 admission 之后，后台 warm-up 不占用 Tool exchange slot。

字节与时间边界：

| 边界 | 限制 | 结果 |
|-|-|-|
| 最终 HTTP request entity | 50 MiB | 超限时不发送 HTTP request。 |
| HTTP response entity | 50 MiB | 对声明长度和实际接收字节都执行限制。 |
| Processor stdin | 50 MiB | 超限时不启动该 Processor。 |
| Processor stdout | 50 MiB | 超限后终止该 Processor。 |
| retained Processor stderr diagnostics | 1 MiB | 保留量受限；总字节数仍计量。 |
| endpoint / Processor `timeoutMs` | 各自 `1..2147483647` | HTTP 或 Processor timeout 结算为受控本地失败。 |

HTTP body 在 request stage 完成编码后检查，`body-encoder` 的结果也受 request limit。
transport 使用背压分块写入，避免在一个 turn 中将大 body 全部放入 Node writable queue。

配置、canonical protocol、Processor、transport、timeout、容量与本地内部失败都映射为标准 `ToolCallResult` 错误。
endpoint 的已校验 business result 也映射为标准结果：

- `completed` 为成功；
- `failed`、`cancelled` 和 canonical `error` 为 `isError: true`。

完整结果映射见 [工具返回结果](TOOL-RESULTS.md)。

内部 failure classification 用于稳定诊断和受控错误构造：

| Classification | 语义 |
|-|-|
| `external_capacity_exceeded` | 8 个 active 和 64 个 pending exchange 都已占满；调用未启动外部工作。 |
| `external_request_too_large` | HTTP 最终 request body 超过 50 MiB；HTTP request 未发送。 |
| `external_transport_failed` | DNS、连接、TLS 或 HTTP stream 失败。 |
| `external_timeout` | route endpoint 的 HTTP exchange 超过其 `timeoutMs`。 |
| `external_response_too_large` | response body 超过 50 MiB。 |
| `external_protocol_failed` | HTTP metadata、UTF-8、JSON、canonical shape、call id 或 status contract 无效。 |
| `external_rejected` | endpoint 返回合法 canonical error。 |
| `external_tool_failed` | endpoint 返回合法 canonical result `failed`。 |
| `external_tool_cancelled` | endpoint 返回合法 canonical result `cancelled`；这是远端领域结果。 |
| `processor_failed` | Processor spawn、stdio、exit、signal、大小限制或输出 contract 失败。 |
| `processor_timeout` | Processor invocation 超过 `timeoutMs`。 |
| `mcp_connection_failed` | 未建立可用下游 MCP session。 |
| `mcp_capability_missing` | 下游没有声明 `tools` capability。 |
| `mcp_call_failed` | 下游 `tools/call` 返回 JSON-RPC error。 |
| `mcp_timeout` | 下游 initialize 或普通调用超时。 |
| `mcp_protocol_failed` | 下游 MCP message / result 不符合协议。 |
| `mcp_result_unsupported` | 下游 result 超出项目 text/image 边界。 |
| `mcp_transport_failed` | 下游 MCP transport / session 交换失败。 |
| `external_internal_failed` | 统一调用管线捕获未建模的内部异常。 |
| `cancelled` | MCP caller cancellation 或 application shutdown 中止本地 exchange。 |

服务不自动重试外部调用，也不接受晚到结果。
transport、timeout、response-side Processor timeout 和 caller cancellation 后，外部服务可能已经执行操作。
调用方只能在该操作可安全重复时自行重试。

caller `AbortSignal` 会传递到 pending / active admission 和对应的 HTTP 或 MCP route adapter。
取消 queued 调用会将其移出 FIFO。
取消 active 调用先结算为 `cancelled`，然后继续等待本地 drain。

HTTP Processor 在 timeout 或取消时：

1. 关闭 stdio；
2. 向 direct child 发送 `SIGTERM`；
3. 有界等待后仍未退出时发送 `SIGKILL`。

child 未确认关闭时，runner 进入 degraded cleanup。
处于该状态的 runner 会拒绝未来的 Processor admission。

首次 `SIGINT` 或 `SIGTERM` 启动幂等 application shutdown：

1. 停止 HTTP listener 与新上游 MCP session admission，并立即启动 Android runtime close。
2. 关闭已有上游 session，并传播调用取消。
3. 等待 HTTP listener、session drain 和 Android barrier。
4. 调用 `LoadedApplicationRuntime.close()`。
5. external runtime 停止新 admission、取消 pending、abort active invocation，同时启动 MCP connection manager close。
6. connection manager close 解除下游 HTTP lifecycle 的 drain barrier。
7. active drain 与 manager close 完成后，关闭 Processor runner（存在时）和专用 HTTP/HTTPS Agents。
8. 最后关闭 logger。

已有下游 session best-effort 发送 DELETE，最多等待 5 秒。
失败或超时仍关闭本地 Client/transport。
单个上游 session DELETE 或 transport close 不关闭 workspace external runtime。
关闭过程复用一个 completion promise。
任一阶段失败后仍继续后续阶段，并聚合报告。

---

## 日志与敏感信息边界

启动摘要由 `formatExternalRoutingStartupLines()` 生成，按以下状态输出：

```text
  External routing: disabled
```

Tool config 未配置 `externalRoutingConfigFile` 时输出 disabled。

```text
  External routing: configured
    Routes: 0
```

External routing config 存在但 `routes` 为空时输出 configured。

```text
  External routing: enabled
    Routes: 2
    Route: external-echo
      Routing mode: http
      Tool: external_echo
      Request stages: body-encoder
      Response stages: body-decoder
      Endpoint: http://127.0.0.1:43120/external/v1/tool-calls
    Route: external-mcp
      Routing mode: mcp
      Tool: external_mcp_tool
      Server: http://127.0.0.1:43130/mcp
```

有 route 时，摘要按全局 route 声明顺序输出 definition id、routing mode 和 Tool name。
HTTP route 还输出两个 stage mode 与 endpoint identity。
MCP route 输出 server identity。

URL identity 剥离 query、credentials 与 fragment。
摘要不输出：

- 静态 header；
- 配置文件路径；
- Processor executable path 或 argv。

Manager connection diagnostic 按 server identity 记录：

- connected / failed；
- phase；
- classification；
- duration。

shared server 的一次 warm-up 只产生一次 outcome。
新增 MCP diagnostic 不包含：

- 静态 header name/value；
- 下游 request/session ID；
- arguments 或 result payload；
- 下游原始错误；
- URL query。

Processor post-drain diagnostics 记录安全的 `route=<definitionId>` 与 `tool=<toolName>`。
诊断还记录 role、Processor name、duration、byte counts、stderr truncation 和 cleanup state。

诊断不包含 endpoint URL、header value、payload、executable path、argv、stdout 或 stderr text。
diagnostic sink 的异常或耗时不会改变调用结果，也不会延迟资源 cleanup。

Processor 默认继承 process environment，但会先按 Windows 大小写不敏感规则删除 `CUSTOM_MCP_PROCESSOR_ROLE` 和全部 `CUSTOM_MCP_EXTERNAL_*` 名称变体，再注入本次 invocation 的保留变量：

| Variable | 注入范围与值 |
|-|-|
| `CUSTOM_MCP_PROCESSOR_ROLE` | 所有 Processor；值为 `request.canonical-filter`、`request.body-encoder`、`response.canonical-filter` 或 `response.body-decoder`。 |
| `CUSTOM_MCP_EXTERNAL_CALL_ID` | 所有 Processor；原 canonical request 的不透明 call id。 |
| `CUSTOM_MCP_EXTERNAL_HTTP_STATUS` | response Processor；最终 HTTP status 的十进制字符串。 |
| `CUSTOM_MCP_EXTERNAL_CONTENT_TYPE` | response Processor；存在时为校验后的 Content-Type，缺失时不设置。 |
| `CUSTOM_MCP_EXTERNAL_CONTENT_ENCODING` | response Processor；存在时为规范化后的 Content-Encoding，缺失时不设置。 |

Request Processor 不接收 response-only metadata。
Response `body-decoder` 应使用 `CUSTOM_MCP_EXTERNAL_CALL_ID` 构造 canonical result id。
即使目标私有协议不回显该 id，这项要求仍然适用。
保留变量不包含 endpoint URL、认证 header、MCP session 或其它 response headers。

已通过 canonical protocol 校验的 endpoint `message` / `error.message` 是业务结果，会进入 MCP text result。
这些业务结果不经过通用内容脱敏。
配置 endpoint 和 Processor 的维护者应避免在业务文本中返回敏感信息。

---

## 维护入口与回归测试

### 配置、catalog 与启动

- `src/tools/custom-tool-config.ts`
  - 职责：Tool config v2、definition 加载与 External routing config 入口。
  - 测试：`test/tools/custom-tool-config.test.ts`。
- `src/tools/external-routing/config.ts`
  - 职责：External routing config v2、Processor registry、endpoint/server config、route union 与 binding。
  - 测试：`test/external-routing/config.test.ts`。
- `src/tools/catalog.ts`
  - 职责：definition-id external binding、unavailable binding、override 保持 built-in binding。
  - 测试：`test/tools/tool-exposure.test.ts`。
- `src/runtime/startup-runtime.ts`
  - 职责：配置与 catalog 校验、空 route 无资源运行时、共享 executor 创建和 shutdown。
  - 测试：`test/runtime/startup-runtime.test.ts`。

### Route 执行与共享资源

- `src/tools/external-routing/canonical-protocol.ts`
  - 职责：canonical JSON contract 与 filter invariant。
  - 测试：`test/external-routing/canonical-protocol.test.ts`。
- `src/tools/external-routing/strategy-adapter.ts`
  - 职责：HTTP route stage 编排、status/protocol mapping 与 drain diagnostics。
  - 测试：`test/external-routing/strategy-adapter.test.ts`。
- `src/tools/external-routing/http-transport.ts`
  - 职责：HTTP resources、endpoint snapshot、limits、metadata、失败、取消与 shutdown。
  - 测试：`test/external-routing/http-transport.test.ts`。
- `src/tools/external-routing/processor-runner.ts`
  - 职责：subprocess limits、environment、termination 与 drain。
  - 测试：`test/external-routing/processor-runner.test.ts`。
- `src/tools/external-routing/mcp-connection-manager.ts` 与 `src/tools/external-routing/mcp-transport.ts`
  - 职责：下游 MCP Client/session、single-flight warm-up、tracked exchange 与 transport close barrier。
  - 测试：`test/external-routing/` 下的 MCP 专题测试。
- `src/tools/external-routing/runtime.ts`
  - 职责：workspace 8 active / 64 pending admission、FIFO、cancel 与 close。
  - 测试：`test/external-routing/runtime-lifecycle.test.ts`。
- `src/tools/external-routing/executor.ts`
  - 职责：route-bound facade、HTTP result mapping、MCP dispatch 与资源关闭。
  - 测试：`test/external-routing/executor.test.ts`。

### Application 集成与诊断

- `src/runtime/application-lifecycle.ts`
  - 职责：listener、Android runtime、MCP session、external runtime 与 logger 的关闭顺序。
  - 测试：`test/runtime/application-lifecycle.test.ts`。
- `src/runtime/startup-logging.ts`
  - 职责：disabled/configured/enabled 启动摘要与 HTTP/MCP URL 脱敏。
  - 测试：`test/runtime/startup-logging.test.ts`。
- `src/runtime/application-diagnostics.ts`
  - 职责：Processor drain 与 MCP connection 的安全诊断格式。
  - 测试：`test/runtime/application-diagnostics.test.ts`。
- `test/runtime/external-routing-integration.test.ts`
  - 职责与测试：selected workspace 到 MCP/loopback endpoint 的多 route custom-only 集成。
