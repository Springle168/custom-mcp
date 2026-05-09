# write_file 工具文档

## 概述

`write_file` 用于将完整的文本内容写入目标文件，支持自动创建缺失的父目录，并覆盖已存在文件。它适合新建文件或整文件重写；如果只是局部修改，仍应优先使用 `replace_text`。

该工具只处理文本，不负责二进制文件写入。写入路径必须位于当前配置的 `rootDir` 范围内。

---

## Schema

### 工具名称

`write_file` → Android Studio 中显示为 `mcp__custom_mcp__write_file`

### 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|-|-|-|-|-|
| `file_path` | `string` | ✅ | — | 要写入的文件路径，支持相对 `rootDir` 或绝对路径 |
| `content` | `string` | ✅ | — | 要写入的完整文本内容，不要留省略占位符 |

### description 设计意图

- **全量写入**：强调必须提供完整文件内容，而不是局部片段。
- **目录创建**：自动创建缺失的父目录，方便直接新建文件。
- **路径安全**：写入目标必须保持在 `rootDir` 内。
- **成功输出**：成功时返回英文消息，包含写入路径和文件总行数。

---

## 实现细节

### 路径安全

`file_path` 先通过 `resolvePath()` 解析为绝对路径，再通过 `validatePathAccess()` 校验必须位于 `rootDir` 范围内。

### 写入策略

- 写入前使用 `withFileLock()`，避免同一路径的并发写入互相覆盖。
- 目标路径已存在时，会先读取文件并检测原始行尾；`lineEnding=auto` 时保留原始行尾风格。
- 目标路径不存在时，`lineEnding=auto` 默认使用 LF。
- 内容中如果包含省略占位符，也会返回错误，避免把不完整的文件写入工作区。
- 目标路径是目录、二进制文件，或无法读取/写入时都会返回错误。

### 成功输出

成功消息是英文，格式类似：

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
| `src/utils/paths.ts` | `resolvePath()` 与 `validatePathAccess()` 路径安全校验 |
| `src/utils/file-lock.ts` | `withFileLock()` 文件级并发锁 |
| `src/engine/text-utils.ts` | 行尾符检测与解析 |
| `src/utils/file-read.ts` | 二进制文件识别 |
