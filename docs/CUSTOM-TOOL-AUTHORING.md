# 自定义 Tool definition 与 Processor 编写规范

本文说明如何为 `custom-mcp` 编写 custom-only Tool 的 definition，以及与该 Tool 配合的 Processor 程序。

这里的 custom-only Tool 是具有独立名称和外部执行实现的自定义工具。与内置 Tool 重名的 definition 是合法的 override，而不是 custom-only Tool，不属于本文范围。为避免意外覆盖，应使用明确、稳定且不会与内置 Tool 冲突的名称；采用项目或用途前缀通常更容易保持唯一。

本文是可脱离仓库独立提供的编写规范，只描述文件与进程本身必须满足的契约，不依赖其他仓库文档或链接。
本文不涉及如何注册 definition、注册 Processor、选择处理阶段、绑定执行 route 或配置 HTTP endpoint。

---

## 编写 Tool definition

每个 Tool definition 是一个 JSON object，顶层只能包含以下三个必填字段：

| 字段 | 类型 | 要求 |
|-|-|-|
| `name` | string | Tool identity，必须匹配 `^[A-Za-z0-9._-]{1,128}$`；要作为 custom-only Tool，还不得与内置 Tool 名称冲突。 |
| `description` | string | 至少包含一个非 whitespace 字符；内容会直接提供给调用 Tool 的 AI。 |
| `inputSchema` | JSON Schema object | Tool 参数的 JSON Schema Draft 2020-12 schema；根 `type` 必须精确为 `"object"`。 |

不能添加 executor、Processor、route、输出格式或其他顶层字段。definition 只负责告诉 MCP 客户端 Tool 的名称、用途与输入契约。

### `description` 与参数说明

Tool description 和 property description 都是 AI 选择并调用 Tool 时使用的上下文。它们应当简洁说明：

- Tool 能做什么，以及不能做什么；
- 何时应当使用该 Tool；
- 参数的含义、格式和重要约束；
- 能避免常见错误的必要提示。

不要在 description 中展开 Processor、HTTP 协议、内部算法、本地路径或其他调用方不需要了解的实现细节。过长的描述会增加上下文成本，也可能弱化关键约束。

### `inputSchema` 约束

`inputSchema` 遵循以下规则：

- 使用 JSON Schema Draft 2020-12；
- 根节点必须是 object schema，并显式写成 `"type": "object"`；
- `$schema` 可以省略；出现时必须精确为 `https://json-schema.org/draft/2020-12/schema`；
- `properties` 出现时必须是 JSON object；
- `properties` 的每个直接 property schema 必须使用 object form，不能使用 `true` 或 `false` boolean schema；
- schema 在隔离的 resolver context 中编译，不会通过网络、文件或其他 definition 解析外部 reference；需要使用 `$ref` 时，应让引用保持在同一份 schema 内；
- schema 必须能够同步编译；不支持 `$async: true` 或其他会产生 asynchronous validator 的 schema；
- 同一组 custom definitions 中不能有两个 definition 声明相同的 `name`。

输入校验只判断值是否符合 schema，不会执行类型转换、填充 `default` 或删除未知字段。definition 因此应完整表达调用契约：

- 使用 `required` 声明必填参数；
- 使用 `enum`、长度、范围和数组数量等关键字表达简单值域；
- 不接受未知参数时，在相应 object schema 上写明 `"additionalProperties": false`；
- 对嵌套 object 同样明确其 `required` 和未知字段策略。

`default` 可以作为 schema annotation 使用，但不能依赖它为缺失参数产生实际值。

`format` 也只作为 annotation，不会使输入校验失败。需要强制检查 email、URI、日期或其他字符串格式时，应使用 `pattern`、`enum`、长度等实际约束表达可机械校验的部分，并由 Processor 检查其余业务语义。

### 完整示例

```json
{
  "name": "acme_text_summary",
  "description": "Summarizes the supplied text. Use this only when the complete source text is already available.",
  "inputSchema": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "text": {
        "type": "string",
        "minLength": 1,
        "description": "The complete text to summarize."
      },
      "max_sentences": {
        "type": "integer",
        "minimum": 1,
        "maximum": 20,
        "description": "Maximum number of sentences in the summary."
      }
    },
    "required": [
      "text"
    ],
    "additionalProperties": false
  }
}
```

