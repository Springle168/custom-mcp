# replace_text 工具文档

版本：v3

## 概述

`replace_text` 在一次调用中按顺序执行一个或多个文件项，每个文件项包含一个或多个局部文本替换。工具在 MCP 标准 `content[0].text` 中返回可解析的批量 JSON 结果。

批次采用部分成功语义：每次成功修改立即写入；任一 replacement 失败不会回滚先前修改，也不会阻止后续 replacement 或文件项。任一 replacement 失败时，结果外壳设置 `isError: true`，调用方需要检查逐项结果判断已经落盘的修改。

---

## 输入 Schema

顶层只接受必填的 `files`：

```json
{
  "files": [
    {
      "file_path": "src/example.ts",
      "allow_multiple": false,
      "match_mode": "default",
      "replacements": [
        {
          "target": "return 1;",
          "replacement": "return 2;"
        }
      ]
    }
  ]
}
```

`files` 至少包含一个文件项。文件项按数组顺序执行，同一路径可以重复出现，用于表达使用不同模式或选项的阶段。每个文件项包含：

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|-|-|-|-|-|
| `file_path` | `string` | 是 | — | 非空文件路径；结果原样返回该字符串 |
| `replacements` | `array` | 是 | — | 非空有序 replacement 数组 |
| `allow_multiple` | `boolean` | 否 | `false` | 作用于该文件项中的全部 replacements；`false` 要求每项恰好匹配一次 |
| `match_mode` | `"default" \| "regex"` | 否 | `"default"` | 作用于该文件项中的全部 replacements |
| `regex_flags` | `string` | 否 | `"ms"` | 仅 regex 模式可用；只允许不重复的 `g`、`m`、`s` |

每个 replacement 必须包含字符串 `target` 和 `replacement`。各层对象均拒绝未知字段。Schema 负责结构、类型、枚举、非空数组和非空 `file_path`；handler 负责 flags 参数关系、regex 非空 target、文件状态和匹配语义。

## 执行顺序与锁

批次使用确定性的全局顺序：

```text
files[0].replacements[0]
files[0].replacements[1]
...
files[1].replacements[0]
...
```

不同文件项不会在同一次 handler 调用内并行。每个文件项单独解析路径并获取一次 `withFileLock()` 文件锁，锁覆盖该项中的全部 replacements；文件项结束后释放锁。重复路径文件项分别获取锁，因此其它同路径调用可能在两个文件项之间执行。

每个 replacement 都在文件项锁内重新执行写入目标安全校验、文件类型和大小检查、二进制检测与文本读取。成功 replacement 立即写回；后项从文件系统重新读取，不使用前项的内存内容。该边界保证：

- 后项能看到前项实际写入的内容；
- 前项计算或写入失败后，后项不会用陈旧缓存覆盖未知磁盘状态；
- 前项把文件写成二进制或超过 `20MB` 后，后项会在自己的读取入口拒绝该文件；
- 其它同路径调用不能插入一个文件项的两个 replacements 之间。

整批调用不持有多个文件锁，不提供跨文件或跨文件项事务隔离。不同文件上的独立工具调用仍可并行。

---

## 匹配模式

### default

`default` 把 `target` 和 `replacement` 作为普通文本处理。输入在匹配前规范化为 LF；缩进、空白和文本必须精确一致，不解释 replacement 特殊语法。

空 `target` 仅在目标文件不存在时表示创建文本文件。文件已经存在时，空 target 失败。创建成功的 replacement 返回 `matched_targets=0`、`replacement_count=0`，并在 `note` 中说明文件已创建。

### regex

`regex` 把 `target` 编译为裸 JavaScript pattern。工具始终启用全局扫描 `g`，默认 `regex_flags="ms"`：

- 不接受 `/pattern/flags` 形式；flags 通过文件项的 `regex_flags` 指定；
- `regex_flags` 只允许不重复的 `g`、`m`、`s`；显式 `g` 是冗余配置，成功项会在 `note` 中提示；
- `target` 必须非空；非法正则与零长度匹配失败且不写入；
- 默认 dotAll 下 `.` 会匹配换行；行内捕获优先使用 `[^\n]+`；
- 匹配跨行时，成功项的 `note` 提示检查 dotAll 风险。

regex replacement 只解释：

| 语法 | 结果 |
|-|-|
| `$!0` | 完整匹配文本 |
| `$!1`、`$!2`、`$!10` | 对应捕获组；不存在或未参与时为空字符串 |
| `$!01`、`$!00` | 允许前导零 |
| `$$` | 字面量 `$` |
| `$!`、`$!x` | 按字面量写入，并在成功项中返回警告 |

JavaScript 原生 replacement 语法如 `$1`、`$&`、``$` `` 和 `$'` 保持字面量。

---

## 输出

executor 的 `content[0].text` 是以下结构的 JSON 字符串：

```typescript
interface ReplaceTextBatchPayload {
  success: boolean;
  files: Array<{
    success: boolean;
    file_path: string;
    match_mode: 'default' | 'regex';
    allow_multiple: boolean;
    replacements: Array<{
      success: boolean;
      matched_targets: number;
      replacement_count: number;
      matched_span: { start_line: number; end_line: number } | null;
      replacement_line_count: number;
      file_line_count: {
        previous: number | null;
        current: number | null;
      };
      note?: string;
    }>;
  }>;
}
```

