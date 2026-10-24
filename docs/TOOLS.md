# 工具开发说明

本文说明工具 definition、executor、catalog 与 workspace service 的契约，以及工具特有的校验和并发约束。源码定位见[项目结构](PROJECT-STRUCTURE.md#工具目录与执行)，应用接线见[系统架构](ARCHITECTURE.md)。

## 工具索引

| 工具名 | 功能 | 契约与机制 |
|-|-|-|
| `replace_text` | 按输入顺序批量替换，支持 default 精确字面匹配与显式 JavaScript regex | [replace_text](tools/replace-text.md) |
| `read` | literal/glob 文本读取、行号/正则范围、行号前缀和 shallow 统计 | [read](tools/read.md) |
| `discover_guidelines` | 从 Markdown Front Matter 发现指南元数据，不返回正文 | [discover_guidelines](tools/discover-guidelines.md) |
| `write_file` | 完整文本写入、自动创建父目录与内容警告 | [write_file](tools/write-file.md) |
| `android_assembleDebug` | Android Debug 构建 | [Android 工具](tools/android-build.md) |
| `android_testDebugUnitTest` | Android Debug 单元测试与本次 JUnit 报告聚合 | [Android 工具](tools/android-build.md) |
| configured custom-only Tool | 通过 definition reference id 绑定 HTTP/Processor 或下游 MCP route | [外部路由](EXTERNAL-ROUTING.md) |

## Definition 与 executor

built-in definition 定义 `name`、`description` 与 Draft 2020-12 `inputSchema`，通过 `satisfies MCPTool['definition']` 保留 identity 与 schema 的静态约束。handler 模块绑定 definition 与 executor；两者共置但责任分离。共享稳定常量由 definition 或已有基础设施提供，不在 schema 与 handler 中重复维护。

`TOOL_NAMES` 定义 built-in identity 与 canonical 顺序。名称目录和实现 registry 必须一一对应；registry 构建会拒绝缺失、额外或重复实现，深冻结 definitions，并编译各自的 implementation validator。

workspace custom definition 只描述对外契约，不携带 executor。文件格式、引用路径和 definitionId binding 见[自定义 Tool 配置](config/tool-config.md)。

handler 接收两类独立输入：workspace `ToolRuntimeContext` 与单次 `ToolInvocationContext`。后者承载调用 identity 和 `AbortSignal`，不消费调用信息的 handler 可以省略第三个形参。工具不读取配置文件、解析全局配置或自行应用环境变量；能力来源见[系统架构](ARCHITECTURE.md#会话与单次工具调用)。

## Catalog、exposure 与调用

`compileWorkspaceToolCatalog()` 构建 exposure 前的 effective catalog：

- 未覆盖 built-in 使用内置 definition、executor 与 implementation contract。
- 同名 custom definition 完整替换对外 description/input schema，保留 built-in executor 与 implementation contract。
- custom-only definition 按 Tool config reference 顺序追加；有 route 时绑定 external executor，没有 route 时绑定 unavailable executor。
- built-in 保持 canonical 顺序，override 保持原位置；selector 在 effective names 构建后校验和过滤，过滤不重排。

exposed catalog 同时派生 definitions view 与 route lookup。`createWorkspaceToolService()` 包装已编译 catalog，`tools/list` 与 `tools/call` 因此共享 exposure 边界。隐藏与未知名称统一返回 `Unknown tool`，不运行 validator 或 executor。会话工具视图只能进一步收窄这个边界，见 [setToolList](request-header-policy/on-initialize/set-tool-list.md)。

调用顺序为 effective input validation → built-in implementation validation（适用时）→ executor：

- 未覆盖 built-in 复用同一 validator，不重复执行相同校验。
- override 同时满足 workspace 对外 contract 和 built-in implementation contract。
- custom-only 通过 configured contract 后进入绑定的外部 route；没有 route 时返回标准 unavailable 工具错误。

catalog 固定性、snapshot 分工与共享 service 生命周期见[系统架构](ARCHITECTURE.md#启动与固定运行时)。

## Schema 与 handler 的校验分工

每份 schema 在隔离 resolver context 中同步编译，references 必须在自身 document 内解析，不读取网络、文件或其他 definition。validator 不执行类型转换、default 注入或字段删除，不启用 `format` 校验，并拒绝 `$async` schema。

built-in `inputSchema` 是参数结构的校验边界，表达 required、类型、枚举、简单值域、集合数量与未知字段策略；不接受未知字段时使用 `additionalProperties: false`。handler 在 schema 成功后运行，不重复检查这些结构约束，只处理路径、文件状态、正则可编译性、参数关系与环境条件等运行时语义。

结构负例测试通过 workspace service 或 implementation validator 进入 schema 边界；直接调用 handler 的测试传入满足 schema 的参数。

项目定义的工具名、`inputSchema` 属性名和工具返回 JSON 字段名默认使用 `snake_case`，嵌套属性相同。外部协议、领域固有标识和其他明确约束按各自语义命名；该约定不约束 MCP/JSON Schema 标准字段或内部 TypeScript 标识符。

`description` 直接进入调用 Agent 的上下文，应表达功能边界、输入格式和必要的纠错提示，不放内部实现知识。详细维护说明留在开发文档，不复制进 Tool description。

## 结果与文件能力

结果构造、显式 `isError`、text/image 内容块、`textErrorResult()`、稳定 JSON 约束和字段所有权统一由[工具返回结果](TOOL-RESULTS.md)维护。错误文本应提供安全且可操作的修正方向，不暴露底层敏感信息。

文件工具消费 `ToolRuntimeContext.fileAccessPolicyContext`，遵守[路径安全接入要求](PATH-SAFETY.md#工具接入要求)，不自行实现 allowed roots、glob、ignore/deny 或 realpath 边界。

已有内容按完整字节分类，只对 `text` 解码并执行文本操作；后缀不参与准入。缺失文件与分类异常分开处理，分类失败不授予文本访问。共享分类规则见[内容分类](tools/read.md#内容分类规则)。写入类工具使用 `resolveLineEnding()` 解析 workspace 行尾符策略；保留尾换行、遗漏占位符警告与写入恢复由单工具契约约束。

## 并发与共享资源

写入类工具通过 `withFileLock()` 按文件路径 FIFO 串行化，不同文件互不阻塞；只读工具不获取写锁。锁 registry 清理 idle entry。批次是否构成事务、锁持有范围与失败后的继续行为见[replace_text](tools/replace-text.md#执行顺序与锁)和[write_file](tools/write-file.md#写入策略)。

Android 工具按 workspace 共享可取消 FIFO gate，不同 workspace 独立。active lease 持有到 Gradle drain 与报告后处理结束，不能在返回执行结果时提前转交。queued cancellation、恢复期限和迟到事件隔离见[Android 工具](tools/android-build.md#workspace-gate-与取消)。

外部 HTTP/MCP route 共享 workspace admission 与容量，但各自拥有对应 transport 资源；容量释放依赖 exchange drain，而非 caller-visible settled。细节见[外部路由运行时](external-routing/runtime.md)。

## 验证入口

`npm test -- tools config runtime` 覆盖 definition 加载、双重 contract、catalog/exposure 与 HTTP/MCP 接线；外部执行另运行 `npm test -- external-routing`。验证命令和类型检查要求见[测试](TESTING.md)。

查看 canonical built-in definitions 可显式运行 `node --import tsx test/tools/inspect-tools.ts`；该输出不代表 selected workspace 经 override、custom-only 与 exposure 后的实际工具列表。
