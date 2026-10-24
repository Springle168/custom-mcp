# 工具调用与结果日志

本文维护 CALL / RESULT 的格式、关联标识与正文边界。公共输出规则与验证入口见[日志概览](../LOGGING.md)，策略元信息见[请求头策略日志](request-header-policy.md)。

## 调用与结果格式

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

## Session 与 Call ID

MCP session ID 是服务端生成的实际协议 ID，格式为 `session_<uuid>`。同一 session 的后续请求通过该值关联 transport、server 和工具日志。

每次进入统一 `tools/call` handler 时生成独立的日志关联 ID，格式为 `call_<uuid>`。同一次调用的 CALL 与 RESULT 日志使用相同 call ID；同一 session 内并发调用相同工具时，可通过 call ID 准确配对日志。

CALL 与 RESULT 都固定输出 `Session:` 和 `Call ID:`。若工具调用路径没有可用的 transport session ID，session 行明确输出：

```text
  Session: unavailable (session ID missing)
```

call ID 由服务端工具调用入口生成，不复用客户端提供的 JSON-RPC request ID。

## 工具结果正文

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

完整 base64 与工具参数、文本结果一样写入本机 stdout 和日志文件；输出图片的 Tool 应考虑日志体积和数据敏感性。结果契约与字段覆盖语义见[工具返回结果](../TOOL-RESULTS.md)，两阶段策略与隐私边界见[请求头策略](../REQUEST-HEADER-POLICY.md)。
