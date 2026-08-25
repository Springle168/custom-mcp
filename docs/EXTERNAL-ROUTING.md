# External Routing

External routing 为 selected workspace 中的 custom-only Tool 提供受控的 HTTP 执行 route。Tool config v2 以 definition reference `id` 连接到 External routing config v1；每条 route 选择自己的 endpoint snapshot 与 request / response stage，同时共享 workspace 范围的容量、生命周期和资源所有权。

本机制不为 built-in Tool 增加 HTTP route，也不改变同名 custom override 的内置 executor。它面向已配置且受信任的本地 Processor 与外部 endpoint；运行期不重新读取任何 route 配置文件。

---

## 配置关系与启动期加载

入口位于 selected workspace 的 `tools.toolConfigFile`。引用关系如下：

```text
workspace tools.toolConfigFile
  └─ Tool config v2
       ├─ definitions[]: id + toolDefinitionFile
       └─ externalRoutingConfigFile
            └─ External routing config v1
                 ├─ processorConfigFile (optional)
                 └─ routes[]
                      ├─ definitionId
                      ├─ httpEndpointConfigFile
                      └─ routingStrategy
```

启动期先读取并编译 Tool config 与全部 Tool definition，再读取已配置的 External routing config、Processor registry 和每条 route endpoint，完成 definition binding、Processor reference 和 workspace exposure 校验。仅在所有纯配置与 catalog 校验成功、且至少存在一条 route 后，才创建 Processor runner、HTTP transport 与 admission runtime。

启动不探测 endpoint，也不发送 HTTP 请求。任何引用文件的读取、JSON 或字段错误都使启动失败，并将 `ConfigError.configFilePath` 指向实际出错文件；字段错误同时携带 field path。修改 Tool config、External routing config、Processor registry 或 endpoint config 后需要重启服务。

所有 config reference path 都必须是无首尾 whitespace 的本地绝对路径。Windows 下只接受 drive-absolute 路径；不接受相对路径、UNC、namespace、drive-relative、rooted-without-drive 或 `~`。这些引用文件不要求位于 workspace allowed roots 内。

---

## Schema 版本与文件职责

所有配置外壳拒绝未知字段。版本字段使用 JSON number。

| 文件 | version | 职责 |
|-|-|-|
| Tool config | `2` | 引用 Tool definition，并可选启用 External routing config。 |
| External routing config | `1` | 将 custom-only definition reference 绑定到 endpoint 和两个方向的 stage。 |
| Processor config | `2` | 提供可被多条 route 复用的 Processor definition registry。 |
| HTTP endpoint config | `1` | 定义一个 endpoint 的 URL、timeout 与静态 headers。 |

Tool config 的完整字段、definition schema、路径 policy 和 exposure 见 [自定义 Tool 配置](config/tool-config.md)。

---

## External routing config v1

External routing config 顶层只允许下列字段：

| 字段 | 类型 | 必填 | 说明 |
|-|-|-|-|
| `version` | `1` | 是 | External routing config schema version。 |
| `processorConfigFile` | local absolute path | 否 | Processor config v2 registry。 |
| `routes` | object[] | 是 | 有序 route definitions；空数组合法。 |

`processorConfigFile` 出现时会在启动期读取并完整校验，即使没有 stage 引用其中的 Processor，或 `routes` 为空。Processor registry 可以包含未被 route 使用的 definition。

`routes: []` 表示 routing config 已配置但没有执行 route。此状态不会创建 external admission runtime、Processor runner 或 HTTP Agents；application `close()` 直接完成。custom-only Tool 保留 unavailable binding。

每个 `routes[]` object 只允许下列字段：

| 字段 | 类型 | 必填 | 说明 |
|-|-|-|-|
| `definitionId` | string | 是 | Tool config `definitions[].id` 的 binding identity。 |
| `httpEndpointConfigFile` | local absolute path | 是 | 此 route 使用的 endpoint config v1。 |
| `routingStrategy` | object | 是 | request 与 response 的单 stage strategy。 |

