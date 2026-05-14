# replace_text 工具文档

## 概述

对文件进行精准的局部文本替换。从 Gemini CLI 的 Edit 工具移植而来，核心是四级匹配策略：Exact → Flexible → Regex → Fuzzy，按优先级依次尝试，在保持精确性的同时容忍 AI 常见的格式偏差（缩进错误、空白差异等）。

也支持通过空 `old_string` +不存在的路径来创建新文件。

---

## Schema

### 工具名称

`replace_text` → Android Studio 中显示为 `mcp__custom_mcp__replace_text`

### 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|-|-|-|-|-|
| `file_path` | `string` | ✅ | — | 要修改的文件路径 |
| `old_string` | `string` | ✅ | — | 要查找的精确文本，空字符串表示创建新文件 |
| `new_string` | `string` | ✅ | — | 替换后的文本 |
| `allow_multiple` | `boolean` | ❌ | `false` | 是否允许替换多处匹配 |

### description 设计意图

description 中包含了详细的使用规则，这些不是普通文档，而是直接影响 AI 行为的 prompt：

- **old_string 规则**：强调必须是精确文本、包含上下文行、不要转义——这些是 AI 最常犯的错误
- **new_string 规则**：提示避免省略占位符（如 `...`、`rest of methods`），要求完整代码——防止 AI 偷懒
- **最佳实践**：引导 AI 先 `read_file` 再替换、偏好小替换——降低匹配失败率、如果目标文件需要大量重构就建议使用 `write_file` 进行全量覆写

---

## 实现细节

### 执行流程

```
参数校验（包含 allow_multiple 严格类型检查）+ 生成省略占位符提醒
  → 路径解析 + 安全校验（validatePathAccess）
    → 文件锁（withFileLock）
      → 读取文件（统一 \n 处理）
        → 分支判断：├── old_string 为空 + 文件不存在 → 创建新文件
          ├── old_string 为空 + 文件已存在 → 报错
          ├── 文件不存在 → 报错
          └── 正常替换 → calculateReplacement（四级策略）
            → 检查匹配数量
              → 写入文件（恢复行尾符）
```

### 四级替换策略

定义在 `src/engine/replacement.ts`，按优先级依次尝试：

#### 1. Exact（精确匹配）

直接字面匹配，使用 `split().length - 1` 计数出现次数。最快，零误差。

命中条件：`old_string` 在文件中能找到完全一致的文本。

#### 2. Flexible（弹性缩进匹配）

逐行 `trim()` 后比较，忽略每行的前导/尾随空白。匹配成功后提取目标位置的缩进，用 `applyIndentation()` 将替换文本重新对齐。

命中条件：内容相同但缩进不一致（AI 常见的错误模式）。

#### 3. Regex（正则令牌化匹配）

将 `old_string` 按分隔符 `( ) : [ ] { } > < =` 拆分为token，每个 token 转义后用 `\s*` 连接。容忍 token 之间的任意空白变化。

实现上会把表达式锚定到行首或行首缩进后的位置（`^([ \t]*)`），因此它适合匹配完整代码行/代码块，不适合匹配行中间的任意片段。替换时会复用捕获到的目标缩进并应用到 `new_string`。

命中条件：代码结构相同但空白/换行格式不同，且匹配片段位于行首或缩进之后。

#### 4. Fuzzy（模糊匹配）

滑动窗口 + Levenshtein 距离。双重评分机制：

```
weightedDist = d_norm + (d_raw - d_norm) * 0.1
score = weightedDist / searchBlock.length
```

- `d_norm`：去除所有空白后的编辑距离（内容差异）
- `d_raw`：原始编辑距离（包含格式差异）
- 空白差异只算 10% 权重

阈值：`score ≤ 0.1`（允许最多 10% 的加权差异）

安全限制：
- `old_string.length < 10` →跳过（防止短字符串误匹配）
- `sourceLines.length * old_string.length² > 4e8` → 跳过（防止性能问题）

