# read_file 工具文档

## 概述

读取单个文本文件内容，支持按 1-based 行号范围读取，或按逐行正则定位起止行后读取连续范围，并可按需给返回内容添加原始行号前缀。该工具只返回 text 内容，不处理图片、音频或 PDF 等多模态文件。

适用场景：需要查看一个具体文件，或在 `read_many_files` 返回截断提示后，使用 `read_file` 对单文件读取完整内容或更精确的局部范围。

---

## 测试文件

```text
test/read-file/
├── fixtures.ts         # suite 自有 fixture 的生成、清理和临时文件生命周期
└── read-file.test.ts   # read_file 参数校验、行号/regex 范围、完整读取和二进制拒绝
```

fixture 模块在 `test/fixtures/read-file/` 中创建并清理 suite 自有的文本与二进制文件树；路径安全的跨工具回归另见 [docs/PATH-SAFETY.md](../PATH-SAFETY.md)。

---

## Schema

### 工具名称

`read_file`

### 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|-|-|-|-|-|
| `file_path` | `string` | ✅ | — | 要读取的文本文件路径；相对路径基于 primary `rootDir`，drive-absolute 路径可位于任一 allowed root 内 |
| `start_line` | `integer \| string` | ❌ | — | 起始位置；解释方式由 `read_mode` 决定 |
| `end_line` | `integer \| string` | ❌ | — | 结束位置，包含该行；解释方式由 `read_mode` 决定 |
| `read_mode` | `"line" \| "regex"` | ❌ | `"line"` | 行定位模式：`line` 按行号解释，`regex` 按逐行正则解释 |
| `show_line_numbers` | `boolean` | ❌ | `false` | 给返回内容每行添加原始 1-based 行号前缀，仅在确实需要行号时开启 |

### description 设计意图

- **精确读取**：引导 AI 使用 `read_mode`、`start_line` 和 `end_line` 做小范围读取，减少 token 浪费。
- **模式明确**：通过 `read_mode` 区分行号定位和正则定位，避免把字符串行号误解为数字。
- **文本限定**：明确当前实现只处理文本文件，二进制文件会返回错误。
- **读取边界**：说明单文件保留 20MB 体积保护，且没有返回行数或单行长度截断。
- **行号提醒**：说明 `show_line_numbers` 只在需要精确引用行号时开启。

---

## 实现细节

### 路径安全

`file_path` 统一通过 `src/utils/paths.ts` 的路径安全层处理：先按原始输入分类，再解析和做 lexical root 边界校验。相对路径只基于 primary `rootDir`；drive-absolute 路径可位于 primary 或 additional root 内，并会命中唯一 matched root。drive-relative（如 `C:foo.txt`）、rooted without drive（如 `/foo.txt`、`\\foo.txt`）、UNC、Windows namespace 路径都会在文件系统 I/O 前被拒绝。

读取已存在文件时，工具通过 `FileAccessPolicyContext` 先执行 lexical file candidate deny，再执行 `realpath` / same-root 校验；实际类型确认后按 file 或 directory candidate 同时重查 lexical 与 realpath deny。只有通过 deny 后才继续目录错误、二进制检测和文本读取。Literal 读取不应用 ignore。

### 参数校验

built-in implementation validator 在进入 handler 前校验非空 `file_path`、`read_mode` 枚举、`show_line_numbers` boolean，以及 `start_line` / `end_line` 的 integer-or-string 基础类型、正数或非空值域。handler 继续校验依赖 `read_mode` 的参数关系和正则运行时语义：

- `line` 模式下，`start_line` / `end_line` 如果提供，必须使用正整数 JSON number，字符串数字会被拒绝。
- `line` 模式下，同时提供 `start_line` 和 `end_line` 时，`start_line` 不得大于 `end_line`；错误信息会包含实际传入值，便于修正。
- `regex` 模式下，`start_line` / `end_line` 如果提供，必须使用非空字符串，且能作为 JavaScript `RegExp` pattern 编译。

### `read_mode="line"`

- 不提供 `start_line` 时从第 1 行开始。
- 不提供 `end_line` 时读取到 EOF。
- `start_line` 超出文件总行数时返回错误。
- `end_line` 超出文件总行数时裁剪到 EOF，不视为截断。

