# 请求头策略开发说明

请求头策略由 selected workspace 显式配置，分为会话初始化与单次工具结果两个阶段。本文承接配置契约、客户端参数、跨层数据流、会话资源所有权、错误与隐私边界；workspace 的其他字段见 [workspace 配置](config/workspace-config.md)，结果字段所有权见 [工具返回结果](TOOL-RESULTS.md)，日志格式见 [日志](LOGGING.md)。

## 职责与边界

| 阶段 | 功能 | 生命周期 |
|-|-|-|
| `onInitialize` | `setToolList`、`setInstructions` | 在新会话初始化时读取参数，设置在会话内固定。 |
| `onCallToolResult` | `structuredContentDup` | 每次 `tools/call` 开始时按该 POST 的请求头计算，执行完成后适配结果。 |

请求头是客户端自报数据，不是身份认证。策略不能选择 workspace、扩大文件权限、修改工具参数、选择 executor、重编译 catalog 或把 header 转发到下游。

初始化设置只减少 workspace 已暴露工具集合，并可指定该会话 initialize response 的说明文本。MCP Server 始终声明 `tools: {}` capability，空工具集合也不撤销此声明。服务不提供任意 capabilities 改写、会话内设置更新或 `tools/list_changed` 通知。

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

策略不增加可配置 header 大小上限，也不扩容 Node HTTP 的 header 总大小限制。换行应通过单行 JSON 中的 `\n` 表达；非 ASCII 文本可用 JSON Unicode escape，避免客户端对 header 编码的限制。长说明不适合经请求头传输。

## 初始化功能参数

### `setToolList`

绑定的请求头值必须是 JSON object，顶层仅允许必填 `toolList`，类型为 string 数组。名称 grammar 是 `^[A-Za-z0-9._-]{1,128}$`，区分大小写、不 trim；重复名称无效。空数组合法。

设 workspace 已暴露集合为 `W`，客户端请求集合为 `H`，会话集合为 `S`：

- header 缺失时，`S = W`。
- header 合法时，`S = W ∩ H`。
- `toolList: []` 或所有名称均被过滤时，`S` 为空。

grammar 合法但未在 `W` 中暴露的名称正常过滤，不透露它属于未定义还是被禁用。列表顺序按 workspace definitions view 保留，客户端数组不控制排序。

选择依据是调用名称而非 definition reference id，适用于内置与 custom-only 工具。不能重新启用 workspace 禁用工具、替换 definition 或改变 external binding。

会话视图的同一集合同时约束 `tools/list` 与 `tools/call`。不在集合内的调用返回标准 `Unknown tool: <name>` 错误结果，不进入 validator 或 executor；该结果仍经过本次工具结果策略。会话只持有受限视图，validators、executors 与共享运行资源继续归 workspace service 所有。

### `setInstructions`

绑定的请求头值必须是 JSON object，顶层仅允许必填 `instructions`，类型为 string。文本原样保留，不 trim、不追加默认文本、不模板展开。

缺失 header 或空字符串都不在 initialize response 中发送 instructions。metadata 能区分未应用与主动设置空值。非空文本通过 Server options 交给 SDK 序列化。

instructions 是本会话的说明数据，不是服务端命令或权限指令。服务端不执行文本、不传给 executor 或下游；客户端如何展示或交给模型使用由客户端决定。后续请求不能修改说明，重新选择设置需要新会话。

## 数据流与会话生命周期

### 启动与调用

```text
selected workspace v2 → 静态规则校验 / 归一化 → immutable snapshot
workspace definitions / exposure / bindings → compiled catalog → shared tool service

POST rawHeaders → strict view → AsyncLocalStorage
  → tools/call 开始时捕获 snapshot 与结果 policy
  → 会话工具准入 → workspace 校验与 executor
  → 结果校验 → adapter → result logger → SDK / transport
```

`AsyncLocalStorage` 只传播单次 POST 的 strict header view，不保存会话 policy。调用开始时计算一次结果 policy，跨异步执行保留局部值，结束时不重算。并发请求上下文隔离，会话工具视图隔离，workspace 运行资源共享。

