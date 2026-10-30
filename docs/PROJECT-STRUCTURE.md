# 项目结构

本文集中维护文件布局与简要职责，用于定位实现。`src/` 展开全部源码文件；`test/` 展开主题目录、runner 与关键公共 helper，不枚举普通测试脚本或 fixture。整体协作关系见[系统架构](ARCHITECTURE.md)，按任务选择专题见[开发入口](DEVELOPMENT.md)。

## 顶层

```text
custom-mcp/
├── AGENTS.md                          # 仓库级 Agent 操作与开发约束
├── README.md                          # 项目简介、运行入口与文档入口
├── LICENSE                            # 许可
├── package.json                       # 依赖、包入口与 npm 脚本
├── package-lock.json                  # 依赖版本锁定
├── tsconfig.json                      # 生产源码编译配置
├── tsconfig.test.json                 # 源码与测试的无输出类型检查配置
├── eslint.config.js                   # 源码、测试与配置脚本的静态规则
├── .prettierrc.json                   # 代码排版配置
├── .prettierignore                    # 排版排除项
├── .gitignore                         # Git 忽略项
├── src/                               # 生产源码
├── test/                              # 测试、辅助函数与测试生成物
├── examples/                          # 配置与 Tool definition 示例
└── docs/                              # 开发文档、专题与按需读取的指南
```

`dist/`、依赖目录、缓存和本地临时资料不展开。`docs/` 中开发文档的主题导航由 `DEVELOPMENT.md` 维护；指南按根目录 `AGENTS.md` 的发现规则读取。

## 源码

### 入口与配置

```text
src/
├── index.ts                           # 进程入口、信号注册与启动失败报告
├── cli.ts                             # 启动参数与显式 workspace 选择输入
├── config.ts                          # 配置公共 facade 与两层加载管线
└── config/
    ├── errors.ts                      # 配置错误分类、文件归属与修复提示
    ├── global-config-path.ts          # home-level 全局配置和默认日志目录定位
    ├── global-config-schema.ts        # 全局 reference 索引 schema
    ├── workspace-selection.ts         # reference 选择与稳定 runtime identity
    ├── schema.ts                      # workspace schema 与归一化配置模型
    ├── value-policy.ts                # token、数值、IP、行尾符等集中值策略
    ├── path-policy.ts                 # 本地绝对路径形态与存在目录校验
    ├── strict-utf8-file.ts            # 同一 descriptor 的普通文件检查和严格 UTF-8 读取
    ├── json-file.ts                   # 配置 JSON 解析与诊断边界
    ├── file-access-policy.ts          # 策略文件加载、编译与只读访问 facade
    ├── env-overrides.ts               # selected workspace 的 allowlisted 环境变量覆盖
    ├── request-header-rules.ts        # 两阶段请求头规则 schema 与归一化模型
    ├── tool-exposure.ts               # tools 外壳、tool config 路径与未决 selector
    └── runtime-snapshot.ts            # canonical roots、能力快照与不可变图构建
```

### 应用、会话与调用运行时

```text
src/runtime/
├── runtime-extensions.ts                           # 会话准备、POST context 与结果阶段的内部契约
├── application/
│   ├── start-application.ts                        # 配置、service、日志、listener 与 lifecycle 组装
│   ├── startup-runtime.ts                          # snapshot/catalog 组合与外部运行时装配
│   ├── config-store.ts                             # 固定 snapshot、identity 与状态的只读访问
│   ├── application-lifecycle.ts                    # listener、pending/published 会话和共享资源关闭
│   ├── application-diagnostics.ts                  # 工具管线、Processor drain 与 MCP 连接安全诊断
│   ├── startup-logging.ts                          # 启动摘要、route identity 与敏感信息排除
│   └── startup-errors.ts                           # CLI/配置启动错误格式化
├── mcp/
│   ├── http-app.ts                                 # Express MCP POST/GET/DELETE 接线
│   ├── mcp-post-handler.ts                         # 新会话准备、SDK dispatch 与初始化发布
│   ├── mcp-server.ts                               # MCP Server factory 与 tools/list、tools/call 接线
│   ├── session-tool-service.ts                     # 会话级不可变工具视图与调用准入
│   ├── mcp-identifiers.ts                          # 服务端 session ID 与 call ID 生成
│   ├── pending-session.ts                          # 未发布资源所有权、关闭信号与幂等清理
│   ├── initialization-tracking-transport.ts        # initialize 响应的公开 send 完成观测
│   └── initialization-http-completion.ts           # HTTP 正常完成与提前中断观测
├── invocation/
│   ├── tool-call-handler.ts                        # 单次调用、结果校验/适配与日志隔离管线
│   ├── tool-context.ts                             # snapshot 派生的 workspace 工具能力
│   ├── tool-invocation-context.ts                  # 单次调用 identity 与 AbortSignal 契约
│   ├── tool-call-log-context.ts                    # CALL/RESULT 关联信息与安全摘要契约
│   └── tool-result-validation.ts                   # 稳定 JSON 图与 MCP text/image 结果校验
└── request/
    ├── request-header-extensions.ts                # 按已配置阶段组装请求头扩展
    ├── request-header-view.ts                      # raw header、重复状态与 strict view
    ├── request-context.ts                          # POST-local AsyncLocalStorage 上下文
    ├── feature-contracts.ts                        # 阶段 parser、初始化贡献与结果绑定的窄契约
    ├── feature-registry.ts                         # 显式初始化映射与静态有序默认结果表
    ├── initialize-header-errors.ts                 # 初始化安全错误分类与诊断
    ├── initialize-header-policy.ts                 # 公共 header/JSON 边界、parser 分派与安全 metadata
    ├── initialize-header-extension.ts              # 验证后贡献合并、会话准备、拒绝与发布观察
    ├── request-header-policy.ts                    # 本次结果规则匹配与 feature 并集
    ├── tool-result-header-extension.ts             # 会话结果表绑定与调用开始时的适配方案捕获
    ├── tool-result-adapter.ts                      # 按已绑定表顺序执行本次启用的结果变换
    ├── features/
    │   ├── set-tool-list.ts                        # 工具名称 payload 校验与受限会话服务准备
    │   ├── set-instructions.ts                     # instructions payload 校验与会话说明贡献
    │   └── structured-content-dup.ts               # content/isError wrapper 的纯结果变换
    └── request-header-policy-logging.ts            # 请求头策略安全摘要格式化
```