### 省略占位符提醒

`replace_text` 会检查 `new_string` 中是否出现 `old_string` 中没有的疑似省略占位符，并在成功创建或修改后的返回消息中追加 `Warning:`，但不会直接拒绝写入。这样可以提醒 AI 自检，同时允许文档、测试数据或示例代码中合法出现这些文本。

当前提醒会覆盖两类模式：

- `src/engine/text-utils.ts` 的 `detectOmissionPlaceholders()` 识别的带省略号短语，如 `rest of code ...`、`unchanged code ...`
- `src/tools/replace.ts` 中的额外宽松检测，如裸 `...`、注释包裹的 `// ...`、`/* ... */`、`same as above`、`existing code ...`

如果 warning 对应的是文档或真实内容，可以忽略；否则应使用 `read_file` 核对并提供完整 `new_string`。

### 行尾符处理

|阶段 | 处理 |
|-|-|
| 读取 | 检测原始行尾符（`detectLineEnding`），然后统一转为 `\n` 处理 |
| 替换 | 所有匹配和替换在 `\n` 环境下进行 |
| 写入 | 根据配置策略（`resolveLineEnding`）恢复行尾符 |

行尾符策略由 `config.lineEnding` 控制，详见 `DEVELOPMENT.md` 配置说明。

### 并发安全

所有文件写入操作包裹在 `withFileLock()` 中，同一文件的并发替换请求会被串行化。不同文件完全并行。

### 错误消息设计

错误消息不只是告诉 AI "失败了"，而是引导自我纠正：

```
// 匹配数量为 0
"Failed to edit, 0 occurrences found for old_string in src/index.ts. Ensure you're not escaping content incorrectly and check whitespace, indentation, and context. Use read_file tool to verify."

// 匹配数量 > 1 且未设置 allow_multiple
"Failed to edit, expected 1 occurrence but found N for old_string in file: src/index.ts. If you intended to replace multiple occurrences, set 'allow_multiple' to true."

// allow_multiple 类型错误
"The 'allow_multiple' parameter must be a boolean when provided."
```

---

## 涉及文件

| 文件 | 职责 |
|-|-|
| `src/tools/replace.ts` | Schema 定义、参数校验、执行流程编排（读取→替换→写入） |
| `src/engine/replacement.ts` | 四级替换策略实现（`calculateReplacement`）、错误结果生成（`getErrorReplaceResult`） |
| `src/engine/text-utils.ts` | 行尾符检测/解析（`detectLineEnding`、`resolveLineEnding`）、省略占位符检测（`detectOmissionPlaceholders`） |
| `src/utils/paths.ts` | `resolvePath()` 路径解析、`validatePathAccess()` 安全校验 |
| `src/utils/file-lock.ts` | `withFileLock()` 文件级并发锁 |

---

## 移植来源

基于 Gemini CLI 的 Edit 工具移植，主要参考文件：

| Gemini CLI 文件 | 参考内容 |
|-|-|
| `packages/core/src/tools/editTool.ts` | 整体流程：参数校验 → 文件读写 → 替换调用 |
| `packages/core/src/tools/definitions/model-family-sets/gemini-3.ts` | Schema 参数设计和 description |
| `packages/core/src/utils/editOperations.ts` | 四级替换策略算法 |

### 移植时的裁剪

| 原版功能 | 处理方式 | 原因 |
|-|-|-|
| `MessageBus` / `AbortSignal` | 移除 | MCP handler 不需要框架级消息总线和取消信号 |
| `logEditStrategy()` 遥测 | 移除 | 本项目使用自己的日志系统（入口层自动记录） |
| `Config` 对象依赖 | 替换为本项目的 `Config` 接口 | 只需要 `rootDir` 和 `lineEnding` |
| 确认流程（`ToolConfirmationOutcome`） | 移除 | MCP 协议中工具调用不需要用户确认 |
