# MCP Route

MCP route 以独立 MCP Client 调用配置的下游 Streamable HTTP Server，不使用 HTTP canonical wrapper、Processor 或下游 Tool discovery。Tool definition 与 server config 在启动期校验；下游连接和调用失败不使其它工具不可用。

配置字段、静态 header 与 real-path identity 规则见[配置专题](configuration.md#mcp-server-config-v1)。所有 route 共用的容量和 workspace 关闭见[运行时边界](runtime.md)。

## 下游共享与身份隔离

Workspace 按不同 MCP server config real path 维护 connection manager。一个 manager 共享一个 MCP Client、Streamable HTTP transport 和下游 session；多个 route、调用和上游 MCP session 可复用它。

上下游 request ID、session ID、initialize 和能力协商相互独立。下游 `tools/call` 只发送本地 Tool definition 的 `name` 与已校验 `arguments`，不发送 definition ID、本地 call ID、上游 session、workspace roots、上游请求 headers 或 canonical wrapper。

下游使用 server config 的静态 headers，不透传上游认证或请求头策略输入。Manager 不调用 `tools/list`，也不导入、映射或预先验证下游 Tool name。

## Warm-up 与连接恢复

HTTP listener listening 且启动摘要写出后，每个 server identity 接受一次非阻塞 warm-up。被 workspace exposure 隐藏的 MCP route 仍参与对应 identity 的 warm-up。

Manager 采用 single-flight initialize，并检查下游声明的 `tools` capability。同期 waiter 共享同一次连接；单个 waiter 取消不会终止共享 initialize。

连接失败后 manager 回到 idle 并输出安全 diagnostic，不阻止 listener 或其它工具工作；后续 Tool 调用可再次按需连接。Transport 或 session 无效时废弃连接，后续调用建立新 session；已发送调用不自动重试。

连接与调用 timeout 由 [server config](configuration.md#mcp-server-config-v1)约束。Tool 调用引起的 connect 消耗已获得的 active slot，后台 warm-up 不占用 Tool exchange slot。

## 下游结果边界

合法下游 `CallToolResult` 保留项目支持的字段，包括 text/image content、annotations、`_meta` 与 `structuredContent`。省略的 `isError` 归一化为 `false`；`isError: true` 保持为业务结果，不作为连接失败处理。

JSON-RPC、timeout、连接、transport 或协议错误转换为本地稳定的 `isError: true` Tool result。Audio、resource、resource link 和其它不满足项目统一 text/image 边界的内容不会被截断，也不会被转成文本返回。HTTP canonical 的图片与 unknown wire 规则不适用于此 route。

结果仍经过[统一结果验证](../TOOL-RESULTS.md)、[request policy](../REQUEST-HEADER-POLICY.md) 和 Tool-call/result logger。失败分类见[运行时分类表](runtime.md#失败分类与重试边界)；下游 raw error data 不进入新增 MCP diagnostic。

## 调用取消与 drain

MCP `tools/call` 使用独立下游 request ID。Caller cancellation 通过 route-owned signal 触发 SDK cancellation notification，不复用上游 ID，也不重试调用。

已结算调用继续占据 active slot，直到 request-specific HTTP body 和 cancellation notification 完成 HTTP lifecycle drain。Connection manager 的 transport close 是 shutdown 时的最终 drain barrier，不能只等待 caller-visible result。

单个上游 session close 只取消该 session 的调用，不关闭 workspace-owned 下游 session。Workspace close 才关闭 manager，并对已有下游 session best-effort 发送 DELETE；5 秒终止窗口及与 active drain 的协调见[运行时关闭](runtime.md#取消终止与关闭)。

连接 diagnostic 的安全标识、允许字段与禁止泄漏项见[安全诊断](runtime.md#安全诊断与业务内容边界)，日志格式见[下游 MCP 诊断](../logging/startup-and-diagnostics.md#下游-mcp)。
