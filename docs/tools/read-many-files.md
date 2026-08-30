# read_many_files 工具文档

## 概述

批量读取多个文本文件内容并拼接返回。支持相对路径、位于任一 allowed root 内的 drive-absolute 路径和 glob 模式混合输入，解决 Android Studio 内置 `read_file` 只能逐个读取的效率问题。

核心设计理念：AI 在分析代码时经常需要同时查看多个文件的内容（如一个包下的所有 `.kt` 文件），逐个调用 `read_file` 会产生大量往返，浪费 token和时间。本工具一次调用即可返回所有文件内容。

---

## 测试文件

```text
test/read-many-files/
├── fixtures.ts                  # suite 自有 fixture 文件树的生成与清理
└── read-many-files.test.ts      # include/exclude、glob、shallow_read、行号和二进制跳过

test/file-access-policy/
└── file-tools.test.ts           # literal/glob ignore、deny、mixed-result 隐私与写入拒绝

test/fixtures/read-many-files/
└── <runtime-generated>          # 由同主题 fixtures.ts 创建并清理的 suite 自有文件树
```

同主题 fixture 模块声明 glob、嵌套路径、特殊文件名、二进制文件和无内置 ignore 回归所需的数据，测试不依赖手动 fixture 生成步骤。

跨 allowed roots、glob static base、exclude 与 symlink 的横向路径安全回归另见 [docs/PATH-SAFETY.md](../PATH-SAFETY.md)。

---

## Schema

### 工具名称

`read_many_files`

### 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|-|-|-|-|-|
| `include` | `string[]` | ✅ | — | 相对路径、drive-absolute 路径或 glob 模式数组；相对输入基于 primary `rootDir`，drive-absolute 输入可位于任一 allowed root 内 |
| `exclude` | `string[]` | ❌ | `[]` | 仅过滤 glob 自动发现结果的本次调用 glob pattern；literal 绕过 |
| `use_ignore_files` | `boolean` | ❌ | `true` | 是否使用 matched root 配置的 `ignoreFiles` 过滤 glob 自动发现结果；不影响 literal、`exclude` 或 deny。宽泛发现应保持默认开启；如需检查被 ignore 的候选，推荐先收窄 include pattern，再以 `use_ignore_files=false` 和 `shallow_read=true` 预检，最后通过 literal 路径读取选中的文件 |
| `shallow_read` | `boolean` | ❌ | `false` | 返回文件列表、各自行数与大小、总行数与总大小和是否会截断；可通过 `shallow_read_content_limit_bytes` 为小规模结果同时返回文件内容；内容返回阈值建议不超过 `SHALLOW_READ_BATCH_SIZE_BYTES` |
| `shallow_read_content_limit_bytes` | `integer` | ❌ | — | 仅与 `shallow_read=true` 配合使用的正整数；成功处理文件的原始磁盘总大小不大于该字节数时，同时返回浅读统计和文件内容 |
| `show_line_numbers` | `boolean` | ❌ | `false` | 给返回内容每行添加原始行号前缀，仅在确实需要行号时开启 |

### description设计意图

工具与参数 description 按职责分层，引导 AI 正确选择工具并构造参数：

- **主 description**：说明多文件和 glob 读取场景、文本文件限定、截断边界，以及与单文件 `read_file` 的分工
- **批量预检**：建议宽泛文件集合先使用 `shallow_read` 评估大小和截断风险，再决定后续读取范围
- **输入路径**：由 `include` 参数说明 relative / drive-absolute 路径和 glob 的 root 语义，并提供输入示例
- **过滤规则**：由 `exclude` 和 `use_ignore_files` 参数区分本次调用过滤与 root-specific 持久 ignore；所有 literal 都绕过两者
- **ignore 渐进式探查**：保持宽泛发现的默认 ignore；如需检查被过滤候选，先收窄 pattern 并以关闭 ignore 的浅读取预检，再通过 literal 路径精读
- **浅读取结果**：由 `shallow_read` 参数说明行数、大小、截断状态、可选内容返回和建议批次大小
- **小规模结果合并返回**：由 `shallow_read_content_limit_bytes` 说明按成功处理文件的原始磁盘总大小决定是否同时返回内容
- **行号输出**：由 `show_line_numbers` 参数说明 1-based 行号及输出体积影响