### 工具目录与执行

```text
src/tools/
├── names.ts                                         # 内置工具 identity 与 canonical 顺序
├── index.ts                                         # built-in registry 编译与 workspace service facade
├── catalog.ts                                       # effective/exposed catalog、validator 与 executor 路由
├── custom-tool-config.ts                            # Tool config、definition 与外部路由入口加载
├── input-schema-validator.ts                        # Draft 2020-12 validator facade
├── types.ts                                         # definition、executor 与 ToolCallResult 公共契约
├── results.ts                                       # 单文本块错误结果 helper
├── built-in/
│   ├── files/
│   │   ├── read.definition.ts                       # read 描述、schema 与请求上限
│   │   ├── read.ts                                  # 请求覆盖/去重、源文件分组与范围编排
│   │   ├── read-model.ts                            # 请求、文本/图片结果与源读取契约
│   │   ├── read-result.ts                           # 文本统计、shallow 与有序图文渲染
│   │   ├── replace-text.definition.ts               # replace_text 描述与 schema
│   │   ├── replace.ts                               # 有序替换、文件锁、写入与逐项结果
│   │   ├── write-file.definition.ts                 # write_file 描述与 schema
│   │   └── write-file.ts                            # 完整写入、创建目录、内容警告与结果
│   ├── guidelines/
│   │   ├── discover-guidelines.definition.ts        # 指南发现描述、schema 与资源上限
│   │   └── discover-guidelines.ts                   # Markdown 选择、有界前缀读取与元数据汇总
│   └── android/
│       ├── android-build.definition.ts              # 两个 Android 工具的描述与共享 schema
│       ├── android-assemble-debug.ts                # assembleDebug handler
│       ├── android-test-debug-unit-test.ts          # testDebugUnitTest handler
│       └── android-build-shared.ts                  # gate、执行、报告与失败结果编排
└── external-routing/
    ├── config.ts                                    # route、Processor、endpoint/server 配置与 binding 校验
    ├── canonical-protocol.ts                        # HTTP canonical 协议校验、快照与 filter 不变量
    ├── executor.ts                                  # route-bound executor、结果映射与资源 facade
    ├── strategy-adapter.ts                          # HTTP request/response stage 编排与诊断
    ├── runtime.ts                                   # 共享 admission、FIFO、取消与 exchange drain
    ├── http-transport.ts                            # 专用 HTTP Agents、交换限制、取消与关闭
    ├── processor-runner.ts                          # 子进程环境、stdio 限制、termination 与 drain
    ├── mcp-connection-manager.ts                    # 下游共享会话、single-flight 连接与 warm-up
    └── mcp-transport.ts                             # 下游 Streamable HTTP 与 request-specific drain
```

### 引擎与系统基础设施