`definitionId` 必须匹配 `^[A-Za-z0-9._-]{1,128}$`，在同一 External routing config 内只能出现一次，并且必须引用所属 Tool config 中的一个 definition reference。binding 不按 MCP Tool `name` 匹配；canonical request 仍发送 Tool definition 的 `name`。

route 只能引用 custom-only definition。definition 的 `name` 属于 built-in registry 时，它是 built-in override，保留 built-in executor；route 引用它会在启动期失败。custom-only definition 可以没有 route，此时保持 deterministic unavailable binding。被 workspace exposure 隐藏的 route 仍在启动期完成加载与校验，但隐藏 Tool 调用返回 `Unknown tool`。

每条 route 都读取并冻结自己的 endpoint snapshot。不同 route 可以引用同一 endpoint config path；重复 path 可以复用已编译 snapshot，且不会改变 route 的 source identity。声明顺序用于稳定加载、诊断和启动日志；调用通过唯一 `definitionId` 直接定位 route，不存在优先级。

### `routingStrategy`

`routingStrategy` 必须是严格 object，且恰好包含：

- `request-to-external`
- `response-from-external`

两个字段都必须是数组，并且在 External routing config v1 中都必须精确包含一个 stage。空数组、多个 stage、缺少任一方向或额外字段都是配置错误。

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

stage object 不含方向字段；方向由父级 key 表示。`processor` 必须匹配 `^[A-Za-z0-9._-]{1,128}$`。`body-encoder` 的 `contentType` 必须是可安全写入 HTTP `Content-Type` header 的有效 media type。

Processor stage 要求配置 `processorConfigFile`，并且名称必须存在于该 registry。direct stage 不引用 registry。多个 route 与两个方向可以引用同一个 Processor。

### 配置示例

`examples/` 提供 direct / direct route 模板：

- [Tool config](../examples/tool-config.example.json)
- [custom-only Tool definition](../examples/tool-definition.example.json)
- [External routing config](../examples/external-routing-config.example.json)
- [Processor registry](../examples/processor-config.example.json)
- [HTTP endpoint config](../examples/http-endpoint-config.example.json)

模板中的 `external_echo` 是 custom-only definition，`read_file` 是 built-in override。route 绑定 `external-echo` definition reference id，而 canonical request 使用 `external_echo` Tool name。使用模板前应替换本地绝对路径和 endpoint URL。

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

registry 不拥有 endpoint 或 routing strategy。未被 route 使用的 registry 或 Processor definition 合法，但显式引用的 registry 仍会在启动期完整校验。

---

## HTTP endpoint config v1

endpoint config 顶层只允许下列字段：

| 字段 | 类型 | 必填 | 约束 |
|-|-|-|-|
| `version` | `1` | 是 | endpoint config schema version。 |
| `url` | string | 是 | absolute `http://` 或 `https://` URL，必须有 hostname；不允许 credentials 或 fragment。query 可以存在。 |
| `timeoutMs` | positive integer | 是 | 范围为 `1..2147483647`，覆盖该 endpoint 的完整 HTTP exchange。 |
| `headers` | object | 否 | static request headers；每个 value 必须是 string 并通过 Node.js HTTP header 校验。 |

`headers` 的名称按大小写不重复，且不能配置 transport-owned 或 hop-by-hop 字段：`Host`、`Content-Length`、`Content-Type`、`Content-Encoding`、`Accept-Encoding`、`Transfer-Encoding`、`Connection`、`Keep-Alive`、`TE`、`Trailer`、`Upgrade`、`Proxy-Authenticate`、`Proxy-Authorization`、`Proxy-Connection`。transport 为每次请求生成 `Content-Type` 与 `Content-Length`。

HTTPS 使用 Node.js 默认 TLS 行为，只信任运行环境认可的服务端证书。配置不支持自定义 CA、客户端证书、mTLS、TLS cipher/version 或关闭证书校验，也不会把 `https://` endpoint 降级为 HTTP。

---

## Catalog binding 与调用边界

catalog 以 Tool config definition reference `id` 接收 route-bound external executor：

