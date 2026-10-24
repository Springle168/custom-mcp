# 请求头策略开发说明

请求头策略由 selected workspace 显式配置，分为会话初始化与单次工具结果两个阶段。本文承接阶段配置、公共输入边界、跨层数据流、会话资源所有权、错误与隐私边界；具体功能的参数与效果由下列子专题维护。

workspace 的其他字段见 [workspace 配置](config/workspace-config.md)，结果字段所有权见 [工具返回结果](TOOL-RESULTS.md)，日志格式见 [日志](LOGGING.md)。

## 职责与边界

| 阶段 | 功能 | 生命周期 |
|-|-|-|
| `onInitialize` | `setToolList`<br>`setInstructions` | 在新会话初始化时读取参数，设置在会话内固定。 |
| `onCallToolResult` | `structuredContentDup` | 每次 `tools/call` 开始时按该 POST 的请求头计算，执行完成后适配结果。 |

### 阶段与功能专题

- `onInitialize` 阶段：
  - [setToolList](request-header-policy/on-initialize/set-tool-list.md)
  - [setInstructions](request-header-policy/on-initialize/set-instructions.md)
- `onCallToolResult` 阶段：
  - [structuredContentDup](request-header-policy/on-call-tool-result/structured-content-dup.md)

### 边界约束

请求头是客户端自报数据，不是身份认证。策略不能选择 workspace、扩大文件权限、修改工具参数、选择 executor、重编译 catalog 或把 header 转发到下游。

初始化设置作用于本会话的工具视图与说明，不修改共享 catalog 或工具实现，也不提供任意 capabilities 改写。具体参数、空值和响应行为见各功能专题。

结果策略不缓存到会话、不继承初始化请求头，也不干预业务执行。GET / DELETE 不应用这两个阶段；工具结果策略归属于触发调用的 POST，而不是接收结果的 GET SSE 通道。

## 配置契约

workspace 配置要求 JSON number `version: 2`。全局索引、Tool config 与 External routing config 有各自独立的版本契约；workspace 版本不驱动其他文件版本。

两阶段请求头规则的具体配置见 [workspace 配置示例](../examples/workspace-config.example.json)。示例中的路径和值需要替换为本机有效配置，字段与运行时契约由下文说明。

`rules` 只允许 `requestHeaders`，后者只允许 `onInitialize` 与 `onCallToolResult`。缺失 object 或阶段、空 object 与空阶段数组均归一化为两个数组，缺失数组为 `[]`。`null`、错误类型与未知字段无效；`requestHeaders` 必须是 object，不能是数组。

只有 selected workspace 的规则进入不可变 runtime snapshot。`version` 与 `rules*` 禁止 env override；配置没有 watcher 或 reload API，修改后需要重启。配置解析不转换或重写文件。

### `onInitialize`

每项恰好包含两个必填字段：

| 字段 | 契约 |
|-|-|
| `readHeader` | 符合 HTTP token grammar 的 header name，按 lowercase 保存，不 trim。 |
| `apply` | 精确的 `setToolList` 或 `setInstructions` string。 |

同一阶段中，每个 `apply` 最多配置一次，lowercase 后的 `readHeader` 也必须唯一。配置顺序用于稳定的校验和 metadata 顺序，不表示覆盖优先级。

初始化规则不接受 `match`、`enable`、自定义 schema、默认值或脚本。相同 header name 可以在结果阶段作为独立匹配条件出现，两阶段没有隐式联动。未配置的功能不会解析客户端参数；功能启用权来自配置，不来自客户端 header 内容。

### `onCallToolResult`

每项恰好包含必填的 `match` 与 `enable`：

- `match` 是非空 object；header name 满足 HTTP token grammar 并按 lowercase 保存，同一 match 中归一化后重复名称无效。
- match value 是非空、无首尾 whitespace 的 string，不允许除 HTAB 外的 ASCII control character 或 DEL；配置诊断不输出期望 value。
- `enable` 是非空数组，只接受精确的 `structuredContentDup`，同一规则内不能重复。

单条规则的条件采用 AND，所有命中规则的 feature 取并集并去重。没有首条命中或覆盖优先级。阶段与功能的组合在配置解析时校验，初始化功能不能出现在结果阶段。

## 请求头输入边界

`createStrictRequestHeaderView()` 从 Node `req.rawHeaders` 的 name/value 对建立 strict view。header name 按 lowercase 查找，重复名称保留为 duplicate 状态，不使用 Node 的合并值，也不拆分逗号值。raw 输入长度为奇数或包含非 string 项时，整个 view 无效。

结果阶段进行精确、区分大小写的 value 比较，不 trim、不解释 JSON。引用 header 缺失或重复时，该条件不匹配；无关 header 重复不影响匹配。缺少请求上下文或 strict view 无效时，不启用结果 feature，也不拒绝工具执行。

初始化阶段对已配置的参数头使用另一套输入契约：

