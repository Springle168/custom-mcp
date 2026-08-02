# 工具开发说明

本文记录 `custom-mcp` 的工具注册流程、工具设计约定、并发模型，以及已实现工具索引。单个工具的参数契约和实现细节优先参考 `docs/tools/` 下对应文档。

---

## 单工具文档目录

```text
docs/tools/
├── replace-text.md      # replace_text 工具文档
├── read-file.md         # read_file 工具文档
├── write-file.md        # write_file 工具文档
├── read-many-files.md   # read_many_files 工具文档
├── ask-user.md          # ask_user 工具文档
└── android-build.md     # Android 构建工具文档
```

---

## 已实现工具

| 工具名 | 功能 | 文档 |
|-|-|-|
| `replace_text` | 文件局部替换，default 模式使用精确字面匹配，regex 模式使用显式 JavaScript 正则 | [docs/tools/replace-text.md](tools/replace-text.md) |
| `read_many_files` | 批量读取多个文本文件，支持相对路径、位于 allowed roots 内的 drive-absolute 路径和 glob 模式 | [docs/tools/read-many-files.md](tools/read-many-files.md) |
| `read_file` | 读取单个文本文件，支持行号或逐行正则范围和可选行号前缀 | [docs/tools/read-file.md](tools/read-file.md) |
| `write_file` | 写入完整文本文件，自动创建父目录，成功时返回英文消息并包含路径和总行数 | [docs/tools/write-file.md](tools/write-file.md) |
| `ask_user` | 向用户提问并收集答案，支持单选、多选、是/否、文本输入，所有类型支持补充说明 | [docs/tools/ask-user.md](tools/ask-user.md) |
| `android.assembleDebug` | 在固定 Android 工作目录执行 `./gradlew.bat assembleDebug`，仅支持 `quiet` / `stacktrace` / `offline` | [docs/tools/android-build.md](tools/android-build.md) |
| `android.testDebugUnitTest` | 在固定 Android 工作目录执行 `./gradlew.bat testDebugUnitTest`，仅支持 `quiet` / `stacktrace` / `offline` | [docs/tools/android-build.md](tools/android-build.md) |

---

## 源码布局

工具层只负责工具定义、参数校验、业务编排和结果返回。配置来源由 `ToolRuntimeContext` 提供；文件路径、安全边界、日志、进程执行等共享能力应复用已有基础设施。

```text
src/tools/
├── names.ts                         # canonical 工具名目录、ToolName 类型和名称判断
├── index.ts                         # canonical registry 与 workspace filtered service
├── types.ts                         # MCPTool 与 ToolCallResult 类型
├── results.ts                       # textResult / textErrorResult 等返回值 helper
├── replace.ts                       # replace_text 工具
├── read-file.ts                     # read_file 工具
├── read-many-files.ts               # read_many_files 工具
├── write-file.ts                    # write_file 工具
├── ask-user.ts                      # ask_user 工具
├── android-build-shared.ts          # Android 构建工具共享逻辑
├── android-assemble-debug.ts        # android.assembleDebug 工具
└── android-test-debug-unit-test.ts  # android.testDebugUnitTest 工具
```

### 共享实现归属

| 区域 | 归属 |
|-|-|
| `src/runtime/mcp-server.ts` | MCP server factory；使用调用方传入的同一 workspace tool service 接入 `tools/list` / `tools/call` |
| `src/runtime/tool-context.ts` | 工具 handler 的运行时输入类型；配置派生语义见 [docs/CONFIG.md](CONFIG.md) |
| `src/engine/text-utils.ts` | 文本行尾符检测与解析，供写入类工具复用 |
| `src/engine/replacement.ts` | `replace_text` 的核心匹配算法，细节见 [docs/tools/replace-text.md](tools/replace-text.md) |
| `src/engine/android-gradle-output.ts` | Android Gradle 输出解析，细节见 [docs/tools/android-build.md](tools/android-build.md) |
| `src/utils/paths.ts` | 文件类工具共享路径安全层，细节见 [docs/PATH-SAFETY.md](PATH-SAFETY.md) |
| `src/utils/file-read.ts` | 文本读取、二进制检测和截断逻辑，细节见 read 文件类工具文档 |
| `src/utils/file-lock.ts` | 写入类工具的文件级并发锁，见本文“并发模型” |
| `src/utils/logger.ts` | 工具调用日志，细节见 [docs/LOGGING.md](LOGGING.md) |
| `src/utils/android-gradle.ts` | Android Gradle 进程执行和超时控制，细节见 [docs/tools/android-build.md](tools/android-build.md) |