---

## Processor 的进程契约

Processor 是由 `custom-mcp` 为某个处理阶段启动的受信任本地子进程。一次 Processor invocation 对应一次独立的 stdin/stdout exchange。

Processor 必须遵守以下通用规则：

1. 从 stdin 读取全部输入，直到 EOF。输入可能是 JSON，也可能是任意二进制数据，具体取决于 Processor role。
2. 将且仅将最终输出写入 stdout。日志、进度、提示语和调试文本不得混入 stdout。
3. 需要输出诊断时使用 stderr。stderr 不是 Tool 的业务结果通道，不能依赖其文本会返回给调用方。
4. 成功时以退出码 `0` 正常结束，并在退出前完整 flush、关闭 stdout。
5. 非零退出码、signal 退出、stdio 错误、超时、取消、stdout 超限或不符合角色契约的输出都会使 Processor invocation 失败；失败时 stdout 不会作为部分结果使用。
6. stdin 与 stdout 都应按原始字节流处理。只有角色契约明确要求 canonical JSON 时，才将对应字节解释为文本。
7. 不要依赖 shell 解析、交互式终端、持续驻留状态或跨 invocation 的 stdin/stdout 会话。
8. Processor 可能因调用取消、超时或服务关闭而被终止。程序应及时响应终止，并负责停止自己创建的子进程或其他资源。

每次 invocation 的 stdin 和 stdout 上限均为 `50 MiB`。超限 stdin 不会启动 Processor；stdout 超限会终止 Processor。stderr 会持续排空以避免阻塞，但只保留最多 `1 MiB` 的诊断内容。Processor 应避免输出大量诊断。

终止控制只直接作用于 Processor 进程。Processor 必须自行清理其进程树，并避免让后台子进程继续持有 stdin、stdout 或 stderr；未确认关闭的进程或被后代长期持有的 stdio 会影响后续 Processor invocation，直至服务重启。

外部操作可能已经发生，但本地调用仍可能因 timeout、cancel 或连接失败而得不到确认。`custom-mcp` 不会自动重试，Processor 也不应自行重试具有副作用的操作，除非目标操作明确支持安全重复。

---

## Processor role

每次 invocation 都通过 `CUSTOM_MCP_PROCESSOR_ROLE` 指明 Processor 的角色。Processor 可以只实现一个固定角色，也可以根据该变量分派到多个处理函数。

| Role | stdin | stdout | 关键不变量 |
|-|-|-|-|
| `request.canonical-filter` | canonical request JSON | canonical request JSON | 必须保留原始 call id；可以替换 Tool name、arguments 和 extensions。 |
| `request.body-encoder` | canonical request JSON | 最终 HTTP request body 的原始字节 | stdout 不做 JSON 校验，可输出任意二进制格式。 |
| `response.canonical-filter` | 已校验的 canonical response JSON | canonical response JSON | 必须保留 response kind；results response 还必须保留原始 result id。 |
| `response.body-decoder` | 原始 HTTP response body 字节 | canonical response JSON | 输出 results response 时必须使用原始 call id；输出还必须与 HTTP status 相容。 |

`response kind` 指 canonical results response 与 canonical error response 这两种互斥形状。
`response.canonical-filter` 不能在两种 kind 之间转换；results filter 保留 result id，可以修改 status，替换、增删或重排 content；error filter 可以修改 error code、error message。
两者都可以修改 extensions，输出必须是完整合法消息，不会补回省略的 content 或 extensions。
Filter stdin 中 image 保持 canonical `mime_type`，unknown 保持 JSON value；不要提前转成 MCP 内容或文本。

`response.body-decoder` 收到的是 endpoint response entity 的原始字节，`custom-mcp` 不会先自动解压。若 `Content-Encoding` 表示压缩格式，decoder 应根据环境变量决定是否以及如何解码。多个 content coding 按 HTTP 语义以声明顺序的反向逐层解码。

