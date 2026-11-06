# 自定义 Tool 配置

selected workspace 的 `tools.toolConfigFile` 可选地引用一份 Tool config v2。该文件以独立的 Tool definition 文件定制 `tools/list` 对外暴露的工具名称、描述和输入 schema；可选 `externalRoutingConfigFile` 则为 custom-only definition 提供按 `definitionId` 绑定的外部执行 route。

---

## 在 workspace 中启用

在 selected workspace 的 `tools` 段中，将 `toolConfigFile` 设置为 Tool config 文件的本地绝对路径。

`toolConfigFile` 必须是无首尾 whitespace 的本地绝对路径。Windows 下只接受 drive-absolute 路径；不接受相对路径、UNC、namespace、drive-relative、rooted-without-drive 或 `~`。该文件不要求位于 workspace 的 allowed roots 内。

`toolConfigFile` 可以与 `enabled` 或 `disabled` 并存；两者的 exposure 规则见 [workspace 配置](workspace-config.md#tools)。

---

## Tool config v2

Tool config 必须是合法 JSON object，顶层只允许下列字段：

| 字段 | 类型 | 必填 | 说明 |
|-|-|-|-|
| `version` | `2` | 是 | Tool config schema version。 |
| `definitions` | object[] | 是 | 有序的 Tool definition reference 列表；空数组合法。 |
| `externalRoutingConfigFile` | local absolute path | 否 | External routing config v2 文件。 |

每个 `definitions[]` reference 只允许下列字段：

| 字段 | 类型 | 必填 | 说明 |
|-|-|-|-|
| `id` | string | 是 | 配置内稳定的 definition reference identity。 |
| `toolDefinitionFile` | local absolute path | 是 | 对应 Tool definition 文件。 |

`id` 必须匹配 `^[A-Za-z0-9._-]{1,128}$`，并且在同一 Tool config 内唯一。它用于 definition 文件错误的 source metadata，也作为 External routing config 中 route 的 `definitionId` binding key，不是工具调用名称。

`toolDefinitionFile` 和 `externalRoutingConfigFile` 都遵循与 `toolConfigFile` 相同的本地绝对路径边界。引用文件不要求位于 workspace allowed roots 内。

最小示例见 [Tool config](../../examples/tool-config.example.json) 和 [custom-only Tool definition](../../examples/tool-definition.example.json)；使用前替换其中的本地绝对路径和值。External routing 的配置、示例与执行契约见 [External routing](../EXTERNAL-ROUTING.md)。

---

## Tool definition 文件

源 definition 必须是合法 JSON object，且顶层只允许以下字段。加载器保留声明和文件来源，definition 编译器解释指令并生成标准 MCP definition；项目指令不会进入 `tools/list`、调用参数或下游协议。

| 字段 | 类型 | 说明 |
|-|-|-|
| `name` | 必填 string | 稳定名称，用于内置 override 匹配、workspace exposure 和内部执行身份。 |
| `$alias` | 可选 string | 对外调用名称；省略时使用稳定名称。 |
| `description` | 可选 string | 对外顶层描述；至少包含一个非 whitespace 字符。 |
| `$inheritTopDescription` | 可选 boolean | `true` 表示沿用同名 built-in 的顶层描述。 |
| `inputSchema` | 可选 JSON Schema object | 显式的完整输入 Schema；未继承时必填。 |
| `$inheritInputSchema` | 可选 boolean | `true` 表示沿用同名 built-in 的完整输入 Schema。 |

`name` 与 `$alias` 都必须匹配 `^[A-Za-z0-9._-]{1,128}$`，区分大小写，不 trim 或归一化。别名可以等于自身稳定名称。未知顶层字段、错误类型与 `null` 均无效，不因字段以 `$` 开头就放行。同一 Tool config 内稳定名称必须唯一，即使别名不同或工具被隐藏也不能重复。

### 描述与 Schema 的选择

- 显式 `description` 与 `$inheritTopDescription: true` 互斥。两者都不提供时，最终 definition 省略描述，不补空字符串；内置继承对象本身没有描述时也省略。
- 显式 `inputSchema` 与 `$inheritInputSchema: true` 互斥。两者都不提供时启动失败，包括 built-in override。
- 两个继承指令各自独立。`false` 与省略等价，可以与对应显式字段并存。
- 继承只读取 registry 中同稳定名称 built-in 的原始定义，不受别名、其他 custom definition 或文件顺序影响。custom-only 设置任一继承指令为 `true` 都会启动失败，不支持 custom 链式继承或下游 Schema 发现。
- 未被 custom definition 覆盖的 built-in 保持自身定义；源 definition 省略描述不表示自动沿用内置描述。

显式 `inputSchema` 使用 JSON Schema Draft 2020-12，根 `type` 必须精确为 `"object"`。`$schema` 可省略；出现时必须精确为 `https://json-schema.org/draft/2020-12/schema`。若包含 `properties`，其每个直接 property schema 都必须使用 object 形式，不能使用 boolean schema。

显式 Schema 完整替换对外输入契约，不与内置 Schema 合并；继承则保留完整参数描述、required 和未知字段约束。Schema 内的标准 `$schema`、`$ref` 按 JSON Schema 语义处理，不作为项目指令，编译器不递归扫描 Schema 或普通数据解释指令。

Schema 的隔离编译、引用解析与校验行为见[工具校验分工](../TOOLS.md#schema-与-handler-的校验分工)。内置工具的别名与继承示例见 [read definition](../../examples/read.override.example.json)。

---

## 加载、binding 与调用行为

Tool config、全部源 definitions 与已引用的外部路由配置在启动期读取和校验，隐藏工具也不跳过校验。运行期不重新读取这些配置；修改后需要重启服务。

源 definition 的稳定 `name` 与内置 Tool 同名时属于 built-in override，`$alias` 不参与匹配。override 可以定制对外 definition，但不能更换内置执行实现，也不能通过放宽显式 `inputSchema` 解除内置实现的输入限制。External route 只能绑定 custom-only definition；override 即使配置别名也不能绑定 route。

custom-only definition 的 executor 由其 definition reference `id` 决定：

- External routing config 为该 `id` 声明 route 时，配置后的输入校验成功会进入该 route 的外部 executor。
- 没有 route 时，definition 仍可暴露且输入仍会校验；调用返回 deterministic unavailable route 工具错误。

Route 不按稳定名称或别名匹配；引用校验和下游名称规则见[外部路由配置](../external-routing/configuration.md#route-union-与-binding-校验)。外部 artifact 的加载与空 route 行为见[外部路由启动与 binding](../EXTERNAL-ROUTING.md#启动与-binding)。

catalog 的合并、exposure、名称冲突与调用校验机制见[工具开发](../TOOLS.md#catalogexposure-与调用)；启动资源装配与失败清理见[系统架构](../ARCHITECTURE.md#启动与固定运行时)。

---

## 错误归属

Tool config、Tool definition、External routing config、Processor registry、HTTP endpoint config 或 MCP server config 的文件读取、JSON、严格外壳和 schema 错误归属实际出错的 referenced 文件。definition 指令组合、继承与 Schema 编译错误归属 definition 文件，附 reference `id` 和字段位置。

重复 reference id 或稳定名称归属 Tool config 的对应 reference。对外名称冲突归属 Tool config 中一个 custom reference 的 `definitions[i].toolDefinitionFile`，诊断列出冲突名称、双方稳定名称及 reference id 或未覆盖 built-in 身份。route union、binding、重复 binding 和 Processor reference 错误归属 External routing config；workspace selector 不存在仍归属 workspace 配置。

## 验证重点

运行 `npm test -- tools external-routing runtime`，重点验证严格外壳、可选描述、继承组合与隔离 Schema 编译，built-in override 双层输入校验及继承 validator 复用，以及稳定名 exposure、对外名称冲突、definition id binding 和 unavailable route。

跨文件集成应覆盖 selected workspace 到真实 MCP / loopback HTTP endpoint 的调用链；隐藏 definition 和空 route 仍需通过配置校验，空 route 不创建外部运行资源。External routing 的传输与生命周期验证由其[专题文档](../EXTERNAL-ROUTING.md)承接，通用测试约定见 [测试](../TESTING.md)。
