# 工具返回结果设计

本文记录项目内 `tools/call` 结果的内容块、字段所有权、构造方式和统一出口约束。单个工具的参数契约和业务行为仍放在 `docs/tools/`。

---

## 结果契约

`src/tools/types.ts` 的 `ToolCallResult` 复用 MCP SDK `CallToolResult` 顶层字段，收窄 `content` 为 `TextContent | ImageContent` 数组，并要求显式布尔值 `isError`。`content` 可以为空，也可以包含任意数量、任意顺序的 text/image 块；成功和错误结果都可以包含图片。`isError` 表示整次调用的业务状态，不限制内容块类型。

文本块使用 `type: 'text'` 和 `text: string`；图片块使用 `type: 'image'`、裸 base64 `data: string` 和独立的 `mimeType: string`，不用 data URI。两类块都保留 SDK 的可选 `annotations`、`_meta` 字段。`audio`、`resource`、`resource_link` 等其他块不属于项目结果契约。

字段所有权如下：

| 字段 | 所有者 | 规则 |
|-|-|-|
| `content` | Tool | 决定内容块、数量和顺序。 |
| `isError` | Tool | 显式表示业务状态；简单文本错误可以由 `textErrorResult()` 代为填写。 |
| `_meta` | Tool | 按 MCP 契约返回 metadata，具体语义由工具定义。 |
| `structuredContent` | Tool；结果阶段功能可以覆盖 | Tool 可以自行构造；覆盖语义见 [structuredContentDup](request-header-policy/on-call-tool-result/structured-content-dup.md)。 |
| 其他顶层扩展字段 | Tool | 沿用 SDK `CallToolResult` 的扩展边界。 |

项目 Tool definition 不提供 `outputSchema`；返回 `structuredContent` 不改变 `tools/list` 的 definition。

Tool 不读取 request headers，也不判断 request policy；统一出口在工具执行后负责结果校验和适配。策略分阶段配置、初始化会话准入与单次调用数据流见 [请求头策略](REQUEST-HEADER-POLICY.md)。

## 构造结果

Tool 直接构造成功结果并显式设置 `isError`。普通单文本块成功结果也遵循这一规则：

```typescript
return {
  content: [{ type: 'text', text: 'Operation completed.' }],
  isError: false,
};
```

简单文本错误可以使用 `src/tools/results.ts` 的 `textErrorResult()`，它生成一个文本块并设置 `isError: true`：

```typescript
import { textErrorResult } from './results.js';

return textErrorResult('Operation failed. Check the input and retry.');
```

该 helper 表达的是单文本块错误，不要求文本只有一行，也不是所有错误结果的强制构造方式。成功/失败共用同一内容构造逻辑，或者错误需要多个内容块、图片、`_meta`、`structuredContent` 或扩展字段时，直接构造 `ToolCallResult`：

```typescript
import type { ToolCallResult } from './types.js';

const result = {
  content: [
    { type: 'text', text: 'Generated preview:' },
    { type: 'image', data: pngBase64, mimeType: 'image/png' },
    { type: 'text', text: 'Generation completed.' },
  ],
  structuredContent: { width: 800, height: 600 },
  _meta: { 'example.com/generation-id': generationId },
  isError: false,
} satisfies ToolCallResult;

return result;
```

项目不提供成功结果 helper，也不提供镜像 MCP 顶层字段的通用 option-bag helper。具体工具可以保留稳定业务语义下的局部 helper，例如返回固定富结果结构的工具。

## Runtime 结果校验

`src/runtime/invocation/tool-call-handler.ts` 在 request policy adapter 和 result logger 之前校验工具结果。`src/runtime/invocation/tool-result-validation.ts` 先遍历整个结果，要求它是稳定的 JSON data graph：

- 值只包含 `null`、string、boolean、有限 number、稠密标准数组与普通 object。
- object 的 prototype 只能是 `Object.prototype` 或 `null`，自有属性必须为可枚举 data property。
- 数组使用标准 `Array.prototype`，不能有稀疏项或额外属性（固有的不可枚举 `length` 除外）。
- 不接受 Proxy、accessor、symbol key、普通 object 的不可枚举字段、`undefined`、`bigint`、非有限数、函数、自定义 prototype 或循环引用。

