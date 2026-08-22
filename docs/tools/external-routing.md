# External Routing

`processorConfigFile` 为 selected workspace 的 custom-only Tool 提供共享的外部执行 route。每次有效调用被转换为单调用 canonical request，并按配置经过可选 Processor、一个 HTTP `POST` 交换和可选响应 Processor，最后转换为项目标准 `ToolCallResult`。

本机制不为 built-in Tool 增加 HTTP route，也不改变同名 custom override 的内置 executor。它面向已配置且受信任的本地 Processor 与外部 endpoint；运行期不重新读取任何 route 配置文件。

---

## 启用边界与加载顺序

入口位于 selected workspace 的 `tools.toolConfigFile`。该 Tool config 可选字段 `processorConfigFile` 指向 Processor config；Processor config 再以 `httpEndpointConfigFile` 指向 endpoint config。

```text
workspace tools.toolConfigFile
  └─ Tool config: processorConfigFile
       └─ Processor config: httpEndpointConfigFile
            └─ HTTP endpoint config
```

三份文件都在启动期读取、严格校验并冻结为 route snapshot。启动不探测 endpoint，也不发送 HTTP 请求。任何引用文件的读取、JSON 或字段错误都使启动失败，并将 `ConfigError.configFilePath` 指向实际出错文件；字段错误同时携带 field path。修改 Tool config、Processor config 或 endpoint config 后需要重启服务。

`processorConfigFile` 必须是无首尾 whitespace 的本地绝对路径，遵循 Tool config 的路径 policy：Windows 下只接受 drive-absolute 路径，不接受相对、UNC、namespace、drive-relative、rooted-without-drive 或 `~` 路径。它不要求位于 workspace allowed roots 内。

存在 `processorConfigFile` 时，Tool config 至少必须含有一个名称不属于 built-in registry 的 custom-only definition；否则启动失败。一个 workspace 只创建一个共享 external executor，所有 custom-only definition 共用该 executor。custom-only definition 仍先通过其 configured input schema，再进入外部 route。被隐藏的 custom-only definition 虽会参与启动期加载和绑定，但不在 `tools/list` 暴露，也不能调用。

custom definition 覆盖 built-in 名称时，仍绑定 built-in executor，并继续满足 configured schema 与 built-in implementation schema；它不会进入 external route。没有 `processorConfigFile` 的 custom-only definition 保持可列出、可校验但不可执行的 deterministic unavailable route。

Tool config 的基础结构、definition schema 和 exposure selector 见 [自定义 Tool 配置](../config/tool-config.md)。

---

## 配置 schema

所有 schema version 均为 JSON number `1`，外壳拒绝未知字段。

### Tool config 扩展

| 字段 | 类型 | 必填 | 说明 |
|-|-|-|-|
| `processorConfigFile` | local absolute path | 否 | Processor config 文件；出现时启用 external routing 的启动期加载和 binding。 |

`processorConfigFile` 只补充原有 Tool config；`version` 与 `definitions` 仍为必填字段。

### Processor config

Processor config 顶层字段如下，四项全部必填：

| 字段 | 类型 | 说明 |
|-|-|-|
| `version` | `1` | Processor config schema 版本。 |
| `httpEndpointConfigFile` | local absolute path | endpoint config 文件。 |
| `processors` | object[] | 有序 Processor 定义；request / response 都为 `direct` 时可以为空数组。 |
| `routingStrategy` | object[] | 必须恰好含有一个 request direction 和一个 response direction。 |

每个 `processors[]` object 只允许下列字段：

| 字段 | 类型 | 约束 |
|-|-|-|
| `name` | string | 匹配 `^[A-Za-z0-9._-]{1,128}$`，且在该文件内唯一。 |
| `executable` | object | 见下方 executable union。 |
| `arguments` | string[] | 原样作为 subprocess argv 传入。 |
| `workingDirectory` | existing local absolute directory | Processor 的工作目录。 |
| `timeoutMs` | positive integer | 范围为 `1..2147483647`。 |

`executable` 是严格 union：

| `resolution` | 其余字段 | 约束 |
|-|-|-|
| `absolute-path` | `path` | existing regular file 的本地绝对路径。 |
| `path-search` | `command` | 不含 `/`、`\` 或 Windows drive prefix 的 bare command name；由操作系统 PATH 搜索。 |

Processor name 必须被某个非 `direct` routing strategy 引用；未引用 Processor 或引用不存在名称都使启动失败。

### Endpoint config

endpoint config 顶层只允许下列字段：

| 字段 | 类型 | 必填 | 约束 |
|-|-|-|-|
| `version` | `1` | 是 | endpoint config schema 版本。 |
| `url` | string | 是 | absolute `http://` 或 `https://` URL，必须有 hostname；不允许 credentials 或 fragment。query 可以存在。 |
| `timeoutMs` | positive integer | 是 | 范围为 `1..2147483647`，覆盖整个 HTTP exchange。 |
| `headers` | object | 否 | static request headers；每个 value 必须是 string 并通过 Node.js HTTP header 校验。 |

