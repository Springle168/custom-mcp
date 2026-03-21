# Custom MCP 开发文档

## 项目概述

基于 Gemini CLI 的 Edit 工具移植而来的 MCP 服务器，通过 Streamable HTTP 协议与 Android Studio 等 MCP 宿主通信，提供精准的文件局部替换能力。

核心替换引擎实现了四级匹配策略：Exact → Flexible → Regex → Fuzzy，按优先级依次尝试，确保高成功率的同时保持精确性。

---

## 目录结构

```
custom-mcp/
├── config.json                 # 运行时配置
├── package.json
├── tsconfig.json
├── logs/                       # 自动生成，每次启动一个日志文件
├── src/
│   ├── index.ts                # HTTP 入口 + MCP 会话管理
│   ├── config.ts               # 配置加载（文件 + 环境变量）
│   ├── tools/
│   │   ├── types.ts            # MCPTool 接口定义
│   │   ├── index.ts            # 工具注册表 + 路由分发
│   │   └── replace.ts          # replace 工具（schema + handler）
│   ├── engine/
│   │   ├── replacement.ts      # 四级替换策略
│   │   └── text-utils.ts       # 文本处理工具集
│   └── utils/
│       ├── paths.ts            # 路径解析 + 沙箱校验
│       ├── file-lock.ts        # 按文件路径的并发锁
│       └── logger.ts           # 日志系统（console + 文件双输出）
```

### 各层职责

| 层 | 目录 | 职责 | 原则 |
|---|---|---|---|
| 入口层 | `src/index.ts` | HTTP 服务器、MCP 协议处理、会话管理 | 加新工具时不需要改动 |
| 工具层 | `src/tools/` | 工具定义、参数校验、业务编排 | 每个工具一个文件 |
| 引擎层 | `src/engine/` | 纯算法逻辑，无 I/O 操作 | 可独立测试，无副作用 |
| 工具库 | `src/utils/` | 基础设施（日志、路径、锁） | 跨工具共用 |

---

## 添加新工具

### 步骤 1：创建工具文件

在 `src/tools/` 下新建文件，例如 `src/tools/read-file.ts`：

```typescript
import type { Config } from '../config.js';
import type { MCPTool, ToolCallResult } from './types.js';

// 1. 定义 Schema（MCP tools/list 返回给宿主）
const READ_FILE_TOOL_DEFINITION = {
  name: 'read_file',
  description: '工具描述，这段文字会直接进入 AI 的上下文，是 prompt engineering 的一部分。',
  inputSchema: {
    type: 'object' as const,
    properties: {
      file_path: {
        type: 'string',
        description: '参数描述，同样会被 AI 看到。',
      },
      // ... 其他参数
    },
    required: ['file_path'],
  },
};

// 2. 实现 Handler
async function handleReadFile(
  args: Record<string, unknown>,
  config: Config,
): Promise<ToolCallResult> {
  // 参数校验
  // 业务逻辑
  // 返回结果
  return {
    content: [{ type: 'text', text: '结果文本' }],
  };
}

// 3. 默认导出 MCPTool 对象
const readFileTool: MCPTool = {
  definition: READ_FILE_TOOL_DEFINITION,
  handler: handleReadFile,
};

export default readFileTool;
```

### 步骤 2：注册工具

编辑 `src/tools/index.ts`，加两行：

```typescript
import replaceTool from './replace.js';
import readFileTool from './read-file.js';  // ← 加这行

const registry: MCPTool[] = [
  replaceTool,
  readFileTool,  // ← 加这行
];
```

完成。`index.ts` 入口文件、日志系统、路由逻辑都不需要改动。

### 步骤 3：编译测试

```bash
npm run build
npm start
```

---

## 编写工具时的注意事项

### Schema 设计

Schema 中的 `description` 字段不仅仅是文档，**它是给 AI 看的 prompt**。这是从 Gemini CLI 学到的核心设计理念。

**应该包含的内容：**
- 工具的功能边界（能做什么、不能做什么）
- 参数的格式要求和约束
- 常见错误的预防提示
- 与其他工具的配合建议（如 "先用 read_file 查看内容"）

**应该避免的内容：**
- 内部实现细节（AI 不需要知道你用了什么算法）
- 过长的描述（增加 token 消耗，降低 AI 注意力）

参考 replace 工具的 description，它在简洁和完整之间做了平衡。

### 返回值设计

```typescript
// 成功
return {
  content: [{ type: 'text', text: '给 AI 看的结果描述' }],
};

// 失败
return {
  content: [{ type: 'text', text: '错误描述 + 引导 AI 下一步怎么做' }],
  isError: true,
};
```

**关键原则：错误消息应该引导 AI 自我纠正。** 不只是说"失败了"，要告诉 AI 为什么失败、怎么修复。例如：

