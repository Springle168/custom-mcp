# 日志系统开发说明

本文维护 `custom-mcp` 日志系统的公共输出规则、接线边界与验证入口。具体场景的格式和示例按专题维护：

| 维护任务 | 专题 | 主要内容 |
|-|-|-|
| 修改工具调用与结果日志 | [工具调用与结果](logging/tool-calls.md) | CALL / RESULT、Session 与 Call ID、文本与图片正文 |
| 修改启动摘要与外部资源诊断 | [启动与诊断](logging/startup-and-diagnostics.md) | 文件访问策略、外部路由状态、下游 MCP 与 Processor 诊断 |
| 修改请求头策略日志 | [请求头策略日志](logging/request-header-policy.md) | 初始化会话与拒绝摘要、结果 Rules 元信息、输出条件与隐私边界 |

## 输出位置

- **终端（stdout）**：实时查看，带颜色高亮。
- **日志文件**：默认写入 `~/.custom-mcp/logs/YYYY/MM/DD/<workspace-id>_YYYY-MM-DD_HH-MM-SS.log`，每次启动按系统本地时区生成新文件，纯文本格式。

日志根目录来自启动期 `RuntimeConfigSnapshot.logsDir`，必须是已存在的本地绝对目录。来源可以是默认目录、workspace `logsDir` 或获 allowlist 授权的 `MCP_LOGS_DIR`；字段与覆盖校验见 [workspace 配置](config/workspace-config.md#环境变量覆盖)。

`Logger` 构造时再次确认根目录存在且为目录，再创建本地时区对应的 `YYYY/MM/DD/` 子目录和日志文件。文件名前缀直接使用 selected workspace id，其 grammar 由[全局索引](config/global-index.md#schema)约束。

## 颜色高亮

终端输出使用多种颜色区分不同信息类型（时间戳、调用方向、工具名、状态等）。每次工具调用前会输出分隔线，便于区分不同调用。场景专属元信息的高亮见对应专题。

参数和结果中的 JSON 内容会进行语法着色（键名、字符串、数字、布尔值等使用不同颜色）。当 JSON 内容超过 50KB 时，自动降级为无高亮输出以保证性能。

日志文件保持纯文本格式（无 ANSI 转义码），便于工具处理和长期存档。

## 调用日志接线

统一 `tools/call` 入口生成 call ID 并调用 `Logger.logToolCall()` / `logToolResult()`；session ID 来自 SDK 调用 metadata。工具 handler 不自行记录 CALL/RESULT，也不接收 Logger 能力。

阶段实现提供安全日志摘要，通用 Logger 负责格式和输出，不解释请求头或外部协议。日志及 diagnostic 的失败隔离见[系统架构](ARCHITECTURE.md#关闭与失败隔离)。

## 测试与人工验证

运行 `npm test -- logger runtime`，验证终端/文件格式、纯文本边界、初始化摘要与结果 Rules 元信息、启动摘要顺序和 HTTP/MCP route identity。日志失败不能破坏握手、调用、初始化发布或关闭收尾；隐私验证目标见[请求头策略](REQUEST-HEADER-POLICY.md#验证重点)与[外部路由诊断边界](external-routing/runtime.md#安全诊断与业务内容边界)。

人工颜色与文件验证显式运行：

```bash
node --import tsx test/logger/logger.manual.ts
```

默认跳过超大 JSON 演示；追加 `--verbose` 验证 50KB 阈值下的大输出降级。演示文件写入 `test/logs/`。通用测试与显式脚本约定见[测试](TESTING.md)。