Response Processor 只会在 transport 接受一个 metadata 合法、body 非空且不超过 `50 MiB` 的最终 `2xx`、`4xx` 或 `5xx` response 后启动。Redirect 不会被跟随，`3xx` response 也不会交给 Processor。

---

## Processor 环境变量

Processor 继承宿主进程环境，但 `custom-mcp` 会按大小写不敏感规则先移除 `CUSTOM_MCP_PROCESSOR_ROLE` 和所有以 `CUSTOM_MCP_EXTERNAL_` 开头的变量，再注入本次 invocation 的值。不要通过父进程预设这些变量来覆盖 invocation metadata，也不要把自定义继承变量放在该保留前缀下。

| 环境变量 | 可用角色 | 含义 |
|-|-|-|
| `CUSTOM_MCP_PROCESSOR_ROLE` | 全部 | 本次 invocation 的四种 role 之一。 |
| `CUSTOM_MCP_EXTERNAL_CALL_ID` | 全部 | 原始调用的不透明、非空 call id。需要回写 id 时必须逐字使用该值，不要解析或重新生成。 |
| `CUSTOM_MCP_EXTERNAL_HTTP_STATUS` | response roles | 最终 HTTP status 的十进制字符串。 |
| `CUSTOM_MCP_EXTERNAL_CONTENT_TYPE` | response roles | 经校验的 Content-Type；response 没有该字段时不设置。 |
| `CUSTOM_MCP_EXTERNAL_CONTENT_ENCODING` | response roles | 经规范化、小写并以 `, ` 分隔的 Content-Encoding coding list；response 没有该字段时不设置。 |

Request Processor 不会收到 HTTP status、Content-Type 或 Content-Encoding。Processor 应把缺失的可选 response metadata 当作正常情况，而不是读取父进程中遗留的值。表中的变量是 Processor 获得 invocation metadata 的完整接口；不会另外提供 endpoint URL、认证信息、MCP session 或其他 response headers。

---

## Canonical JSON 协议

Canonical JSON 必须是严格 UTF-8、无 BOM 的单一完整 JSON document。request、call、response、result、error 和 content block 等协议外壳拒绝未知字段；`arguments`、unknown value 与 extension namespace value 内部可以承载其用途所需的 JSON 字段。所有值都必须是合法 JSON 值。

Processor 输出的每个 JSON object 都应使用唯一成员名，不要依赖不同 JSON parser 对重复成员的处理方式。

### Canonical request

Canonical request 只包含一次调用：

```json
{
  "calls": [
    {
      "id": "call_opaque-id",
      "name": "acme_text_summary",
      "arguments": {
        "text": "Example text",
        "max_sentences": 3
      }
    }
  ]
}
```

约束如下：

- `calls` 必须恰好包含一个元素；
- `id` 是非空 opaque string；
- `name` 必须匹配 `^[A-Za-z0-9._-]{1,128}$`；
- `arguments` 必须是 JSON object；
- `request.canonical-filter` 输出的 `id` 必须与输入完全相同；
- filter 可以修改 `name` 与 `arguments`，但修改后的值仍须满足 canonical request 形状。

### Canonical results response

Canonical results response 使用 `results`，并且只包含一个 result。这里的 `results` 表示协议形状，不表示业务状态一定成功：

```json
{
  "results": [
    {
      "id": "call_opaque-id",
      "status": "completed",
      "content": [
        { "type": "text", "text": "Summary completed." },
        { "type": "unknown", "value": { "sentence_count": 3 } }
      ]
    }
  ]
}
```

约束如下：

- `results` 必须恰好包含一个元素；result 恰好包含 `id`、`status` 和 `content`；
- `id` 是非空 opaque string，必须与原始 call id 完全相同；
- `status` 只能是 `completed`、`failed` 或 `cancelled`；
- `content` 是有序、稠密标准数组，允许 `[]`，不能缺失或为 `null`；
- 三个 status 都接受 text、image、unknown 或空 content；`completed` 形成成功 Tool result，`failed` 与 `cancelled` 形成错误 Tool result。