```
// 差
"Failed to replace."

// 好
"Failed to edit, 0 occurrences found for old_string in src/index.ts.
Ensure you're not escaping content incorrectly and check whitespace,
indentation, and context. Use read_file tool to verify."
```

### 文件操作类工具的通用考虑

1. **路径安全**：所有文件操作必须调用 `validatePathAccess()` 校验路径在 `rootDir` 范围内。
2. **并发安全**：涉及文件写入的操作应使用 `withFileLock()` 包裹。
3. **行尾符**：读取时统一转为 `\n` 处理，写入时用 `resolveLineEnding()` 恢复。
4. **错误处理**：区分 `ENOENT`（文件不存在）和其他文件系统错误，给出不同的错误消息。

---

## 配置说明

### config.json

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `rootDir` | string | 无（必填） | 工作区根目录，所有文件操作限制在此范围内 |
| `lineEnding` | `"auto"` \| `"lf"` \| `"crlf"` | `"auto"` | 文件写入时的行尾符策略 |
| `port` | number | `3100` | HTTP 服务器监听端口 |

### 环境变量覆盖

| 环境变量 | 覆盖字段 |
|----------|----------|
| `MCP_ROOT_DIR` | `rootDir` |
| `MCP_LINE_ENDING` | `lineEnding` |
| `MCP_PORT` | `port` |

优先级：**环境变量 > config.json**。

### 行尾符策略详解

| 设置 | 已有文件 | 新建文件 |
|------|----------|----------|
| `auto` | 检测并保留原始行尾符 | 使用 `\n` (LF) |
| `lf` | 强制 `\n` | 强制 `\n` |
| `crlf` | 强制 `\r\n` | 强制 `\r\n` |

---

## 替换引擎详解

`src/engine/replacement.ts` 中的四级策略按优先级依次尝试：

### 1. Exact（精确匹配）

直接字面匹配，使用 `split().length - 1` 计数出现次数。最快，零误差。

**命中条件：** `old_string` 在文件中能找到完全一致的文本。

### 2. Flexible（弹性缩进匹配）

逐行 `trim()` 后比较，忽略每行的前导/尾随空白。匹配成功后提取目标位置的缩进，用 `applyIndentation()` 将替换文本重新对齐。

**命中条件：** 内容相同但缩进不一致（AI 常见的错误模式）。

### 3. Regex（正则令牌化匹配）

将 `old_string` 按分隔符 `( ) : [ ] { } > < =` 拆分为 token，每个 token 转义后用 `\s*` 连接。容忍 token 之间的任意空白变化。

**命中条件：** 代码结构相同但空白/换行格式不同。

### 4. Fuzzy（模糊匹配）

滑动窗口 + Levenshtein 距离。双重评分机制：

```
weightedDist = d_norm + (d_raw - d_norm) * 0.1
score = weightedDist / searchBlock.length
```

- `d_norm`：去除所有空白后的编辑距离（内容差异）
- `d_raw`：原始编辑距离（包含格式差异）
- 空白差异只算 10% 权重

**阈值：** `score ≤ 0.1`（允许最多 10% 的加权差异）

**安全限制：**
- `old_string.length < 10` → 跳过（防止短字符串误匹配）
- `sourceLines.length * old_string.length² > 4e8` → 跳过（防止性能问题）

---

## 日志系统

### 输出位置

- **终端（stdout）**：实时查看
- **日志文件**：`logs/YYYY-MM-DD_HH-MM-SS.log`，每次启动生成新文件

### 日志格式

```
[2025-01-15T14:30:00.000Z] ← CALL replace
  {
    "file_path": "src/index.ts",
    "old_string": "...",
    "new_string": "...",
    "allow_multiple": false
  }
[2025-01-15T14:30:00.050Z] → OK replace (50ms)
  Modified src/index.ts: 1 replacement(s) via exact match.
```

### 扩展日志

日志系统通过 `Logger` 类的 `logToolCall` 和 `logToolResult` 方法自动记录所有工具调用。在 `src/index.ts` 的路由层统一拦截，**工具 handler 内部不需要写任何日志代码**。

如需在 handler 内部输出调试日志，可以将 `logger` 实例通过参数传入，或扩展 `MCPTool` 接口。

---

## 并发模型

MCP 客户端可能并发发送多个 `tools/call` 请求。当前的并发策略：

- **不同文件**：完全并行，互不阻塞
- **同一文件**：通过 `withFileLock()` 串行化，FIFO 顺序

锁的实现基于 Promise 链（`src/utils/file-lock.ts`），不依赖外部库。文件操作完成后自动释放，Map 中不会积累已完成的锁。

**重要：** 只有涉及文件写入的工具需要使用 `withFileLock()`。只读工具（如未来可能的 read_file）不需要加锁。

---

## Android Studio 集成

### 配置