- 未覆盖的 built-in Tool 使用 built-in definition、executor 与 implementation contract。
- built-in override 使用 custom definition 的对外 schema，但保留 built-in executor 和 implementation contract。
- custom-only definition 有 route 时绑定对应 external executor；没有 route 时绑定 unavailable executor。

所有 definition、route、Processor 和 endpoint artifact 都在 exposure 过滤之前加载与校验。随后 compiler 构建 effective catalog，校验 workspace `enabled` / `disabled` selector，并派生 exposed catalog。隐藏 Tool 不会绕过 exposure 到达 external executor。

external invocation 只接收 invocation call id、Tool name、已校验 arguments 和 caller `AbortSignal`，不接收 `ToolRuntimeContext`、workspace roots 或本地文件访问能力。

---

## Canonical protocol 与 stage 编排

每次有效调用被构造成一个单调用 canonical request。route 的 request stage 产生最终 HTTP request entity；HTTP `POST` 交换使用该 route 的 endpoint snapshot；response stage 将 endpoint result 转换为项目标准 `ToolCallResult`。

canonical request 是只含一个 call 的 JSON object：`calls` 是长度为一的数组，call 含 `id`、`name` 和 object 类型 `arguments`；可选 `extensions` 只接受非空、非 `custom-mcp` namespace 的 object 值。`id` 使用 MCP invocation call id，`name` 使用 Tool definition 的 MCP name，`definitionId` 不进入 canonical protocol。

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

HTTP transport 始终使用 `POST`，不自动解压 response entity，不跟随 redirect。`direct` 与 `canonical-filter` response stage 要求有效的 `application/json` content type（charset 缺省或 UTF-8）以及缺省或 `identity` content encoding。`body-decoder` 可根据经校验的 response representation metadata 处理 body。HTTP `2xx` 可以携带任一合法 canonical response；`4xx` / `5xx` 只能携带 canonical `error` response，其他状态范围和 `3xx` 都不会产生确认结果。

canonical JSON 使用严格 UTF-8，Processor canonical output 不允许 BOM。所有 canonical message 拒绝未知字段、非 JSON 值、循环结构、accessor、symbol 与非标准 prototype。filter 输出不会补回它省略的 extensions。

---

## 共享资源、容量、失败与取消

有至少一条 route 时，workspace 创建一个共享 external runtime：

- 所有 route 共用最多 8 个 active exchange 和 64 个 FIFO pending exchange；第 65 个 pending 调用返回 `external_capacity_exceeded`，不会启动 Processor 或 HTTP request。
- active slot 直到 exchange 的 `drained` 完成后释放，而不是 caller-visible result `settled` 时释放。
- 每条 route 具有独立 immutable endpoint snapshot 和 stage adapter，但不会获得独立 capacity pool。
- 所有 route 共用一组 owner-scoped HTTP/HTTPS Agents；Agent 可按 origin 管理连接池，不使用或关闭 process-global Agent。
- 只要任一 route 使用 Processor stage，就创建一个共享 Processor runner 和一个共享 Processor registry。runner 进入 degraded cleanup state 后会拒绝后续 Processor admission；direct route 不调用该 runner。

字节与时间边界：

| 边界 | 限制 | 结果 |
|-|-|-|
| 最终 HTTP request entity | 50 MiB | 超限时不发送 HTTP request。 |
| HTTP response entity | 50 MiB | 对声明长度和实际接收字节都执行限制。 |
| Processor stdin | 50 MiB | 超限时不启动该 Processor。 |
| Processor stdout | 50 MiB | 超限后终止该 Processor。 |
| retained Processor stderr diagnostics | 1 MiB | 保留量受限；总字节数仍计量。 |
| endpoint / Processor `timeoutMs` | 各自 `1..2147483647` | HTTP 或 Processor timeout 结算为受控本地失败。 |

HTTP body 在 request stage 完成编码后检查；`body-encoder` 的结果也受 request limit。transport 使用背压分块写入，避免在一个 turn 中将大 body 全部放入 Node writable queue。

