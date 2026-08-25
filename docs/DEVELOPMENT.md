# Custom MCP 开发文档

## 项目概述

一个别具特色的 MCP 服务器项目，客户端可通过 Streamable HTTP 协议与 MCP 宿主通信。

---

## 文档导航

| 主题 | 文档 | 内容 |
|-|-|-|
| 配置 | [配置概览](CONFIG.md)、[全局索引](config/global-index.md)、[workspace 配置](config/workspace-config.md)、[自定义 Tool 配置](config/tool-config.md) | 两层配置模型、全局 reference 索引、selected workspace schema、env override、runtime snapshot、Tool definition 与配置相关源码和测试 |
| 工具开发 | [docs/TOOLS.md](TOOLS.md) | 已实现工具索引、`src/tools/` 源码布局、添加新工具、schema 设计、返回值、并发模型 |
| 工具返回值 | [docs/TOOL-RESULTS.md](TOOL-RESULTS.md) | `ToolCallResult` 返回壳、`isError` 语义、统一 helper |
| 路径安全 | [docs/PATH-SAFETY.md](PATH-SAFETY.md) | 文件类工具的路径分类、root 边界、glob、realpath 与 symlink 语义 |
| 测试 | [docs/TESTING.md](TESTING.md) | 测试组织规则、统一 runner 与通用验证命令 |
| 日志 | [docs/LOGGING.md](LOGGING.md) | 日志输出位置、格式、颜色高亮、扩展方式 |
| External routing | [external routing](EXTERNAL-ROUTING.md) | `processorConfigFile`、Processor / endpoint schema、canonical route、容量、取消、shutdown 与日志边界 |
| Android Studio | [docs/ANDROID-STUDIO.md](ANDROID-STUDIO.md) | MCP 宿主配置、工具名称规则、schema 转换层限制 |
| 单工具文档 | [docs/tools/](tools/) | 各工具的参数契约、实现细节、设计边界、相关源码和测试 |

---

## 顶层目录

```text
custom-mcp/
├── AGENTS.md                    # AI Agent 操作说明
├── examples/                    # 配置示例；使用前需检查并替换其中的路径和值
├── package.json                 # npm 包信息与脚本
├── package-lock.json            # npm 依赖解析与版本锁定
├── tsconfig.json                # TypeScript 编译配置
├── tsconfig.test.json           # 生产源码与测试代码的无输出 TypeScript 检查配置
├── docs/                        # 开发文档、专题文档和单工具文档
├── src/                         # MCP 服务、配置运行时、工具、引擎和共享基础设施
└── test/                        # 按主题组织的脚本测试、fixtures、helpers 和测试日志
```

`docs/DEVELOPMENT.md` 只保留入口级导航和架构地图。目录或文件的维护细节优先放到对应专题文档，避免高层文档和专题文档重复展开同一份结构。

---

## 各层职责

| 层 | 目录 | 职责 | 原则 |
|-|-|-|-|
| 入口层 | `src/index.ts` | HTTP 服务器、MCP 协议处理、会话管理、启动期配置错误输出 | 加新工具时通常不需要改动 |
| CLI 层 | `src/cli.ts` | 解析启动参数，如 `--workspace` | 只负责命令行输入，不承载配置 schema 细节 |
| 配置层 | `src/config.ts`, `src/config/` | 读取 version 2 全局索引、显式选择 reference、按需读取 version 1 workspace 配置、应用集中 value/path policy、selected workspace env override allowlist 并构建 runtime snapshot | public facade 不承载 schema/value/path/selection/env/snapshot 细节；不在工具层读取配置文件 |
| 运行时层 | `src/runtime/` | 持有 current snapshot 与 identity baseline，在每次工具调用开始时派生 `ToolRuntimeContext`，通过 MCP server factory 接入 workspace tool service | 工具只消费归一化后的运行时能力；`ConfigStore` 不暴露 snapshot mutation API |
| 工具层 | `src/tools/` | built-in registry、custom definition 加载、Draft 2020-12 validator、effective/exposed catalog、executor 路由、业务编排与返回值 helper | definition、executor 和 exposure 分离；单工具细节优先写入 `docs/tools/` |
| 引擎层 | `src/engine/` | 纯算法逻辑，如文本替换、行尾符处理和 Gradle 输出解析 | 无 I/O 副作用，可独立测试；按使用场景由对应工具文档承接细节 |
| 工具库 | `src/utils/` | 基础设施，如路径安全、文件锁、文件读取、日志、Gradle 进程执行 | 跨工具复用；按不变量归属由路径安全、日志、工具或单工具文档承接 |

