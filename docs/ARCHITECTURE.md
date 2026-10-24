# 系统架构

本文说明应用的模块边界、启动与工具调用主链路，以及共享状态和资源的所有权。文件定位见[项目结构](PROJECT-STRUCTURE.md)，具体契约与例外见[开发入口](DEVELOPMENT.md)中的专题导航。

## 模块边界

| 组件 | 责任 | 边界 |
|-|-|-|
| 进程入口与 CLI | 解析 workspace 选择、启动应用、注册退出信号与报告启动失败 | 不组装 HTTP/MCP 资源，不解释配置字段 |
| 配置 | 加载全局索引和 selected workspace，校验值与路径、编译访问策略、应用允许的环境变量覆盖，构建 snapshot 与 identity | 工具不直接读取配置文件或环境变量 |
| 应用运行时 | 组合 snapshot、catalog、日志、HTTP listener、会话与外部资源，控制启动和关闭 | 配置、catalog 校验先于外部资源构造；资源由创建它的所有者关闭 |
| HTTP/MCP | 接入 Streamable HTTP，管理会话准备、初始化发布和 SDK list/call 接线 | 协议校验交给 SDK；核心接线不解释请求头功能规则 |
| 工具目录与执行 | 编译 definition、validator、executor binding 和 exposure，通过同一 service 提供列表与调用 | 对外 definition 与内部 executor 分离；隐藏工具不能绕过 exposure 调用 |
| 业务工具 | 消费 workspace 能力和单次 invocation，执行工具特有的编排 | 复用文件访问、锁、进程执行等基础设施，不重建共享安全边界 |
| 引擎 | 文本替换、范围选择、字节分类、输出与报告解析 | 算法与文件系统、网络、进程 I/O 分离 |
| 系统基础设施 | 文件访问与读取、有限并发、日志、锁和 Gradle 执行 | 持有实际 I/O 与并发保护；领域特有资源不包装成通用调度框架 |

## 启动与固定运行时

启动入口为 `src/index.ts`，应用组装入口为 `startApplication()`。

```text
CLI workspace id
  → 全局索引校验与 reference 选择
  → selected workspace 校验、策略编译、env override
  → immutable runtime snapshot + identity
  → Tool definitions / external routing artifacts 加载与交叉校验
  → effective catalog → exposure 校验
  → 构造需要的 external runtime，绑定最终 catalog
  → ConfigStore + shared workspace tool service + logger
  → HTTP/MCP 接线与 listener
  → 启动摘要 → 下游 MCP 非阻塞 warm-up
```