配置、canonical protocol、Processor、transport、timeout、容量与本地内部失败都映射为标准 `ToolCallResult` 错误。endpoint 的已校验 business result 也映射为标准结果：`completed` 为成功，`failed` / `cancelled` / canonical `error` 为 `isError: true`。完整结果映射见 [工具返回结果](TOOL-RESULTS.md)。

内部 failure classification 用于稳定诊断和受控错误构造：

| Classification | 语义 |
|-|-|
| `external_capacity_exceeded` | 8 个 active 和 64 个 pending exchange 都已占满；调用未启动外部工作。 |
| `external_request_too_large` | 最终 request body 超过 50 MiB；HTTP request 未发送。 |
| `external_transport_failed` | DNS、连接、TLS 或 HTTP stream 失败。 |
| `external_timeout` | route endpoint 的 HTTP exchange 超过其 `timeoutMs`。 |
| `external_response_too_large` | response body 超过 50 MiB。 |
| `external_protocol_failed` | HTTP metadata、UTF-8、JSON、canonical shape、call id 或 status contract 无效。 |
| `external_rejected` | endpoint 返回合法 canonical error。 |
| `external_tool_failed` | endpoint 返回合法 canonical result `failed`。 |
| `external_tool_cancelled` | endpoint 返回合法 canonical result `cancelled`；这是远端领域结果。 |
| `processor_failed` | Processor spawn、stdio、exit、signal、大小限制或输出 contract 失败。 |
| `processor_timeout` | Processor invocation 超过 `timeoutMs`。 |
| `external_internal_failed` | 统一调用管线捕获未建模的内部异常。 |
| `cancelled` | MCP caller cancellation 或 application shutdown 中止本地 exchange。 |

服务不自动重试外部调用，也不接受晚到结果。transport、timeout、response-side Processor timeout 和 caller cancellation 后，外部服务可能已经执行操作；调用方只能在该操作可安全重复时自行重试。

caller `AbortSignal` 会传递到 pending / active admission、Processor 和 HTTP transport。取消 queued 调用会移出 FIFO；取消 active 调用先结算为 `cancelled`，然后继续等待本地 drain。Processor 在 timeout 或取消时关闭 stdio、先向 direct child 发送 `SIGTERM`，再在有界等待后发送 `SIGKILL`；若 child 未确认关闭，runner 进入 degraded cleanup 并拒绝未来 Processor admission。

首次 `SIGINT` 或 `SIGTERM` 启动幂等 application shutdown：先停止 HTTP listener 与新 MCP session admission，再关闭已有 MCP session 以传播调用取消，然后调用 `LoadedApplicationRuntime.close()`。external runtime 停止新 admission、取消 pending work、abort active work 并等待 active exchange drain，随后关闭共享 Processor runner（存在时）和专用 HTTP/HTTPS Agents；最后关闭 logger。单个 MCP session 的 DELETE 或 transport close 只关闭该 session，不关闭 workspace external runtime。所有 application shutdown 调用复用同一个 completion promise。某个关闭阶段失败时仍继续执行后续阶段，最终以聚合错误报告；transport 在每个 active exchange 脱离本地 listener 后才销毁其 dedicated Agents，且不影响 process-global Agent。

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
      Tool: external_echo
      Request stages: body-encoder
      Response stages: body-decoder
      Endpoint: http://127.0.0.1:43120/external/v1/tool-calls
