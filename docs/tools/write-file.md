# write_file 工具文档

## 概述

`write_file` 用于将完整的文本内容写入目标文件，支持自动创建缺失的父目录，并覆盖已存在文件。它适合新建文件或整文件重写；如果只是局部修改，仍应优先使用 `replace_text`。

该工具接受字符串内容，已有目标只允许覆盖符合共享[内容分类规则](read.md#内容分类规则)的文本；缺失目标可使用任意后缀创建。写入路径必须位于 `ToolRuntimeContext` 的 allowed roots 范围内；相对路径基于 primary `rootDir`，additional root 必须通过 drive-absolute 路径访问。

---

## Schema

### 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|-|-|-|-|-|
| `file_path` | `string` | ✅ | — | 要写入的文件路径；相对路径基于 primary `rootDir`，drive-absolute 路径可位于任一 allowed root 内 |
| `content` | `string` | ✅ | — | 要写入的完整文本内容 |

`inputSchema` 设置 `additionalProperties: false`，未知字段会在进入 handler 前由 built-in implementation validator 拒绝。

Tool description 对多个大文件的新建或整文件重写建议每次处理一个文件，或每个并行批次最多两个独立文件；小型独立文件可正常并行。这是调用建议，不是 handler 的批次硬限制。

---

## 实现细节

### 路径安全

`file_path` 的输入分类、allowed-root 与 realpath 规则由[路径安全](../PATH-SAFETY.md)承接；写入策略区分锁前预检与锁内复检，后者不能被首次路径解析替代。

### 写入策略

- Lexical file candidate deny 在取得 `withFileLock()` 前执行；命中时不会创建目录、读取内容或取得锁。
- 锁内查找最近存在祖先，将其 `realpath` 与剩余 lexical 路径组合为预计 real target，并执行 same-root 与 deny。
- 已存在目标先按实际类型执行 lexical/realpath deny，再处理 symbolic link、目录和文件类型错误。
- 创建缺失父目录后和正式写入前都重新执行写入安全与 deny。
- 已有普通文件在锁内完整读取字节，按共享规则分类，仅 `text` 可继续；同一份字节用于 UTF-8 解码和行尾检测，`lineEnding=auto` 时保留原始行尾风格。
- 文件不存在须由文件系统操作明确确认；该分支不分类路径或后缀，`lineEnding=auto` 默认使用 LF。分类异常即使携带 `ENOENT` 也只导致失败，不授权创建或覆盖。
- `write_file` 没有 `read` / `replace_text` 的 20 MiB 读取上限。
- 输入字符串和最终写出字节不参与分类，允许写出 NUL 等非文本内容；成功保持有效，后续调用按磁盘实际内容重新分类并可能拒绝。
- 输入中的换行按行尾符策略规范化，尾换行的有无和数量由输入内容决定，不额外补删。
- 目标不是普通文件、已有内容属于 `image` / `other` / `unknown`、分类异常，或无法读取/写入时返回错误。内容准入失败不修改目标；分类异常不回显探测器原始错误。

### 成功输出

格式类似：

```text
Success: wrote nested/example.txt. Total lines: 2.
```

这里的总行数口径与 [`read`](read.md) 保持一致，按最终写入内容的换行结构计算。

---

## 验证重点

运行 `npm test -- write-file`，重点验证任意后缀创建与已有内容准入、探测异常不授权写入、`auto` 行尾保留、输入换行规范化与尾换行数量。

跨 root、deny 与 symlink 回归见[路径安全](../PATH-SAFETY.md)；写入锁与行尾符并发回归见 [replace_text](replace-text.md#验证重点)。通用测试约定见[测试](../TESTING.md)。
