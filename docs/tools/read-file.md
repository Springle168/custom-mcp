# read_file 工具文档

## 概述

读取单个文本文件内容，支持按 1-based 行号范围读取，并可按需给返回内容添加行号前缀。该工具只返回 text 内容，不处理图片、音频或 PDF 等多模态文件。

适用场景：需要查看一个具体文件，或在 `read_many_files` 返回截断提示后，使用 `start_line` / `end_line` 对单文件进行更精确的分段读取。

---

## Schema

### 工具名称

`read_file` → Android Studio 中显示为 `mcp__custom_mcp__read_file`

### 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|-|-|-|-|-|
| `file_path` | `string` | ✅ | — | 要读取的文本文件路径，支持相对 `rootDir` 或绝对路径 |
| `start_line` | `number` | ❌ | — | 起始行号，1-based |
| `end_line` | `number` | ❌ | — | 结束行号，1-based，包含该行 |
| `show_line_numbers` | `boolean` | ❌ | `false` | 给返回内容每行添加原始行号前缀，仅在确实需要行号时开启 |

### description 设计意图

- **精确读取**：引导 AI 使用 `start_line` / `end_line` 做小范围读取，减少 token 浪费。
- **文本限定**：明确当前实现只处理文本文件，二进制文件会返回错误。
- **截断限制**：说明单文件 20MB、最多 2000 行、单行最多 2000 字符的限制。
- **行号提醒**：说明 `show_line_numbers` 只在需要精确引用行号时开启。

---

## 实现细节

### 路径安全

`file_path` 先通过 `resolvePath()` 解析为绝对路径，再通过 `validatePathAccess()` 校验必须位于 `rootDir` 范围内。

### 参数校验

- `file_path` 必须是非空字符串。
- `start_line` / `end_line` 必须是整数且不小于 1。
- 同时提供 `start_line` 和 `end_line` 时，`start_line` 不得大于 `end_line`。
- `show_line_numbers` 必须是 boolean。

### 文本读取与截断

读取逻辑复用 `src/utils/file-read.ts` 的 `readTextFile()`：

| 限制 | 值 | 行为 |
|-|-|-|
| 单文件体积 | 20MB | 超过直接返回错误 |
| 返回行数 | 2000 行 | 超过会截断 |
| 单行长度 | 2000 字符 | 超过会截断，行尾加 `... [truncated]` |

未发生截断时，返回会明确包含：

```
No truncation: all returned file content is complete.
```

发生截断时，返回会明确说明当前显示的行号范围，并提示后续继续用 `start_line` / `end_line` 读取更多内容。

### 输出示例

完整读取：

```
Read 15 of 15 line(s) from src/Foo.kt.
No truncation: all returned file content is complete.

package com.example.demo
...
```

范围读取并显示行号：

```
Read 3 of 15 line(s) from src/Foo.kt.
IMPORTANT: The file content has been truncated. Showing lines 6-8 of 15 total lines. Use start_line and end_line in a subsequent read_file call to read more.

6: data class Foo(
7:     val id: Long,
8:     val name: String
```

---

## 涉及文件

| 文件 | 职责 |
|-|-|
| `src/tools/read-file.ts` | Schema 定义、参数校验、路径安全、结果拼接 |
| `src/utils/file-read.ts` | 二进制检测、文本读取、行范围、行号前缀和截断逻辑 |
| `src/utils/paths.ts` | `resolvePath()` 与 `validatePathAccess()` 路径安全校验 |
| `src/tools/index.ts` | 工具注册 |

---

## 移植来源

参考 Gemini CLI 的 `read_file` schema 和文本文件读取行为：

| Gemini CLI 文件 | 参考内容 |
|-|-|
| `packages/core/src/tools/definitions/model-family-sets/gemini-3.ts` | `file_path`、`start_line`、`end_line` 参数设计和 description 写法 |
| `packages/core/src/tools/read-file.ts` | 行范围校验、截断提示思路 |
| `packages/core/src/utils/fileUtils.ts` | 文本读取截断逻辑和常量语义 |

### 移植时的裁剪

| 原版功能 | 处理方式 | 原因 |
|-|-|-|
| 图片 / PDF / 音频读取 | 不移植，二进制文件直接报错 | 本项目 `ToolCallResult` 目前只建模 text 内容 |
| JIT 上下文注入 | 移除 | Gemini CLI 专属功能 |
| 遥测日志 | 移除 | 本项目使用自己的日志系统 |
| ignore 文件过滤 | 移除 | 本项目以 `rootDir` 沙箱作为安全边界 |
