# custom-mcp

一个使用 TypeScript 和 Node.js 构建的 MCP 工具集，通过 Streamable HTTP 提供文件读写、文本替换和批量读取等能力，并支持把 configured custom-only Tool 路由到受控 Processor 与外部 HTTP endpoint。

## Built-in 工具

- `read`：按 literal 路径或 glob 读取文本，支持逐请求行号/正则范围、行号前缀和 shallow 统计。
- `discover_guidelines`：从 Markdown 文件开头的 YAML Front Matter 发现指南元数据，不返回正文。
- `write_file`：写入完整文本文件。
- `replace_text`：通过精确文本或正则表达式执行局部替换。
- `android_assembleDebug` / `android_testDebugUnitTest`：执行 Android 项目的 Debug 构建和单元测试。

完整工具列表和参数说明见 [docs/TOOLS.md](docs/TOOLS.md) 与 [docs/tools/](docs/tools/)。

## 运行

需要 Node.js 22 和 npm。

```bash
npm ci
npm run build
```

根据 [全局配置示例](examples/config.example.json) 创建 `~/.custom-mcp/config.json`，并让其中的 `configFile` 指向按 [workspace 配置示例](examples/workspace-config.example.json) 创建的独立 JSON 文件。使用前必须替换示例中的本地绝对路径。

启动前确保默认日志目录 `~/.custom-mcp/logs` 已存在，然后运行：

```bash
npm run start -- --workspace my-workspace
```

服务默认监听 `127.0.0.1`，MCP endpoint 为：

```text
http://127.0.0.1:3100/mcp
```

全局、workspace 与外部路由配置模板见 [examples/](examples/)，配置字段与 workspace 选择规则见 [docs/CONFIG.md](docs/CONFIG.md)。

## 文档

- [开发文档入口](docs/DEVELOPMENT.md)
- [系统架构](docs/ARCHITECTURE.md)
- [项目结构与文件职责](docs/PROJECT-STRUCTURE.md)
- [运行配置](docs/CONFIG.md)
- [工具开发与工具索引](docs/TOOLS.md)
- [路径安全](docs/PATH-SAFETY.md)
- [测试](docs/TESTING.md)
- [日志](docs/LOGGING.md)
- [外部路由](docs/EXTERNAL-ROUTING.md)

## License

本项目使用 [MIT License](LICENSE)。
