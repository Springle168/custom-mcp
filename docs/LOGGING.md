# 日志系统开发说明

本文记录 `custom-mcp` 的日志输出位置、格式、颜色高亮和扩展方式。

---

## 输出位置

- **终端（stdout）**：实时查看，带颜色高亮。
- **日志文件**：默认写入 `~/.custom-mcp/logs/YYYY/MM/DD/YYYY-MM-DD_HH-MM-SS.log`，每次启动按系统本地时区生成新文件，纯文本格式。

日志文件根目录来自启动期 `RuntimeConfigSnapshot.logsDir`：selected workspace 可配置 `logsDir`，也可在 `envOverrides.allowedFields` 包含 `logsDir` 后通过 `MCP_LOGS_DIR` 覆盖。`logsDir` 表示日志根目录；`Logger` 在该根目录下按系统本地时间创建 `YYYY/MM/DD/` 日期子目录和日志文件。`logsDir` 和 `MCP_LOGS_DIR` 必须是本地绝对路径；Windows 下使用 drive-absolute path，例如 `E:/Logs/custom-mcp`。目录不存在时由 `Logger` 递归创建。

---

## 日志格式

```text
────────────────────────────────
[2025-01-15T22:30:00.000+08:00] ← CALL replace_text
  {
    "file_path": "src/index.ts",
    "target": "...",
    "replacement": "...",
    "allow_multiple": false,
    "match_mode": "default"
  }
[2025-01-15T22:30:00.050+08:00] → OK replace_text (50ms)
  {"success":true,"file_path":"src/index.ts","match_mode":"default","allow_multiple":false,"matched_targets":1,"replacement_count":1,"matched_span":{"start_line":10,"end_line":10},"replacement_line_count":1,"file_line_count":{"previous":120,"current":120}}
```

---

## 颜色高亮

终端输出使用多种颜色区分不同信息类型（时间戳、调用方向、工具名、状态等），提升可读性。每次工具调用前会输出分隔线，便于区分不同调用。

**JSON 语法高亮**：参数和结果中的 JSON 内容会进行语法着色（键名、字符串、数字、布尔值等使用不同颜色）。当 JSON 内容超过 50KB 时，自动降级为无高亮输出以保证性能。

日志文件保持纯文本格式（无 ANSI 转义码），便于工具处理和长期存档。

---

## 扩展日志

日志系统通过 `Logger` 类的 `logToolCall` 和 `logToolResult` 方法自动记录所有工具调用。在 `src/index.ts` 的路由层统一拦截，**工具 handler 内部不需要写任何日志代码**。

如需在 handler 内部输出调试日志，可以将 `logger` 实例通过参数传入，或扩展 `MCPTool` 接口。

---

## 测试日志

运行 `test/logger/logger.test.ts` 可以测试日志系统的颜色输出效果：

```bash
cmd /c npx tsx test/logger/logger.test.ts
```

默认会跳过超大 JSON 演示，避免 Agent 或自动化运行时输出大量噪音；需要验证 50KB 阈值下的大输出降级行为时，追加 `--verbose`：

```bash
cmd /c npx tsx test/logger/logger.test.ts --verbose
```

测试生成的日志文件显式写入 `test/logs/` 目录。更多测试约定见 [docs/TESTING.md](TESTING.md)。
