# replace_text 工具文档

## 概述

对文件进行精准的局部文本替换。从 Gemini CLI 的 Edit 工具移植而来，核心是四级匹配策略：Exact → Flexible → Regex → Fuzzy，按优先级依次尝试，在保持精确性的同时容忍 AI 常见的格式偏差（缩进错误、空白差异等）。

也支持通过空`old_string` +不存在的路径来创建新文件。

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
- **new_string 规则**：禁止省略占位符（如 `...`、`rest of methods`），要求完整代码——防止 AI 偷懒
- **最佳实践**：引导 AI 先 `read_file` 再替换、偏好小替换——降低匹配失败率、如果目标文件需要大量重构就建议使用 `write_file` 进行全量覆写

---

## 实现细节

### 执行流程

```
参数校验（省略占位符检测）
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

命中条件：代码结构相同但空白/换行格式不同。

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

### 省略占位符检测

参数校验阶段会检查 `new_string` 中是否包含省略占位符（如 `...`、`rest of methods`、`unchanged code` 等）。如果 `new_string` 中出现了`old_string` 中不存在的占位符，直接拒绝，防止 AI 用占位符替代实际代码导致代码丢失。

检测逻辑在 `src/engine/text-utils.ts` 的 `detectOmissionPlaceholders()` 中。

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
//匹配数量为 0
"Failed to edit,0 occurrences found for old_string in src/index.ts.Ensure you're not escaping content incorrectly and check whitespace,
 indentation, and context. Use read_file tool to verify."

// 匹配数量 > 1且未设置 allow_multiple
"Found N occurrences of old_string in src/index.ts, expected 1.
 Include more surrounding context to uniquely identify the target,
 or set allow_multiple to true."
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
