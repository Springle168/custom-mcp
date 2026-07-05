# 工具返回结果设计

本文记录项目内 MCP 工具调用结果的统一构造约定。单个工具的参数契约和业务行为仍放在 `docs/tools/`；本文只关注 `tools/call` 返回壳、`isError` 语义和跨工具复用 helper。

---

## 标准返回形状

项目内工具返回 `ToolCallResult` 时，必须显式写入布尔值 `isError`。

成功结果：

```json
{
  "content": [
    {
      "type": "text",
      "text": "Operation completed."
    }
  ],
  "isError": false
}
```

错误结果：

```json
{
  "content": [
    {
      "type": "text",
      "text": "Failed because ..."
    }
  ],
  "isError": true
}
```

当前项目只建模 text content。后续如果需要返回非文本内容，应该重新评估统一 helper，而不是在单个工具里临时扩展返回壳。

---

## `structuredContent` 适配

`structuredContent` 是 `tools/call` 统一出口根据 request header policy 执行的兼容适配，不是单个工具 handler 的返回契约。工具 handler 只返回项目标准 `ToolCallResult`，不读取 request headers，不判断 request policy，也不自行构造 `structuredContent`。

命中 `structuredContent` feature 时，runtime adapter 返回一个新对象：

```json
{
  "content": [
    {
      "type": "text",
      "text": "Operation completed."
    }
  ],
  "isError": false,
  "structuredContent": {
    "content": [
      {
        "type": "text",
        "text": "Operation completed."
      }
    ],
    "isError": false
  }
}
```

适配规则：

- 未启用 `structuredContent` 时返回 handler 的原始 result 对象，不添加扩展字段。
- 启用 `structuredContent` 时返回新对象，不修改 handler 返回对象。
- wrapper 只包含 `content` 和 `isError`，不复制顶层其它扩展字段。
- wrapper 不解析 `content[0].text`，不读取工具私有 JSON payload。
- `structuredContent.isError` 只把 `result.isError === true` 判定为错误。
- handler 返回中已有同名扩展字段时，统一出口用规范 wrapper 覆盖 adapted result 中的 `structuredContent`，原对象保持不变。
- `tools/list` 的工具 definition 保持不变，不为该兼容能力暴露或动态添加 `outputSchema`。

---

## 统一 helper

文本结果统一通过 `src/tools/results.ts` 构造：

```typescript
import { textErrorResult, textResult } from './results.js';

return textResult('给 AI 看的成功结果描述');
return textErrorResult('错误原因 + 建议下一步怎么修正');
```

使用约定：

- 普通文本工具直接调用 `textResult()` / `textErrorResult()`。
- 不要在工具文件中重复手写 `{ content: [{ type: 'text', text }], isError: ... }`。
- 错误文本应说明失败原因，并尽量给出 AI 可以自我修正的下一步。
- 成功文本也必须通过 helper 返回，以保证 `isError: false` 不被遗漏。

---

## JSON payload 工具

部分工具会把 JSON 字符串放在 `content[0].text` 中，例如 `replace_text`。这类工具可以保留本地语义 helper，但内部仍应复用统一文本 helper：

```typescript
function successResult(payload: ReplaceTextPayload): ToolCallResult {
  return textResult(JSON.stringify(payload));
}

function errorResult(payload: ReplaceTextPayload): ToolCallResult {
  return textErrorResult(JSON.stringify(payload));
}
```

这样可以把工具自身的 payload 契约留在工具文件附近，同时避免重复维护 MCP 文本返回壳。

注意事项：

- 迁移时必须保留原有 `JSON.stringify` 格式，避免改变客户端或测试依赖的文本内容。
- Android 构建失败结果使用 `JSON.stringify(failure, null, 2)` 输出可读 JSON，后续维护时应保持该格式。
- JSON payload 内部的 `success` 字段和 MCP 返回壳的 `isError` 字段应表达同一语义：成功时 `success: true` / `isError: false`，失败时 `success: false` / `isError: true`。

---

## 类型约定

`ToolCallResult` 的 `isError` 字段是必填字段：

```typescript
export interface ToolCallResult {
  content: Array<{ type: 'text'; text: string }>;
  isError: boolean;
  [key: string]: unknown;
}
```

`[key: string]: unknown` 仍用于兼容未来 MCP SDK 字段或协议扩展，但项目内新增工具不应绕过统一 helper 返回不同形状。

---

## 新增工具 checklist

新增或修改工具返回结果时，检查以下事项：

1. 成功路径是否使用 `textResult()`，并因此显式返回 `isError: false`。
2. 失败路径是否使用 `textErrorResult()`，并因此显式返回 `isError: true`。
3. 错误文本是否包含失败原因和可操作的修正建议。
4. JSON payload 工具是否保留原有 stringify 格式。
5. 是否避免在工具文件内重复拼装相同的 `content` 文本返回壳。
