# 自定义 Tool 配置

`workspace` 配置中的 `tools.toolConfigFile` 可选地引用一份 version 1 Tool config。它用独立的 Tool definition 文件定制 `tools/list` 对外暴露的工具名称、描述和输入 schema；可选 `processorConfigFile` 为 custom-only definitions 提供共享 external executor，其余 definition 不在 Tool config 内定义 executor。

---

## 在 workspace 中启用

在 selected workspace 的 `tools` 段中，将 `toolConfigFile` 设置为 Tool config 文件的本地绝对路径。

`toolConfigFile` 必须是无首尾 whitespace 的本地绝对路径。Windows 下只接受 drive-absolute 路径；不接受相对路径、UNC、namespace、drive-relative、rooted-without-drive 或 `~`。该文件不要求位于 workspace 的 allowed roots 内。

`toolConfigFile` 可以与 `enabled` 或 `disabled` 并存；两者的 exposure 规则见 [workspace 配置](workspace-config.md#tools)。

---

## Tool config 文件

Tool config 必须是合法 JSON object，顶层只允许下列字段：

| 字段 | 类型 | 必填 | 说明 |
|-|-|-|-|
| `version` | `1` | 是 | Tool config schema 版本。 |
| `definitions` | object[] | 是 | 有序的 Tool definition reference 列表；空数组合法。 |
| `processorConfigFile` | string | 否 | external routing 的 Processor config 本地绝对路径；出现时至少需要一个 custom-only definition。 |

每个 `definitions[]` reference 只允许下列字段：

| 字段 | 类型 | 必填 | 说明 |
|-|-|-|-|
| `id` | string | 是 | 配置诊断身份；在同一 Tool config 内必须唯一，不参与 MCP Tool identity。 |
| `toolDefinitionFile` | string | 是 | 对应 Tool definition 文件的本地绝对路径。 |

`id` 必须匹配 `^[A-Za-z0-9._-]{1,128}$`。`toolDefinitionFile` 与可选 `processorConfigFile` 都遵循与 `toolConfigFile` 相同的本地绝对路径边界。

完整 JSON 模板见 [Tool config 示例](../../examples/tool-config.example.json)。其中的路径需要替换为本机有效位置。

---

## Tool definition 文件

每份 definition 必须是合法 JSON object，且只允许以下全部必填字段：

| 字段 | 类型 | 说明 |
|-|-|-|
| `name` | string | MCP Tool identity，必须匹配 `^[A-Za-z0-9._-]{1,128}$`。 |
| `description` | string | `tools/list` 中暴露给客户端的描述，至少包含一个非 whitespace 字符。 |
| `inputSchema` | JSON Schema object | `tools/list` 中暴露的输入 schema。 |

`inputSchema` 使用 JSON Schema Draft 2020-12，根 `type` 必须精确为 `"object"`。`$schema` 可省略；出现时必须精确为 `https://json-schema.org/draft/2020-12/schema`。若包含 `properties`，其每个直接 property schema 都必须使用 object 形式，不能使用 boolean schema。

每份 schema 在隔离 resolver context 中同步编译，不读取网络、文件或其它 definition 来解析 references。Tool config 中不能有两个 definition 定义同一个 `name`。

完整 JSON 模板见 [Tool definition 示例](../../examples/read-file.override.example.json)。该示例使用 `read_file` 名称覆盖内置工具的对外定义。

---

## 生效与调用行为

所有被引用的 Tool config 和 Tool definition 文件都在启动期依声明顺序读取、校验并编译，即使某个 definition 最终被 `enabled` 或 `disabled` 隐藏也一样。存在 `processorConfigFile` 时，Processor config 与它引用的 endpoint config 也在启动期校验。Tool config / definition 文件必须存在、解析 symlink 后为 regular file、可读、可严格 UTF-8 解码（允许 BOM）并包含合法 JSON。服务运行期不会重新读取这些配置；修改后需要重启服务。

custom definition 与内置工具同名时，完整替换 `tools/list` 暴露的 description 与 input schema，同时保留内置 executor 和 implementation contract。调用时必须同时通过 custom 对外 schema 和内置 implementation schema。

没有同名内置工具的 custom-only definition 在未配置 `processorConfigFile` 时会被列出；输入通过它的 schema 后，调用会返回未配置 execution route 的工具错误。配置 `processorConfigFile` 时，全部 custom-only definitions 共用 external executor；同名 built-in override 仍保留内置 executor。因此，若目标是修改既有工具的对外契约，应使用内置工具的名称。示例中的 `read_file` definition 正是这种可执行 override。

effective catalog 的合并顺序、exposure 和调用管线见 [工具开发](../TOOLS.md)。

`processorConfigFile` 的 Processor / endpoint schema、canonical protocol、容量、失败、取消、shutdown 和日志脱敏边界见 [external routing](../tools/external-routing.md)。

---

## 错误与维护入口

Tool config、Tool definition、Processor config 或 endpoint config 的文件读取、JSON、严格外壳和 schema 编译错误归属实际出错的 referenced 文件；definition 的诊断会附带对应 reference `id`。workspace `enabled` / `disabled` selector 不存在的错误仍归属 workspace 配置。

| 区域 | 职责 |
|-|-|
| `src/config/tool-exposure.ts` | workspace `tools` 外壳、Tool config 路径与未决 exposure selector。 |
| `src/tools/custom-tool-config.ts` | Tool config / definition 加载、严格外壳与 source metadata。 |
| `src/tools/input-schema-validator.ts` | 隔离的 Draft 2020-12 schema 编译与 validator facade。 |
| `src/tools/catalog.ts` | effective catalog 合并、selector 成员校验与 exposed catalog。 |
| `src/runtime/startup-runtime.ts` | external route 的 custom-only 前置条件、共享 executor 创建与 shutdown。 |
| `src/tools/external-routing/` | Processor / endpoint config、canonical protocol、HTTP / Processor 生命周期。 |
| `test/config/tool-exposure.test.ts` | workspace `tools` 结构、路径、selector grammar 与重复项。 |
| `test/tools/custom-tool-config.test.ts` | referenced files、definition 外壳、schema dialect 与 validator。 |
| `test/tools/tool-exposure.test.ts` | effective/exposed catalog、override、双重 contract 与 unavailable executor。 |
| `test/external-routing/*.test.ts` | route config、protocol、strategy、transport、Processor、executor 与 lifecycle。 |
