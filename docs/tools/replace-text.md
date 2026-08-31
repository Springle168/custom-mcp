# replace_text 工具文档

版本：v2.1

## 概述

`replace_text` 对单个文本文件执行局部替换，并在 MCP 标准 `content[0].text` 中返回可解析的 JSON 字符串。

---

## 测试文件

```text
test/replace-text/
├── smoke.test.ts                    # replace_text 轻量回归入口
├── helpers.ts                       # suite-scoped fixture harness、调用封装和结果 JSON 断言
├── schema.test.ts                   # Schema、description 和输出外壳
├── runtime-validation.test.ts       # catalog 结构校验与 handler 参数关系语义
├── default-mode.test.ts             # default 匹配、创建文件、行数与 no-op
├── regex-mode.test.ts               # regex 匹配、捕获组、$ 语法和零长度保护
├── io-safety.test.ts                # 路径、二进制、大小、行尾符和文件锁
├── output-safety.test.ts            # JSON 失败形状、sandbox 和安全写入
└── line-ending-concurrency.test.ts  # CRLF/LF 规范化与并发回归

test/fixtures/replace-text/
└── <suite>/                         # 每个测试脚本独立创建并清理的 fixture root
```

各测试脚本通过 fixture harness 绑定确定性的 suite 目录；reset 和 cleanup 只作用于该脚本拥有的 root，root 外负向测试路径也使用 suite-specific sibling 名称。

---

## Schema

### 工具名称

`replace_text`

### 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|-|-|-|-|-|
| `file_path` | `string` | ✅ | — | 要修改的文件路径；结果 JSON 原样返回调用方传入的字符串 |
| `target` | `string` | ✅ | — | 要定位的内容；`default` 模式为普通文本，`regex` 模式为裸 JavaScript `RegExp` pattern |
| `replacement` | `string` | ✅ | — | 完整替换内容；`default` 模式为普通文本，`regex` 模式仅解释 `$!n` 捕获组和 `$$` |
| `allow_multiple` | `boolean` | ❌ | `false` | 是否允许替换全部匹配；默认要求恰好一个匹配 |
| `match_mode` | `"default" \| "regex"` | ❌ | `"default"` | 匹配模式；`default` 使用精确字面匹配，`regex` 使用显式 JavaScript 正则流程 |
| `regex_flags` | `string` | ❌ | `"ms"` | 仅 `regex` 模式可用；可控制 `m` / `s`，`g` 始终由工具强制启用 |

`inputSchema` 设置 `additionalProperties=false`，并由 built-in implementation validator 在进入 handler 前统一校验必填字段、字段类型、枚举值、非空 `file_path` 和未知字段。handler 只校验 `regex_flags` 的模式依赖与语法，以及 regex 模式下 `target` 非空等参数关系。

### description 设计意图

工具与参数 description 按调用风险分层：

- **精确输入契约**：default 模式要求 AI 提供从目标文件取得的精确原文，包括空白、缩进和换行，不转义、不近似构造。
- **正则风险提示**：主 description 提醒 regex 模式使用裸 JavaScript pattern、始终全局匹配、默认启用 dotAll，并建议行内捕获优先使用 `[^\\n]+`。`regex_flags` 参数 description 负责合法 flags、默认值和关闭 dotAll 的具体方式。
- **参数局部约束**：匹配数量、模式默认值、捕获组语法和未知字段拒绝等规则由对应参数 description 与 `inputSchema` 表达，主 description 不逐项复述。

---

## 匹配模式

### default

`default` 模式把 `target` 和 `replacement` 都作为普通文本处理，不解释 `$!1`、`$1`、`$&`、`$$` 等任何 replacement 特殊语法。

`target` 和 `replacement` 规范化为 LF 后进行字面匹配。缩进、空白或文本内容存在差异时不会匹配。

空 `target` 只在 `default` 模式且目标文件不存在时表示创建新文件；目标文件已存在时会失败。创建新文件仍建议优先使用 `write_file`。

### regex

`regex` 模式把 `target` 编译为裸 JavaScript pattern。工具始终强制启用全局扫描 `g`，默认 `regex_flags="ms"`，等价于 `new RegExp(target, 'gms')`。

