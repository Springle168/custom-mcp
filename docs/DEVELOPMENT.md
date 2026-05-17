# Custom MCP 开发文档

## 项目概述

基于 Gemini CLI 的 Edit 工具移植而来的 MCP 服务器，通过 Streamable HTTP 协议与 Android Studio 等 MCP 宿主通信，当前提供三类能力：精准的文件局部替换（含 default 容错文本匹配与显式 regex 模式）、文件读取（单文件与批量），以及固定环境下的 Android Gradle 构建能力。

---

## 文档导航

| 主题 | 文档 | 内容 |
|-|-|-|
| 配置 | [docs/CONFIG.md](CONFIG.md) | `config.json`、环境变量覆盖、行尾符策略、配置相关故障排查 |
| 工具开发 | [docs/TOOLS.md](TOOLS.md) | 已实现工具索引、添加新工具、schema 设计、返回值、并发模型 |
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
├── AGENTS.md                    # AI Coding Agent 操作说明
├── config.example.json          # 配置示例
├── config.json                  # 本地运行配置
├── package.json                 # npm 包信息与脚本
├── tsconfig.json                # TypeScript 编译配置
├── docs/
│   ├── DEVELOPMENT.md           # 开发入口与文档导航
│   ├── CONFIG.md                # 配置开发说明
│   ├── TOOLS.md                 # 工具开发说明
│   ├── TESTING.md               # 测试开发说明
│   ├── LOGGING.md               # 日志系统开发说明
│   ├── ANDROID-STUDIO.md        # Android Studio 集成说明
│   ├── GEMINI-CLI.md            # Gemini CLI 移植参考
│   ├── commit-guidelines.md     # Git 提交信息规范
│   └── tools/                   # 单工具文档
├── src/
│   ├── index.ts                 # HTTP 入口 + MCP 会话管理
│   ├── config.ts                # 配置加载（文件 + 环境变量）
│   ├── tools/
│   │   ├── index.ts             # 工具注册表 + 路由分发
│   │   ├── types.ts             # MCPTool 接口定义
│   │   ├── replace.ts           # replace_text 工具
│   │   ├── write-file.ts        # write_file 工具
│   │   ├── read-file.ts         # read_file 工具
│   │   ├── read-many-files.ts   # read_many_files 工具
│   │   ├── ask-user.ts          # ask_user 工具
│   │   ├── android-build-shared.ts # Android 构建工具共享逻辑
│   │   ├── android-assemble-debug.ts # android.assembleDebug 工具
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
| 入口层 | `src/index.ts` | HTTP 服务器、MCP 协议处理、会话管理 | 加新工具时不需要改动 |
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
