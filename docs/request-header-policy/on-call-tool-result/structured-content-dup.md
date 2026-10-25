# structuredContentDup

`structuredContentDup` 是 `onCallToolResult` 阶段的功能，将最终 MCP 结果的 `content` 与 `isError` 复制到 `structuredContent` wrapper。规则配置与匹配见[结果阶段配置](../../REQUEST-HEADER-POLICY.md#oncalltoolresult)，共同执行时序见[调用管线](../../REQUEST-HEADER-POLICY.md#启动与调用)。

## 启用与覆盖

`rules.requestHeaders.onCallToolResult` 按本次工具调用 POST 的请求头决定是否启用功能；初始化参数不决定此功能。

Tool 可以自行返回 `structuredContent`。启用时，功能创建新结果对象，并用只含 `content` 与 `isError` 的 wrapper 完整替换 Tool 自有 `structuredContent`，不合并原有字段。

## 对象身份与字段保留

wrapper 直接引用输入结果的 `content` 数组，并复制已校验的布尔值 `isError`。输出的顶层 `content` 与 wrapper 的 `content` 引用同一数组，保留 text/image 字段与顺序。输入结果对象不变；顶层 `_meta` 及其他扩展字段由对象展开保留。

这些对象身份保证属于项目 handler 边界。后续 SDK 仍会再次 parse 结果，不能据此推断 wire 对象身份。稳定 JSON 与 SDK 校验边界见[统一结果校验](../../TOOL-RESULTS.md#runtime-结果校验)。

## 内容与序列化边界

功能不解析文本 payload，只复制最终 MCP content 与 `isError`。外部 HTTP route 的 canonical unknown 值已[映射为 text](../../external-routing/http-route.md#canonical-to-mcp-映射)，不会从中恢复原 JSON 值。

包含图片时，序列化后的 JSON 会在顶层 `content` 和 `structuredContent.content` 中各包含一份 base64。RESULT 日志只记录一次顶层 content，见[日志正文](../../logging/tool-calls.md#工具结果正文)。

功能不为 `tools/list` 的 definition 添加 `outputSchema`；项目的公共 definition 与结果字段契约见[工具返回结果](../../TOOL-RESULTS.md#结果契约)。