每个 block 只允许以下字段：

| Type | 形状 | 生产方要求 |
|-|-|-|
| `text` | `{ "type": "text", "text": "..." }` | text 为 string，可以为空。 |
| `image` | `{ "type": "image", "data": "...", "mime_type": "image/png" }` | 非空规范标准 base64；MIME 仅接受精确小写的 `image/png`、`image/jpeg`、`image/webp`。 |
| `unknown` | `{ "type": "unknown", "value": ... }` | value 必须存在，可以是 null 或任意合法 JSON 值。 |

图片 data 必须使用标准 RFC 4648 base64 字母表 `A-Z`、`a-z`、`0-9`、`+`、`/`，长度为四的倍数。
`=` 只能作为末尾一个或两个必需的 padding 字符，不能缺少、多余或出现在内部。
两个 `=` 时最后一个有效 sextet 的低四位必须为零，一个 `=` 时低两位必须为零。
Data 不能为空字符串，不能含空白、URL-safe 字符、data URL、URL 或文件路径。
`mime_type` 不接受 `image/jpg`、大小写变体或参数；生产方负责图片字节与 MIME 相符，宿主不验证文件结构或修复编码。

合法 JSON 值仅包括 null、string、boolean、有限 number，以及递归包含这些值的稠密数组和 object。
Unknown value 内部字段不受 block wrapper 字段白名单限制，但每个值仍须合法；不能依赖序列化时静默省略字段、将无效数组项替换为 null 或自定义 coercion 来修复非法值。

Unknown 不是未知 block type 的兜底，`audio`、`custom` 等 type 仍不合法。
宿主只在最终 MCP 适配时对 unknown value 执行紧凑 `JSON.stringify`：一个 unknown 成为一个 text 块，string 带 JSON 引号，null 成为 `null` 文本，内部 type、URL 和 JSON 字符串不会被再次解析。
示例中的 unknown 成为 `{"sentence_count":3}` 文本。
文本、图片与 unknown 的数量和顺序原样保留，不合并相邻 text，不丢弃空字符串或空数组，不为 failed / cancelled 添加状态文本或固定失败前缀。

任一非法块使整个 response 校验失败，不会返回部分内容。
Result 的 `message` 结构不兼容，`message` 与 `content` 并存也拒绝，不做协议探测、自动转换或版本协商。
Endpoint 的非法 results 产生 `external_protocol_failed`；response Processor 的非法输出产生 `processor_failed`。
Canonical-filter 的 endpoint 输入先被校验，不能用于修复 message result；body-decoder 按 content 契约构造完整 canonical response。
这些要求不改变 request、顶层 error、extensions 或配置 schema version。

### Canonical error response

Canonical error response 使用 `error`，不能同时出现 `results`：

```json
{
  "error": {
    "code": "invalid_request",
    "message": "The request could not be processed."
  }
}
```

约束如下：

- `code` 必须是非空 string；
- `message` 必须是 string，可以为空；
- canonical error 形成错误 Tool result；
- error response 不包含 result id，因此 `response.body-decoder` 不需要把 call id 写入这一形状。

### HTTP status 与 canonical response

Response Processor 的输出必须与 `CUSTOM_MCP_EXTERNAL_HTTP_STATUS` 相容：

| HTTP status | 允许的 canonical response |
|-|-|
| `2xx` | results response 或 error response |
| `4xx` / `5xx` | 只能是 error response |
| 其他 status | 不能产生可接受的确认结果 |

`response.canonical-filter` 的输入已经通过该约束；输出仍须保持相容。`response.body-decoder` 必须自行根据 status 选择正确的 response shape。

### 可选 `extensions`

Canonical request、results response 和 error response 顶层都可以包含 `extensions`：

```json
{
  "extensions": {
    "acme.example": {
      "trace_id": "trace-123"
    }
  }
}
```

`extensions` 必须是 JSON object。每个 key 都必须是非空 namespace，且不能是保留名称 `custom-mcp`；每个 namespace value 必须是 JSON object。