---

## 实现细节

### 路径分类处理

`include` 数组中的每个元素由 `src/utils/file-selection.ts` 的 `selectReadableFiles()` 统一选择。该模块组合 allowed-root、policy candidate、lexical/realpath deny 和受控 glob 遍历，并将工具参数映射为内部的 `pathSelectors`、`discoveryExcludePatterns` 与 `respectIgnoreFiles`：

```text
遍历 include 数组
├── 字面路径候选（relative 或 drive-absolute）
│   → lexical 校验、文件 candidate deny 并得到 matched root
│   → realpath/same-root 与实际类型 lexical/real deny
│   → 确认为文件后加入待读集合
│   → relative 与 drive-absolute literal 都绕过 ignore 和 exclude
│
└── glob 候选
    → 分类并计算 static base，执行 lexical/预计 real deny
    → 受控 glob adapter 在 readdir 前执行目录 lexical/real deny，拒绝目录会被剪枝
    → 每个展开结果再次执行 lexical/realpath deny
    → `use_ignore_files` 启用时应用 lexical ignore，再应用本次 exclude
```

支持的 glob 来源包括 relative glob（如 `src/**/*.ts`）、drive-absolute glob（如 `E:/Repo/src/**/*.ts`）和窄兼容的 slash-leading glob（如 `/**/Foo.kt`）。relative glob 和 slash-leading glob 只基于 primary `rootDir`；drive-absolute glob 可命中 primary 或 additional root。普通 `/foo/bar.ts` 不含 glob 元字符，会按 rooted without drive 拒绝。

文件名中包含 glob 元字符（如 `special/file[test].ts`、`special/file{brace}.ts`）时，工具会先在 lexical 校验通过后按字面文件探测；只有不存在或不是文件时，才继续按 glob 模式处理。

Literal 是显式访问，因此 relative 与 drive-absolute literal 都不走 ignore / exclude。Deny 是强制访问边界，始终应用于 literal、glob static base、遍历目录和展开结果，不能由工具参数关闭。

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

`shallow_read: true` 时仍会读取文本以统计行数和判断截断风险。返回信息包括每个文件的原始总行数和磁盘字节数、所有成功处理文件的总行数和总字节数，以及如果正常读取内容是否会被截断。大小统计复用 `readTextFile()` 读取前取得的 `fs.stat().size`，不会为此增加额外的文件系统访问；被跳过、读取失败或因总文件数限制而未处理的文件不计入合计。

提供 `shallow_read_content_limit_bytes` 时，成功处理文件的原始磁盘总大小小于或等于该配置值便同时返回浅读统计和文件内容；超过配置值则只返回浅读统计。该参数必须是正整数并显式搭配 `shallow_read: true`。参数比较不计入行号前缀、文件分隔符、浅读统计、截断警告、内容结束标记或 MCP 返回壳，因此配置值不是最终响应体的硬上限。

`SHALLOW_READ_BATCH_SIZE_BYTES` 是建议的内容返回批次大小，值为 `50 * 1024` 字节，不限制调用者配置更大的 `shallow_read_content_limit_bytes`。实际附带内容的原始磁盘总大小超过该建议值时，服务器仍返回内容并追加接收端风险警告：

```text
WARNING: Included file contents exceed the recommended 50.0 KB batch size. The response may be truncated or otherwise limited by the receiving client or host.
```

该警告表示 MCP 接收端或宿主可能进一步限制响应。服务器自身因单文件行数或单行长度限制而发生的内容截断，仍通过逐文件截断警告明确报告。