```

有 route 时，摘要按 route 声明顺序输出 definition id、Tool name、两个 stage mode 和 endpoint identity。endpoint identity 会剥离 URL query、credentials 与 fragment。摘要不输出 endpoint headers、Processor config path、endpoint config path、Processor executable path 或 argv。

Processor post-drain diagnostics 还会记录安全的 `route=<definitionId>` 与 `tool=<toolName>`，以及 role、Processor name、duration、byte counts、stderr truncation 和 cleanup state。诊断不包含 endpoint URL、header value、payload、executable path、argv、stdout 或 stderr text。诊断 sink 的异常或耗时不会改变调用结果或延迟资源 cleanup。

Processor 默认继承 process environment，但会先按 Windows 大小写不敏感规则删除 `CUSTOM_MCP_PROCESSOR_ROLE` 和全部 `CUSTOM_MCP_EXTERNAL_*` 名称变体，再注入本次 invocation 的保留变量：

| Variable | 注入范围与值 |
|-|-|
| `CUSTOM_MCP_PROCESSOR_ROLE` | 所有 Processor；值为 `request.canonical-filter`、`request.body-encoder`、`response.canonical-filter` 或 `response.body-decoder`。 |
| `CUSTOM_MCP_EXTERNAL_CALL_ID` | 所有 Processor；原 canonical request 的不透明 call id。 |
| `CUSTOM_MCP_EXTERNAL_HTTP_STATUS` | response Processor；最终 HTTP status 的十进制字符串。 |
| `CUSTOM_MCP_EXTERNAL_CONTENT_TYPE` | response Processor；存在时为校验后的 Content-Type，缺失时不设置。 |
| `CUSTOM_MCP_EXTERNAL_CONTENT_ENCODING` | response Processor；存在时为规范化后的 Content-Encoding，缺失时不设置。 |

Request Processor 不接收 response-only metadata。Response `body-decoder` 应使用 `CUSTOM_MCP_EXTERNAL_CALL_ID` 构造 canonical result id，即使目标私有协议不回显该 id。保留变量不包含 endpoint URL、认证 header、MCP session 或其它 response headers。

已通过 canonical protocol 校验的 endpoint `message` / `error.message` 是业务结果，会进入 MCP text result；它们不经过通用内容脱敏。配置 endpoint 和 Processor 的维护者应避免在这些业务文本中返回敏感信息。

---

## 维护入口与回归测试

| 区域 | 职责 | 主要测试 |
|-|-|-|
| `src/tools/custom-tool-config.ts` | Tool config v2、definition 加载与 External routing config 入口 | `test/tools/custom-tool-config.test.ts` |
| `src/runtime/startup-runtime.ts` | 纯配置 / catalog 校验、空 route 无资源运行时、共享 executor 创建和 shutdown | `test/runtime/startup-runtime.test.ts` |
| `src/runtime/application-lifecycle.ts` | listener、MCP session、external runtime 与 logger 的关闭顺序 | `test/runtime/application-lifecycle.test.ts` |
| `src/tools/catalog.ts` | definition-id external binding、unavailable binding、override 保持 built-in binding | `test/tools/tool-exposure.test.ts` |
| `src/tools/external-routing/config.ts` | External routing config、Processor registry、endpoint config、route / Processor binding | `test/external-routing/config.test.ts` |
| `src/tools/external-routing/canonical-protocol.ts` | canonical JSON contract 与 filter invariant | `test/external-routing/canonical-protocol.test.ts` |
| `src/tools/external-routing/strategy-adapter.ts` | route-specific stage 编排、status / protocol mapping、drain diagnostics | `test/external-routing/strategy-adapter.test.ts` |
| `src/tools/external-routing/http-transport.ts` | shared HTTP resources、endpoint snapshot、limits、metadata、failure / cancel / shutdown | `test/external-routing/http-transport.test.ts` |
| `src/tools/external-routing/processor-runner.ts` | subprocess limits、environment、termination 与 drain | `test/external-routing/processor-runner.test.ts` |
| `src/tools/external-routing/runtime.ts` | workspace 8 active / 64 pending admission、FIFO、cancel 与 close | `test/external-routing/runtime-lifecycle.test.ts` |
| `src/tools/external-routing/executor.ts` | route-bound facade、canonical-to-`ToolCallResult` mapping 与 shared resource close | `test/external-routing/executor.test.ts` |
| `test/runtime/external-routing-integration.test.ts` | selected workspace 到 MCP / loopback endpoint 的多 route custom-only 集成 | `test/runtime/external-routing-integration.test.ts` |
| `src/runtime/startup-logging.ts` | disabled / configured / enabled 启动摘要与 endpoint 脱敏 | `test/runtime/startup-logging.test.ts` |
| `src/runtime/application-diagnostics.ts` | Processor drain 的 route / Tool 安全诊断格式 | `test/runtime/application-diagnostics.test.ts` |
