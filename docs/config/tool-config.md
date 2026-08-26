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
| `externalRoutingConfigFile` | local absolute path | 否 | External routing config v1 文件。 |

每个 `definitions[]` reference 只允许下列字段：

| 字段 | 类型 | 必填 | 说明 |
|-|-|-|-|
| `id` | string | 是 | 配置内稳定的 definition reference identity。 |
| `toolDefinitionFile` | local absolute path | 是 | 对应 Tool definition 文件。 |

`id` 必须匹配 `^[A-Za-z0-9._-]{1,128}$`，并且在同一 Tool config 内唯一。它用于 definition 文件错误的 source metadata，也作为 External routing config 中 route 的 `definitionId` binding key。`id` 不改变 MCP Tool identity：canonical request 的 `name` 使用 Tool definition 的 `name`。

`toolDefinitionFile` 和 `externalRoutingConfigFile` 都遵循与 `toolConfigFile` 相同的本地绝对路径边界。引用文件不要求位于 workspace allowed roots 内。

完整模板见下列示例：

- [Tool config](../../examples/tool-config.example.json)
- [direct custom-only Tool definition](../../examples/tool-definition.example.json)
- [Processor custom-only Tool definition](../../examples/processed-tool-definition.example.json)
- [External routing config](../../examples/external-routing-config.example.json)
- [Processor registry](../../examples/processor-config.example.json)
- [direct HTTP endpoint config](../../examples/http-endpoint-config.example.json)
- [Processor HTTP endpoint config](../../examples/processed-http-endpoint-config.example.json)

使用模板前应替换其中的本地绝对路径和值。External routing config、Processor registry、endpoint config 与外部调用行为见 [External routing](../EXTERNAL-ROUTING.md)。

---

## Tool definition 文件

每份 definition 必须是合法 JSON object，且只允许以下全部必填字段：

| 字段 | 类型 | 说明 |
|-|-|-|
| `name` | string | MCP Tool identity，必须匹配 `^[A-Za-z0-9._-]{1,128}$`。 |
| `description` | string | `tools/list` 中暴露给客户端的描述，至少包含一个非 whitespace 字符。 |
| `inputSchema` | JSON Schema object | `tools/list` 中暴露的输入 schema。 |

`inputSchema` 使用 JSON Schema Draft 2020-12，根 `type` 必须精确为 `"object"`。`$schema` 可省略；出现时必须精确为 `https://json-schema.org/draft/2020-12/schema`。若包含 `properties`，其每个直接 property schema 都必须使用 object 形式，不能使用 boolean schema。

每份 schema 在隔离 resolver context 中同步编译，不读取网络、文件或其它 definition 来解析 references。Tool config 中不能有两个 definition 声明同一个 `name`。

完整 JSON 模板见 [Tool definition 示例](../../examples/read-file.override.example.json)。该示例使用 `read_file` 名称覆盖内置工具的对外定义。

---

## 加载、binding 与调用行为

Tool config、全部 Tool definition、已配置的 External routing config、其显式 Processor registry 和每条 route 的 endpoint config 都在启动期读取、校验并编译。Processor registry 即使未被任何 route 使用也会被读取和校验；相同 endpoint config path 被多条 route 引用时可共享已编译的 endpoint snapshot。运行期不重新读取这些配置；修改后需要重启服务。

custom definition 与内置工具同名时，完整替换 `tools/list` 暴露的 description 与 input schema，同时保留内置 executor 和 implementation contract。调用时必须同时通过 custom 对外 schema 和内置 implementation schema。External route 只能绑定 custom-only definition；route 引用 built-in override 是启动期配置错误。

custom-only definition 的 executor 由其 definition reference `id` 决定：

- External routing config 为该 `id` 声明 route 时，配置后的输入校验成功会进入该 route 的外部 executor。
- 没有 route 时，definition 仍可暴露且输入仍会校验；调用返回 deterministic unavailable route 工具错误。
- route 不按 Tool `name` 匹配，因此修改 definition 文件中的 `name` 不会改变配置 binding identity。

`routes: []` 表示 external routing 已配置但没有执行 route。此状态不创建 external admission runtime、Processor runner 或 HTTP Agents；custom-only definitions 仍保留 unavailable binding。被 `enabled` / `disabled` 隐藏的 definition 和 route 也会完成启动期加载与校验，但隐藏名称不会出现在 `tools/list`，调用返回 `Unknown tool`。

effective catalog 的合并顺序、exposure 和调用管线见 [工具开发](../TOOLS.md)。

---

## 错误与维护入口

Tool config、Tool definition、External routing config、Processor registry 或 endpoint config 的文件读取、JSON、严格外壳和 schema 错误归属实际出错的 referenced 文件；definition 诊断会附带对应 reference `id`。route binding、重复 binding 和 Processor reference 错误归属 External routing config。workspace `enabled` / `disabled` selector 不存在的错误仍归属 workspace 配置。

| 区域 | 职责 |
|-|-|
| `src/config/tool-exposure.ts` | workspace `tools` 外壳、Tool config 路径与未决 exposure selector。 |
| `src/tools/custom-tool-config.ts` | Tool config v2 / definition 加载、严格外壳、source metadata，以及 External routing config 加载入口。 |
| `src/tools/input-schema-validator.ts` | 隔离的 Draft 2020-12 schema 编译与 validator facade。 |
| `src/tools/catalog.ts` | effective catalog 合并、selector 成员校验、exposed catalog，以及按 definition reference id 注入 external binding。 |
| `src/tools/external-routing/config.ts` | External routing config v1、Processor registry v2、endpoint config 与跨文件 binding 校验。 |
| `src/runtime/startup-runtime.ts` | 全部纯配置 / catalog 校验后创建共享 external runtime，空 route 的无资源 close。 |
| `src/tools/external-routing/executor.ts` | workspace 共享 admission、route-bound executor facade 与资源 close。 |
| `src/tools/external-routing/strategy-adapter.ts` | route-specific stage 编排、endpoint dispatch 与 Processor drain metadata。 |
| `test/tools/custom-tool-config.test.ts` | Tool config / definition 外壳、schema dialect 与 validator。 |
| `test/tools/tool-exposure.test.ts` | effective/exposed catalog、override、definition-id external binding 与 unavailable executor。 |
| `test/external-routing/config.test.ts` | External routing config、Processor registry、endpoint config、route / Processor reference 校验。 |
| `test/runtime/external-routing-integration.test.ts` | selected workspace 到 MCP / loopback endpoint 的完整 custom-only route。 |