`show_line_numbers: true` 时，每一行返回内容会添加原始 1-based 行号前缀，例如 `12: print("xxx")`。这个选项会增加输出体积，只有需要精确定位或引用行号时才建议开启；行号前缀不计入 `shallow_read_content_limit_bytes` 的比较值。

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
Total size: 62.4 KB (63898 bytes).
Files:
- src/Foo.kt: 40 line(s), 12.1 KB (12390 bytes), would be truncated: no.
- src/Large.kt: 80 line(s), 50.3 KB (51508 bytes), would be truncated: no.
```

AI 可以直接从分隔符中提取路径调用 `read_file` 查看完整内容。

配置阈值允许返回内容时，浅读统计之后追加与普通读取相同的截断状态、文件内容分隔符和结束标记：

```text
Read 2 file(s).
Shallow read: file contents included because total size is within the configured 10.0 KB (10240 bytes) limit.
Total lines: 120.
Total size: 8.5 KB (8704 bytes).
Files:
- src/Foo.kt: 40 line(s), 3.1 KB (3174 bytes), would be truncated: no.
- src/Bar.kt: 80 line(s), 5.4 KB (5530 bytes), would be truncated: no.
No truncation: all returned file contents are complete.

--- src/Foo.kt ---

<文件内容>

--- src/Bar.kt ---

<文件内容>

--- End of content ---
```

### Ignore、deny 与 mixed result

- 没有硬编码默认 ignore 列表，也不从二进制扩展名生成 glob 排除项。
- `ignoreFiles` 只过滤自动发现的 lexical 可见路径；`use_ignore_files=false` 可以关闭该软过滤。
- `denyFiles` 始终应用，并同时检查 lexical path 与 realpath。
- glob 同时得到返回文件和被 `ignoreFiles` 过滤的自动发现项时，追加固定说明：`NOTE: Some glob-discovered paths were filtered by configured ignoreFiles rules.`。该说明不列出被过滤路径；只在至少一个文件成功返回时出现。
- glob 同时得到 allowed 文件和 denied 自动发现项时，只返回 allowed 文件并追加固定说明：`NOTE: Some paths were blocked by the file access deny policy.`。
- denied 自动发现项不进入 skipped、排序、去重、数量限制或数量统计，也不输出路径。
- 全部结果被 ignore、exclude 或 deny 时，与普通零匹配使用相同错误，不追加 ignore 或 deny 的 mixed-result 说明。

---

## 涉及文件

| 文件 | 职责 |
|-|-|
| `src/tools/read-many-files.ts` | Schema 定义、参数校验、默认值、文件数量限制、并行读取与结果拼接 |
| `src/utils/file-selection.ts` | literal / glob 分类、discovery exclude、ignoreFiles 开关、去重与选择结果汇总 |
| `src/utils/file-read.ts` | 常量、二进制检测（`isBinaryFile`）、文本读取与截断（`readTextFile`）、`BINARY_EXTENSIONS` 集合 |
| `src/utils/paths.ts` | 路径分类、root 边界和 glob static base 的 lexical 解析 |
| `src/utils/file-access-policy.ts` | candidate、deny/ignore、realpath 校验和受控 glob 遍历 |
| `src/tools/index.ts` | 工具注册 |

---

## 设计边界

本项目的稳定边界如下：

- 不自动遍历多个 workspace；relative 输入只基于 primary root，additional roots 必须通过 drive-absolute path / glob 明确访问。
- allowed roots 与 deny 决定可访问边界；ignore 和 `exclude` 只过滤自动发现结果。
- 只返回文本内容；图片、PDF、音频和其它二进制内容会被跳过。
- 使用 UTF-8 读取文本，不做 BOM 编码检测。
- 递归由 glob 的 `**` 表达，不提供单独的 `recursive` 参数。
- 工具不注入 JIT 上下文，也不记录遥测事件。
