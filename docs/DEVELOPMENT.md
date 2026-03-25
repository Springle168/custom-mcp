# Custom MCP 开发文档

## 项目概述

基于 Gemini CLI 的 Edit 工具移植而来的 MCP 服务器，通过 Streamable HTTP 协议与 Android Studio 等 MCP 宿主通信，提供精准的文件局部替换和批量文件读取能力。

---

## 目录结构

```
custom-mcp/
├── config.json                 # 运行时配置
├── package.json
├── tsconfig.json
├── logs/                       # 生产日志，每次启动一个日志文件
├── test/
│   ├── test-logger.ts          # 日志系统测试
│   └── logs/                   # 测试日志输出目录
├── docs/
│   ├── DEVELOPMENT.md          # 本文件
│   └── tools/
│       ├── replace-text.md     # replace_text 工具文档
│       └── read-many-files.md  # read_many_files 工具文档
├── src/
│   ├── index.ts                # HTTP 入口 + MCP 会话管理
│   ├── config.ts               # 配置加载（文件 + 环境变量）
│   ├── tools/
│   │   ├── types.ts            # MCPTool 接口定义
│   ├── index.ts                # 工具注册表+ 路由分发
│   │   ├── replace.ts          # replace_text 工具
│   │   └── read-many-files.ts  # read_many_files 工具
│   ├── engine/
│   │   ├── replacement.ts      # 四级替换策略
│   └── text-utils.ts           # 文本处理工具集
│   └── utils/
│       ├── paths.ts            # 路径解析 + 沙箱校验
│       ├── file-lock.ts        # 按文件路径的并发锁
│       ├── file-read.ts        # 文件读取 + 截断 + 二进制检测
│       └── logger.ts           # 日志系统（终端彩色 + 文件纯文本双输出）
```

### 各层职责

| 层 | 目录 | 职责 | 原则 |
|-|-|-|-|
| 入口层 | `src/index.ts` | HTTP 服务器、MCP 协议处理、会话管理 | 加新工具时不需要改动 |
| 工具层 | `src/tools/` | 工具定义、参数校验、业务编排 | 每个工具一个文件 |
| 引擎层 | `src/engine/` | 纯算法逻辑，无 I/O 操作 | 可独立测试，无副作用 |
| 工具库 | `src/utils/` | 基础设施（日志、路径、锁、文件读取） | 跨工具共用 |

---

## 已实现工具

| 工具名| 功能 | 文档 |
|-|-|-|
| `replace_text` | 文件局部替换，四级匹配策略（Exact → Flexible → Regex → Fuzzy） | [docs/tools/replace-text.md](tools/replace-text.md) |
| `read_many_files` | 批量读取多个文本文件，支持绝对路径和glob 模式 | [docs/tools/read-many-files.md](tools/read-many-files.md) |

---

## 添加新工具

### 步骤 1：创建工具文件

在 `src/tools/` 下新建文件，例如 `src/tools/read-file.ts`：

```typescript
import type { Config } from '../config.js';
import type { MCPTool,ToolCallResult } from './types.js';

// 1. 定义 Schema（MCP tools/list返回给宿主）
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
import readManyFilesTool from './read-many-files.js';
import readFileTool from './read-file.js';  // ← 加这行

const registry: MCPTool[] = [
  replaceTool,
  readManyFilesTool,
  readFileTool,  // ← 加这行
];
```

完成。`index.ts` 入口文件、日志系统、路由逻辑都不需要改动。

### 步骤 3：编译测试

```bash
npm run build
npm start
```

### 步骤 4：编写工具文档

在 `docs/tools/` 下新建对应的 markdown 文件，记录Schema 设计意图、实现细节、涉及文件和移植来源。然后在本文件的"已实现工具"表格中添加条目。

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

参考已实现工具的 description，它们在简洁和完整之间做了平衡。

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

**关键原则：错误消息应该引导 AI 自我纠正。** 不只是说"失败了"，要告诉 AI 为什么失败、怎么修复。

### 文件操作类工具的通用考虑

1. **路径安全**：所有文件操作必须调用 `validatePathAccess()` 校验路径在 `rootDir` 范围内。
2. **并发安全**：涉及文件写入的操作应使用 `withFileLock()` 包裹。只读工具不需要加锁。
3. **行尾符**：读取时统一转为 `\n` 处理，写入时用 `resolveLineEnding()` 恢复。
4. **错误处理**：区分 `ENOENT`（文件不存在）和其他文件系统错误，给出不同的错误消息。
5. **二进制检测**：读取文件内容前应使用 `isBinaryFile()` 检查，避免处理二进制文件。

---

## 配置说明

### config.json

| 字段 | 类型 | 默认值 | 说明 |
|-|-|-|-|
| `rootDir` | string | 无（必填） | 工作区根目录，所有文件操作限制在此范围内 |
| `lineEnding` | `"auto"` \| `"lf"` \| `"crlf"` | `"auto"` | 文件写入时的行尾符策略 |
| `port` | number | `3100` | HTTP 服务器监听端口 |

### 环境变量覆盖

| 环境变量 | 覆盖字段 |
|-|-|
| `MCP_ROOT_DIR` | `rootDir` |
| `MCP_LINE_ENDING` | `lineEnding` |
| `MCP_PORT` | `port` |

