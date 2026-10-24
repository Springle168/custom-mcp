# 外部路由运行时边界

Workspace external runtime 统一负责 HTTP / MCP route 的 admission、调用取消、资源 drain 与关闭。协议特有行为分别见 [HTTP route](http-route.md) 和 [MCP route](mcp-route.md)，配置字段见[配置专题](configuration.md)。

## 共享容量与资源所有权

至少存在一条 route 时，workspace 才创建共享 external runtime。HTTP 与 MCP 共用最多 **8 个 active exchange 和 64 个 FIFO pending exchange**；第 65 个 pending 调用返回 `external_capacity_exceeded`，不启动外部工作。

每个 exchange 分离 caller-visible `settled` 与资源生命周期 `drained`。Active slot 直到 `drained` 完成才释放，不能因结果、错误或取消已返回给 caller 就提前复用容量。结果映射失败也受此约束。

| 资源 | 所有权与共享边界 |
|-|-|
| HTTP endpoint / stage adapter | 每条 HTTP route 使用 immutable endpoint snapshot 与 route-specific stage adapter。 |
| HTTP/HTTPS Agents | HTTP route 共用一组 owner-scoped Agents，不使用或关闭 process-global Agent。 |
| Processor runner | 使用 Processor stage 时创建，共享显式 registry；direct HTTP 与 MCP route 不调用 runner。 |
| MCP connection manager / Client / session | 按 MCP server config real path 共享，归 workspace 所有；不与 HTTP route 共享 transport resource。 |

Tool 调用触发的 MCP connect 位于 admission 之后；后台 warm-up 不占用 Tool exchange slot。单个上游 session close 只取消该 session 的调用，不关闭共享 external runtime 或下游 session。

External invocation 只接收 invocation call id、Tool name、已校验 arguments 和 caller `AbortSignal`，不接收 `ToolRuntimeContext`、workspace roots 或本地文件访问能力。此边界限制 executor 输入，不把配置的本地 Processor 变成 sandbox。

## 字节与时间限制

| 边界 | 限制 | 结果 |
|-|-|-|
| 最终 HTTP request entity | 50 MiB | 超限不发送 HTTP request。 |
| HTTP response entity | 50 MiB | 对声明长度和实际接收字节都执行限制。 |
| Processor stdin | 50 MiB | 超限不启动 Processor。 |
| Processor stdout | 50 MiB | 超限后终止 Processor。 |
| retained Processor stderr diagnostics | 1 MiB | 保留量受限，总字节数仍计量。 |
| endpoint / Processor `timeoutMs` | 各自 `1..2147483647` | 分别覆盖 HTTP exchange / Processor invocation，超时结算为受控本地失败。 |
| MCP server `timeoutMs` | `1..2147483647` | initialize、连接 deadline 与每次普通 `tools/call` 使用；progress 不重置 timeout。 |

HTTP request body 在 request stage 编码完成后检查，body-encoder 输出同样受限。Transport 使用背压分块写入，避免一个 turn 内把大 body 全部放入 Node writable queue。

图片按 base64 后的 entity 字节计量，unknown 按 JSON entity 字节计量，不新增 per-block 上限，也不绕过 entity / Processor 限制。最终 MCP wire 大小不保证等于 HTTP entity 大小；这些 HTTP / Processor 字节上限不是 MCP route 的通用 entity 限制。

## 失败分类与重试边界

配置读取与 schema 校验失败阻止启动。调用期 canonical protocol、Processor、transport、timeout、容量及内部失败映射为标准 `ToolCallResult` 错误；已校验的业务结果则按各 route 契约返回。HTTP `completed` 为成功，`failed`、`cancelled` 和 canonical `error` 为 `isError: true`；MCP 下游 `isError: true` 保持为业务结果。

内部 classification 用于稳定诊断和受控错误构造：

| Classification | 语义 |
|-|-|
| `external_capacity_exceeded` | 8 active 与 64 pending 都已占满，未启动外部工作。 |
| `external_request_too_large` | HTTP 最终 request body 超过 50 MiB，未发送请求。 |
| `external_transport_failed` | DNS、连接、TLS 或 HTTP stream 失败。 |
| `external_timeout` | endpoint HTTP exchange 超过 `timeoutMs`。 |
| `external_response_too_large` | HTTP response body 超过 50 MiB。 |
| `external_protocol_failed` | HTTP metadata、UTF-8、JSON、canonical shape、call id 或 status contract 无效。 |
| `external_rejected` | endpoint 返回合法 canonical error。 |
| `external_tool_failed` | endpoint 返回合法 canonical result `failed`。 |
| `external_tool_cancelled` | endpoint 返回合法 canonical result `cancelled`，属于远端领域结果。 |
| `processor_failed` | Processor spawn、stdio、exit、signal、大小限制或输出 contract 失败。 |
| `processor_timeout` | Processor invocation 超过 `timeoutMs`。 |
| `mcp_connection_failed` | 未建立可用下游 MCP session。 |
| `mcp_capability_missing` | 下游未声明 `tools` capability。 |
| `mcp_call_failed` | 下游 `tools/call` 返回 JSON-RPC error。 |
| `mcp_timeout` | 下游 initialize 或普通调用超时。 |
| `mcp_protocol_failed` | 下游 MCP message / result 不符合协议。 |
| `mcp_result_unsupported` | 下游 result 超出项目 text/image 边界。 |
| `mcp_transport_failed` | 下游 MCP transport / session 交换失败。 |
| `external_internal_failed` | 统一调用管线捕获未建模内部异常。 |
| `cancelled` | Caller cancellation 或 application shutdown 中止本地 exchange。 |

