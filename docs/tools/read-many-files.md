# read_many_files 工具文档

## 概述

批量读取多个文本文件内容并拼接返回。支持相对路径、位于任一 allowed root 内的 drive-absolute 路径和 glob 模式混合输入，解决 Android Studio 内置 `read_file` 只能逐个读取的效率问题。

核心设计理念：AI 在分析代码时经常需要同时查看多个文件的内容（如一个包下的所有 `.kt` 文件），逐个调用 `read_file` 会产生大量往返，浪费 token和时间。本工具一次调用即可返回所有文件内容。

---

## Schema

### 工具名称

`read_many_files` → Android Studio 中显示为 `mcp__custom_mcp__read_many_files`

### 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|-|-|-|-|-|
| `include` | `string[]` | ✅ | — | 相对路径、drive-absolute 路径或 glob 模式数组；相对输入基于 primary `rootDir`，drive-absolute 输入可位于任一 allowed root 内 |
| `exclude` | `string[]` | ❌ | `[]` | 额外排除模式，追加到默认排除之后 |
| `useDefaultExcludes` | `boolean` | ❌ | `true` | 是否启用默认排除规则 |
| `shallow_read` | `boolean` | ❌ | `false` | 浅读取，只返回文件列表、各自行数、总行数和是否会截断，不返回文件内容 |
| `show_line_numbers` | `boolean` | ❌ | `false` | 给返回内容每行添加原始行号前缀，仅在确实需要行号时开启 |

### description设计意图

description 中刻意包含了以下信息引导 AI 正确使用：

- **使用场景示例**：给出 drive-absolute 路径、glob、混合三种用法，降低 AI 猜测成本
- **文本文件限定**：明确告知只处理文本文件，避免 AI 尝试读取图片等二进制文件
- **截断提示**：告知超过行数限制会截断，引导 AI 用 `read_file` 或类似读取工具查看完整内容
- **浅读取提示**：说明 `shallow_read` 适合先摸清文件集合规模和截断风险
- **行号提示**：说明 `show_line_numbers` 会增加 token，仅在需要精确引用行号时开启
- **与 read_file 的分工**：明确建议单文件用 `read_file`，多文件用本工具

---

## 实现细节

### 路径分类处理

`include` 数组中的每个元素先进入统一路径安全层，路径层会在任何文件系统 I/O 前完成输入形态分类、lexical root 边界校验和 matched root 选择：

```text
遍历 include 数组
├── 字面路径候选（relative 或 drive-absolute）
│   → resolveSafePathInContext lexical 校验并得到 matched root
│   → validateSafeReadTarget realpath 校验，真实目标必须仍在 matched root 内
│   → fs.stat 确认为文件后加入待读集合
│   → drive-absolute 字面路径不受 exclude 模式影响
│
└── glob 候选
    → resolveSafeGlobPatternInContext 分类并计算 static base
    → static base 必须命中唯一 matched root，否则不调用 glob()
    → glob(pattern, { cwd: matchedRoot.rootDir, ignore: effectiveExcludes, absolute: true })
    → 每个展开结果再次做 lexical + realpath 校验，且必须仍在同一个 matched root 内
```

支持的 glob 来源包括 relative glob（如 `src/**/*.ts`）、drive-absolute glob（如 `E:/Repo/src/**/*.ts`）和窄兼容的 slash-leading glob（如 `/**/Foo.kt`）。relative glob 和 slash-leading glob 只基于 primary `rootDir`；drive-absolute glob 可命中 primary 或 additional root。普通 `/foo/bar.ts` 不含 glob 元字符，会按 rooted without drive 拒绝。

文件名中包含 glob 元字符（如 `special/file[test].ts`、`special/file{brace}.ts`）时，工具会先在 lexical 校验通过后按字面文件探测；只有不存在或不是文件时，才继续按 glob 模式处理。

Drive-absolute 字面路径不走 exclude 过滤的原因：AI 显式指定的文件不应被默认规则拦截。Glob 展开结果仍受 exclude 过滤，包括 additional root 内的 drive-absolute glob。

### 二进制文件检测

两层策略，定义在 `src/utils/file-read.ts`：

| 层 | 方法 | I/O 成本 |
|-|-|-|
| 第一层 | 扩展名判断：已知文本扩展名（`.kt`、`.ts` 等）直接放行，已知二进制扩展名（`.png`、`.jar` 等）直接跳过 | 零 |
| 第二层 | 内容检测：读取文件头4KB，检查 null 字节或不可打印字符比例 >30% | 极少 |

第二层只对扩展名不在两个名单中的文件触发（如 `Makefile`、无扩展名文件等）。

`.ts`/`.mts`/`.cts` 被显式列入文本扩展名白名单，因为 mime 库会将它们误识别为 MPEG transport stream（视频格式）。