优先级：**环境变量 > config.json**。

### 行尾符策略详解

| 设置 | 已有文件 | 新建文件 |
|-|-|-|
| `auto` | 检测并保留原始行尾符 | 使用 `\n` (LF) |
| `lf` | 强制 `\n` | 强制 `\n` |
| `crlf` | 强制 `\r\n` | 强制 `\r\n` |

---

## 日志系统

### 输出位置

- **终端（stdout）**：实时查看，带颜色高亮
- **日志文件**：`logs/YYYY-MM-DD_HH-MM-SS.log`，每次启动生成新文件，纯文本格式

### 日志格式

```
────────────────────────────────
[2025-01-15T14:30:00.000Z] ← CALL replace_text
  {
    "file_path": "src/index.ts",
    "old_string": "...",
    "new_string": "...",
    "allow_multiple": false
  }
[2025-01-15T14:30:00.050Z] → OK replace_text (50ms)
  Modified src/index.ts:1 replacement(s) via exact match.
```

### 颜色高亮

终端输出使用多种颜色区分不同信息类型（时间戳、调用方向、工具名、状态等），提升可读性。每次工具调用前会输出分隔线，便于区分不同调用。

**JSON 语法高亮**：参数和结果中的 JSON 内容会进行语法着色（键名、字符串、数字、布尔值等使用不同颜色）。当 JSON 内容超过 50KB 时，自动降级为无高亮输出以保证性能。

日志文件保持纯文本格式（无 ANSI 转义码），便于工具处理和长期存档。

### 扩展日志

日志系统通过 `Logger` 类的 `logToolCall` 和 `logToolResult` 方法自动记录所有工具调用。在 `src/index.ts` 的路由层统一拦截，**工具 handler 内部不需要写任何日志代码**。

如需在handler 内部输出调试日志，可以将 `logger` 实例通过参数传入，或扩展 `MCPTool` 接口。

### 测试日志

运行 `test/test-logger.ts` 可以测试日志系统的颜色输出效果：

```bash
npx tsx test/test-logger.ts
```

测试生成的日志文件保存在 `test/logs/` 目录下，不会与生产日志混淆。

---

## 并发模型

MCP 客户端可能并发发送多个 `tools/call` 请求。当前的并发策略：

- **不同文件**：完全并行，互不阻塞
- **同一文件**：通过 `withFileLock()` 串行化，FIFO 顺序

锁的实现基于 Promise链（`src/utils/file-lock.ts`），不依赖外部库。文件操作完成后自动释放，Map 中不会积累已完成的锁。

**重要：** 只有涉及文件写入的工具需要使用 `withFileLock()`。只读工具（如 `read_many_files`）不需要加锁。

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

最终显示名由两处决定：

| 段| 来源 | 文件 |
|-|-|-|
| 中间段 (server name) | `Server` 构造函数的 `name` | `src/index.ts` |
| 末段 (tool name) | 工具定义的 `name` | 各工具文件 |

`-` 会被 Android Studio 自动转为 `_`。

### 与 Android Studio 内置工具的覆盖分析

Android Studio 已内置以下工具，无需移植：

| Gemini CLI 工具 | Android Studio 内置对应工具 |
|-|-|
| `read_file` | `read_file` |
| `write_file` | `write_file` |
| `list_directory` | `list_files` |
| `glob` | `find_files` |
| `grep_search` | `grep` |

---

## 继续移植 Gemini CLI 能力的参考

### 移植通用注意事项

1. **定位Schema**：所有工具的参数描述统一在
   `packages/core/src/tools/definitions/model-family-sets/default-legacy.ts`
   中，按工具名搜索即可找到完整 `description` 和 `inputSchema`。

2. **定位实现**：工具执行逻辑在
   `packages/core/src/tools/<toolName>.ts`。

3. **移除框架依赖**：原版工具依赖 `Config`、`MessageBus`、`AbortSignal` 等Gemini CLI 内部对象，移植时用本项目的 `Config` 和直接的 `fs` 调用替代。

4. **移除遥测**：删除所有 `logEditStrategy()`、`EditStrategyEvent` 等调用。

5. **async清理**：原版部分函数标记 `async` 但无实际异步操作，
   可视情况简化。

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
|-|-|-|
| 启动报"rootDir is not configured" | config.json 中 rootDir 为空 | 填入项目绝对路径 |
| Android Studio 连接失败 | 服务器未启动 / 端口不对 | 确认 `npm start` 正常运行，端口与 AS 配置一致 |
| 工具调用返回 "Path outside workspace" | AI 传了rootDir 范围外的路径 | 检查 config.json 的 rootDir 是否覆盖目标项目 |
| 替换失败 "0 occurrences found" | AI 给的 old_string 与文件实际内容不匹配 | 四级策略都未命中，AI 需要先read_file 确认内容 |
| 替换失败 "expected 1 but found N" | old_string 匹配了多处 | AI 需要提供更多上下文，或设置 allow_multiple |
| 批量读取返回空| include 模式未匹配任何文件 | 检查路径/glob 是否正确，确认文件在 rootDir 范围内 |
| 编译报类型错误 | SDK 版本更新导致接口变化 | 检查 `ToolCallResult` 是否需要补充字段 |
