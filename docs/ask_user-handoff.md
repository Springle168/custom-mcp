# ask_user 工具实现交接文档

## 功能概述

移植 Gemini CLI 的 `ask_user` 工具到 custom-mcp 服务器，允许 AI 在执行过程中向用户提问，收集选择或文本输入。

## 核心设计决策

### 1. 工具调用模型
`ask_user` 是一个**普通的阻塞式工具调用**：
- AI 调用工具时传入问题参数
- 工具 handler 内部阻塞等待用户输入
- 用户完成输入后，工具返回答案给 AI
- 对 MCP 协议来说，就是一个响应时间较长的 `tools/call`

### 2. 交互方式
**采用 Web UI 方案**，理由：
- 服务器已有 HTTP 基础设施
- 支持丰富的交互类型（单选、多选、文本输入）
- 多行文本输入体验好（`<textarea>`）
- 实现简单，无需额外依赖

**不采用终端交互**，理由：
- 终端主要用于日志输出
- 多行文本输入体验差
- 服务器通常后台运行，用户看不到终端

### 3. 多行文本输入
使用 `<textarea>` 足以覆盖使用场景：
- 预期输入量：几十行（不会是几百行）
- 设置合适的 `rows` 属性 + 滚动条
- 支持从外部编辑器复制粘贴
- 外部编辑器集成属于"锦上添花"，暂不实现

## 技术方案

### 工具参数（参考 Gemini CLI）

```typescript
interface AskUserParams {
  questions: Question[];
}

interface Question {
  question: string;      // 完整问题文本
  header: string;        // 短标签（用于显示）
  type: 'choice' | 'text' | 'yesno';
  options?: Option[];    // type='choice' 时必需
  multiSelect?: boolean; // type='choice' 时是否允许多选
  placeholder?: string;  // 输入提示文本
}

interface Option {
  label: string;         // 选项标签（1-5 词）
  description: string;   // 选项说明
}
```

### 答案格式（参考 Gemini CLI）

```typescript
// 返回给 AI 的格式
{
  answers: {
    "0": "OAuth 2.0",           // 问题索引 -> 答案
    "1": "PostgreSQL\nwith pooling"  // 多行用 \n 分隔
  }
}
```

### 实现流程

1. **工具 handler 创建会话**
   ```typescript
   const sessionId = crypto.randomUUID();
   const answerPromise = new Promise((resolve, reject) => {
     pendingQuestions.set(sessionId, { questions, resolve, timeout });
   });
   ```

2. **生成 URL 并记录日志**
   ```typescript
   const url = `http://localhost:${config.port}/interact/${sessionId}`;
   logger.info(`User input required: ${url}`);
   ```

3. **阻塞等待用户输入**
   ```typescript
   const answers = await answerPromise;
   return {
     content: [{ type: 'text', text: JSON.stringify({ answers }) }],
   };
   ```

4. **HTTP 路由处理**
   - `GET /interact/:sessionId` - 渲染问题表单
   - `POST /submit/:sessionId` - 接收答案，resolve Promise

### 状态管理

```typescript
interface PendingQuestion {
  questions: Question[];
  resolve: (answers: Record<string, string>) => void;
  timeout: NodeJS.Timeout;
}

const pendingQuestions = new Map<string, PendingQuestion>();
```

### 超时机制

- 设置 5 分钟超时
- 超时后自动清理会话，返回错误或默认值
- 避免 Promise 永久挂起

## 实现要点

### 1. Schema 定义
直接参考 `packages/core/src/tools/definitions/coreTools.ts` 中的 `ASK_USER_DEFINITION`，包含完整的参数描述和约束。

### 2. 参数校验
- 至少 1 个问题，最多 4 个
- `type='choice'` 必须有 2-4 个 options
- 每个 option 必须有 label 和 description

### 3. UI 实现
- 最简单的 HTML 表单即可
- `type='choice'` 用 `<select>` 或 `<input type="radio">`
- `type='text'` 用 `<textarea rows="25">`
- `type='yesno'` 用两个按钮或单选框
- 后续可优化样式，但功能优先

### 4. 日志输出
- 工具调用时输出 URL（用户需要手动打开浏览器）
- 用户提交后记录答案摘要
- 超时或取消时记录状态

## 参考资料

### Gemini CLI 源码
- 工具定义：`packages/core/src/tools/ask-user.ts`
- Schema：`packages/core/src/tools/definitions/coreTools.ts`
- 常量：`packages/core/src/tools/tool-names.ts`

### 本项目相关文件
- 工具注册：`src/tools/index.ts`
- 工具类型：`src/tools/types.ts`
- HTTP 入口：`src/index.ts`
- 日志系统：`src/utils/logger.ts`

## 未来优化方向（可选）

1. 自动打开浏览器（`open` 包）
2. 更好的 UI 样式
3. Monaco Editor 集成（如果需要编辑复杂文本）
4. WebSocket 实时通信（避免轮询）

---

**关键原则：先实现基础功能，验证可用性，再考虑优化。**