这一约束覆盖内容块、嵌套 metadata、`structuredContent` 和未知顶层扩展字段，避免序列化时静默改变结果。

随后确认顶层 `content` 是数组、`isError` 是显式 boolean，并使用 MCP SDK `CallToolResultSchema` 校验协议字段形状与图片 base64 语法。每个内容块的 `type` 还必须是 `text | image`；非 object 的 `_meta` / `structuredContent`、缺少图片字段或非法 base64 无法通过校验。校验仅判断是否合法，不用 SDK schema 的 parse output 替换 Tool 构造的对象；项目不解码、重编码图片，也不根据二进制内容推断 MIME type。

校验失败（包括遍历或 schema evaluation 抛错）产生安全的 `malformed_result` pipeline diagnostic，并返回稳定的 `textErrorResult()` 错误文本。该受控错误仍经过 request policy adapter 和 result logger。MCP SDK 在 request handler 包装层还会执行 `CallToolResultSchema` parse，再把 parse output 交给 transport；项目 handler 内的对象身份与 wire 对象身份不是同一项保证。

---

## 工具准入与输入校验错误

会话工具视图与 workspace tool catalog 在 executor 前产生的可恢复失败也使用标准 `ToolCallResult`：

- effective input schema validation failure；
- built-in implementation contract validation failure；
- 已通过输入与 implementation contract 校验、但在进入 built-in executor 前已经取消的调用；
- custom-only tool 的 unavailable executor；
- workspace hidden、会话工具视图不允许或 unknown tool。

这些结果通过 `textErrorResult()` 返回 `isError: true`，随后与 handler 结果经过同一个 request policy adapter 和 result logger。validation 文本区分 workspace configured contract 与 executor implementation contract，并只输出整理后的 instance location、message 和 keyword；不输出 Ajv 原始错误对象、schema path、tool config path 或 definition path。

Built-in pre-admission cancellation 使用稳定文本 `The tool call was cancelled before execution started.`。该检查位于 effective input validation 和 built-in implementation validation 之后，只阻止原本会进入 built-in executor 的有效调用。External routing 继续由自身 runtime 处理 queued 和 active cancellation。

---

## External routing 结果

custom-only Tool 的 HTTP 与 MCP route 都返回统一 `ToolCallResult`，继续经过 runtime 校验、request policy adapter 与 result logger。

HTTP route 将已校验 canonical content 逐块映射为 MCP text/image；`unknown` JSON 值在最终适配时转成 text，status 派生 `isError`。严格协议、块顺序、空内容、错误文本与映射规则由 [HTTP route](external-routing/http-route.md)维护。MCP route 不使用 canonical wrapper，下游结果支持范围与归一化由 [MCP route](external-routing/mcp-route.md)维护。

容量、取消、timeout、transport 与协议失败也进入同一结果管线；本地失败与远端业务内容的敏感信息边界见[外部路由运行时](external-routing/runtime.md)。

---

## JSON payload 工具

部分工具会把 JSON 字符串放在 `content[0].text` 中，例如 `replace_text`。如果成功和失败共用同一内容结构，工具直接构造结果并从 payload 状态派生 `isError`：

```typescript
return {
  content: [{ type: 'text', text: JSON.stringify(payload) }],
  isError: !payload.success,
};
```

这样可以把 payload 契约及其与 MCP 业务状态的对应关系留在工具文件附近。具有稳定富结果结构的工具也可以保留本地语义 helper。

注意事项：

- 保留工具既有 `JSON.stringify` 格式，避免改变客户端或测试依赖的文本内容。
- Android 构建失败结果使用 `JSON.stringify(failure)` 输出紧凑 JSON，后续维护时应保持该格式。
- JSON payload 内部的 `success` 字段和 MCP 返回壳的 `isError` 字段应表达同一语义：成功时 `success: true` / `isError: false`，失败时 `success: false` / `isError: true`。
