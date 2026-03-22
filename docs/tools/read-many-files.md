# read_many_files 工具文档

## 概述

批量读取多个文本文件内容并拼接返回。支持绝对路径和 glob 模式混合输入，解决 Android Studio 内置 `read_file` 只能逐个读取的效率问题。

核心设计理念：AI 在分析代码时经常需要同时查看多个文件的内容（如一个包下的所有 `.kt` 文件），逐个调用 `read_file` 会产生大量往返，浪费 token和时间。本工具一次调用即可返回所有文件内容。

---

## Schema

### 工具名称

`read_many_files` → Android Studio 中显示为 `mcp__custom_mcp__read_many_files`

### 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `include` | `string[]` | ✅ | — | 绝对路径或 glob 模式数组 |
| `exclude` | `string[]` | ❌ | `[]` | 额外排除模式，追加到默认排除之后 |
| `useDefaultExcludes` | `boolean` | ❌ | `true` | 是否启用默认排除规则 |

### description设计意图

description 中刻意包含了以下信息引导 AI 正确使用：

- **使用场景示例**：给出绝对路径、glob、混合三种用法，降低 AI 猜测成本
- **文本文件限定**：明确告知只处理文本文件，避免 AI 尝试读取图片等二进制文件
- **截断提示**：告知超过行数限制会截断，引导 AI 用`read_file` 查看完整内容
- **与 read_file 的分工**：明确建议单文件用 `read_file`，多文件用本工具

---

## 实现细节

### 路径分类处理

`include` 数组中的每个元素按以下规则分类：

```
遍历 include 数组
├── 绝对路径（/ 开头 或 C:\ 开头）
│   → validatePathAccess 安全校验
│   → fs.stat 检查存在性
│   → 直接加入待读文件集合
│   → 不受 exclude 模式影响
│
└── 其他（相对路径 / glob 模式）
    ├── 解析为完整路径后检查是否为已存在的文件
    │   ├── 是 → escape() 转义 glob 元字符，当字面路径处理
    │   └── 否 → 当 glob 模式处理
    └── 统一传给 glob(patterns, { cwd: rootDir, ignore: effectiveExcludes })→ 结果逐个 validatePathAccess
```

绝对路径不走 exclude 过滤的原因：AI 显式指定的文件不应被默认规则拦截。

### 二进制文件检测

两层策略，定义在 `src/utils/file-read.ts`：

| 层 | 方法 | I/O 成本 |
|---|------|----------|
| 第一层 | 扩展名判断：已知文本扩展名（`.kt`、`.ts` 等）直接放行，已知二进制扩展名（`.png`、`.jar` 等）直接跳过 | 零 |
| 第二层 | 内容检测：读取文件头4KB，检查 null 字节或不可打印字符比例 >30% | 极少 |

第二层只对扩展名不在两个名单中的文件触发（如 `Makefile`、无扩展名文件等）。

`.ts`/`.mts`/`.cts` 被显式列入文本扩展名白名单，因为 mime 库会将它们误识别为 MPEG transport stream（视频格式）。

### 文本读取与截断

| 限制 | 值 | 行为 |
|------|------|------|
| 单文件体积 | 20MB | 超过直接跳过，计入 skipped 列表 |
| 单文件行数 | 2000 行 | 超过截断，附带`[WARNING: Truncated...]` |
| 单行长度 | 2000 字符 | 超过截断，行尾加 `... [truncated]` |
| 总文件数 | 100 个 | 超过后停止读取，结果中说明 |

截断逻辑参考自Gemini CLI 的 `fileUtils.ts`，常量值与原版一致。

### 并行读取

使用 `Promise.allSettled` 并行处理所有文件。每个文件独立执行二进制检测 → 文本读取，单个文件失败不影响其他文件。

本工具为只读操作，不需要使用 `withFileLock()`。

### 输出格式

```
Read3 file(s), skipped 1.
Skipped:
- /path/to/logo.png (binary file)

--- /absolute/path/to/src/Foo.kt ---

<文件内容>

--- /absolute/path/to/src/Bar.kt ---

<文件内容>

--- /absolute/path/to/src/Baz.kt ---

[WARNING: Truncated. Showing 2000 of 5432 lines. Use read_file for full content.]

<截断后的文件内容>

--- End of content ---
```

分隔符使用绝对路径，与 Android Studio 内置 `read_file` 的路径格式一致，AI 可以直接从分隔符中提取路径调用 `read_file` 查看完整内容。

### 默认排除列表

启用 `useDefaultExcludes`（默认）时，以下模式会被排除：

| 类别 | 模式 |
|------|------|
| 版本控制 | `**/node_modules/**`, `**/.git/**`, `**/.svn/**`, `**/.hg/**`, `**/bower_components/**` |
| IDE | `**/.vscode/**`, `**/.idea/**` |
| 构建输出 | `**/dist/**`, `**/build/**`, `**/coverage/**`, `**/__pycache__/**`, `**/.gradle/**` |
| 系统文件 | `**/.DS_Store`, `**/.env` |
| 二进制文件 | 由 `BINARY_EXTENSIONS` 集合自动生成（`**/*.exe`, `**/*.jar`, `**/*.png` 等） |

排除列表与 `BINARY_EXTENSIONS` 共用同一数据源，保持一致性。

---

## 涉及文件

| 文件 | 职责 |
|------|------|
| `src/tools/read-many-files.ts` | Schema定义、参数校验、路径分类、glob 展开、结果拼接 |
| `src/utils/file-read.ts` | 常量、二进制检测（`isBinaryFile`）、文本读取与截断（`readTextFile`）、`BINARY_EXTENSIONS` 集合 |
| `src/utils/paths.ts` | `validatePathAccess()` 路径安全校验 |
| `src/tools/index.ts` | 工具注册 |

---

## 移植来源

基于 Gemini CLI 的 `ReadManyFilesTool` 移植，主要参考文件：

| Gemini CLI 文件 | 参考内容 |
|-----------------|----------|
| `packages/core/src/tools/readManyFiles.ts` | 整体流程：glob 展开 → 安全校验 → 并行读取 → 拼接输出 |
| `packages/core/src/tools/definitions/model-family-sets/default-legacy.ts` | Schema 参数设计和description 写法 |
| `packages/core/src/utils/fileUtils.ts` | 文本读取截断逻辑、二进制检测、常量值 |
| `packages/core/src/utils/ignorePatterns.ts` | 默认排除模式、二进制扩展名列表 |
| `packages/core/src/utils/constants.ts` | `DEFAULT_MAX_LINES_TEXT_FILE`、`MAX_LINE_LENGTH_TEXT_FILE`、`MAX_FILE_SIZE_MB` |

### 移植时的裁剪

| 原版功能 | 处理方式 | 原因 |
|----------|----------|------|
| 多工作区遍历 | 移除，使用单一 `rootDir` | 本项目只有一个工作区 |
| gitignore / geminiignore 过滤 | 移除 | `rootDir` 沙箱 + exclude 参数已足够 |
| 图片 / PDF / 音频读取（base64） | 移除，统一跳过非文本文件 | Android Studio 侧支持不确定，使用场景极少 |
| JIT 上下文注入 | 移除 | Gemini CLI 专属功能 |
| 遥测日志 | 移除 | 本项目使用自己的日志系统 |
| BOM 编码检测 | 未移植，使用 UTF-8 读取 | 目标场景（Kotlin/Java源码）几乎不涉及 BOM |
| `recursive` 参数 | 移除 | glob 的 `**` 已控制递归，参数无实际作用 |
| `file_filtering_options` 参数 | 移除 | 依赖 gitignore/geminiignore，已整体去掉 |
