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
    "file_path": "src/index.ts",
    "target": "...",
    "replacement": "...",
    "allow_multiple": false,
    "match_mode": "default"
  }
[2025-01-15T22:30:00.050+08:00] → OK replace_text (50ms)
  Session: session_13a09d50-0000-4000-8000-000000000000
  Call ID: call_7c2c62a1-0000-4000-8000-000000000000
  {"success":true,"file_path":"src/index.ts","match_mode":"default","allow_multiple":false,"matched_targets":1,"replacement_count":1,"matched_span":{"start_line":10,"end_line":10},"replacement_line_count":1,"file_line_count":{"previous":120,"current":120}}
```

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

## 测试日志

运行 `test/logger/logger.test.ts` 可以测试日志系统的颜色输出效果：

```bash
node --import tsx test/logger/logger.test.ts
```

运行 `test/logger/request-header-rules-logging.test.ts` 可以测试 request header rules 的 `Rules:` 响应日志格式、文件日志纯文本边界和隐私边界：

```bash
node --import tsx test/logger/request-header-rules-logging.test.ts
```

默认会跳过超大 JSON 演示，避免 Agent 或自动化运行时输出大量噪音；需要验证 50KB 阈值下的大输出降级行为时，追加 `--verbose`：

```bash
node --import tsx test/logger/logger.test.ts --verbose
```

测试生成的日志文件显式写入 `test/logs/` 目录。更多测试约定见 [docs/TESTING.md](TESTING.md)。
