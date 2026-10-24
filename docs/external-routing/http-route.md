# HTTP Route

HTTP route 以单调用 canonical request 作为内部边界，经 request stage、HTTP `POST` 与 response stage，得到已校验 canonical response，再映射为项目 `ToolCallResult`。MCP route 不使用 canonical wrapper 或 Processor stage。

Stage 可选模式和配置字段见[配置专题](configuration.md#http-routingstrategy)；字节上限、容量、取消和资源 drain 见[运行时边界](runtime.md)。

## Stage 与 HTTP exchange

Request `direct` 发送 canonical request UTF-8 JSON；`canonical-filter` 输入、输出均为 canonical request；`body-encoder` 将 canonical request bytes 编码为最终 HTTP body，并由配置的 `contentType` 指定 media type。

Response `direct` 要求 endpoint 返回 canonical response；`canonical-filter` 先校验 endpoint canonical response 再运行 filter；`body-decoder` 接收 raw endpoint body，生成 canonical response。

Request filter 必须保留原 call id，可以修改 Tool name、arguments 和 extensions。Response filter 必须保留 response kind；results filter 还须保留原 result id，可以修改 status，替换、增删或重排 content。

Filter 输出是完整权威替换，必须自行包含全部必需字段：省略 content 不会从输入补回，省略 extensions 表示删除。Filter stdin 中 image 保持 `mime_type`，unknown 保持 JSON 值，不提前映射为 MCP 文本。最终 status 决定 MCP `isError`。

HTTP transport 始终使用 `POST`，不自动解压 response entity，不跟随 redirect。Response representation 有以下边界：

- `direct` 与 `canonical-filter` 要求有效的 `application/json` content type。
- charset 必须缺省或为 UTF-8，content encoding 必须缺省或为 `identity`。
- `body-decoder` 可根据经校验的 response representation metadata 处理 body。

| HTTP status | 可确认的 canonical response |
|-|-|
| `2xx` | 任一合法 `results` 或 `error`。 |
| `4xx` / `5xx` | 仅 `error`。 |
| `3xx` 与其它范围 | 不产生确认结果。 |

合法 results 不代表 HTTP status 合法：`4xx` / `5xx` 携带 failed 或 cancelled results 仍不能确认。Direct / canonical-filter 的 endpoint status 违约属于 `external_protocol_failed`；body-decoder 为 `4xx` / `5xx` 构造 results 属于 Processor contract violation，分类为 `processor_failed`。

## Canonical request 与 response

Canonical JSON 是严格 UTF-8、无 BOM 的单一完整 document。协议 wrapper 拒绝未知字段；arguments、unknown value 与 extension namespace value 内部按各自 JSON 数据契约承载字段，不增加 wire version 字段。

Request 是只含一个 call 的 JSON object：

- `calls` 是长度为一的数组；
- call 包含 `id`、`name` 和 object 类型的 `arguments`；
- 可选 `extensions` 只接受非空、非 `custom-mcp` namespace 的 object 值。

`id` 使用 MCP invocation call id，`name` 使用 definition 的 MCP name；`definitionId` 不进入 canonical protocol。

Response 只允许两种互斥形状之一：

- `results`：长度为一的数组，result 恰好包含 `id`、`status` 和 `content`；
- `error`：恰好包含非空 string `code` 和 string `message`，message 可以为空。

不能同时包含或同时省略 `results` 与 `error`。两种封套都可带 `extensions`，不能有其它顶层字段。Response extensions 沿用 request namespace 规则，不自动进入 MCP content、`_meta` 或 `structuredContent`。

### Result 与内容块

Result `id` 是非空 opaque string，必须与原 call id 完全相同，不 trim 或解析前缀。`status` 只能为 `completed`、`failed` 或 `cancelled`。三个 status 都接受任意合法内容块组合，包括图片、unknown 与空数组。

`content` 必须是有序、稠密标准数组，允许 `[]`，不能缺失或为 `null`。每个 block 是严格 object：

| Type | 字段 | 规则 |
|-|-|-|
| `text` | `type`、`text` | `text` 为 string，允许空字符串，原样保留。 |
| `image` | `type`、`data`、`mime_type` | `data` 为非空规范标准 base64；MIME 精确为 `image/png`、`image/jpeg` 或 `image/webp`。 |
| `unknown` | `type`、`value` | `value` 必须存在且为合法 JSON 值，允许 `null`。 |

`unknown` 是显式 JSON 内容，不是未定义 type 的兜底；`audio`、`custom` 等块仍是协议错误。Result 的 `message`、`images`、`isError` 等额外字段全部拒绝，`message` 与 `content` 并存也不合法。

### 图片 wire 规则

`data` 使用 RFC 4648 标准 base64 字母表 `A-Z`、`a-z`、`0-9`、`+`、`/`，长度必须为四的倍数。`=` 只能位于末尾，数量为编码所需的一个或两个，拒绝缺少、多余或内部 padding。两个 `=` 时最后一个有效 sextet 的低四位必须为零，一个 `=` 时低两位必须为零。

空串、空白、URL-safe 字符、data URL、URL 和文件路径均不合法。`mime_type` 不接受 `image/jpg`、大小写变体或带参数的值。

校验只保证编码与 MIME 声明合法，不验证图片文件结构；生产方负责字节与 MIME 相符。项目不解码、重新编码、修复 padding、下载图片或推断 MIME。这是 HTTP canonical wire 边界，不收窄 built-in Tool 或 MCP route 的 MCP 图片契约。

### JSON 快照与不可执行数据边界

`unknown.value` 接受 `null`、string、boolean、有限 number、稠密标准数组和普通 object（包括 null-prototype object）。其内部不受 block wrapper 字段白名单限制，也不解释 `type`、URL、文件 ID 或 MCP 字段。

Canonical validation 使用 descriptor-based 读取，复制独立规范表示并深度冻结，包括 content 数组、块 wrapper、unknown 子树和 extensions。响应封套、error、results、result、content、块和 JSON 子树的读取路径都在属性、descriptor 或 prototype 访问前拒绝 Proxy，不触发其 trap。

JSON 数据边界还要求：

- object 原型只能为 `Object.prototype` 或 `null`，数组原型只能为 `Array.prototype`；
- 拒绝 `undefined`、bigint、function、symbol、非有限数、循环、accessor、symbol key、普通 object 的非枚举属性、稀疏数组和数组额外属性；
- 拒绝 `Date`、`Map`、`Set`、`Buffer`、类实例及依赖自定义 `toJSON()` 的对象，不读取 accessor 值或调用输入的 coercion；
- 非循环共享子对象合法，`__proto__`、`constructor`、`toJSON` 等普通字符串 key 保持 JSON 数据语义。

源对象后续突变不能改变已校验 response、filter stdin 或 MCP 输出。任一块或 JSON 子树不合法，整个 response 校验失败，不跳过坏块、修复图片或返回部分内容。

## Canonical-to-MCP 映射

| Canonical block | MCP block |
|-|-|
| `{ type: 'text', text }` | `{ type: 'text', text }` |
| `{ type: 'image', data, mime_type }` | `{ type: 'image', data, mimeType: mime_type }` |
| `{ type: 'unknown', value }` | `{ type: 'text', text: JSON.stringify(value) }` |

Executor 创建新的结果对象与内容数组，保留块数量、顺序、相邻文本边界、空 text 和空 content，不合并或分组。HTTP 映射本身不生成 annotations、`_meta` 或 `structuredContent`。`completed` 派生 `isError: false`；`failed` 与 `cancelled` 派生 `isError: true`。

不插入状态文本或 `External tool failed:` / `External tool reported cancellation:` 前缀，也不为远端 cancelled 添加 MCP metadata。远端 cancelled 是已确认领域结果，不等同于本地 caller cancellation。

Unknown 只在 executor 最终适配时执行一次紧凑 `JSON.stringify(value)`，每个 unknown 对应一个 text 块。不排序、pretty-print、添加前缀或 Markdown fence、截断或拆分 JSON 子树；不使用 `String(value)`，不解析 JSON 字符串，也不把内部 object 识别成 MCP 块。

| Unknown value | MCP text 字符内容 |
|-|-|
| `null` | `null` |
| `false` | `false` |
| `0` | `0` |
| `"hello"` | `"hello"`，包含 JSON 双引号。 |
| `""` | `""`，不是空 text。 |
| `[1, null]` | `[1,null]` |
| `{ "type": "image", "data": "example" }` | `{"type":"image","data":"example"}`，仍是文本。 |

文本化承诺 JSON 语义，不承诺原始 whitespace、member 顺序或数字词法表示，沿用 `JSON.parse` / `JSON.stringify` 行为。无效数据不能依靠 stringify 的静默省略、数组 null 替换或自定义 `toJSON` 修复。快照后的未建模适配异常进入 `external_internal_failed`，不返回部分内容或原始异常。

顶层 canonical error 映射成单文本错误结果：`External endpoint rejected the tool call (<code>): <message>`。本地失败使用各自稳定安全文本，完整分类见[运行时失败分类](runtime.md#失败分类与重试边界)。

映射后仍经过[统一结果校验](../TOOL-RESULTS.md)、[request policy adapter](../REQUEST-HEADER-POLICY.md) 和 result logger。[structuredContentDup](../request-header-policy/on-call-tool-result/structured-content-dup.md#内容与序列化边界) 对最终 MCP 结果的处理及其序列化影响由功能专题维护。

## Wire 示例

```json
{
  "calls": [
    {
      "id": "call_opaque-id",
      "name": "external_echo",
      "arguments": { "message": "Hello from custom-mcp." }
    }
  ]
}
```

Completed response 使用相同 call id：

```json
{
  "results": [
    {
      "id": "call_opaque-id",
      "status": "completed",
      "content": [
        { "type": "text", "text": "Preview:" },
        { "type": "image", "data": "AQID", "mime_type": "image/png" },
        { "type": "unknown", "value": { "details": [null, true, "example"] } },
        { "type": "text", "text": "" }
      ]
    }
  ]
}
```

`AQID` 仅展示合法 base64，不是 PNG 文件；真实生产方须提供与 MIME 相符的图片。MCP content 按顺序保留文本，将 image 字段改名为 `mimeType`，将 unknown 转成 `{"details":[null,true,"example"]}` 文本，并保留最后的空 text。`failed` / `cancelled` 使用相同 content 结构，仅派生的 `isError` 不同。

Endpoint 拒绝请求时使用 canonical error：

```json
{
  "error": {
    "code": "invalid_request",
    "message": "The request could not be processed."
  }
}
```

## 协议失败归属

| 不合法内容来源 | Classification |
|-|-|
| endpoint direct 输出 | `external_protocol_failed` |
| canonical-filter 的 endpoint 输入 | `external_protocol_failed`，不运行 filter 修复非法输入。 |
| canonical-filter 或 body-decoder 的 Processor 输出 | `processor_failed` |

三个 result status 都只接受 `content`，不做协议探测、自动转换或双版本协商。endpoint results 使用 `message` 时产生 `external_protocol_failed`，response Processor 输出该形状时产生 `processor_failed`。私有 body 应由 body-decoder 按 content 契约生成 response；这不改变顶层 `error.message` 的契约。

## Processor 输入输出与环境

Processor 使用 stdin / stdout 交换对应 stage 的 bytes；进程级限制与退出失败见[运行时边界](runtime.md)。Response `body-decoder` 必须使用原 canonical call id 构造 result id，即使私有 endpoint 协议不回显该 id。

Processor 默认继承 process environment，但先按 Windows 大小写不敏感规则删除 `CUSTOM_MCP_PROCESSOR_ROLE` 及全部 `CUSTOM_MCP_EXTERNAL_*` 名称变体，再注入本次 invocation 的保留变量：

| Variable | 注入范围与值 |
|-|-|
| `CUSTOM_MCP_PROCESSOR_ROLE` | 所有 Processor；`request.canonical-filter`、`request.body-encoder`、`response.canonical-filter` 或 `response.body-decoder`。 |
| `CUSTOM_MCP_EXTERNAL_CALL_ID` | 所有 Processor；原 canonical request 的不透明 call id。 |
| `CUSTOM_MCP_EXTERNAL_HTTP_STATUS` | response Processor；最终 HTTP status 的十进制字符串。 |
| `CUSTOM_MCP_EXTERNAL_CONTENT_TYPE` | response Processor；存在时为校验后的 Content-Type，缺失时不设置。 |
| `CUSTOM_MCP_EXTERNAL_CONTENT_ENCODING` | response Processor；存在时为规范化后的 Content-Encoding，缺失时不设置。 |

Request Processor 不接收 response-only metadata。保留变量不包含 endpoint URL、认证 header、MCP session 或其它 response headers；继承 environment 不构成对本地 Processor 的权限隔离。业务输出与诊断的隐私边界见[安全诊断](runtime.md#安全诊断与业务内容边界)。