| 参数头状态 | 行为 |
|-|-|
| 缺失 | 不应用功能，保留默认设置。 |
| 单个合法 JSON object，字段和值符合功能契约 | 应用功能。 |
| 重复，即使 value 相同 | 初始化参数错误。 |
| 空 value 或 JSON 语法损坏 | 初始化参数错误。 |
| `null` / array 等错误顶层类型、缺字段、未知字段、错误值 | 初始化参数错误。 |
| strict view 无效且存在初始化绑定 | 初始化参数错误，不回退完整工具列表。 |

未配置的 header 不作功能解析，其损坏 JSON 或重复状态不影响已配置功能。无初始化绑定时，策略不因无效 strict view 增加拒绝。Node / HTTP 自身仍负责传输合法性。

参数先经过标准 `JSON.parse`，再校验内置契约；不另行检测重复 JSON 属性，采用 `JSON.parse` 的最后同名属性语义。全部参数验证成功后才返回不可变设置，不产生部分成功会话。

策略不增加可配置 header 大小上限，也不扩容 Node HTTP 的 header 总大小限制。换行应通过单行 JSON 中的 `\n` 表达；非 ASCII 文本可用 JSON Unicode escape，避免客户端对 header 编码的限制。

## 数据流与会话生命周期

### 内部阶段扩展点

`src/runtime/runtime-extensions.ts` 定义轻量的内部阶段契约，应用组装层通过 `createRequestHeaderExtensions()` 按已配置规则接入请求头策略。没有规则的阶段不安装 hook；没有结果规则时不安装 POST context 桥接。核心 HTTP、MCP Server、工具调用管线和通用 Logger 只消费阶段结果，不解释 header 规则或 feature。

- `prepareSession` 在合法新 initialize 的资源构造前同步准备最终 `toolService` 和 `instructions`，或返回安全的参数拒绝信息。核心负责发送拒绝响应，策略负责参数分类和安全失败摘要。
- `runWithPostContext` 从本次 POST 的 rawHeaders 建立 strict view，并在 AsyncLocalStorage 中运行 SDK dispatch。桥接只传播输入，不计算或缓存会话结果 policy。
- `prepareToolResult` 使用本次调用已捕获的 snapshot 和当前 strict view，一次性生成结果适配闭包和日志摘要 supplier。核心在结果校验后适配，再在受保护的日志路径中求摘要。

这些 hook 是可信同步内部实现，不是动态插件 API，也没有通用插件异常吞噬或 fail-open 行为。策略不持有 session 目录、transport、Response 或资源生命周期控制权。发布观察回调只接收已发布 session ID，核心不等待回调并隔离同步异常及异步 rejection。

### 启动与调用

```text
selected workspace v2 → 静态规则校验 / 归一化 → immutable snapshot
workspace definitions / exposure / bindings → compiled catalog → shared tool service

startApplication → 按阶段规则组装请求头扩展
POST rawHeaders → context 桥接 / strict view / AsyncLocalStorage
  → tools/call 开始时捕获 snapshot → prepareToolResult
  → 会话工具准入 → workspace 校验与 executor
  → 结果校验 → 捕获的适配闭包 → 摘要 supplier / result logger → SDK / transport
```

`AsyncLocalStorage` 只传播单次 POST 的 strict header view，不保存会话 policy。调用开始时计算一次结果 policy，跨异步执行保留局部值，结束时不重算。并发请求上下文隔离，会话工具视图隔离，workspace 运行资源共享。

结果阶段功能在工具执行与 JSON / MCP 结果校验之后应用。成功、会话准入失败、catalog 校验错误、executor 错误和受控 malformed-result 都经过同一返回管线；SDK 协议级错误不是 ToolCallResult，不进入 adapter。具体字段覆盖、对象身份与序列化影响由各结果阶段功能专题维护。

### 初始化入口与发布

新会话初始化通过 `prepareSession` 先解析参数并准备受限工具视图，再构造独立 Server，因为 instructions 属于 Server 构造选项。后续带 session ID 的 POST 不读取初始化参数；即使这些参数头损坏或重复，也不重设会话或拒绝普通工具调用。重复 initialize 由 SDK 处理。

策略入口接受合法 request object 或单元素 `[initializeRequest]`。候选同时通过 SDK 导出的 `JSONRPCRequestSchema` 与 `InitializeRequestSchema`，关联 ID 来自合法 envelope。其他数组和非法输入不触发参数功能，继续由 SDK 负责协议校验。

```text
合法新会话 initialize
  → strict view / 全部参数校验
  → immutable 设置 / 会话工具视图
  → 创建 Server 与 transport，登记 pending 所有权
  → connect / SDK handleRequest
  → 对应 initialize result 经公开 send 成功提交
  → HTTP 正常完成，会话未关闭，应用仍接受新会话
  → 同步转移到 published sessions
```

session ID 可能早于成功响应分配，HTTP 200 也可能承载 JSON-RPC error，两者不能单独证明初始化成功。`InitializationTrackingTransport` 只通过公开 `send(message, options)` 观测指定 request ID 的 result / error；不修改内容、不解析 SSE、不访问 SDK 私有字段。

