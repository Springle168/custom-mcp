# write_file 工具文档

版本：v1.1

## 概述

`write_file` 用于将完整的文本内容写入目标文件，支持自动创建缺失的父目录，并覆盖已存在文件。它适合新建文件或整文件重写；如果只是局部修改，仍应优先使用 `replace_text`。

该工具只处理文本，不负责二进制文件写入。写入路径必须位于当前 `ToolRuntimeContext` 的 allowed roots 范围内；相对路径基于 primary `rootDir`，additional root 必须通过 drive-absolute 路径访问。

---

## 测试文件

```text
test/write-file/
└── write-file.test.ts   # 创建、覆盖、行尾符、二进制拒绝、placeholder warning 和 symlink 写入保护
```

写入类工具的跨 root 和路径安全回归另见 [docs/PATH-SAFETY.md](../PATH-SAFETY.md)；`replace_text` 的写入锁与行尾符并发回归见 [docs/tools/replace-text.md](replace-text.md)。

---

## Schema

### 工具名称

`write_file` → Android Studio 中显示为 `mcp__custom_mcp__write_file`

### 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|-|-|-|-|-|
| `file_path` | `string` | ✅ | — | 要写入的文件路径；相对路径基于 primary `rootDir`，drive-absolute 路径可位于任一 allowed root 内 |
| `content` | `string` | ✅ | — | 要写入的完整文本内容；疑似省略占位符会写入但触发 Warning |

### description 设计意图

- **全量写入**：强调必须提供完整文件内容，而不是局部片段。
- **目录创建**：自动创建缺失的父目录，方便直接新建文件。
- **路径安全**：写入目标必须保持在 matched root 内。
- **并行批次**：新建或重写多个大文件时，建议每次写一个文件，或每个并行批次最多写两个彼此独立的文件；小型独立文件可正常并行。
- **成功输出**：成功时返回英文消息，包含写入路径和文件总行数。

---

## 实现细节

### 路径安全

`file_path` 统一通过 `src/utils/paths.ts` 的路径安全层处理：先按原始输入分类，再解析和做 lexical root 边界校验。相对路径只基于 primary `rootDir`；drive-absolute 路径可位于 primary 或 additional root 内，并会命中唯一 matched root。drive-relative（如 `C:foo.txt`）、rooted without drive（如 `/foo.txt`、`\\foo.txt`）、UNC、Windows namespace 路径都会在文件系统 I/O 前被拒绝。

### 写入策略

- 写入前使用 `withFileLock()`，避免同一路径的并发写入互相覆盖。
- 写入前会查找目标父目录中最近的已存在祖先目录并校验其 `realpath` 仍位于同一个 matched root 内；创建缺失父目录后会再次执行同一校验。
- 目标路径若已存在且是 symbolic link，会被拒绝，避免通过 symlink / junction 写出工作区。
- 目标路径已存在时，会先读取文件并检测原始行尾；`lineEnding=auto` 时保留原始行尾风格。
- 目标路径不存在时，`lineEnding=auto` 默认使用 LF。
- 内容中如果包含疑似省略占位符，会继续写入并在成功消息后追加 Warning，提醒调用方确认是否为有意的文档或示例文本。
- 目标路径是目录、二进制文件，或无法读取/写入时都会返回错误。

### 成功输出

格式类似：

```text
Success: wrote nested/example.txt. Total lines: 2.
```

这里的总行数口径与 `read_file` 保持一致，按最终写入内容的换行结构计算。

---

## 涉及文件

| 文件 | 职责 |
|-|-|
| `src/tools/write-file.ts` | Schema 定义、参数校验、路径安全、写入编排、成功消息 |
| `src/tools/index.ts` | 工具注册 |
| `src/utils/paths.ts` | 路径分类、root 边界校验、display path、写入 realpath / symlink 安全校验 |
| `src/utils/file-lock.ts` | `withFileLock()` 文件级并发锁 |
| `src/engine/text-utils.ts` | 行尾符检测与解析 |
| `src/utils/file-read.ts` | 二进制文件识别 |
