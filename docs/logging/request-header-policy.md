# 请求头策略日志

本文维护初始化会话摘要与工具结果策略元信息的输出条件、格式和隐私边界。跨层参数、生命周期与隐私契约见[请求头策略](../REQUEST-HEADER-POLICY.md)，公共输出规则与验证入口见[日志概览](../LOGGING.md)。

初始化策略使用独立会话摘要，不写入工具结果日志。工具结果的 `Rules:` 元信息只由 `rules.requestHeaders.onCallToolResult` 控制；仅配置初始化规则时，不给工具结果增加此行。

## 初始化会话摘要

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

## 工具结果元信息

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

响应摘要不记录请求或配置的 header name/value、原始 header 列表或匹配字符串。初始化参数不进入结果摘要。阶段契约和捕获时序见[请求头策略](../REQUEST-HEADER-POLICY.md#内部阶段扩展点)。

终端的 `Rules:` 响应元信息会高亮 `Rules:` 前缀、命中状态和 enabled feature；文件日志仍为纯文本。CALL / RESULT 的基本格式与正文边界见[工具调用与结果日志](tool-calls.md)。