通用检查脚本位于 `test/tools/inspect-tools.ts`，可用于查看完整 canonical registry 的 definition 结构；selected workspace 的实际 `tools/list` 还会应用 exposure 过滤：

```bash
node --import tsx test/tools/inspect-tools.ts
```

### Registry 与 workspace tool service

`src/tools/names.ts` 的 `TOOL_NAMES` 是工具名称和顺序的 canonical 目录，不导入 handler。`src/tools/index.ts` 按该目录构建完整 registry，并在启动时检查缺失实现、额外实现和重复实现。

`createWorkspaceToolService()` 使用 selected workspace snapshot 中的 `toolExposure` 过滤完整 registry。service 的 definitions 和 route map 来自同一个 filtered registry，因此 `tools/list` 与 `tools/call` 使用相同的暴露边界；被排除或未注册的名称统一返回 `Unknown tool`。definitions 保持 canonical registry 顺序，不跟随配置数组顺序。

`src/runtime/mcp-server.ts` 提供可导入的 MCP server factory。factory 使用调用方传入的同一个 `WorkspaceToolService` 注册 list/call handlers；`tools/list` 在 SDK 协议边界返回 definitions 数组的浅拷贝。

---

## 添加新工具

### 步骤 1：创建工具文件

在 `src/tools/` 下新建文件，例如 `src/tools/read-file.ts`：

```typescript
import type { ToolRuntimeContext } from '../runtime/tool-context.js';
import type { MCPTool, ToolCallResult } from './types.js';
import { textResult } from './results.js';

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
  context: ToolRuntimeContext,
): Promise<ToolCallResult> {
  // 参数校验
  // 业务逻辑；文件类工具从 context.pathSafetyContext 使用路径安全能力
  // 返回结果
  return textResult('结果文本');
}

// 3. 默认导出 MCPTool 对象
const readFileTool: MCPTool = {
  definition: READ_FILE_TOOL_DEFINITION,
  handler: handleReadFile,
};

export default readFileTool;
```

### 步骤 2：登记 canonical 工具名

编辑 `src/tools/names.ts`，把工具名加入 `TOOL_NAMES`。该数组同时定义合法配置名称和 canonical registry 顺序。

### 步骤 3：注册工具

编辑 `src/tools/index.ts`，导入工具并把实现加入 `importedTools`：

```typescript
import replaceTool from './replace.js';
import readManyFilesTool from './read-many-files.js';
import readFileTool from './read-file.js';  // ← 加这行

const importedTools: readonly MCPTool[] = [
  replaceTool,
  readManyFilesTool,
  readFileTool,  // ← 加这行
];
```

名称目录与实现 registry 必须一一对应；缺失、额外或重复实现会在 registry 构建时失败。`src/index.ts`、日志系统和路由逻辑不需要为单个工具改动。

工具 handler 接收 `ToolRuntimeContext`，不要在工具层读取配置文件或解析全局配置结构。配置来源、workspace 选择和运行时快照归一化由配置层/运行时层负责。

### 步骤 4：编译测试

```bash
npm run build
npm run start
```

### 步骤 5：编写工具文档

在 `docs/tools/` 下新建对应的 markdown 文件，记录 Schema 设计意图、实现细节、设计边界、涉及文件和参考来源。然后在本文的“已实现工具”表格中添加条目。

工具暴露机制的回归入口：