---

## 源码细节归属

| 源码区域 | 主要维护入口 |
|-|-|
| `src/config.ts`, `src/config/` | [配置概览](CONFIG.md) 说明加载边界；[全局索引](config/global-index.md) 承接 `global-config-path.ts`、`global-config-schema.ts` 与 `workspace-selection.ts`；[workspace 配置](config/workspace-config.md) 承接 `schema.ts`、`value-policy.ts`、`path-policy.ts`、`file-access-policy.ts`、`env-overrides.ts`、`request-header-rules.ts` 与 `runtime-snapshot.ts`；[自定义 Tool 配置](config/tool-config.md) 承接 `tool-exposure.ts` 与 `processorConfigFile` 入口 |
| `src/runtime/config-store.ts`, `src/runtime/startup-runtime.ts`, `src/runtime/application-lifecycle.ts`, `src/runtime/application-diagnostics.ts`, `src/runtime/mcp-server.ts`, `src/runtime/tool-call-handler.ts`, `src/runtime/tool-context.ts`, `src/runtime/tool-invocation-context.ts`, `src/runtime/request-context.ts`, `src/runtime/request-header-policy.ts`, `src/runtime/request-header-view.ts`, `src/runtime/tool-result-adapter.ts`, `src/runtime/startup-logging.ts` | 配置 runtime、application shutdown、诊断、启动期 tool catalog composition、MCP server factory、request header rules policy 与启动配置摘要见 [配置概览](CONFIG.md)、[workspace 配置](config/workspace-config.md)、[日志](LOGGING.md) 和 [external routing](EXTERNAL-ROUTING.md)；workspace tool service 与调用管线见 [工具开发](TOOLS.md)，工具返回结果适配见 [工具返回结果](TOOL-RESULTS.md) |
| `src/tools/names.ts`, `src/tools/index.ts`, `src/tools/catalog.ts`, `src/tools/custom-tool-config.ts`, `src/tools/input-schema-validator.ts`, `src/tools/*.ts` | Tool config / definition 格式、schema validator 与 effective/exposed catalog 见 [自定义 Tool 配置](config/tool-config.md)；built-in canonical registry、workspace service 与单工具实现见 [docs/TOOLS.md](TOOLS.md) 和 [docs/tools/](tools/) |
| `src/tools/external-routing/` | external custom-only binding、Processor / endpoint config、canonical protocol、HTTP / subprocess execution、容量和 lifecycle 见 [external routing](EXTERNAL-ROUTING.md) |
| `src/engine/replacement.ts` | [docs/tools/replace-text.md](tools/replace-text.md) |
| `src/engine/text-utils.ts` | 文本/行尾符共享语义见 [docs/TOOLS.md](TOOLS.md)，具体工具使用见对应单工具文档 |
| `src/engine/android-gradle-output.ts` | [docs/tools/android-build.md](tools/android-build.md) |
| `src/utils/paths.ts`, `src/utils/file-access-policy.ts` | allowed-root 路径分类与统一 ignore/deny 文件访问策略见 [docs/PATH-SAFETY.md](PATH-SAFETY.md) |
| `src/utils/file-read.ts` | [docs/tools/read-file.md](tools/read-file.md)、[docs/tools/read-many-files.md](tools/read-many-files.md) |
| `src/utils/file-lock.ts` | [docs/TOOLS.md](TOOLS.md) 的并发模型，以及写入类工具文档 |
| `src/utils/http-url.ts` | HTTP bind host 的 IPv6 host:port 格式和 MCP / `ask_user` endpoint URL 生成，见 [workspace 配置](config/workspace-config.md) |
| `src/utils/logger.ts` | [docs/LOGGING.md](LOGGING.md) |
| `src/utils/android-gradle.ts` | [docs/tools/android-build.md](tools/android-build.md) |

---

## 故障排查入口

- 配置和 workspace 选择相关问题见 [docs/CONFIG.md](CONFIG.md)。
- 文件路径边界、allowed roots、glob 和 symlink 行为见 [docs/PATH-SAFETY.md](PATH-SAFETY.md)。
- 工具替换、读取、写入等行为优先查看 [docs/tools/](tools/) 下对应工具文档。
- Android Studio 连接和宿主限制见 [docs/ANDROID-STUDIO.md](ANDROID-STUDIO.md)。
- Android 构建工具问题见 [docs/tools/android-build.md](tools/android-build.md)。