```text
src/
├── engine/
│   ├── replacement.ts                      # default/regex 替换计算与匹配范围
│   ├── text-utils.ts                       # 行尾符转换、检测与策略解析
│   ├── read-range.ts                       # 行号/正则范围编译、选择与格式化
│   ├── file-content.ts                     # 完整字节分类、严格 UTF-8 与文本准入
│   ├── guideline-front-matter.ts           # Front Matter delimiter、YAML AST 与元数据校验
│   ├── android-gradle-output.ts            # Gradle 输出清洗与失败片段解析
│   └── android-test-report.ts              # JUnit XML 解析、聚合与失败详情
└── utils/
    ├── paths.ts                            # allowed roots、lexical/realpath 边界与路径展示
    ├── file-access-policy.ts               # ignore/deny、读写目标复检与受控 glob
    ├── file-selection.ts                   # 有序 literal/glob 候选、来源下标与文件身份
    ├── file-read.ts                        # 完整源文件读取、文本/图片分类与大小保护
    ├── file-system-errors.ts               # 文件系统异常的受控公开原因
    ├── bounded-workers.ts                  # 有限并发、稳定结果顺序与停止调度后的 drain
    ├── file-lock.ts                        # 按文件路径 FIFO 串行化
    ├── immutable-map.ts                    # runtime-immutable ReadonlyMap 快照
    ├── http-url.ts                         # IPv6 bind host 格式与 MCP URL 构造
    ├── logger.ts                           # 终端/文件日志、结果正文与颜色高亮
    ├── android-gradle-gate.ts              # Gradle workspace FIFO、active lease 与 shutdown barrier
    ├── android-gradle.ts                   # Gradle 启动、输出、超时、进程清理与恢复
    └── android-test-report-files.ts        # JUnit 报告发现、调用前后快照与变化读取
```

## 测试

主题目录用于定位验证范围；测试组织、发现规则与命令见[测试](TESTING.md)。fixture 内部布局由对应测试管理，不作为文件职责清单维护。

```text
test/
├── run-tests.ts                            # 脚本发现、selector、串行调度与失败汇总
├── test-utils.ts                           # 公共断言、suite runner 与输出控制
├── helpers/
│   ├── runtime-config.ts                   # 测试 runtime snapshot、配置与策略构造
│   ├── tool-invocation-context.ts          # 单次 invocation 构造
│   └── built-in-tool-call.ts               # 通过 built-in contract 的工具调用辅助
├── config/                                 # 两层配置、selection、策略、env 与 snapshot
├── tools/                                  # definitions、custom config、catalog 与 exposure
│   └── inspect-tools.ts                    # canonical registry definition 的显式检查脚本
├── runtime/                                # 应用、会话、请求策略、结果管线与 HTTP/MCP 集成
│   └── helpers/request-header-http.ts      # 请求头集成专用 raw HTTP 客户端与会话 harness
├── external-routing/                       # route 配置、协议、Processor、HTTP/MCP 与资源生命周期
├── path-safety/                            # 路径形态、allowed roots、glob 与 symlink 边界
├── file-access-policy/                     # 跨工具 ignore/deny 与读写访问控制
├── file-selection/                         # 有序候选、过滤、文件身份与取消
├── file-content/                           # 完整字节分类、格式样本与严格文本边界
├── file-system-errors/                     # 公开文件错误分类与跨工具异常细节隔离
├── bounded-workers/                        # 并发上限、稳定顺序、取消与异常 drain
├── read/                                   # 选择覆盖、范围、内容准入、统计与生命周期
├── replace-text/                           # 匹配、批次、行尾符、并发与写入失败恢复
├── write-file/                             # 完整写入、内容警告与路径安全
├── discover-guidelines/                    # Front Matter、选择、有界读取与资源限制
├── android-build/                          # Gradle gate/执行/清理、输出与报告
├── logger/                                 # 日志隐私、策略摘要与人工颜色验证
├── runner/                                 # 测试发现、筛选、输出、脚本超时与有界进程清理
│   ├── script-execution.ts                 # 独立脚本执行、超时分类与输出捕获
│   └── termination.ts                      # 测试子进程终止与有界清理结果
├── fixtures/                               # 测试生成物与共享 fixture 工作区
└── logs/                                   # 测试日志输出
```

## 配置示例

```text
examples/
├── AGENTS.md                               # 示例目录的维护约束
├── config.example.json                     # home-level workspace reference 索引
├── workspace-config.example.json           # workspace 参数与文件访问策略引用
├── tool-config.example.json                # definitions、override 与外部路由入口
├── tool-definition.example.json            # custom-only Tool definition
├── read.override.example.json              # 内置 read 的对外 definition override
├── external-routing-config.example.json    # HTTP/MCP route 与 Processor stage
├── processor-config.example.json           # Processor executable 与调用参数 registry
├── http-endpoint-config.example.json       # HTTP endpoint URL、headers 与 timeout
└── mcp-server-config.example.json          # 下游 MCP endpoint、headers 与 timeout
```

示例的路径和值需按本机环境替换；字段与引用关系以[配置](CONFIG.md)和[外部路由配置](external-routing/configuration.md)为准。