- `test/tools/tool-exposure.test.ts`：canonical registry、workspace 过滤、definitions 与路由一致性。
- `test/runtime/mcp-server-tool-exposure.test.ts`：MCP server factory 的真实 `tools/list` / `tools/call` 接线和 service 复用。
- `test/config/tool-exposure.test.ts`：workspace `tools` schema、snapshot 接入和 env override 禁止。

---

## 编写工具时的注意事项

### Schema 设计

Schema 中的 `description` 字段不仅仅是文档，**它是给 AI 看的 prompt**。这是从 Gemini CLI 学到的核心设计理念。

**应该包含的内容：**

- 工具的功能边界（能做什么、不能做什么）。
- 参数的格式要求和约束。
- 常见错误的预防提示。
- 与其他工具的配合建议（如“先用 `read_file` 查看内容”）。

**应该避免的内容：**

- 内部实现细节（AI 不需要知道你用了什么算法）。
- 过长的描述（增加 token 消耗，降低 AI 注意力）。

参考已实现工具的 description，它们在简洁和完整之间做了平衡。

### Android Studio 嵌套 Schema 限制

仅正在为 Android Studio 的使用场景开发工具时需要注意。

详细背景和验证方式见 [docs/ANDROID-STUDIO.md](ANDROID-STUDIO.md)。

### 返回值设计

详细约定见 [docs/TOOL-RESULTS.md](TOOL-RESULTS.md)。新增工具不要手写 MCP 文本返回壳，优先使用 `src/tools/results.ts` 中的统一 helper。

```typescript
// 成功
return textResult('给 AI 看的结果描述');

// 失败
return textErrorResult('错误描述 + 引导 AI 下一步怎么做');
```

**关键原则：错误消息应该引导 AI 自我纠正。** 不只是说“失败了”，要告诉 AI 为什么失败、怎么修复。

### 文件操作类工具的通用考虑

1. **路径安全**：所有文件 I/O 必须先通过 `src/utils/paths.ts` 的统一路径安全层；写入工具还必须使用共享写入安全校验。详细语义见 [docs/PATH-SAFETY.md](PATH-SAFETY.md)。
2. **并发安全**：涉及文件写入的操作应使用 `withFileLock()` 包裹。只读工具不需要加锁。
3. **行尾符**：读取时统一转为 `\n` 处理，写入时根据 `context.lineEnding` 用 `resolveLineEnding()` 恢复。
4. **错误处理**：区分 `ENOENT`（文件不存在）和其他文件系统错误，给出不同的错误消息。
5. **二进制检测**：读取文件内容前应使用 `isBinaryFile()` 检查，避免处理二进制文件。

---

## 并发模型

MCP 客户端可能并发发送多个 `tools/call` 请求。当前的并发策略：

- **不同文件**：完全并行，互不阻塞。
- **同一文件**：通过 `withFileLock()` 串行化，FIFO 顺序。

锁的实现基于 Promise 链（`src/utils/file-lock.ts`），不依赖外部库。文件操作完成后自动释放，Map 中不会积累已完成的锁。

**重要：** 只有涉及文件写入的工具需要使用 `withFileLock()`。只读工具（如 `read_many_files`）不需要加锁。

---

## 故障排查

| 现象 | 可能原因 | 解决方案 |
|-|-|-|
| 替换失败且 `matched_targets=0` | AI 给的 `target` 与文件实际内容不匹配，或 regex pattern 未命中 | default 模式先用 `read_file` 确认内容；regex 模式检查 JavaScript 正则 pattern |
| 替换失败 `expected 1` 或 `matched_targets=N` | `target` 匹配了多处但未允许多匹配 | AI 需要提供更多上下文，或设置 `allow_multiple=true` |
| 批量读取返回空 | `include` 模式未匹配任何文件 | 检查路径 / glob 是否正确；相对输入需位于 primary `rootDir`，drive-absolute 输入需位于 allowed roots 内 |
| 编译报类型错误 | SDK 版本更新导致接口变化 | 检查 `ToolCallResult` 是否需要补充字段 |
