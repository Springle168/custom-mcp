# Custom MCP 开发文档

`custom-mcp` 是供本机使用的 TypeScript / Node.js MCP 工具集，通过 Streamable HTTP 提供工具能力。本文是维护入口，按任务选择文档；源码布局和文件职责集中在[项目结构](PROJECT-STRUCTURE.md)。

## 阅读入口

- 理解模块协作、调用主链路和资源所有权：读[系统架构](ARCHITECTURE.md)。
- 定位源码、测试主题或配置示例：查[项目结构](PROJECT-STRUCTURE.md)。
- 修改具体功能：按下表选择契约与机制文档，不必通读全部专题。
- 编写和运行测试：读[测试](TESTING.md)。运行环境与启动命令见[仓库 README](../README.md#运行)。
- 维护开发文档：先读[文档维护约定](AGENTS.md)，按内容归属更新，避免重复维护。

## 按任务查阅

| 维护任务 | 文档 | 主要内容 |
|-|-|-|
| 修改配置加载、workspace 选择或配置字段 | [配置概览](CONFIG.md) | 两层模型、加载边界，以及全局索引、workspace 和 Tool 配置子专题 |
| 修改工具定义、覆盖、暴露或执行契约 | [工具开发](TOOLS.md) | registry/catalog/service 边界、schema 分工、工具约定与工具索引 |
| 修改工具结果、图片或结果适配 | [工具返回结果](TOOL-RESULTS.md) | 结果壳、字段所有权、稳定 JSON 校验与请求头结果策略入口 |
| 修改初始化参数或按调用请求头策略 | [请求头策略](REQUEST-HEADER-POLICY.md) | 阶段契约、会话工具视图、请求上下文、初始化发布与隐私边界 |
| 修改文件访问和路径校验 | [路径安全](PATH-SAFETY.md) | allowed roots、literal/glob、ignore/deny、realpath 与 symlink |
| 修改 custom-only 工具的外部执行 | [外部路由概览](EXTERNAL-ROUTING.md) | HTTP/Processor 与下游 MCP route，以及配置、协议和共享运行时子专题 |
| 编写可独立提供的 Tool definition 或 Processor | [自定义工具编写规范](CUSTOM-TOOL-AUTHORING.md) | 自包含的文件、进程和协议契约，不依赖仓库内部文档 |
| 修改日志或排查可观测性问题 | [日志概览](LOGGING.md) | 公共输出与验证规则，以及工具调用、启动诊断和请求头策略日志子专题 |
| 修改测试组织和执行方式 | [测试](TESTING.md) | runner、selector、权限分类与验证命令 |

## 单工具契约

| 功能 | 文档 |
|-|-|
| 文件读取、范围、内容准入与 shallow 统计 | [read](tools/read.md) |
| 有序文本替换、匹配与写入恢复 | [replace_text](tools/replace-text.md) |
| 完整文件写入、目录创建与内容警告 | [write_file](tools/write-file.md) |
| Markdown 指南元数据发现与有界读取 | [discover_guidelines](tools/discover-guidelines.md) |
| Android 构建、单元测试、进程清理与报告 | [Android 工具](tools/android-build.md) |
