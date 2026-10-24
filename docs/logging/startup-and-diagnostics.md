# 启动摘要与外部资源诊断

本文维护启动配置摘要、下游 MCP 与 Processor 诊断的输出格式。公共输出规则与验证入口见[日志概览](../LOGGING.md)；外部资源机制与安全字段边界由[外部路由运行时](../external-routing/runtime.md)维护。

## 启动配置摘要

HTTP server 开始监听后，`src/runtime/application/start-application.ts` 输出 selected workspace 的启动配置摘要。完整摘要由 `src/runtime/application/startup-logging.ts` 的 `formatApplicationStartupLines()` 生成，包含监听地址、workspace / 配置文件标识、allowed roots、文件访问策略、external routing、行尾符和日志文件位置。

### 文件访问策略

文件访问策略部分使用 `RuntimeConfigSnapshot.fileAccessPolicyFiles`，按 primary / additional root 分组列出已验证的 resolved lexical 策略文件引用：

```text
  File access policies:
    Primary root: E:\Workspace
      Ignore files:
        - C:\Policies\project.ignore
      Deny files:
        - C:\Policies\project.deny
    Additional root: E:\AdditionalWorkspace
      Ignore files: none
      Deny files:
        - C:\Policies\additional.deny
```

策略文件路径保持配置顺序和重复引用，不排序或去重。日志不输出策略文件内容、matcher 内容或 symbolic link 的 real target。所有 allowed root 均未配置 ignore / deny 文件时，摘要输出 `File access policies: none`。启动时只读取和编译 selected workspace 的策略，启动摘要也只包含该 workspace。

### 外部路由状态

external routing 摘要由 `formatExternalRoutingStartupLines()` 生成。Tool config 未配置 `externalRoutingConfigFile` 时输出 `External routing: disabled`。External routing config 存在但 `routes` 为空时输出 configured 状态与 route 数量：

```text
  External routing: configured
    Routes: 0
```

有 route 时，摘要输出 enabled 状态、总数与按声明顺序排列的 route。HTTP route 展示 stages 与 endpoint，MCP route 展示 server identity：

```text
  External routing: enabled
    Routes: 2
    Route: external-echo
      Routing mode: http
      Tool: external_echo
      Request stages: direct
      Response stages: canonical-filter
      Endpoint: https://external.example.invalid/tool
    Route: downstream-echo
      Routing mode: mcp
      Tool: downstream_echo
      Server: https://mcp.example.invalid/mcp
```

Endpoint/server identity 的脱敏与禁止输出项见[外部路由诊断边界](../external-routing/runtime.md#安全诊断与业务内容边界)。配置摘要不代表下游连接已经成功；MCP warm-up 在摘要写出后非阻塞执行。

## 外部资源诊断

### 下游 MCP

下游 MCP manager 的连接成功与失败使用独立日志。失败前缀按 phase 区分 connection、call 和 shutdown：

```text
Downstream MCP connected: server=https://mcp.example.invalid/mcp durationMs=12
Downstream MCP connection failed: server=https://mcp.example.invalid/mcp phase=initialize classification=mcp_connection_failed durationMs=12
Downstream MCP call failed: server=https://mcp.example.invalid/mcp phase=call classification=mcp_call_failed durationMs=12
Downstream MCP shutdown failed: server=https://mcp.example.invalid/mcp phase=shutdown classification=mcp_transport_failed durationMs=12
```

共享 server 的一次 warm-up 只记录一次 outcome，不逐 route 重复记录。连接共享、恢复与取消见 [MCP route](../external-routing/mcp-route.md)。

### Processor

Processor post-drain 日志使用以下字段：

```text
External Processor drain: route=external-echo tool=external_echo role=response.canonical-filter processor=response-filter cleanupFailed=false settledMs=10 drainMs=12 stdinBytes=120 stdoutBytes=140 stderrBytes=0 stderrCapturedBytes=0 stderrTruncated=false
```

这些诊断记录计量和清理结果，不记录原始 subprocess 内容；允许字段、敏感信息和业务内容的区别由[外部路由运行时](../external-routing/runtime.md#安全诊断与业务内容边界)维护。
