# 日志系统开发说明

本文记录 `custom-mcp` 的日志输出位置、格式、颜色高亮和扩展方式。

---

## 输出位置

- **终端（stdout）**：实时查看，带颜色高亮。
- **日志文件**：默认写入 `~/.custom-mcp/logs/YYYY/MM/DD/<workspace-id>_YYYY-MM-DD_HH-MM-SS.log`，每次启动按系统本地时区生成新文件，纯文本格式。

日志文件根目录来自启动期 `RuntimeConfigSnapshot.logsDir`：selected workspace 可配置 `logsDir`，也可在 `envOverrides.allowedFields` 包含 `logsDir` 后通过 `MCP_LOGS_DIR` 覆盖。`logsDir` 表示日志根目录；默认 `~/.custom-mcp/logs`、configured `logsDir` 和 allowlisted `MCP_LOGS_DIR` 都必须是已存在的本地绝对目录。`MCP_LOGS_DIR` 不存在时不覆盖；存在但为空字符串、whitespace-only、含首尾 whitespace、相对路径或不存在目录时，配置加载失败。Windows 下使用 drive-absolute path，例如 `E:/Logs/custom-mcp`。`Logger` 构造时先确认日志根目录已存在且为目录，然后在该根目录下按系统本地时间创建 `YYYY/MM/DD/` 日期子目录和 `<workspace-id>_YYYY-MM-DD_HH-MM-SS.log` 日志文件。文件名前缀直接使用 selected workspace id；配置 schema 要求 workspace id 以小写字母或数字开头，且仅包含小写字母、数字、短横线 `-` 或下划线 `_`。

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

完整 base64 与工具参数、文本结果一样写入本机 stdout 和日志文件；输出图片的 Tool 应考虑日志体积和数据敏感性。结果契约与 request policy 覆盖语义见 [docs/TOOL-RESULTS.md](TOOL-RESULTS.md)。

### 启动配置摘要

HTTP server 开始监听后，`src/index.ts` 输出 selected workspace 的启动配置摘要。文件访问策略部分使用 `RuntimeConfigSnapshot.fileAccessPolicyFiles`，按 primary / additional root 分组列出已验证的 resolved lexical 策略文件引用：

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

有 route 时，摘要输出 enabled 状态、总数，以及按声明顺序排列的 route definition id、Tool name、request / response stage mode 和经过脱敏的 endpoint identity：

```text
  External routing: enabled
    Routes: 1
    Route: external-echo
      Tool: external_echo
      Request stages: direct
      Response stages: canonical-filter
      Endpoint: https://external.example.invalid/tool
```

endpoint identity 会剥离 URL query、credentials 与 fragment。该摘要不输出 endpoint headers、Processor config / endpoint config 文件路径、Processor executable path 或 argv。Processor post-drain diagnostics 会输出安全的 route definition id 与 Tool name，以及既有 role、Processor name、duration、byte-count、stderr truncation 和 cleanup state；不输出 endpoint、payload 或 subprocess 内容。external routing 失败与 canonical business message 的边界见 [external routing](EXTERNAL-ROUTING.md)。

### Session 与 Call ID

MCP session ID 是服务端生成的实际协议 ID，格式为 `session_<uuid>`。同一 session 的后续请求通过该值关联 transport、server 和工具日志。

每次进入统一 `tools/call` handler 时生成独立的日志关联 ID，格式为 `call_<uuid>`。同一次调用的 CALL 与 RESULT 日志使用相同 call ID；同一 session 内并发调用相同工具时，可通过 call ID 准确配对日志。

CALL 与 RESULT 都固定输出 `Session:` 和 `Call ID:`。若工具调用路径没有可用的 transport session ID，session 行明确输出：

```text
  Session: unavailable (session ID missing)
```

call ID 由服务端工具调用入口生成，不复用客户端提供的 JSON-RPC request ID。

### Request Header Rules 响应元信息

当 selected workspace 的 `rules.requestHeaders` 非空时，每条工具响应日志都会在状态行之后、结果正文之前输出一行 `Rules:` 元信息。

命中规则时，文件日志格式为：

```text
[2026-07-05T10:20:30.000+08:00] → OK read_file (12ms)
  Session: session_13a09d50-0000-4000-8000-000000000000
  Call ID: call_7c2c62a1-0000-4000-8000-000000000000
  Rules: matched rules.requestHeaders[0]; enabled structuredContentDup
  Succeeded.
```

多条规则命中时，规则位置按 policy 输出顺序稳定列出，例如：

```text
  Rules: matched rules.requestHeaders[0], rules.requestHeaders[1]; enabled structuredContentDup
```

配置了 request header rules 但未命中时，输出：

```text
  Rules: no match
```

未配置 request header rules 时，不输出 `Rules:` 行。`Rules:` 行是响应日志元信息，不写入 `ToolCallResult.content` 或 `structuredContent`。

日志层只接收脱敏 metadata：是否配置规则、命中的 `rules.requestHeaders[n]` 相对位置和 enabled feature。响应日志不记录原始 header 列表、请求 header name/value、配置 header name/value、配置期望 value 或匹配字符串。

---

## 颜色高亮

终端输出使用多种颜色区分不同信息类型（时间戳、调用方向、工具名、状态等），提升可读性。`Rules:` 响应元信息会高亮 `Rules:` 前缀、命中状态和 enabled feature。每次工具调用前会输出分隔线，便于区分不同调用。

**JSON 语法高亮**：参数和结果中的 JSON 内容会进行语法着色（键名、字符串、数字、布尔值等使用不同颜色）。当 JSON 内容超过 50KB 时，自动降级为无高亮输出以保证性能。

日志文件保持纯文本格式（无 ANSI 转义码），便于工具处理和长期存档。

---

## 扩展日志

日志系统通过 `Logger` 类的 `logToolCall` 和 `logToolResult` 方法自动记录所有工具调用。`src/runtime/tool-call-handler.ts` 在统一 `tools/call` 入口生成调用 metadata 并写入 CALL 与 RESULT，`src/index.ts` 从对应 transport 提供 session ID；**工具 handler 内部不需要写任何日志代码**。

如需在 handler 内部输出调试日志，可以将 `logger` 实例通过参数传入，或扩展 `MCPTool` 接口。

---

## 测试与人工验证

`test/logger/logger.manual.ts` 用于人工确认日志系统的终端颜色输出和日志文件；默认跳过超大 JSON 演示，避免产生大量噪音。需要验证 50KB 阈值下的大输出降级行为时，可传入 `--verbose`。

`test/logger/request-header-rules-logging.test.ts` 覆盖 request header rules 的 `Rules:` 响应日志格式、文件日志纯文本边界和隐私边界。

`test/runtime/startup-logging.test.ts` 覆盖文件访问策略摘要，以及 external routing disabled / configured / enabled 状态、route summary 和 endpoint identity 的安全格式。`test/runtime/application-diagnostics.test.ts` 覆盖 Processor drain 的 route / Tool 安全诊断格式。

日志演示生成的文件显式写入 `test/logs/` 目录。通用测试与手工脚本执行约定见 [docs/TESTING.md](TESTING.md)。