Filter 的输出是完整替换，不是与输入合并。省略 `extensions` 表示删除输入中的 extensions；需要保留时必须显式复制。除非确有跨协议传递 metadata 的需要，Processor 可以不添加 extensions。
Extensions 不自动进入 MCP content、`_meta` 或 `structuredContent`。

### 业务结果与日志边界

Content 与 `error.message` 是业务结果，可能进入既有 Tool result logger，包括图片 base64 与 unknown 序列化后的 JSON。
Canonical 校验和文本化不提供内容脱敏、HTML 转义或指令过滤；endpoint / Processor 维护者负责避免返回敏感内容。
本地受控失败和运行诊断不泄露 raw body、stdout / stderr、header、endpoint query 或底层异常，但这不代表业务内容会被脱敏。

---

## 语言无关的处理结构

下面的伪代码展示一个按 role 分派的 Processor。实际实现必须使用所选语言的二进制 stdin/stdout API，并确保 stdout 不含额外文本。

```text
input_bytes = read_all_stdin_until_eof()
role = require_environment("CUSTOM_MCP_PROCESSOR_ROLE")
call_id = require_environment("CUSTOM_MCP_EXTERNAL_CALL_ID")

try:
    if role == "request.canonical-filter":
        request = parse_strict_canonical_json(input_bytes)
        output = filter_request(request)
        validate_canonical_request(output)
        require(output.calls[0].id == request.calls[0].id)
        output_bytes = encode_utf8_json_without_bom(output)

    else if role == "request.body-encoder":
        request = parse_strict_canonical_json(input_bytes)
        output_bytes = encode_private_request_body(request)

    else if role == "response.canonical-filter":
        response = parse_strict_canonical_json(input_bytes)
        output = filter_response(response)
        validate_canonical_response(output, call_id)
        require(same_response_kind(output, response))
        if output contains results:
            require(output.results[0].id == response.results[0].id)
        output_bytes = encode_utf8_json_without_bom(output)

    else if role == "response.body-decoder":
        status = parse_decimal_environment("CUSTOM_MCP_EXTERNAL_HTTP_STATUS")
        metadata = read_optional_response_metadata()
        output = decode_private_response(input_bytes, status, metadata, call_id)
        validate_canonical_response(output, call_id)
        require(response_is_compatible_with_http_status(output, status))
        output_bytes = encode_utf8_json_without_bom(output)

    else:
        fail("unsupported Processor role")

    write_all_stdout(output_bytes)
    flush_stdout()
    exit(0)

catch error:
    write_diagnostic_to_stderr(error)
    exit(nonzero)
```

不要在 catch 路径把 Processor 自身的错误写成 canonical response。Processor 自身无法完成其契约时，应以非零退出码失败；只有 endpoint 明确返回了可映射的业务拒绝或业务失败时，才构造相应的 canonical error、`failed` 或 `cancelled` response。

---

## 编写完成后的检查清单

### Definition

- `name` 是否匹配 identity 规则，并确认不会覆盖内置 Tool？
- 顶层是否只有 `name`、`description`、`inputSchema`？
- description 是否面向 AI 说明用途和边界，而不是暴露实现细节？
- `inputSchema.type` 是否精确为 `"object"`？
- 是否完整声明 required、值域和未知字段策略？
- 是否避免依赖外部 `$ref`、asynchronous validator、`format` 校验、类型转换、default 注入或字段删除？

### Processor

- 是否读完 stdin，并把它视为可能包含任意字节的输入？
- stdout 是否只包含最终 payload，没有日志、进度或提示文本？
- canonical JSON 输出是否为严格 UTF-8、无 BOM、单一完整 document？
- 是否按 role 保留 call id、result id 和 response kind？
- response 输出是否与 HTTP status 相容，results 是否包含完整合法 content 而非 message？
- `body-decoder` 是否按需处理 Content-Encoding，并使用原始 call id？
- 成功时是否 flush stdout 并以 `0` 退出，失败时是否使用非零退出码？
- 是否能在 timeout、cancel 或 shutdown 时及时停止自身及其子进程？
- 是否避免对可能产生副作用的操作进行不安全重试？