HTTP 输出来源和 status 违约的精确分类见 [HTTP 协议失败归属](http-route.md#协议失败归属)。统一返回壳见[工具返回结果](../TOOL-RESULTS.md)。

服务不自动重试外部调用，也不接受晚到结果。Transport 失败、timeout、response-side Processor timeout 和 caller cancellation 后，外部服务可能已经执行操作；调用方只能在操作可安全重复时自行重试。

## 取消、终止与关闭

Caller `AbortSignal` 传递到 pending / active admission 和对应 route adapter。取消 queued 调用将其移出 FIFO；取消 active 调用先结算为 `cancelled`，再等待本地 drain。MCP request-specific HTTP body 与 cancellation notification 的 drain 见 [MCP 调用取消](mcp-route.md#调用取消与-drain)。

HTTP Processor timeout 或取消时，先关闭 stdio，向 direct child 发送 `SIGTERM`，有界等待后仍未退出则发送 `SIGKILL`。Child 未确认关闭时 runner 进入 degraded cleanup state，拒绝后续 Processor admission；direct HTTP 和 MCP route 不受 runner admission 状态影响。

External runtime 的关闭复用一个 completion promise：

1. 停止新 admission、取消 pending、abort active invocation，同时启动 MCP connection manager close。
2. Manager close 解除下游 HTTP lifecycle 的 drain barrier，避免等待 active drain 时阻塞自身清理。
3. Active drain 与 manager close 完成后，关闭 Processor runner（存在时）与专用 HTTP/HTTPS Agents。

已有下游 session best-effort 发送 DELETE，最多等待 5 秒；失败或超时仍关闭本地 Client / transport。

External close 在应用级 listener / session drain 之后、logger 关闭之前执行。应用全局顺序与失败隔离由[架构文档](../ARCHITECTURE.md#关闭与失败隔离)维护。

## 安全诊断与业务内容边界

日志格式与启动摘要示例见[启动与诊断日志](../logging/startup-and-diagnostics.md)，通用验证入口见[日志概览](../LOGGING.md#测试与人工验证)。外部路由新增诊断仅使用安全标识和计量信息，不回传底层原始异常。

启动摘要按 route 声明顺序关联 definition id、routing mode 与 Tool name。HTTP route 展示 stage mode 和 endpoint identity，MCP route 展示 server identity。URL identity 剥离 query、credentials 与 fragment；摘要不输出静态 headers、配置文件路径、Processor executable path 或 argv。

MCP manager diagnostic 按 server identity 记录 connected / failed、phase、classification 和 duration。Shared server 的一次 warm-up 只产生一次 outcome；诊断不含静态 header name/value、下游 request/session ID、arguments、result payload、下游 raw error 或 URL query。

Processor post-drain diagnostic 记录安全的 `route=<definitionId>`、`tool=<toolName>`，以及 role、Processor name、duration、byte counts、stderr truncation 和 cleanup state。不包含 endpoint URL、header value、payload、executable path、argv、stdout 或 stderr text。Diagnostic sink 的异常或耗时不改变调用结果，也不延迟资源 cleanup。

本地失败安全文本不包含 URL / query、header、raw body、stdout / stderr、executable path、argv 或底层异常。

这些保证不等于业务内容脱敏：endpoint 或 Processor 输出的合法 canonical content 与 `error.message` 按协议映射进入 MCP 结果，并可能进入既有 Tool result logger，不因来自外部 route 而脱敏或截断；content 包括文本、图片 base64 和 unknown 序列化后的 JSON。MCP 下游合法结果同样经过统一 result logger。

Canonical validation 与 unknown 文本化只提供数据和序列化安全，不提供内容脱敏、HTML 转义或指令过滤。配置 endpoint、下游 Server 和 Processor 的维护者负责避免在业务内容中返回敏感信息。

## 针对性验证

`npm test -- external-routing` 验证配置、canonical protocol、HTTP/Processor、MCP 和共享生命周期主题。修改 listener 后 warm-up、workspace 集成或应用关闭接线时，还需运行 `npm test -- runtime`；测试地图和通用验证要求分别见[项目结构](../PROJECT-STRUCTURE.md)与[测试](../TESTING.md)。