### 文本读取与截断

| 限制 | 值 | 行为 |
|-|-|-|
| 单文件体积 | 20MB | 超过直接跳过，计入 skipped 列表 |
| 单文件行数 | 2000 行 | 超过截断，附带 `[WARNING: Truncated...]` |
| 单行长度 | 2000 字符 | 超过截断，行尾加 `... [truncated]` |
| 总文件数 | 100 个 | 超过后停止读取，结果中说明 |

截断逻辑参考自Gemini CLI 的 `fileUtils.ts`，常量值与原版一致。

`shallow_read: true` 时仍会读取文本以统计行数和判断截断风险，但不会把内容拼接到返回结果中。返回信息包括每个文件的原始总行数、所有文件总行数、以及如果正常读取内容是否会被截断。

`show_line_numbers: true` 时，每一行内容会添加原始 1-based 行号前缀，例如 `12: print("xxx")`。这个选项会增加输出体积，只有需要精确定位或引用行号时才建议开启。

### 并行读取

使用 `Promise.allSettled` 并行处理所有文件。每个文件独立执行二进制检测 → 文本读取，单个文件失败不影响其他文件。

本工具为只读操作，不需要使用 `withFileLock()`。

### 输出格式

返回中的文件显示路径由路径安全层统一决定：drive-absolute 字面路径或 drive-absolute glob 命中的文件显示绝对路径；相对路径、relative glob 和 slash-leading glob 命中的文件显示相对 primary `rootDir` 的路径。正文分隔符和 `shallow_read` 文件列表使用同一显示规则。

```
Read 3 file(s), skipped 1.
Files without a truncation warning are returned completely.
Skipped:
- /path/to/logo.png (binary file)

--- src/Foo.kt ---

<文件内容>

--- src/Bar.kt ---

<文件内容>

--- src/Baz.kt ---

[WARNING: Truncated. showing lines 1-2000 of 5432. Use read_file or a similar file-reading tool for full content.]

<截断后的文件内容>

--- End of content ---
```

无任何截断时，返回头部会明确包含：

```
No truncation: all returned file contents are complete.
```

浅读取模式示例：

```
Read 2 file(s).
Shallow read: file contents omitted.
Total lines: 120.
Files:
- src/Foo.kt: 40 line(s), would be truncated: no.
- src/Large.kt: 80 line(s), would be truncated: no.
```

AI 可以直接从分隔符中提取路径调用 `read_file` 查看完整内容。

### 默认排除列表

启用 `useDefaultExcludes`（默认）时，以下模式会被排除：

| 类别 | 模式 |
|-|-|
| 版本控制 | `**/node_modules/**`, `**/.git/**`, `**/.svn/**`, `**/.hg/**`, `**/bower_components/**` |
| IDE | `**/.vscode/**`, `**/.idea/**` |
| 构建输出 | `**/dist/**`, `**/build/**`, `**/coverage/**`, `**/__pycache__/**`, `**/.gradle/**` |
| 系统文件 | `**/.DS_Store`, `**/.env` |
| 二进制文件 | 由 `BINARY_EXTENSIONS` 集合自动生成（`**/*.exe`, `**/*.jar`, `**/*.png` 等） |

排除列表与 `BINARY_EXTENSIONS` 共用同一数据源，保持一致性。

---

## 涉及文件

| 文件 | 职责 |
|-|-|
| `src/tools/read-many-files.ts` | Schema定义、参数校验、路径分类、glob 展开、结果拼接 |
| `src/utils/file-read.ts` | 常量、二进制检测（`isBinaryFile`）、文本读取与截断（`readTextFile`）、`BINARY_EXTENSIONS` 集合 |
| `src/utils/paths.ts` | 路径分类、root 边界校验、glob static base 校验、展开结果校验、读取 realpath 安全校验 |
| `src/tools/index.ts` | 工具注册 |

---

## 参考来源与设计边界

`read_many_files` 的批量读取流程、默认排除模式、文本截断阈值和二进制扩展名列表参考 Gemini CLI 的 `ReadManyFilesTool` / `fileUtils` / `ignorePatterns` 实现。本项目的稳定边界如下：

- 不自动遍历多个 workspace；relative 输入只基于 primary root，additional roots 必须通过 drive-absolute path / glob 明确访问。
- allowed roots 沙箱和 `exclude` 参数共同决定可读文件集合，不读取 gitignore / geminiignore 作为安全边界。
- 只返回文本内容；图片、PDF、音频和其它二进制内容会被跳过。
- 使用 UTF-8 读取文本，不做 BOM 编码检测。
- 递归由 glob 的 `**` 表达，不提供单独的 `recursive` 参数。
- 工具不注入 JIT 上下文，也不记录遥测事件。
