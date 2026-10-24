# 日志系统开发说明

本文记录 `custom-mcp` 的日志输出位置、格式、颜色高亮和扩展方式。

---

## 输出位置

- **终端（stdout）**：实时查看，带颜色高亮。
- **日志文件**：默认写入 `~/.custom-mcp/logs/YYYY/MM/DD/<workspace-id>_YYYY-MM-DD_HH-MM-SS.log`，每次启动按系统本地时区生成新文件，纯文本格式。

日志根目录来自启动期 `RuntimeConfigSnapshot.logsDir`，必须是已存在的本地绝对目录。来源可以是默认目录、workspace `logsDir` 或获 allowlist 授权的 `MCP_LOGS_DIR`；字段与覆盖校验见 [workspace 配置](config/workspace-config.md#环境变量覆盖)。

`Logger` 构造时再次确认根目录存在且为目录，再创建本地时区对应的 `YYYY/MM/DD/` 子目录和日志文件。文件名前缀直接使用 selected workspace id，其 grammar 由[全局索引](config/global-index.md#schema)约束。

---

## 日志格式

```text
────────────────────────────────
[2025-01-15T22:30:00.000+08:00] ← CALL replace_text
  Session: session_13a09d50-0000-4000-8000-000000000000
  Call ID: call_7c2c62a1-0000-4000-8000-000000000000
  {
    "files": [
      {
        "file_path": "src/index.ts",
        "replacements": [
          {
            "target": "const port = 3000;",
            "replacement": "const port = 3100;"
          }
        ]
      }
    ]
  }
[2025-01-15T22:30:00.050+08:00] → OK replace_text (50ms)
  Session: session_13a09d50-0000-4000-8000-000000000000
  Call ID: call_7c2c62a1-0000-4000-8000-000000000000
  {"success":true,"files":[{"success":true,"file_path":"src/index.ts","match_mode":"default","allow_multiple":false,"replacements":[{"success":true,"matched_targets":1,"replacement_count":1,"matched_span":{"start_line":10,"end_line":10},"replacement_line_count":1,"file_line_count":{"previous":120,"current":120}}]}]}
```

### 工具结果正文

`Logger.logToolResult()` 只格式化 `ToolCallResult.content`，不序列化整个结果。文本块直接输出 `text`；图片块输出独立的 `[image <mimeType>]` 标记，下一行输出完整的 `data` 裸 base64。非空块按 `content` 的顺序以换行分隔，连续图片各有自己的标记，纯图片结果也有 RESULT 正文。

例如，下方 `<完整图片 base64>` 表示实际日志中未经截断的图片数据：

```text
[2025-01-15T22:30:00.050+08:00] → OK generate_preview (50ms)
  Session: session_13a09d50-0000-4000-8000-000000000000
  Call ID: call_7c2c62a1-0000-4000-8000-000000000000
  Generated preview:
  [image image/png]
  <完整图片 base64>
  Generation completed.
```

Logger 不解码图片来计算大小，不截断、摘要或脱敏 base64。顶层 `_meta` 和 `structuredContent` 不进入 RESULT 正文；即使命中 `structuredContentDup`，也只记录一次顶层 `content`。

完整 base64 与工具参数、文本结果一样写入本机 stdout 和日志文件；输出图片的 Tool 应考虑日志体积和数据敏感性。结果契约与字段覆盖语义见 [docs/TOOL-RESULTS.md](TOOL-RESULTS.md)，两阶段策略与隐私边界见 [请求头策略](REQUEST-HEADER-POLICY.md)。

### 启动配置摘要

HTTP server 开始监听后，`src/runtime/application/start-application.ts` 输出 selected workspace 的启动配置摘要。完整摘要由 `src/runtime/application/startup-logging.ts` 的 `formatApplicationStartupLines()` 生成，包含监听地址、workspace / 配置文件标识、allowed roots、文件访问策略、external routing、行尾符和日志文件位置。

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

Endpoint/server identity 的脱敏与禁止输出项见[外部路由诊断边界](external-routing/runtime.md#安全诊断与业务内容边界)。配置摘要不代表下游连接已经成功；MCP warm-up 在摘要写出后非阻塞执行。

### 外部资源诊断

下游 MCP manager 的连接成功与失败使用独立日志。失败前缀按 phase 区分 connection、call 和 shutdown：

```text
Downstream MCP connected: server=https://mcp.example.invalid/mcp durationMs=12
Downstream MCP connection failed: server=https://mcp.example.invalid/mcp phase=initialize classification=mcp_connection_failed durationMs=12
Downstream MCP call failed: server=https://mcp.example.invalid/mcp phase=call classification=mcp_call_failed durationMs=12
Downstream MCP shutdown failed: server=https://mcp.example.invalid/mcp phase=shutdown classification=mcp_transport_failed durationMs=12
```

共享 server 的一次 warm-up 只记录一次 outcome，不逐 route 重复记录。连接共享、恢复与取消见 [MCP route](external-routing/mcp-route.md)。

Processor post-drain 日志使用以下字段：

```text
External Processor drain: route=external-echo tool=external_echo role=response.canonical-filter processor=response-filter cleanupFailed=false settledMs=10 drainMs=12 stdinBytes=120 stdoutBytes=140 stderrBytes=0 stderrCapturedBytes=0 stderrTruncated=false
```

这些诊断记录计量和清理结果，不记录原始 subprocess 内容；允许字段、敏感信息和业务内容的区别由[外部路由运行时](external-routing/runtime.md#安全诊断与业务内容边界)维护。

### Session 与 Call ID

MCP session ID 是服务端生成的实际协议 ID，格式为 `session_<uuid>`。同一 session 的后续请求通过该值关联 transport、server 和工具日志。

每次进入统一 `tools/call` handler 时生成独立的日志关联 ID，格式为 `call_<uuid>`。同一次调用的 CALL 与 RESULT 日志使用相同 call ID；同一 session 内并发调用相同工具时，可通过 call ID 准确配对日志。

CALL 与 RESULT 都固定输出 `Session:` 和 `Call ID:`。若工具调用路径没有可用的 transport session ID，session 行明确输出：

```text
  Session: unavailable (session ID missing)
```

call ID 由服务端工具调用入口生成，不复用客户端提供的 JSON-RPC request ID。

### 请求头策略日志

初始化策略使用独立会话摘要，不写入工具结果日志。工具结果的 `Rules:` 元信息只由 `rules.requestHeaders.onCallToolResult` 控制；仅配置初始化规则时，不给工具结果增加此行。跨层参数、生命周期与隐私契约见 [请求头策略](REQUEST-HEADER-POLICY.md)。

#### 初始化会话摘要

会话成功发布后，`mcp-post-handler.ts` 通过安全的 `info` 调用写入 `New session: <session-id>`，随后触发初始化准备阶段提供的发布观察。请求头策略观察在存在初始化绑定时写入独立摘要：

```text
[2026-10-21T10:20:30.000+08:00] Session policy:
  Session: session_13a09d50-0000-4000-8000-000000000000
  Applied:
    rules.requestHeaders.onInitialize[0]: setToolList
    rules.requestHeaders.onInitialize[1]: setInstructions
```

绑定存在但请求中对应 header 全缺失时，输出 `Applied: none`。显式空 toolList 或 instructions 仍列出对应功能；无初始化绑定时不写 `Session policy:`。

客户端参数失败发生在会话资源构造之前，安全摘要例如：

```text
Initialize policy rejected: rules.requestHeaders.onInitialize[0]; invalid_json
```

失败摘要只包含规则位置与分类，不包含原始 JSON、异常、header name/value 或临时 SDK session ID。初始化日志失败与握手、发布和资源清理隔离，不能触发重复响应。

#### 工具结果元信息

当 selected workspace 的 `rules.requestHeaders.onCallToolResult` 非空时，每条成功记录的工具响应日志都会在状态行之后、结果正文之前输出一行 `Rules:` 元信息。

命中规则时，文件日志格式为：

```text
[2026-07-05T10:20:30.000+08:00] → OK read (12ms)
  Session: session_13a09d50-0000-4000-8000-000000000000
  Call ID: call_7c2c62a1-0000-4000-8000-000000000000
  Rules: matched rules.requestHeaders.onCallToolResult[0]; enabled structuredContentDup
  Succeeded.
```

多条规则命中时，规则位置按 policy 输出顺序稳定列出，例如：

```text
  Rules: matched rules.requestHeaders.onCallToolResult[0], rules.requestHeaders.onCallToolResult[1]; enabled structuredContentDup
```

配置了结果阶段规则但未命中时，输出：

```text
  Rules: no match
```

结果阶段规则为空时，不输出 `Rules:` 行。`Rules:` 行是响应日志元信息，不写入 `ToolCallResult.content` 或 `structuredContent`。

请求头策略根据结果阶段脱敏 metadata 格式化 `fileText` / `consoleText` 摘要，Logger 只负责在固定位置缩进并输出，不解释规则或 feature。摘要 supplier 在受保护的 RESULT 日志路径中求值，格式化或写入失败不影响有效适配和返回结果。

响应摘要不记录请求或配置的 header name/value、原始 header 列表或匹配字符串。初始化参数不进入结果摘要。阶段契约和捕获时序见 [请求头策略](REQUEST-HEADER-POLICY.md#内部阶段扩展点)。

---

## 颜色高亮

终端输出使用多种颜色区分不同信息类型（时间戳、调用方向、工具名、状态等），提升可读性。`Rules:` 响应元信息会高亮 `Rules:` 前缀、命中状态和 enabled feature。每次工具调用前会输出分隔线，便于区分不同调用。

**JSON 语法高亮**：参数和结果中的 JSON 内容会进行语法着色（键名、字符串、数字、布尔值等使用不同颜色）。当 JSON 内容超过 50KB 时，自动降级为无高亮输出以保证性能。

日志文件保持纯文本格式（无 ANSI 转义码），便于工具处理和长期存档。

---

## 调用日志接线

统一 `tools/call` 入口生成 call ID 并调用 `Logger.logToolCall()` / `logToolResult()`；session ID 来自 SDK 调用 metadata。工具 handler 不自行记录 CALL/RESULT，也不接收 Logger 能力。

阶段实现提供安全日志摘要，通用 Logger 负责格式和输出，不解释请求头或外部协议。日志及 diagnostic 的失败隔离见[系统架构](ARCHITECTURE.md#关闭与失败隔离)。

---

## 测试与人工验证

运行 `npm test -- logger runtime`，验证终端/文件格式、纯文本边界、初始化摘要与结果 Rules 元信息、启动摘要顺序和 HTTP/MCP route identity。日志失败不能破坏握手、调用、初始化发布或关闭收尾；隐私验证目标见[请求头策略](REQUEST-HEADER-POLICY.md#验证重点)与[外部路由诊断边界](external-routing/runtime.md#安全诊断与业务内容边界)。

人工颜色与文件验证显式运行：

```bash
node --import tsx test/logger/logger.manual.ts
```

默认跳过超大 JSON 演示；追加 `--verbose` 验证 50KB 阈值下的大输出降级。演示文件写入 `test/logs/`。通用测试与显式脚本约定见[测试](TESTING.md)。
