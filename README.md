# custom-mcp

一个使用 TypeScript 和 Node.js 构建的 MCP 工具集，通过 Streamable HTTP 提供文件读写、文本替换、批量读取和用户交互等能力。

## 工具

- `read_file`：读取单个文本文件，支持按行号或正则范围读取。
- `read_many_files`：批量读取文本文件，支持 glob 与浅层扫描。
- `write_file`：写入完整文本文件。
- `replace_text`：通过精确文本或正则表达式执行局部替换。
- `ask_user`：在工具调用过程中向用户提问并收集回答。
- `android.assembleDebug` / `android.testDebugUnitTest`：执行 Android 项目的 Debug 构建和单元测试。

完整工具列表和参数说明见 [docs/TOOLS.md](docs/TOOLS.md) 与 [docs/tools/](docs/tools/)。

## 运行

需要 Node.js 22 和 npm。

```bash
npm ci
npm run build
```

在 `~/.custom-mcp/config.json` 创建运行配置。以下是一个最小示例，其中 `rootDir` 必须替换为已存在的本地绝对目录：

```json
{
  "version": 1,
  "workspaces": [
    {
      "id": "my-workspace",
      "rootDir": "E:/ExistingWorkspaces/YourProject",
      "port": 3100,
      "lineEnding": "auto"
    }
  ]
}
```

启动前确保默认日志目录 `~/.custom-mcp/logs` 已存在，然后运行：

```bash
npm run start -- --workspace my-workspace
```

服务默认监听 `127.0.0.1`，MCP endpoint 为：

```text
http://127.0.0.1:3100/mcp
```

完整配置模板见 [config.example.json](config.example.json)，配置字段与 workspace 选择规则见 [docs/CONFIG.md](docs/CONFIG.md)。

## 文档

- [开发文档与项目结构](docs/DEVELOPMENT.md)
- [运行配置](docs/CONFIG.md)
- [工具开发与工具索引](docs/TOOLS.md)
- [路径安全](docs/PATH-SAFETY.md)
- [测试](docs/TESTING.md)
- [日志](docs/LOGGING.md)

## License

本项目使用 [MIT License](LICENSE)。
