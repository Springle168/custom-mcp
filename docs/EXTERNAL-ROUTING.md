# External Routing

External routing 为 selected workspace 的 custom-only Tool 提供 HTTP endpoint 或下游 MCP Server 执行 route。Tool config v2 以 definition reference `id` 连接 External routing config v2；两种 route 共用 workspace 范围的 admission、生命周期和资源所有权。

本机制不为 built-in Tool 增加 external route，也不改变同名 custom override 的内置 executor。配置只在启动期读取，修改任一引用配置后需要重启服务。

## HTTP 与 MCP 的边界

| 维度 | HTTP route | MCP route |
|-|-|-|
| 对接边界 | 配置且受信任的 HTTP endpoint 与本地 Processor。 | 独立 MCP Client 调用配置的 Streamable HTTP Server。 |
| 调用协议 | 单调用 canonical JSON，可通过一个 request stage 和一个 response stage 编解码或过滤。 | 下游 `tools/call`，直接使用本地 definition 的 Tool name 与已校验 arguments。 |
| 结果适配 | 校验 canonical response，将 text/image/unknown 逐块映射为 MCP 结果。 | 接受项目支持的下游 text/image 结果字段，不把不支持的内容转成文本。 |
| 共享资源 | Owner-scoped HTTP/HTTPS Agents；需要时共享 Processor runner。 | 按 server config real path 共享 Client、transport 和下游 session。 |
| 下游发现 | 不适用。 | 不调用 `tools/list`，不导入或映射下游 Tool。 |

External executor 不接收 workspace roots 或本地文件访问能力；这不构成对本地 Processor 的 sandbox。权限、敏感信息和资源所有权边界见[运行时专题](external-routing/runtime.md)。

## 配置引用关系

入口是 selected workspace 的 `tools.toolConfigFile`：

```text
workspace tools.toolConfigFile
  └─ Tool config v2
       ├─ definitions[]: id + toolDefinitionFile
       └─ externalRoutingConfigFile
             └─ External routing config v2
                  ├─ processorConfigFile (optional)
                  └─ routes[]
                       ├─ routingMode: http → httpEndpointConfigFile + routingStrategy
                       └─ routingMode: mcp  → mcpServerConfigFile
```

Tool config 与 definition 字段由[自定义 Tool 配置](config/tool-config.md)维护；路由配置版本、路径规则、strict union、Processor registry 和 endpoint/server 字段见[配置专题](external-routing/configuration.md)。

## 启动与 binding

启动期先读取并编译 Tool config 和全部 definition，再加载 External routing config、显式 Processor registry 以及 route 引用的 endpoint/server config。随后校验 definition binding、Processor reference 与 workspace exposure，构建 effective / exposed catalog。

Binding 使用 `definitions[].id`，不是 Tool `name`。Custom-only definition 有 route 时绑定对应 executor，没有 route 时绑定 deterministic unavailable executor；built-in override 保持 built-in executor，不能声明 route。隐藏 definition 和 route 仍完成全部启动校验，但调用隐藏 Tool 返回 `Unknown tool`。

纯配置与 catalog 校验成功且至少存在一条 route 后，才创建共享 admission runtime，并按协议需要创建 HTTP / Processor 资源和 MCP connection manager。`routes: []` 合法，不创建这些外部资源。

配置加载和 runtime 构造不发送下游请求。HTTP listener 成功监听并输出启动摘要后，才非阻塞 warm-up 每个 MCP server identity 一次。连接失败仅记录安全 diagnostic，不阻止 listener 或其它工具工作。

## 按任务导航

| 任务 | 维护入口 |
|-|-|
| 配置 route、核对引用、理解启动校验错误 | [配置与跨文件校验](external-routing/configuration.md) |
| 实现或维护 canonical endpoint、Processor stage 和结果映射 | [HTTP route](external-routing/http-route.md) |
| 排查下游连接、warm-up、调用取消或 session drain | [MCP route](external-routing/mcp-route.md) |
| 修改共享容量、字节限制、失败分类、取消、资源关闭或诊断隐私边界 | [运行时边界](external-routing/runtime.md) |
| 查看启动摘要和诊断日志格式 | [日志](LOGGING.md) |
| 定位源码职责和测试目录 | [项目结构](PROJECT-STRUCTURE.md) |
| 理解应用组装与全局关闭顺序 | [架构](ARCHITECTURE.md) |
| 独立编写 custom-only Tool definition 或 Processor | [自定义 Tool 编写契约](CUSTOM-TOOL-AUTHORING.md) |