全局索引验证所有 reference 的结构，但仅读取被选中 workspace 的配置与关联文件。配置加载的具体顺序和错误归属见[配置概览](CONFIG.md#启动与加载管线)。

snapshot 与 catalog 在启动期构建，职责独立：snapshot 提供 workspace 运行能力，catalog 持有 definitions、validators、executor bindings、source metadata 与 exposure。`ConfigStore` 只提供只读 snapshot、identity 和状态，不提供 reload 或 mutation API；修改配置、策略、definition 或 route 后需要重启。

外部路由的配置、binding 与 exposure 校验成功后才构造 workspace-owned runner、HTTP Agents 和下游连接管理器。构造不发出下游请求；MCP warm-up 在 listener 监听并写入启动摘要后启动，失败由安全 diagnostic 报告，不阻止其他工具工作。具体装配关系见[外部路由](EXTERNAL-ROUTING.md)。

## 会话与单次工具调用

每个上游会话拥有独立的 MCP Server 和 transport；workspace tool service 由所有会话共享。初始化参数可以收窄会话的工具视图或设置 instructions，但不修改共享 catalog。会话列表与调用准入使用同一个受限视图。

初始化资源先登记为 pending；只有对应 initialize result 成功提交、HTTP 正常完成且应用仍接受新会话时，才发布到可路由会话集合。session ID 分配或 HTTP 200 本身不能证明成功。发布条件、观测和失败清理见[请求头策略的会话生命周期](REQUEST-HEADER-POLICY.md#数据流与会话生命周期)。

```text
POST → SDK dispatch（可带 POST-local 请求头上下文）
  → tools/call：创建 invocation identity，读取一次 snapshot
  → 派生 ToolRuntimeContext，捕获本次结果适配方案
  → CALL 日志
  → 会话工具准入
  → workspace effective input validation
  → built-in implementation validation（适用时）
  → executor
  → 稳定 JSON / MCP 结果校验
  → 捕获的结果适配 → RESULT 日志
  → SDK schema parse → transport
```

两类 handler 输入分开传递：

- `ToolRuntimeContext` 是从 snapshot 派生的 workspace 能力，包括文件访问策略、行尾符和 Android 配置。
- `ToolInvocationContext` 是本次调用的服务端 call ID、客户端 request ID、session ID 与 `AbortSignal`。调用身份和取消信号不放入 workspace snapshot。

请求头实现通过内部阶段契约接入会话准备、POST context 和结果适配。HTTP、工具调用核心与通用 Logger 消费阶段结果，不解析功能规则；这些 hook 是可信同步内部实现，不是动态插件 API。具体阶段和隔离条件见[请求头策略](REQUEST-HEADER-POLICY.md#内部阶段扩展点)。

工具准入、输入校验与 executor 的可恢复失败进入统一工具结果管线；SDK 协议级错误不属于 `ToolCallResult`。完整结果契约、字段所有权和适配语义见[工具返回结果](TOOL-RESULTS.md)。

## 状态与资源所有权

| 范围 | 持有内容 | 生命周期限制 |
|-|-|-|
| 应用 / selected workspace | 固定 snapshot、identity、catalog、workspace service、listener、logger、外部路由运行时 | 会话退出不能关闭这些共享资源 |
| 上游会话 | Server、transport、初始化设置、受限工具视图 | pending 阶段也必须纳入关闭；关闭传播到该会话的调用 |
| 单次 POST / invocation | raw header view、call identity、取消信号、捕获的 snapshot 与结果方案 | 请求头上下文不缓存为会话结果策略；并发请求相互隔离 |
| Android workspace | 进程内共享 Gradle gate registry 中的 workspace FIFO、active lease | gate 持有到执行 drain 和报告处理结束；迟到事件不得影响新 lease |
| 外部路由 workspace | 共享 admission、HTTP Agents、Processor runner、按 server identity 共享的下游 MCP manager | HTTP/MCP 共用容量；caller-visible settled 不等于资源 drained |

写入类工具使用按文件路径串行化的共享锁，只读工具不获取写锁。Android gate 的 confirmed/optimistic drain 与外部路由的 exchange drain 有各自的资源语义，不能把“结果已返回”当作释放资源的统一判据。细节分别见[工具并发约束](TOOLS.md#并发与共享资源)、[Android 工具](tools/android-build.md#workspace-gate-与取消)和[外部路由运行时](external-routing/runtime.md)。

## 关闭与失败隔离

`ApplicationLifecycle.close()` 幂等，所有调用者获得同一个 completion promise。关闭顺序为：

1. 停止新会话与 listener 的新连接准入，启动 Android 取消。
2. 关闭 pending 与 published 上游会话，使在途调用和长连接能够释放。
3. 等待 listener drain 与 Android barrier。
4. 关闭 external runtime，完成其 admission 停止、取消与资源 drain。
5. 关闭 logger。

不能先等待 listener 的长连接 drain，再关闭持有这些连接的会话。单阶段失败不阻止后续阶段清理；失败被汇总报告。单会话关闭与应用整体关闭分开，不能重复关闭 SDK 已拥有的 transport，也不能关闭 workspace 共享的下游 session。

CALL / RESULT 日志和 diagnostic 失败与有效工具结果隔离；初始化发布观察也不能改变握手结果。该隔离不表示任意扩展异常均可吞掉或 fail-open。日志输出内容与隐私边界见[日志](LOGGING.md)，外部资源关闭见[外部路由运行时](external-routing/runtime.md)。