顶层 `files`、文件项的 `replacements` 与输入数组保持相同顺序和长度。顶层和文件项的 `success` 仅在其全部后代成功时为 `true`。结果不回显 `target` 或 `replacement`，也不增加索引字段。

handler 直接构造单文本块结果，并根据 payload 的 `success` 设置相反的 `isError`：所有 replacement 成功时返回 `isError=false`，任一失败时返回 `isError=true`。`isError=true` 不表示没有写入。Schema validation 或 executor 前取消由 catalog 返回标准错误文本，不返回批量 JSON。

工具不声明 `outputSchema`，handler 不构造 `structuredContent`。运行时通用 request policy adapter 仍可按统一规则复制标准结果壳。

### Replacement 字段

- `matched_targets`：该项扫描到的目标数量。
- `replacement_count`：确认成功提交的替换次数。直接写入失败时固定为 `0`。
- `matched_span`：基于该项开始时读取的规范化 LF 内容，覆盖全部匹配的起止行。
- `replacement_line_count`：输入 replacement 规范化为 LF 后的行数。
- `file_line_count.previous`：该项开始时的实际行数；缺失文件为 `0`，无法安全确定为 `null`。
- `file_line_count.current`：该项结束后可确认的实际行数；确认缺失为 `0`，无法安全确定为 `null`。
- `note`：失败原因、创建提示或当前成功项的非阻断警告。

空字符串为 `0` 行；其它文本使用规范化内容的 `split('\n').length`。

### 写入失败恢复

直接写入失败不能证明文件保持原样。失败项保持 `success=false` 和 `replacement_count=0`，并提示文件可能已经被截断、部分写入或完整写入。handler 在同一文件锁内重新执行安全校验和读取：

- 恢复读取成功时，`current` 返回实际行数；
- 确认文件缺失时，`current=0`；
- 无法安全读取时，`current=null`。

恢复读取只报告状态，不把失败写入重新分类为成功。后续 replacement 仍从正常入口重新检查并读取文件。

---

## 失败、警告与文件安全

无匹配、多匹配但未启用 `allow_multiple`、no-op、非法正则和零长度 regex 匹配都不写入。单项失败后继续处理后续输入。

文件级共享条件失败时，例如 lexical 路径解析失败、`regex_flags` 与模式冲突或 flags 非法，该文件项的每个 replacement 都生成失败结果。目录、二进制、超限、缺失和读取错误在每个 replacement 开始时重新判断。

警告只附加到产生它的成功 replacement，不提升或跨项合并：

- 新增疑似省略占位符；
- regex replacement 中可疑的 `$!`；
- 显式包含冗余 `g`；
- regex 匹配跨行；
- default 空 target 创建文件。

路径与写入继续使用 `FileAccessPolicyContext`、`resolveFileAccessPath()` 和 `validateFileAccessWriteTarget()`：

- 所有 I/O 在 lexical 路径检查之后执行；
- 每个 replacement 在读取入口和正式写入前检查目标；
- 创建父目录后再次检查 same-root、deny 和实际目标；
- 目录、符号链接、二进制路径/内容和初始大小超过 `20MB` 的文件被拒绝；
- 一个 replacement 可以把小文件写到超过限制，后项会在下一次读取时拒绝；
- 写回行尾符由 `ToolRuntimeContext.lineEnding` 决定，`auto` 保留已有主要行尾符，新文件使用 LF。

---

## 示例

### 同文件有序修改

```json
{
  "files": [
    {
      "file_path": "src/example.ts",
      "replacements": [
        { "target": "const value = 1;", "replacement": "const value = 2;" },
        { "target": "return value;", "replacement": "return value * 2;" }
      ]
    }
  ]
}
```

### 同路径的 default 与 regex 阶段

```json
{
  "files": [
    {
      "file_path": "src/example.ts",
      "replacements": [
        { "target": "enabled = false", "replacement": "enabled = true" }
      ]
    },
    {
      "file_path": "src/example.ts",
      "match_mode": "regex",
      "replacements": [
        { "target": "version=(\\d+)", "replacement": "version=$!1-next" }
      ]
    }
  ]
}
```

---

## 测试文件

```text
test/replace-text/
├── batch.test.ts                    # 顺序、部分成功、状态刷新、恢复读取和文件项锁
├── smoke.test.ts                    # 轻量回归入口
├── helpers.ts                       # fixture、批量结果断言和单项测试构造器
├── schema.test.ts                   # 嵌套 Schema、分层 description 和输出外壳
├── runtime-validation.test.ts       # catalog 结构校验与文件级参数关系
├── default-mode.test.ts             # default 匹配、创建、行数与 no-op
├── regex-mode.test.ts               # regex、捕获组、美元语法和零长度保护
├── io-safety.test.ts                # 路径、二进制、大小、行尾符和文件锁
├── output-safety.test.ts            # JSON 失败形状和安全写入
└── line-ending-concurrency.test.ts  # LF/CRLF 与跨调用并发回归
```

`src/tools/replace.ts` 负责批量编排和 I/O 边界；`src/engine/replacement.ts` 只负责单次 replacement 的纯计算；`src/utils/file-lock.ts` 提供单 lexical resolved path 的进程内 FIFO 锁。