Android Studio 的 MCP 配置文件位置参考官方文档，添加：

```json
{
  "mcpServers": {
    "custom-mcp-server": {
      "httpUrl": "http://localhost:3100/mcp"
    }
  }
}
```

### 限制

- Android Studio **不支持 stdio 传输**，只能用 HTTP
- 不支持 MCP Resources 和 Prompt Templates
- 工具名称在 AI 侧会显示为 `mcp__{server_name}__{tool_name}` 格式

### 工具名称控制

最终显示名 `mcp__custom_mcp__replace_text` 由两处决定：

| 段 | 来源 | 文件 |
|---|---|---|
| 中间段 (server name) | `Server` 构造函数的 `name` | `src/index.ts` |
| 末段 (tool name) | 工具定义的 `name` | `src/tools/replace.ts` |

`-` 会被 Android Studio 自动转为 `_`。

---

## 继续移植 Gemini CLI 能力的参考

如果后续需要从 Gemini CLI 移植更多工具或能力，以下是各项的评估。

### 可直接移植的工具

| 工具 | 复杂度 | 关键源文件 | 备注 |
|------|--------|-----------|------|
| `read_file` | 低 | `packages/core/src/tools/readFile.ts` | 文本读取 + 行范围支持，最实用的搭配 |
| `write_file` | 低 | `packages/core/src/tools/writeFile.ts` | 全量写入，比 replace 简单 |
| `glob` (FindFiles) | 中 | `packages/core/src/tools/glob.ts` | 需要 glob 库，如 `fast-glob` |
| `grep_search` | 中 | `packages/core/src/tools/grep.ts` | 可简化为纯 JS 实现，不依赖 git grep |
| `list_directory` | 低 | `packages/core/src/tools/readFolder.ts` | 基础 `fs.readdir` |

**推荐优先级：** `read_file` > `list_directory` > `glob` > `grep_search` > `write_file`

`read_file` 优先级最高，因为 replace 工具的错误消息会引导 AI 去调用它验证文件内容。目前这个引导指向的是宿主环境中可能存在的其他 read_file 实现，如果自己提供一个会更可靠。

### 可选能力增强

| 能力 | 复杂度 | 关键源文件 | 价值评估 |
|------|--------|-----------|----------|
| LLM 自纠错 | 高 | `packages/core/src/utils/llm-edit-fixer.ts` | 替换失败时调 LLM 修正参数后重试。需要接入 LLM API，成本高但能显著提升成功率 |
| 按模型差异化 Schema | 中 | `packages/core/src/tools/definitions/resolver.ts` | 不同模型用不同的 description。单一宿主环境下价值不大 |
| Diff 输出 | 低 | 使用 `diff` npm 包 | 在成功消息中返回 unified diff，帮助 AI 验证修改结果 |

### 移植时的通用注意事项

1. **去除框架依赖**：Gemini CLI 的工具重度依赖 `Config`、`MessageBus`、`AbortSignal` 等框架对象。移植时需要用直接的 `fs` 调用和本项目的 `Config` 替代。

2. **去除遥测代码**：所有 `logEditStrategy()`、`EditStrategyEvent` 等遥测调用可以直接删除，本项目用自己的日志系统。

3. **async 清理**：Gemini CLI 中很多函数标记为 `async` 但内部没有真正的异步操作（如四级替换策略）。移植时可以去掉 `async` 简化调用。

4. **Schema 来源**：每个工具的 JSON Schema 定义在 `packages/core/src/tools/definitions/model-family-sets/default-legacy.ts` 中，可以直接参考其 `description` 和 `parametersJsonSchema` 字段，根据需要精简后使用。

---

## 常用命令

```bash
# 编译
npm run build

# 启动
npm start

# 编译并启动
npm run dev

# 安装新依赖
npm install <package>
npm install -D <package>    # 仅开发依赖
```

---

## 故障排查

| 现象 | 可能原因 | 解决方案 |
|------|----------|----------|
| 启动报 "rootDir is not configured" | config.json 中 rootDir 为空 | 填入项目绝对路径 |
| Android Studio 连接失败 | 服务器未启动 / 端口不对 | 确认 `npm start` 正常运行，端口与 AS 配置一致 |
| 工具调用返回 "Path outside workspace" | AI 传了 rootDir 范围外的路径 | 检查 config.json 的 rootDir 是否覆盖目标项目 |
| 替换失败 "0 occurrences found" | AI 给的 old_string 与文件实际内容不匹配 | 四级策略都未命中，AI 需要先 read_file 确认内容 |
| 替换失败 "expected 1 but found N" | old_string 匹配了多处 | AI 需要提供更多上下文，或设置 allow_multiple |
| 编译报类型错误 | SDK 版本更新导致接口变化 | 检查 `ToolCallResult` 是否需要补充字段 |