- 不支持 `/pattern/flags` 形式；如需调整 flags，使用 `regex_flags`。
- `regex_flags` 只允许字符 `g`、`m`、`s`，每个最多出现一次；出现其它字符或重复字符会失败且不写入。
- `g` 可以传入但不需要传入；工具始终强制启用 `g`，传入时会在成功结果的 `note` 中提示。
- `regex_flags` 实际只控制 `m` / `s`：例如 `"m"` 编译为 `gm`，`"s"` 编译为 `gs`，`""` 编译为 `g`。
- 默认 dotAll (`s`) 下 `.` 会匹配换行；行内捕获推荐优先使用 `[^\n]+`，不要使用容易跨行吞内容的 `.+`。
- 不使用 default 模式的字面匹配。
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

## 输出

所有结果都返回 MCP 标准外壳：

```json
{
  "content": [{ "type": "text", "text": "<result text>" }]
}
```

结构无效的参数在进入 executor 前由 catalog 拒绝：结果设置 `isError: true`，`content[0].text` 是 schema validation 文本，不是下述 JSON payload。进入 executor 后，成功结果和业务或运行时失败都在 `content[0].text` 中返回 JSON；失败时额外设置 `isError: true` 且 JSON `success=false`。所有结果都不使用 `structuredContent`，工具定义也不暴露 MCP `outputSchema`。

executor 返回的 `content[0].text` 解析后包含：

| 字段 | 类型 | 说明 |
|-|-|-|
| `success` | `boolean` | 工具是否执行成功 |
| `file_path` | `string` | 已通过 input schema 校验的原始 `file_path` |
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

- 结构无效参数和未知字段由 catalog 返回 schema validation 错误；参数关系、正则语义、路径越界、目录路径、二进制文件、超限文件和读写失败由 executor 返回 JSON 错误。两类失败都会设置 `isError: true`，且不会写入文件。
- 无匹配时 `matched_targets=0`、`replacement_count=0`、`matched_span=null`，并在 `note` 中提示检查 `target` 或 regex pattern。
- 多匹配但未设置 `allow_multiple=true` 时不会写入；`matched_targets` 和 `matched_span` 仍反映扫描到的匹配结果。
- 计算后的最终内容与原文件完全一致时视为 no-op：返回失败、不写入、`replacement_count=0`，并提示检查 `target` 与 `replacement` 是否相同。
- regex 模式下非法正则和零长度匹配都会失败且不写入；零长度匹配不返回部分匹配结果。

executor 前置失败的参数已经通过 schema 校验，结果 JSON 按下列规则填充尚未产生的运行时信息：

| 字段 | 前置失败值 |
|-|-|
| `file_path` | 原样返回已校验的输入值 |
| `match_mode` | 原样返回输入值；省略时为 `"default"` |
| `allow_multiple` | 原样返回输入值；省略时为 `false` |
| `matched_targets` / `replacement_count` | `0` |
| `matched_span` | `null` |
| `replacement_line_count` | 按已校验的 `replacement` 计算 |
| `file_line_count.previous` / `current` | 默认均为 `0`；若失败发生在成功读取已有文件后，则均为修改前行数 |
| `note` | 必填，说明失败原因和可执行的修正建议 |

---

## 安全与写入规则

- 路径通过 `FileAccessPolicyContext` 组合输入分类、allowed-root、policy candidate 和 deny。Lexical deny 在文件锁、目录创建或既有内容读取前失败。
- 不存在目标通过最近存在祖先计算预计 real target 并执行 deny；创建缺失父目录后和正式写入前都会重新执行 same-root 与 deny。
- 已存在目标先按实际 file/directory 类型查询 lexical/realpath deny，再处理符号链接、目录和文件类型错误。`write_file` 与 `replace_text` 共享同一写入策略入口。
- 写入流程使用 `withFileLock()`，同一文件并发替换会串行化，不同文件互不阻塞。
- 已有文件超过 `20MB`、被判定为二进制，或新建路径看起来是二进制文件时会被拒绝。
- 写回行尾符由 `ToolRuntimeContext.lineEnding` 控制：`auto` 保留已有主要行尾符，新文件默认 LF。
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