`structuredContentDup` 在工具执行与 JSON / MCP 结果校验之后应用。成功、会话准入失败、catalog 校验错误、executor 错误和受控 malformed-result 都经过同一返回管线；SDK 协议级错误不是 ToolCallResult，不进入 adapter。具体字段覆盖、对象身份与图片序列化代价由 [工具返回结果](TOOL-RESULTS.md#structuredcontent-适配) 承接。

### 初始化入口与发布

新会话初始化先解析参数，再构造受限工具视图与独立 Server，因为 instructions 属于 Server 构造选项。后续带 session ID 的 POST 不读取初始化参数；即使这些参数头损坏或重复，也不重设会话或拒绝普通工具调用。重复 initialize 由 SDK 处理。

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

shutdown 先停止新准入和 listener 的新连接准入，并启动 Android runtime 取消。pending 与 published 会话随后关闭以释放请求，listener drain 在会话关闭后等待；Android settle、external runtime 与 logger 的关闭由 application lifecycle 继续完成。

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

## 源码与测试索引

| 源码 | 职责 |
|-|-|
| `src/config/request-header-rules.ts` | 两阶段静态 schema、功能名称和 runtime rules。 |
| `src/config/schema.ts`、`runtime-snapshot.ts` | workspace v2 接入、snapshot 复制与冻结。 |
| `src/runtime/request/request-header-view.ts` | raw 输入与 duplicate 状态。 |
| `src/runtime/request/request-context.ts` | 本次 POST 的 AsyncLocalStorage 生命周期。 |
| `src/runtime/request/initialize-header-policy.ts` | 初始化 JSON 参数、不可变设置、安全错误与 metadata。 |
| `src/runtime/request/request-header-policy.ts` | 工具结果匹配、feature 并集与脱敏 metadata。 |
| `src/runtime/mcp/session-tool-service.ts` | 会话列表与准入共用的受限工具视图。 |
| `src/runtime/mcp/mcp-post-handler.ts`、`http-app.ts` | 策略入口、HTTP 响应、session 工厂与发布。 |
| `src/runtime/mcp/initialization-tracking-transport.ts` | 公开 send 的初始化 result 成功观测。 |
| `src/runtime/mcp/initialization-http-completion.ts` | HTTP 正常完成与提前中断的公共事件观测。 |
| `src/runtime/mcp/pending-session.ts` | connect 前资源所有权、幂等关闭与关闭信号。 |
| `src/runtime/mcp/mcp-server.ts` | Server options、tools/list 与 tools/call 接线。 |
| `src/runtime/invocation/tool-call-handler.ts`、`tool-result-adapter.ts` | 单次 policy 捕获、结果校验后适配与日志。 |
| `src/runtime/application/`、`src/utils/logger.ts` | pending / published 生命周期与日志输出。 |

| 测试 | 关注点 |
|-|-|
| `test/config/request-header-rules.test.ts` | workspace 版本、两阶段 schema、绑定唯一性、selected-only snapshot 与冻结、env 禁止覆盖。 |
| `test/runtime/initialize-header-policy.test.ts` | 参数 grammar、缺失与显式空值、原样说明、安全错误与 metadata、整体失败。 |
| `test/runtime/request-header-view.test.ts` | rawHeaders 输入、重复状态与名称大小写。 |
| `test/runtime/request-header-policy.test.ts` | 精确匹配、AND / 并集、重复 header 和上下文缺失。 |
| `test/runtime/session-tool-service.test.ts` | 工具交集、顺序、列表与准入一致、独立会话、共享 validator / binding 和错误结果适配。 |
| `test/runtime/initialization-tracking-transport.test.ts` | 公开 send 的对应 request ID、fulfilled result / error / rejection 与停止等待。 |
| `test/runtime/pending-session.test.ts` | connect 前、期间及失败时的资源所有权与幂等 close。 |
| `test/runtime/mcp-post-request-context.test.ts` | POST 上下文、合法 envelope、双完成条件、提前中断、connect / shutdown 与日志失败隔离。 |
| `test/runtime/request-header-integration.test.ts` | 真实 HTTP 初始化 object / 单元素数组、instructions、会话交集与准入、参数错误隐私、SDK 拒绝、pending shutdown。 |
| `test/runtime/http-app.test.ts` | 真实 HTTP 接线、会话隔离与 session 路由。 |
| `test/runtime/application-lifecycle.test.ts` | shutdown 顺序、即时停止准入、幂等关闭与多资源失败隔离。 |
| `test/runtime/mcp-server-tool-exposure.test.ts` | SDK list / call 接线、共享 service 与结果往返。 |
| `test/runtime/tool-call-handler.test.ts` | 调用 policy 捕获、返回管线与失败隔离。 |
| `test/runtime/tool-result-adapter.test.ts` | 条件覆盖、不修改原对象、扩展字段与 wrapper。 |
| `test/logger/request-header-rules-logging.test.ts` | Rules 行、纯文本日志、结果正文与隐私边界。 |

测试组织和命令见 [测试](TESTING.md)。维护新增功能时，先确定所属阶段、输入契约、生命周期和权限边界；配置层不依赖 HTTP / catalog，executor 不依赖请求头策略模块。