`headers` 的名称按大小写不重复，且不能配置 transport-owned 或 hop-by-hop 字段：`Host`、`Content-Length`、`Content-Type`、`Content-Encoding`、`Accept-Encoding`、`Transfer-Encoding`、`Connection`、`Keep-Alive`、`TE`、`Trailer`、`Upgrade`、`Proxy-Authenticate`、`Proxy-Authorization`、`Proxy-Connection`。transport 为每次请求生成 `Content-Type` 与 `Content-Length`。

---

## Routing strategy 与 canonical protocol

`routingStrategy` 的每个 object 包含 `strategy` 与 `mode`，并按 strategy / mode 使用严格字段集合：

| 方向 | `mode` | 额外字段 | 行为 |
|-|-|-|-|
| `request-to-external` | `direct` | 无 | 直接发送 canonical request UTF-8 JSON，`Content-Type` 为 `application/json; charset=utf-8`。 |
| `request-to-external` | `canonical-filter` | `processor` | Processor stdin / stdout 都是 canonical request JSON；输出是完整替换消息，必须保留原 call id。 |
| `request-to-external` | `body-encoder` | `processor`、`contentType` | Processor 将 canonical request bytes 编码为 HTTP body；`contentType` 必须是可安全写入 HTTP `Content-Type` 的有效 media type。 |
| `response-from-external` | `direct` | 无 | endpoint body 必须是 canonical response JSON。 |
| `response-from-external` | `canonical-filter` | `processor` | 先校验 endpoint canonical response，再由 Processor 输出完整替换 canonical response；输出必须保留 response kind 和 result id。 |
| `response-from-external` | `body-decoder` | `processor` | Processor 接收 raw endpoint body，并负责生成 canonical response。 |

每个方向恰好一个；重复或缺少任一方向都会使配置加载失败。`processor` 是已定义 Processor name。

canonical request 是只含一个 call 的 JSON object：`calls` 是长度为一的数组，call 含 `id`、`name` 和 object 类型 `arguments`；可选 `extensions` 只接受非空、非 `custom-mcp` namespace 的 object 值。canonical response 只允许两种形状之一：

- `results`：长度为一的数组，result 的 `id` 必须与原 call id 相同，`status` 为 `completed`、`failed` 或 `cancelled`，并有 string `message`；
- `error`：有 non-empty string `code` 和 string `message`。

canonical JSON 使用严格 UTF-8，Processor canonical output 不允许 BOM。所有 canonical message 拒绝未知字段、非 JSON 值、循环结构、accessor、symbol 与非标准 prototype。filter 输出不会补回它省略的 extensions。

HTTP transport 始终使用 `POST`，不自动解压 response entity，不跟随 redirect。`direct` 与 `canonical-filter` response mode 要求一个有效的 `application/json` content type（charset 缺省或 UTF-8）以及缺省或 `identity` content encoding。`body-decoder` 允许 Processor 根据经校验的 response representation metadata 处理 body。HTTP `2xx` 可以携带任一合法 canonical response；`4xx` / `5xx` 只能携带 canonical `error` response，其他状态范围和 `3xx` 都不会产生确认结果。

---

## 并发、限制、失败与取消

### Admission 与容量

每个 workspace external executor 固定最多同时保有 8 个 active exchange，以及 64 个 FIFO pending exchange。第 65 个 pending 调用立即返回 `external_capacity_exceeded`，不会启动 Processor 或 HTTP request。pending 调用在取得 active slot 前也不会启动外部工作。

active slot 直到该 exchange 的 `drained` 完成后才释放，而不是在 caller-visible result `settled` 时释放。这样 timeout、取消和失败后的本地清理不会与后续 replacement work 重叠。

### 字节与时间限制

| 边界 | 限制 | 结果 |
|-|-|-|
| 最终 HTTP request entity | 50 MiB | 超限时不发送 HTTP request。 |
| HTTP response entity | 50 MiB | 对声明长度和实际接收字节都执行限制。 |
| Processor stdin | 50 MiB | 超限时不启动该 Processor。 |
| Processor stdout | 50 MiB | 超限后终止该 Processor。 |
| retained Processor stderr diagnostics | 1 MiB | 保留量受限；总字节数仍计量。 |
| endpoint / Processor `timeoutMs` | 各自 `1..2147483647` | HTTP 或 Processor timeout 结算为受控本地失败。 |

HTTP body 在 request strategy 完成编码后检查；body-encoder 的结果也受该限制。transport 使用背压分块写入，避免在一个 turn 中将大 body 全部放入 Node writable queue。

### 失败、重试与取消语义

配置、canonical protocol、Processor、transport、timeout、容量与本地内部失败都映射为标准 `ToolCallResult` 错误，包含稳定的可操作文本。endpoint 的已校验 business result 也映射为标准结果：`completed` 为成功，`failed` / `cancelled` / canonical `error` 为 `isError: true`。