### `read_mode="regex"`

- `start_line` / `end_line` 按 JavaScript `RegExp` pattern 编译，不额外添加 `g`、`m`、`s` 等标志。
- 匹配按单行逐行执行，不支持跨行正则定位。
- 不提供 `start_line` 时从第 1 行开始；提供时，从文件开头寻找第一条匹配行作为起始行。
- 不提供 `end_line` 时读取到 EOF；提供时，从已解析的起始行开始寻找第一条匹配行作为结束行，并包含该行。
- 正则语法无效、`start_line` 无匹配或 `end_line` 无匹配时返回错误，并提示检查 pattern。

### 文本读取与输出

读取逻辑复用 `src/utils/file-read.ts` 的 `readTextFile()`，但 `read_file` 会关闭行数与单行长度截断，仅保留文件大小和二进制保护：

| 限制 | 值 | 行为 |
|-|-|-|
| 单文件体积 | 20MB | 超过直接返回错误 |
| 二进制文件 | — | 拒绝读取并返回错误 |
| 返回行数 | 不限制 | 可读取完整文本内容 |
| 单行长度 | 不限制 | 不缩短长行内容 |

完整读取时，返回会明确包含：

```
No truncation: all returned file content is complete.
```

主动范围读取时，返回会明确包含：

```
Partial read: showing lines A-B of N total lines.
```

主动范围读取输出 `Partial read` 摘要；`read_file` 正常成功结果不会因为行数或单行长度出现截断提示。

成功返回固定使用以下结构，避免 summary 与正文混淆：

```text
<summary line 1>
<summary line 2>

--- {filePath} ---

<file content>

--- End of content ---
```

输出中的 `{filePath}` 由路径安全层统一决定：drive-absolute 输入显示解析后的绝对路径，相对输入显示相对 primary `rootDir` 的路径。工具层不自行通过 `path.isAbsolute()` 判断显示策略。

### 输出示例

完整读取：

```text
Read 3 of 3 line(s) from src/Foo.kt.
No truncation: all returned file content is complete.

--- src/Foo.kt ---

package com.example.demo

class Foo

--- End of content ---
```

行号范围读取并显示行号：

```text
Read 3 of 15 line(s) from src/Foo.kt.
Partial read: showing lines 6-8 of 15 total lines.

--- src/Foo.kt ---

6: data class Foo(
7:     val id: Long,
8:     val name: String

--- End of content ---
```

正则范围读取：

```text
Read 5 of 15 line(s) from src/Foo.kt.
Partial read: showing lines 6-10 of 15 total lines.

--- src/Foo.kt ---

data class Foo(
    val id: Long,
    val name: String,
    val email: String
) {

--- End of content ---
```

---

## 与 read_many_files 的分工

`read_many_files` 使用批量输出保护：单文件最多返回 2000 行、单行最多 2000 字符，并在发生截断时提示使用 `read_file` 查看完整内容。`read_file` 面向单文件精读，不应用这些批量输出截断限制。

---

## 涉及文件

| 文件 | 职责 |
|-|-|
| `src/tools/definitions/read-file.definition.ts` | Tool description、Draft 2020-12 input schema 与输出分隔常量 |
| `src/tools/read-file.ts` | 参数校验、`read_mode` 解析、路径安全、结果拼接 |
| `src/utils/file-read.ts` | 二进制检测、20MB 文件大小保护、文本读取、可配置截断、行号前缀 |
| `src/utils/paths.ts` | 路径分类、root 边界校验和 display path |
| `src/utils/file-access-policy.ts` | policy candidate、lexical/realpath deny 与读取目标检查 |
| `src/tools/index.ts` | 工具注册 |

---

## 设计边界

本项目的稳定边界如下：

- 只返回 MCP text 内容；图片、PDF、音频和其它二进制内容会被拒绝读取。
- 可访问边界由 allowed roots 与 matched-root deny 共同决定；ignore 只用于自动发现，不影响 `read_file` literal。
- 工具不注入 JIT 上下文，也不记录遥测事件。
