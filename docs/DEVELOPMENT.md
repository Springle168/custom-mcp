# Custom MCP 开发文档

## 项目概述

一个别具特色的 MCP 服务器项目，客户端可通过 Streamable HTTP 协议与 MCP 宿主通信。

---

## 文档导航

| 主题 | 文档 | 内容 |
|-|-|-|
| 配置 | [docs/CONFIG.md](CONFIG.md) | `~/.custom-mcp/config.json`、`version: 1` 全局 workspace schema、阶段 4 workspace 选择、行尾符策略、配置相关故障排查 |
| 工具开发 | [docs/TOOLS.md](TOOLS.md) | 已实现工具索引、添加新工具、schema 设计、返回值、并发模型 |
| 工具返回值 | [docs/TOOL-RESULTS.md](TOOL-RESULTS.md) | `ToolCallResult` 返回壳、`isError` 语义、统一 helper |
| 路径安全 | [docs/PATH-SAFETY.md](PATH-SAFETY.md) | 文件类工具的路径分类、root 边界、glob、realpath 与 symlink 语义 |
| 测试 | [docs/TESTING.md](TESTING.md) | 测试目录、脚本测试约定、常用验证命令、测试日志 |
| 日志 | [docs/LOGGING.md](LOGGING.md) | 日志输出位置、格式、颜色高亮、扩展方式 |
| Android Studio | [docs/ANDROID-STUDIO.md](ANDROID-STUDIO.md) | MCP 宿主配置、工具名称规则、MCP → Gemini 转换层限制 |
| Gemini CLI 移植 | [docs/GEMINI-CLI.md](GEMINI-CLI.md) | 继续移植 Gemini CLI 能力时的参考路径和裁剪原则 |
| 单工具文档 | [docs/tools/](tools/) | 各工具的参数契约、实现细节和移植来源 |
| 提交规范 | [docs/commit-guidelines.md](commit-guidelines.md) | Git 提交信息格式与约束 |

---

## 目录结构

```text
custom-mcp/
├── AGENTS.md                    # AI Agent 操作说明
├── config.example.json          # 全局配置示例模板，可复制到 ~/.custom-mcp/config.json
├── config.json                  # 本地/历史配置，可能含个人路径；运行时不再读取仓库根配置
├── package.json                 # npm 包信息与脚本
├── tsconfig.json                # TypeScript 编译配置
├── logs/                        # 生产日志，每次启动一个日志文件
├── docs/
│   ├── DEVELOPMENT.md           # 开发入口与文档导航
│   ├── CONFIG.md                # 配置开发说明
│   ├── TOOLS.md                 # 工具开发说明
│   ├── TOOL-RESULTS.md          # 工具返回结果设计
│   ├── PATH-SAFETY.md           # 文件路径安全维护说明
│   ├── TESTING.md               # 测试开发说明
│   ├── LOGGING.md               # 日志系统开发说明
│   ├── ANDROID-STUDIO.md        # Android Studio 集成说明
│   ├── GEMINI-CLI.md            # Gemini CLI 移植参考
│   ├── commit-guidelines.md     # Git 提交信息规范
│   └── tools/                   # 单工具文档
├── src/
│   ├── index.ts                 # HTTP 入口 + MCP 会话管理
│   ├── cli.ts                   # CLI 参数解析（如 --workspace）
│   ├── config.ts                # 运行配置加载 facade、快照构建
│   ├── config/
│   │   ├── errors.ts            # 结构化配置错误
│   │   ├── global-config-path.ts # home-level dotdir 配置路径解析
│   │   ├── schema.ts            # version: 1 全局 workspace schema 校验
│   │   └── workspace-selection.ts # 显式/cwd workspace 选择与 RuntimeConfigIdentity
│   ├── runtime/
│   │   ├── config-store.ts      # 运行时配置快照存取
│   │   └── tool-context.ts      # 工具 handler 消费的运行时上下文
│   ├── tools/
│   │   ├── index.ts             # 工具注册表 + 路由分发
│   │   ├── types.ts             # MCPTool 接口定义
│   │   ├── replace.ts           # replace_text 工具
│   │   ├── write-file.ts        # write_file 工具
│   │   ├── read-file.ts         # read_file 工具
│   │   ├── read-many-files.ts   # read_many_files 工具
│   │   ├── ask-user.ts          # ask_user 工具
│   │   ├── android-build-shared.ts         # Android 构建工具共享逻辑
│   │   ├── android-assemble-debug.ts       # android.assembleDebug 工具
│   │   └── android-test-debug-unit-test.ts # android.testDebugUnitTest 工具
│   ├── engine/
│   │   ├── replacement.ts       # 四级替换策略
│   │   ├── text-utils.ts        # 文本处理工具集
│   │   └── android-gradle-output.ts # Gradle 输出解析
│   └── utils/
│       ├── paths.ts             # 路径解析 + 沙箱校验
│       ├── file-lock.ts         # 按文件路径的并发锁
│       ├── file-read.ts         # 文件读取 + 截断 + 二进制检测
│       ├── logger.ts            # 日志系统（终端彩色 + 文件纯文本双输出）
│       └── android-gradle.ts    # Gradle 执行 + 超时控制 + JAVA_HOME 注入
└── test/                        # 脚本测试、fixtures 与 Android 构建测试
```

---

## 各层职责

| 层 | 目录 | 职责 | 原则 |
|-|-|-|-|
| 入口层 | `src/index.ts` | HTTP 服务器、MCP 协议处理、会话管理、启动期配置错误输出 | 加新工具时不需要改动 |
| 配置层 | `src/config.ts`, `src/config/` | 读取 `~/.custom-mcp/config.json`、校验 `version: 1` 全局 workspace schema、选择 workspace、生成 `RuntimeConfigIdentity` 并构建运行时快照 | 不在工具层读取配置文件 |
| 运行时层 | `src/runtime/` | 持有配置快照，派生 `ToolRuntimeContext` | 工具只消费归一化后的运行时能力 |
| 工具层 | `src/tools/` | 工具定义、参数校验、业务编排 | 每个工具一个文件 |
| 引擎层 | `src/engine/` | 纯算法逻辑，无 I/O 操作 | 可独立测试，无副作用 |
| 工具库 | `src/utils/` | 基础设施（日志、路径、锁、文件读取） | 跨工具共用 |

---

## 常用命令

```bash
# 编译
npm run build

# 启动
npm run start

# 编译并启动
npm run dev

# 单个脚本测试
npx tsx test/test-read-file.ts

# 安装新依赖
npm install <package>
npm install -D <package>    # 仅开发依赖
```

更多测试命令见 [docs/TESTING.md](TESTING.md)。

---

## 故障排查入口

- 配置和路径相关问题见 [docs/CONFIG.md](CONFIG.md)。
- 工具替换、读取、写入等行为优先查看 [docs/tools/](tools/) 下对应工具文档。
- Android Studio 连接和宿主限制见 [docs/ANDROID-STUDIO.md](ANDROID-STUDIO.md)。
- Android 构建工具问题见 [docs/tools/android-build.md](tools/android-build.md)。
