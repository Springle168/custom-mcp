# replace_text 工具文档

版本：v2.1

## 概述

`replace_text` 对单个文本文件执行局部替换，并在 MCP 标准 `content[0].text` 中返回可解析的 JSON 字符串。

---

## 测试文件

```text
test/
├── test-replace-text.ts                 # replace_text 轻量回归入口
└── replace-text/
    ├── helpers.ts                       # fixture、调用封装和结果 JSON 断言
    ├── schema.test.ts                   # Schema、description 和输出外壳
    ├── runtime-validation.test.ts       # 参数校验、未知字段和失败默认值
    ├── default-mode.test.ts             # default 匹配、创建文件、行数与 no-op
    ├── regex-mode.test.ts               # regex 匹配、捕获组、$ 语法和零长度保护
    ├── io-safety.test.ts                # 路径、二进制、大小、行尾符和文件锁
    ├── output-safety.test.ts            # JSON 失败形状、sandbox 和安全写入
    └── line-ending-concurrency.test.ts  # CRLF/LF 规范化与并发回归
```

---

## Schema

### 工具名称

`replace_text` → Android Studio 中显示为 `mcp__custom_mcp__replace_text`

### 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|-|-|-|-|-|
| `file_path` | `string` | ✅ | — | 要修改的文件路径；结果 JSON 原样返回调用方传入的字符串 |
| `target` | `string` | ✅ | — | 要定位的内容；`default` 模式为普通文本，`regex` 模式为裸 JavaScript `RegExp` pattern |
| `replacement` | `string` | ✅ | — | 完整替换内容；`default` 模式为普通文本，`regex` 模式仅解释 `$!n` 捕获组和 `$$` |
| `allow_multiple` | `boolean` | ❌ | `false` | 是否允许替换全部匹配；默认要求恰好一个匹配 |
| `match_mode` | `"default" \| "regex"` | ❌ | `"default"` | 匹配模式；`default` 使用容错文本流程，`regex` 使用显式 JavaScript 正则流程 |
| `regex_flags` | `string` | ❌ | `"ms"` | 仅 `regex` 模式可用；可控制 `m` / `s`，`g` 始终由工具强制启用 |

`inputSchema` 设置 `additionalProperties=false`，handler 也会主动校验必填字段、字段类型、枚举值和未知字段。

---

## 匹配模式

### default

`default` 模式把 `target` 和 `replacement` 都作为普通文本处理，不解释 `$!1`、`$1`、`$&`、`$$` 等任何 replacement 特殊语法。

匹配策略按以下顺序尝试，命中后不会继续后续策略：

1. **Exact**：规范化 LF 后进行字面匹配。
2. **Flexible**：逐行 `trim()` 后比较，忽略缩进差异，并把目标缩进应用到 `replacement`。
3. **Tokenized**：将 `target` 按分隔符 `( ) : [ ] { } > < =` 拆分为token，把 token 转义后用 `\s*` 连接，容忍 token 间空白变化。
4. **Fuzzy**：滑动窗口 + Levenshtein 距离，容忍小幅文本差异。

空 `target` 只在 `default` 模式且目标文件不存在时表示创建新文件；目标文件已存在时会失败。创建新文件仍建议优先使用 `write_file`。

### regex

`regex` 模式把 `target` 编译为裸 JavaScript pattern。工具始终强制启用全局扫描 `g`，默认 `regex_flags="ms"`，等价于 `new RegExp(target, 'gms')`。

- 不支持 `/pattern/flags` 形式；如需调整 flags，使用 `regex_flags`。
- `regex_flags` 只允许字符 `g`、`m`、`s`，每个最多出现一次；出现其它字符或重复字符会失败且不写入。
- `g` 可以传入但不需要传入；工具始终强制启用 `g`，传入时会在成功结果的 `note` 中提示。
- `regex_flags` 实际只控制 `m` / `s`：例如 `"m"` 编译为 `gm`，`"s"` 编译为 `gs`，`""` 编译为 `g`。
- 默认 dotAll (`s`) 下 `.` 会匹配换行；行内捕获推荐优先使用 `[^\n]+`，不要使用容易跨行吞内容的 `.+`。
- 不走 Exact / Flexible / Tokenized / Fuzzy fallback。
- `target` 必须非空；非法正则、无匹配、零长度匹配都会失败且不写入。
- 扫描阶段先收集全部匹配，再根据 `allow_multiple`、no-op 和写入规则决定是否修改文件。
- 成功替换且任一匹配跨多行时，`note` 会提示检查 dotAll / `.` 是否误伤。

`replacement` 只解释以下语法：

| 语法 | 结果 |
|-|-|
| `$!0` | 完整匹配文本 |
| `$!1`、`$!2`、`$!10` | 对应捕获组；不存在或未参与匹配时为空字符串 |
| `$!01`、`$!00` | 允许前导零，分别等价于 `$!1`、`$!0` |
| `$$` | 字面量 `$` |
| `$!`、`$!x` | 按字面量写入，并在成功结果的 `note` 中给出警告 |