正常 HTTP 终结时，没有对应 send 或已提交 error / send 失败则不能发布；对应 send 已开始但未终结时等待其终结。发布不等待客户端 `notifications/initialized`，也不另设握手 timeout。send fulfilled 证明提交到底层 transport，不证明网络送达。

`observeInitializationHttpCompletion()` 使用 response `finish` / `close` / `error` 和 request `aborted` 区分正常完成与提前中断。普通 request `close` 不是失败判据，正常 response close 不撤销已完成成功。提前中断或会话关闭终结等待并禁止发布，发布或清理时释放事件监听和初始化观测。

### Pending 资源所有权与 shutdown

未发布 Server / transport 纳入 application 的 pending 跟踪，登记早于第一次异步 connect。pending 不是可路由会话目录；只有发布后的 sessions Map 用于后续请求查找。

会话工厂同步创建未连接资源，入口登记所有权后才开始 connect。已创建会话因 connect、handleRequest、协议拒绝、中断或 shutdown 不能发布时，入口负责最终关闭；工厂与入口的内部异常使用安全错误路径。关闭操作幂等；SDK 已持有 transport 时通过 `server.close()` 释放，否则由所有者关闭 transport，不无条件分别关闭两次。关闭会话不关闭共享 workspace service 或 external runtime。

Application lifecycle 在 shutdown 中关闭 pending 与 published 会话以释放请求；等待 listener drain 前必须先启动会话清理。全局关闭顺序与跨阶段失败隔离见[系统架构](ARCHITECTURE.md#关闭与失败隔离)。

发布前再次检查 admission，并同步完成 pending 到 published 的转移。清理失败不能改写已发送响应或阻止其他会话清理。

## 错误与隐私

| 边界 | 行为 |
|-|-|
| workspace 版本、规则结构、重复绑定或错误阶段功能 | 启动期 `ConfigError`，关联 selected workspace 文件与字段。 |
| 合法 initialize 的客户端参数错误 | HTTP 400，JSON-RPC error `-32602`，关联原 request ID，不创建会话或返回 session ID。 |
| JSON-RPC、transport header、协议协商或重复握手 | SDK 负责，不映射为 feature 参数错误。 |
| 初始化内部异常 | 尚未发送响应时返回 HTTP 500 / JSON-RPC `-32603`；已开始响应时不重复发送 JSON，清理未发布资源，不输出异常对象。 |
| 调用名称不在会话工具集合 | 标准 Unknown tool ToolCallResult，继续结果适配。 |
| 结果规则未命中、引用 header 缺失 / 重复或上下文缺失 | 不启用 feature，不拒绝执行。 |

参数错误分类为 `invalid_header_view`、`duplicate_header`、`invalid_json`、`invalid_payload`。响应仅使用配置规则位置、安全分类和内置字段名；不插入未知 JSON key、无效工具名或 JSON.parse 异常文本。参数错误与 transport 错误同时存在时，不承诺跨边界错误优先级。

初始化成功日志只接收 session ID、应用规则位置与 feature；参数失败只接收规则位置与安全分类，不记录临时 SDK session ID。结果 metadata 只包含结果阶段是否配置规则、命中位置和 enabled feature。两阶段摘要分开，只有结果阶段规则控制工具日志的 `Rules:` 行；格式见 [日志](LOGGING.md)。

策略日志与参数错误响应不包含 header name/value、instructions 文本、客户端工具列表、原始 JSON 或异常对象。成功初始化响应按功能契约提供 instructions，并声明 `tools: {}` capability；工具列表通过该会话的 `tools/list` 提供。日志失败不改变有效策略、不阻止成功握手或工具调用，也不触发重复响应。这一边界不对工具参数和业务结果进行通用脱敏；既有工具日志仍按自己的契约记录内容。

## 验证重点

运行 `npm test -- config runtime logger`，按以下边界验证，而不是只检查规则匹配：

- 配置与输入：selected-only snapshot、冻结和 env 禁止覆盖；header 名称大小写、raw duplicate 状态、精确匹配、AND / 并集，以及缺失与显式空值的区别。
- 会话隔离：工具交集的顺序、list / call 准入一致、instructions 原样传递；会话受限视图隔离，validator、binding 和 workspace 资源共享。
- 初始化发布：合法 object / 单元素数组 envelope、对应 request ID 的公开 send 结果、HTTP 完成双条件；提前中断、connect 失败、协议拒绝与 shutdown 均不能留下可路由的未发布会话。
- 调用管线：POST 上下文并发隔离，调用开始时捕获结果方案，业务成功、准入失败、catalog 错误和受控 malformed-result 均在校验后适配；SDK 协议错误不进入 adapter。
- 隐私与恢复：真实 HTTP 与生产启动组装下，参数错误响应和策略日志均不含 header name/value、客户端工具列表、instructions 或异常对象；日志失败不能破坏握手、工具调用或多资源清理。

测试约定见[测试](TESTING.md)。维护新增功能时，先确定所属阶段、输入契约、生命周期和权限边界；配置层不依赖 HTTP / catalog，executor 不依赖请求头策略模块。
