# 工具返回结果设计

本文记录项目内 MCP 工具调用结果的统一构造约定。单个工具的参数契约和业务行为仍放在 `docs/tools/`；本文只关注 `tools/call` 返回壳、`isError` 语义、内部结构化 payload 和跨工具复用 helper。

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

项目内工具只建模 text content。需要返回非文本内容时，应重新评估统一 helper 和 adapter 规则，而不是在单个工具里临时扩展返回壳。

---

## `structuredContent` 适配

`structuredContent` 是 `tools/call` 统一出口根据 request header policy 执行的协议适配，不是单个工具 handler 的返回契约。工具 handler 只返回项目标准 `ToolCallResult` 与可选内部字段 `structuredPayload`，不读取 request headers，不判断 request policy，也不自行构造 `structuredContent`。

`structuredPayload` 表示工具自身已经持有的原生 JSON payload。该字段是内部字段，不进入最终 public result 或工具结果日志对象。

命中 `structuredContent` feature 时，runtime adapter 返回清理后的 public result，并添加 adapter 生成的协议字段：

```json
{
  "content": [
    {
      "type": "text",
      "text": "Operation completed."
    }
  ],
  "isError": false,
  "structuredContent": "\nOperation completed.\n"
}
```

适配规则：

- adapter 先从 handler result 中清理内部 `structuredPayload` 与 handler-supplied `structuredContent`，形成 public result。
- 未启用 `structuredContent` 时返回 public result，不添加 `structuredContent`。
- 启用 `structuredContent` 时返回 public result，并添加 adapter 生成的 `structuredContent`。
- `structuredPayload` 是有效 JSON value 时，`structuredContent` 直接使用该 payload 值。
- `structuredPayload` 不存在、值为 `undefined` 或未通过 JSON value 校验时，`structuredContent` 使用 `content[0]?.text ?? ''` 的文本 fallback。
- 文本 fallback 固定为 `` `\n${text}\n` ``，不 trim、不合并换行、不拼接多个 content item。
- adapter 不修改 handler 返回对象。
- 除 `structuredPayload` 与 handler-supplied `structuredContent` 外，其它顶层扩展字段保留在 public result 中。
- handler 返回中已有同名 `structuredContent` 字段时，该字段会被丢弃；只有 runtime adapter 生成的协议字段可以进入最终响应。
- `tools/list` 的工具 definition 保持不变，不为该适配能力暴露或动态添加 `outputSchema`。

`replace_text` 的成功与失败结果使用该机制：handler 把 `ReplaceTextPayload` 写入内部 `structuredPayload`，兼容文本是同一对象的紧凑 `JSON.stringify(payload)`。

---

## 统一 helper

文本结果统一通过 `src/tools/results.ts` 构造：

```typescript
import { textErrorResult, textResult } from './results.js';

return textResult('给 AI 看的成功结果描述');
return textErrorResult('错误原因 + 建议下一步怎么修正');
```

拥有原生 JSON payload 的工具同时传入兼容文本和内部 payload：

```typescript
return textResult(JSON.stringify(payload), {
  structuredPayload: payload,
});

return textErrorResult(JSON.stringify(payload), {
  structuredPayload: payload,
});
```

使用约定：

- 普通文本工具直接调用 `textResult()` / `textErrorResult()`。
- 拥有原生 JSON payload 的工具通过 options object 传入 `structuredPayload`。
- `structuredPayload: undefined` 表示没有 payload，helper 不写该字段。
- `structuredPayload: null` 是合法 payload，helper 必须写入该字段。
- 不要在工具文件中重复手写 `{ content: [{ type: 'text', text }], isError: ... }`。
- 错误文本应说明失败原因，并尽量给出 AI 可以自我修正的下一步。
- 成功文本也必须通过 helper 返回，以保证 `isError: false` 不被遗漏。

---

## JSON payload 工具

拥有原生结构化结果的工具应把兼容文本放在 `content[0].text`，并把同一个 JSON value 作为内部 `structuredPayload` 交给 helper。`replace_text` 成功和失败路径遵循该模式：`ReplaceTextPayload.success` 与顶层 `isError` 对齐，request policy 命中时 adapter 以该 object 作为 `structuredContent`。

```typescript
function successResult(payload: JsonValue): ToolCallResult {
  return textResult(JSON.stringify(payload), {
    structuredPayload: payload,
  });
}

function errorResult(payload: JsonValue): ToolCallResult {
  return textErrorResult(JSON.stringify(payload), {
    structuredPayload: payload,
  });
}
```

注意事项：

- `JSON.stringify(payload)` 不传 `space` 参数，兼容文本使用紧凑 JSON。
- `structuredPayload` 本体直接交给 adapter，不经过 stringify 后再 parse。
- JSON payload 内部的 `success` 字段和 MCP 返回壳的 `isError` 字段应表达同一语义：成功时 `success: true` / `isError: false`，失败时 `success: false` / `isError: true`。
- 工具 handler 不构造协议字段 `structuredContent`。

---

## 类型约定

`ToolCallResult` 的 `isError` 字段是必填字段，`structuredPayload` 是可选内部字段：

```typescript
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface ToolCallResult {
  content: Array<{ type: 'text'; text: string }>;
  isError: boolean;
  structuredPayload?: JsonValue;
  [key: string]: unknown;
}
```

`structuredPayload` 必须是 JSON value：`string`、有限 `number`、`boolean`、`null`、JSON array 或 JSON object。`undefined`、`NaN`、`Infinity`、`BigInt`、function、symbol、循环引用、class instance、`Date`、`Map`、`Set`、`Error` 实例等值会被 adapter 视为非法 payload，并触发文本 fallback。

`[key: string]: unknown` 仍用于兼容未来 MCP SDK 字段或协议扩展，但项目内新增工具不应绕过统一 helper 返回不同形状。

---

## 新增工具 checklist

新增或修改工具返回结果时，检查以下事项：

1. 成功路径是否使用 `textResult()`，并因此显式返回 `isError: false`。
2. 失败路径是否使用 `textErrorResult()`，并因此显式返回 `isError: true`。
3. 错误文本是否包含失败原因和可操作的修正建议。
4. 工具拥有原生 JSON payload 时，payload 是否能赋给 `JsonValue`，且兼容文本是否使用紧凑 `JSON.stringify(payload)`。
5. 工具没有原生 JSON payload 时，是否只返回自然文本并让 adapter 使用文本 fallback。
6. 是否避免在工具文件内重复拼装相同的 `content` 文本返回壳。
7. 是否没有在 handler 内构造协议字段 `structuredContent`。