JavaScript 原生 replacement 语法如 `$1`、`$&`、`$\``、`$'` 都保持字面量。

---

## 输出 JSON

成功和失败都返回 MCP 标准外壳：

```json
{
  "content": [{ "type": "text", "text": "{...json...}" }]
}
```

失败时额外设置 `isError: true`，且 `content[0].text` 中的 JSON `success=false`。不使用 `structuredContent`，工具定义也不暴露 MCP `outputSchema`。

`content[0].text` 解析后的对象包含：

| 字段 | 类型 | 说明 |
|-|-|-|
| `success` | `boolean` | 工具是否执行成功 |
| `file_path` | `string` | 调用方传入的原始 `file_path`；缺失或非字符串时为 `""` |
| `match_mode` | `"default" \| "regex"` | 本次实际使用或规范化后的模式 |
| `allow_multiple` | `boolean` | 本次实际使用或规范化后的多匹配设置 |
| `matched_targets` | `number` | 扫描阶段发现的目标数量 |
| `replacement_count` | `number` | 实际写入阶段执行的替换次数 |
| `matched_span` | `object \| null` | 所有匹配目标的整体行号跨度：`{ start_line, end_line }` |
| `replacement_line_count` | `number` | 输入 `replacement` 的行数 |
| `file_line_count.previous` | `number` | 修改前文件行数 |
| `file_line_count.current` | `number` | 修改后文件行数；失败未写入时等于 `previous` |
| `note` | `string` | 可选说明；失败原因、创建提示和非阻断警告都放在这里 |

行号与行数都基于规范化 LF 后的内容计算。行数口径为：空字符串是 `0` 行，否则使用 `text.split('\n').length`。

---

## 失败与 no-op 行为

- 参数校验、未知字段、路径越界、目录路径、二进制文件、超限文件、读写失败都会返回 `isError: true`，且不会写入文件。
- 无匹配时 `matched_targets=0`、`replacement_count=0`、`matched_span=null`，并在 `note` 中提示检查 `target` 或 regex pattern。
- 多匹配但未设置 `allow_multiple=true` 时不会写入；`matched_targets` 和 `matched_span` 仍反映扫描到的匹配结果。
- 计算后的最终内容与原文件完全一致时视为 no-op：返回失败、不写入、`replacement_count=0`，并提示检查 `target` 与 `replacement` 是否相同。
- regex 模式下非法正则和零长度匹配都会失败且不写入；零长度匹配不返回部分匹配结果。

前置失败无法自然获得字段值时，结果 JSON 使用以下默认值：

| 字段 | 失败默认值 |
|-|-|
| `file_path` | 传入值是字符串则原样返回，否则为 `""` |
| `match_mode` | 传入值为 `"default"` 或 `"regex"` 时原样返回，否则为 `"default"` |
| `allow_multiple` | 仅传入值严格为 `true` 时为 `true`，否则为 `false` |
| `matched_targets` / `replacement_count` | `0` |
| `matched_span` | `null` |
| `replacement_line_count` | `replacement` 是字符串时按行数口径计算，否则为 `0` |
| `file_line_count.previous` / `current` | 默认均为 `0`；若失败发生在成功读取已有文件后，则均为修改前行数 |
| `note` | 必填，说明失败原因和可执行的修正建议 |

---

## 安全与写入规则

- 路径先经过 `resolvePath()` 和 `validatePathAccess()`，必须位于 `rootDir` 或 `otherRootDirs` 内；相对路径只基于主工作区 `rootDir`。Windows 下访问 `otherRootDirs` 必须使用带盘符的完整路径，drive-relative 路径和无盘符 rooted 路径会被拒绝。
- 创建缺失父目录前后都会校验现有父目录的 realpath，避免路径穿越或符号链接绕过命中的允许工作区。
- 目标路径若已存在且是符号链接会被拒绝；目录路径也会被拒绝。
- 写入流程使用 `withFileLock()`，同一文件并发替换会串行化，不同文件互不阻塞。
- 已有文件超过 `20MB`、被判定为二进制，或新建路径看起来是二进制文件时会被拒绝。
- 写回行尾符由 `config.lineEnding` 控制：`auto` 保留已有主要行尾符，新文件默认 LF。
- 无匹配、多匹配但未设置 `allow_multiple=true`、no-op、非法正则和零长度正则匹配都不会写入文件。
- `replacement` 中新增疑似省略占位符会成功写入，但 `note` 会提示自检。

---

## 示例

### default 精确替换

```json
{
  "file_path": "src/example.ts",
  "target": "return 1;",
  "replacement": "return 2;"
}
```

### regex 捕获组替换

```json
{
  "file_path": "src/example.ts",
  "match_mode": "regex",
  "target": "const (\\w+) = (\\d+);",
  "replacement": "const $!1 = Number($!2);",
  "allow_multiple": true
}
```

### default 创建新文件

```json
{
  "file_path": "notes/new-file.txt",
  "target": "",
  "replacement": "hello\nworld"
}
```
