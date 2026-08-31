# ask_user 工具文档

## 概述

`ask_user` 工具允许 AI 在执行过程中向用户提问，收集选择或文本输入。支持三种问题类型：
- **choice**：单选或多选题
- **yesno**：是/否确认
- **text**：自由文本输入

所有问题类型都支持附加"补充说明"字段，用户可以在选择答案后添加额外的上下文信息。

工具调用时会生成一个唯一的 URL，用户通过浏览器访问该 URL 填写表单，提交后工具返回结构化的答案数据。

---

## Schema

### 工具名称

`ask_user`

### 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|-|-|-|-|-|
| `questions` | `Question[]` | 是 | - | 问题数组，1-4 个问题 |

#### Question 对象

| 字段 | 类型 | 必填 | 约束 | 说明 |
|-|-|-|-|-|
| `question` | `string` | 是 | - | 完整问题文本，应清晰具体，以问号结尾 |
| `header` | `string` | 是 | - | 短标签（用于显示），使用缩写，如 "Auth method"、"Library" |
| `type` | `'choice' \| 'text' \| 'yesno'` | 是 | - | 问题类型 |
| `options` | `Option[]` | 条件必填 | 2-4 个 | `type='choice'` 时必需，其他类型不需要 |
| `multi_select` | `boolean` | 否 | `false` | 仅 `type='choice'` 时有效，是否允许多选 |
| `placeholder` | `string` | 否 | - | 输入提示文本，用于 `type='text'` |

#### Option 对象

| 字段 | 类型 | 必填 | 说明 |
|-|-|-|-|
| `label` | `string` | 是 | 选项标签（1-5 词），如 "OAuth 2.0" |
| `description` | `string` | 是 | 选项说明，如 "Industry standard, supports SSO" |

### description 设计意图

description 是给 AI 看的 prompt，包含以下关键信息：

- **功能定位**："Ask the user one or more questions to gather preferences, clarify requirements, or make decisions"
- **返回格式提示**："Returns structured answers with optional additional notes"

简洁明确，避免冗长描述，让 AI 快速理解工具用途。

---

## 实现细节

### 会话管理与阻塞机制

工具 handler 创建会话时：
1. 生成唯一的 `sessionId`（UUID）
2. 创建 Promise 并存入全局 Map：`pendingQuestions`
3. 使用 selected workspace runtime snapshot 中的 host / port 输出 URL，例如 `http://127.0.0.1:{port}/ask/{sessionId}`；IPv6 host 使用方括号
4. `await` Promise，阻塞等待用户输入
5. 用户提交表单后，HTTP handler 通过 `normalizeAskUserAnswerPayload()` 规范化表单数据并调用 `resolve()`，Promise 返回答案
6. 清理会话，返回结果给 AI

无超时限制，会话在用户提交或取消后自动清理。

### HTTP 路由

| 路由 | 方法 | 功能 |
|-|-|-|
| `/ask/:sessionId` | GET | 渲染问题表单（HTML） |
| `/answer/:sessionId` | POST | 接收表单提交，解析答案，resolve Promise |
| `/cancel/:sessionId` | POST | 用户取消，resolve Promise 为 `null` |

### 答案格式

返回给 AI 的 `content[0].text` 是由 `JSON.stringify(payload)` 生成的紧凑 JSON：

```json
{
  "answers": {
    "0": {
      "answer": "OAuth 2.0",
      "note": "with PKCE flow"
    },
    "1": {
      "answer": "Yes"
    },
    "2": {
      "answer": "Multi-line text\nwith newlines"
    }
  }
}
```

- **key**：字符串形式的问题索引（`"0"`, `"1"`, ...）
- **value**：对象，包含 `answer`（必需）和 `note`（可选）
- **多选题**：多个选项用 `\n` 分隔，如 `"OAuth 2.0\nJWT"`
- **格式化 helper**：答案路径通过 `formatAskUserAnswerResult()` 返回标准 `content` + `isError` 结果
- **取消**：返回文本 `"User dismissed ask_user dialog without answering."`
- **取消 helper**：取消路径通过 `formatAskUserCanceledResult()` 返回自然文本，不设置 `isError: true`

### HTML 表单生成

`generateQuestionForm()` 函数生成纯 HTML 表单：

- **choice 单选**：`<input type="radio">`
- **choice 多选**：`<input type="checkbox">`
- **yesno**：两个 `<input type="radio">`，值为 `"Yes"` / `"No"`
- **text**：`<textarea rows="10">`
- **补充说明**：每个问题下方都有 `<textarea rows="3">`，name 为 `note_{index}`

表单提交到 `/answer/:sessionId`，取消按钮调用 `/cancel/:sessionId`。

### 表单数据解析

`POST /answer/:sessionId` 调用 `normalizeAskUserAnswerPayload()` 解析表单数据：

1. 遍历所有问题，读取 `question_{index}` 和 `note_{index}`
2. **多选题特殊处理**：`req.body[answerKey]` 可能是数组（多个选中）或字符串（单个选中），统一用 `\n` 拼接
3. **非字符串值**：通过安全字符串化处理，避免异常值让答案解析抛错
4. **补充说明**：trim 后非空才添加 `note` 字段
5. 构造答案对象，调用 `pending.resolve(payload)`

### 参数校验

built-in implementation validator 在进入 handler 前校验 1–4 个 questions、`question` / `header` / `type` 必填与基础类型、`type` 枚举、option 结构和未知字段。`question` 与 `header` 必须是非空字符串；choice question 的 option `label` 必须包含至少一个非空白字符；option `description` 必须存在且为 string，但允许空字符串。非 choice question 携带的未使用 options 保持原有结构边界，不额外要求 label 非空。

handler 保留一项跨字段关系：`type='choice'` 必须提供 options。options 一旦出现，其 2–4 项数量和元素结构由 schema 校验。

---

## 涉及文件

| 文件 | 职责 |
|-|-|
| `src/tools/definitions/ask-user.definition.ts` | Tool description 与 Draft 2020-12 input schema |
| `src/tools/ask-user.ts` | choice/options 参数关系、handler 实现、待回答会话、答案规范化/格式化 helper、HTML 生成 |
| `src/tools/ask-user-routes.ts` | 浏览器 HTTP 路由（`/ask`, `/answer`, `/cancel`）及 `/answer` 的表单解析中间件 |
| `src/index.ts` | HTTP server 创建和 `ask_user` 路由注册 |
| `src/tools/index.ts` | 工具注册 |
| `src/tools/types.ts` | `MCPTool` 接口定义 |
| `test/ask-user/ask-user-result.test.ts` | 答案规范化、结果格式化与 handler 返回测试 |
| `test/ask-user/ask-user-routes.test.ts` | 浏览器路由的表单渲染、提交、取消和未知会话响应测试 |
| `test/ask-user/ask-user.manual.ts` | 人工交互脚本（模拟 MCP 客户端调用） |

---

## 设计边界

本项目的稳定边界如下：

- 工具通过 HTTP 表单完成交互，使用全局 Map + Promise 管理待回答会话。
- MCP 调用保持阻塞直到用户提交或取消；当前实现不支持外部 `AbortSignal` 中止。
- 返回给 AI 的结果是结构化 JSON 文本，答案对象包含 `answer` 和可选 `note`。
- 所有问题类型都支持补充说明；补充说明不与主答案互斥。
- 工具不依赖消息总线、确认执行机制或遥测事件。