服务不会自动重试外部调用，也不会接受晚到结果。transport、timeout、Processor response-side timeout 和 caller cancellation 后，外部服务可能已经执行操作；调用方只能在该操作可安全重复时自行重试。

caller `AbortSignal` 会传递到 queued / active admission、Processor 和 HTTP transport。取消 queued 调用会移出 FIFO；取消 active 调用先结算为 `cancelled`，然后继续等待其本地 drain。Processor 在 timeout 或取消时关闭 stdio、先向 direct child 发送 `SIGTERM`，再在有界等待后发送 `SIGKILL`；若 child 仍未确认关闭，runner 进入降级 cleanup 并拒绝未来 Processor admission。

### Shutdown

首次 `SIGINT` 或 `SIGTERM` 启动幂等 application shutdown：先停止 HTTP listener 与新 MCP session admission，再关闭已有 MCP session 以传播调用取消，然后调用 `LoadedApplicationRuntime.close()`。External runtime 停止新 admission、取消 pending work、abort active work并等待 active exchange drain，随后关闭 Processor runner 和专用 HTTP/HTTPS Agents；最后关闭 logger。单个 MCP session 的 DELETE 或 transport close 只关闭该 session，不关闭共享 external runtime。

所有 application shutdown 调用复用同一个 completion promise。某个关闭阶段失败时仍继续执行后续阶段，最终以聚合错误报告；transport 在每个 active exchange 脱离本地 listener 后才销毁其 dedicated Agents，且不影响 process-global Agent。

---

## 日志与敏感信息边界

启动摘要只输出 external routing 的 enabled / disabled 状态、request mode、response mode 和 endpoint identity。endpoint identity 会剥离 URL query、credentials 和 fragment；摘要不输出 endpoint headers、Processor config path、endpoint config path、Processor executable path 或 argv。

transport / runner 的本地失败只以受控 failure code 和 caller 文本离开模块，不携带 endpoint URL、header value、entity bytes 或 Node.js exception。Processor post-drain diagnostics 只含 role、Processor name、duration、byte counts、stderr truncation 和 cleanup state；不含 executable path、argv、stdout、stderr text 或 stdin bytes。诊断 sink 的异常或耗时不会改变调用结果或延迟资源 cleanup。

Processor 默认继承 process environment，但会先按大小写删除 `CUSTOM_MCP_PROCESSOR_ROLE` 和全部 `CUSTOM_MCP_EXTERNAL_*`，再仅注入 role、call id，以及 response Processor 所需的 HTTP status、content type、content encoding。request Processor 不接收 response-only metadata。

已通过 canonical protocol 校验的 endpoint `message` / `error.message` 是业务结果，会进入 MCP text result；它们不经过通用内容脱敏。配置 endpoint 和 Processor 的维护者应避免在这些业务文本中返回敏感信息。

---

## 维护入口与回归测试

| 区域 | 职责 | 主要测试 |
|-|-|-|
| `src/tools/custom-tool-config.ts` | Tool config 的 `processorConfigFile` 加载与 route snapshot 组合 | `test/tools/custom-tool-config.test.ts` |
| `src/runtime/startup-runtime.ts` | custom-only 前置条件、共享 executor 创建和 runtime close | `test/runtime/startup-runtime.test.ts` |
| `src/runtime/application-lifecycle.ts` | listener、MCP session、external runtime 与 logger 的关闭顺序 | `test/runtime/application-lifecycle.test.ts` |
| `src/tools/catalog.ts` | custom-only external binding、override 保持 built-in binding | `test/tools/tool-exposure.test.ts` |
| `src/tools/external-routing/config.ts` | Processor / endpoint config schema、路径和引用校验 | `test/external-routing/config.test.ts` |
| `src/tools/external-routing/canonical-protocol.ts` | canonical JSON contract 与 filter invariant | `test/external-routing/canonical-protocol.test.ts` |
| `src/tools/external-routing/strategy-adapter.ts` | mode 编排、status / protocol mapping、drain diagnostics | `test/external-routing/strategy-adapter.test.ts` |
| `src/tools/external-routing/http-transport.ts` | HTTP limits、metadata、failure / cancel / shutdown | `test/external-routing/http-transport.test.ts` |
| `src/tools/external-routing/processor-runner.ts` | subprocess limits、environment、termination 与 drain | `test/external-routing/processor-runner.test.ts` |
| `src/tools/external-routing/runtime.ts` | 8 active / 64 pending admission、FIFO、cancel 与 close | `test/external-routing/runtime-lifecycle.test.ts` |
| `src/tools/external-routing/executor.ts` | canonical-to-`ToolCallResult` mapping 与 shared resource close | `test/external-routing/executor.test.ts` |
| `test/runtime/external-routing-integration.test.ts` | selected workspace 到 MCP / loopback endpoint 的完整 custom-only route | `test/runtime/external-routing-integration.test.ts` |
| `src/runtime/startup-logging.ts` | 安全启动摘要 formatter | `test/runtime/startup-logging.test.ts` |
