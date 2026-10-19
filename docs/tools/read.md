# read 工具文档

## 职责与入口

`read` 从 literal 路径或 glob 选择文本文件，返回整文件或指定连续范围。它支持同一文件的多个独立片段、原始行号前缀和基于实际返回正文的 shallow 统计，只返回 MCP text 内容。

工具入口是 `src/tools/built-in/files/read.ts`，对外 description 和 Draft 2020-12 input schema 位于共置的 `read.definition.ts`。路径分类、allowed roots、deny、realpath 与 symlink 规则由[路径安全](../PATH-SAFETY.md)承接；工具不自行读取 workspace 配置或绕过共享文件访问层。

## 参数

| 参数 | 类型 | 默认值 | 说明 |
|-|-|-|-|
| `include` | `(string \| object)[]` | 必填 | 至少一个非空路径/glob 字符串或 literal 文件 object。相对输入基于 primary root，drive-absolute 输入可命中任一 allowed root。 |
| `exclude` | `string[]` | `[]` | 仅过滤 glob 自动发现的文件；literal 字符串和 object 均绕过。 |
| `use_ignore_files` | `boolean` | `true` | 是否使用 matched root 的 `ignoreFiles` 过滤 glob 发现结果；不关闭 `exclude` 或 deny。 |
| `shallow_read` | `boolean \| integer` | `false` | `false` 返回成功正文，`true` 省略成功正文；正整数表示按整批成功正文 UTF-8 字节数决定是否附带全部正文。 |
| `show_line_numbers` | `boolean` | `false` | 给正文添加原始 1-based 行号；object 可逐请求覆盖。 |

每个 object 只允许以下字段：

| 字段 | 类型 | 默认值 | 说明 |
|-|-|-|-|
| `file_path` | `string` | 必填 | 单个非空 literal 文件路径，不展开 glob。 |
| `start_line` | `integer \| string` | 文件开头 | 起始行号或逐行正则，取决于 `read_mode`。 |
| `end_line` | `integer \| string` | EOF | 包含结束行；解释方式由 `read_mode` 决定。 |
| `read_mode` | `"line" \| "regex"` | `"line"` | 数字行号或无 flags 的 JavaScript RegExp pattern。 |
| `show_line_numbers` | `boolean` | 继承顶层 | 显式 `false` 可以覆盖顶层 `true`。 |

Schema 拒绝未知字段，行号值域为正整数，pattern 为非空字符串。数值 `shallow_read` 范围为 `1..Number.MAX_SAFE_INTEGER`。模式与范围类型的关系、起止顺序和正则合法性属于逐请求语义校验，不把同批其他有效请求变成整次拒绝。

宽泛文件集合宜先用 `shallow_read=true` 检查范围和大小；数值阈值适合在结果较小时一次附带正文。需要检查被 ignore 的候选时，先收窄 glob 再显式关闭 ignore，或使用已知 literal 路径，不为此扩大 deny 边界。

## 选择顺序、去重与覆盖

字符串表示默认整文件请求。共享选择层先按 literal 文件识别，只有字面文件不存在或不是文件且包含 glob 语法时才展开，因此真实文件名中的 glob 元字符不改变 literal 语义。Object 始终是一个显式 literal 请求，不要求同批存在对应的字符串或 glob。

结果以 `include` 声明顺序为主，每条 glob 在自身位置展开，其成功候选和非 deny 选择失败按显示路径一起排序。选择结果保留 0-based `includeIndex`，不执行全局路径排序或共享层去重。

`read` 在安全检查确认的 realpath 身份上执行以下规则：

1. 默认整文件请求去重，保留首次出现的位置和显示路径。
2. 每个 object 保留自身声明位置；object 之间即使路径、范围和选项相同也不合并。
3. 能安全确认文件身份的 object 移除同一身份的全部默认请求，包括位于 object 后面的字符串或 glob 结果。
4. 覆盖后才执行保留请求的范围语义校验。Object 的范围无效或读取失败不会恢复默认请求。
5. 无法安全确认身份的选择失败不参与去重或覆盖，不同输入产生的失败分别保留。

例如，假设 `src/*.ts` 按显示路径展开为 `a.ts`、`b.ts`、`c.ts`：

```json
{
  "include": [
    "src/*.ts",
    { "file_path": "src/c.ts", "start_line": 10, "end_line": 20 },
    { "file_path": "src/b.ts" }
  ]
}
```

最终顺序是 `a.ts` 整文件、`c.ts` 指定范围、`b.ts` 整文件。Object 不移动到被覆盖默认请求的位置，同一文件的片段也不按路径重新归组。

`ignoreFiles` 和 `exclude` 只过滤通过访问校验的自动候选。显式路径或 glob static base 的访问失败按 selector 隔离；glob 成员的非 deny 访问失败保留自身显示路径和位置，不被后续软过滤抹去。自动发现的 denied 项完全隐藏，不进入请求、排序、数量上限或统计。Lexical deny 命中后不为去重、覆盖或提示继续探查真实目标。

## 文本与范围

每个实际源文件在单次调用中只执行一次完整文本读取，各选入请求使用同一份文本独立定位和格式化。这不构成跨文件快照，也没有跨调用缓存。

文本使用 UTF-8，单文件大小上限为 `20 * 1024 * 1024` bytes（20 MiB），范围读取同样受该限制。二进制检测先使用已知文本/二进制扩展名；未知扩展名检查开头 4 KiB 的 null 字节与不可打印字符比例。`.ts`、`.mts`、`.cts` 显式按文本扩展名处理。

正文不限制行数或单行长度。文本按 `split(/\r?\n/)` 拆行，片段使用 LF 连接；空文件计为一个空行，末尾换行保留末尾空行。行号前缀形如 `12: content`，使用源文件的原始行号。

### `read_mode="line"`

- 只接受正整数 JSON number，不把数字字符串转换为行号。
- 缺少起始行时从第 1 行开始，缺少结束行时读取到 EOF。
- 同时给出起止行时，起始行不得大于结束行。
- 起始行超出总行数时该请求失败；结束行超过 EOF 时裁剪到实际结尾。

### `read_mode="regex"`

- 起止值只接受非空 JavaScript RegExp pattern string，不附加 flags。
- 按单行匹配，不支持跨行定位。
- 提供起始 pattern 时，从文件开头寻找第一条匹配行；缺省从第 1 行开始。
- 提供结束 pattern 时，从已解析起始行开始寻找第一条匹配行并包含该行；缺省到 EOF。
- 正则编译失败或指定 pattern 无匹配时该请求失败，不扩大读取范围。

文件读取失败影响该源文件的全部选入请求；范围失败只影响对应请求，不阻止同文件其他有效片段。

## 数量、调度与取消

工具在去重和 object 覆盖后只处理前 100 个最终请求。每个默认请求、object 或选择失败各占一个名额；成功展开的 glob 本身不额外占名额。被去重、覆盖或过滤掉的项不计数，选入请求失败不从后续请求补位。超限时返回已处理结果并附带限制说明，未处理项不生成失败块或进入内容统计。

数量限制先于按源文件分组。读取层最多使用 8 个 worker，并发与同文件文本复用均不改变最终结果顺序。此限制不是 glob 遍历上限或整批响应字节硬上限；只读工具不使用文件写入锁。

共享 `mapWithWorkers()` 在取消或不可继续的内部异常后停止领取新任务，等待已启动任务 settle/drain 后再传播错误。工具在选择和读取边界响应 `AbortSignal`，取消返回整次错误，不返回可能被误认为完整结果的部分业务内容。Helper 不负责业务失败文案、文件选择、数量限制或 `isError` 判定。

## 统计与 shallow

摘要统计成功片段的实际起止行、源文件总行数、片段行数和正文 UTF-8 字节数。同文件重复或重叠片段分别累计，不按不同源文件数或磁盘大小计算。

字节数按实际正文的 `Buffer.byteLength(content, 'utf8')` 计算：行号前缀和返回 LF 计入，摘要、标题、错误块与 MCP 包装不计入。空正文可以是 0 bytes，但成功空文件仍有 1 lines。

| `shallow_read` | 返回行为 |
|-|-|
| 缺失或 `false` | 统计、全部成功正文和失败块。 |
| `true` | 统计和失败块，省略全部成功正文。 |
| 正整数 | 成功正文总字节数小于或等于阈值时附带全部正文，否则全部省略；统计和失败块始终保留。 |

阈值采用整批判断，不按顺序填预算，不部分附带或截断片段；省略正文不改变成功状态。Shallow 仍读取并解析文本，不是仅查询文件 metadata。

## 返回结构与状态

正常完成时先返回一个摘要 text 块，随后每个已处理请求各有一个正文块或失败块，顺序与最终请求一致。Shallow 省略成功正文时保留摘要和所有失败块，剩余块的相对顺序不变。

摘要包含 `Selected content: <lines> lines, <bytes> bytes.`，并在 `Files:` 下逐项标注 `include[index]`、显示路径、实际范围/总行数、片段行数和字节数，或 `failed`。没有已处理请求时省略 `Files:`。字节数使用整数 `bytes`，不换算 KB；不为失败伪造统计。

以下三个代码块各代表一个独立 text 块：

```text
Selected content: 2 lines, 10 bytes.
Files:
- include[0] src/a.ts: lines 2-3 of 5, 2 lines, 10 bytes.
- include[1] logo.png: failed.
```

```text
--- include[0] src/a.ts: lines 2-3 of 5 ---

alpha
beta
```

```text
--- include[1] logo.png: failed ---

binary file
```

摘要按需附带 shallow 与 100 requests 限制说明，以及 `Notes:`：

- 实际存在 glob 结果被 ignore 过滤且至少有一个成功片段时，报告 `Some glob-discovered paths were filtered by configured ignoreFiles rules.`。
- 返回的显式请求中存在 deny 失败，或自动发现隐藏了 deny 项且至少有一个成功片段时，报告 `Some paths were blocked by the file access deny policy.`。
- ignore 与 deny 各最多一行，不列自动过滤路径或数量；`exclude` 不生成策略提示。纯自动发现零结果不区分零匹配与全部被 deny 隐藏。

| 情况 | `isError` |
|-|-|
| 至少一个片段成功，包括 shallow 省略正文或空文件成功 | `false` |
| 零匹配或所有请求失败 | `true` |
| Schema 拒绝、取消或不可继续的内部异常 | `true` |

整次拒绝、取消或内部异常可以返回单错误块，不伪装成已完成的逐请求结果。逐请求错误与显示路径遵循路径安全层的隐私边界，不泄露调用方未显式提供的 denied realpath。

## 实现与测试归属

| 入口 | 职责 |
|-|-|
| `src/tools/built-in/files/read.definition.ts` | 对外 description、input schema 与请求上限。 |
| `src/tools/built-in/files/read.ts` | 默认请求去重、object 覆盖、前 100 请求、源文件分组、结果与策略提示。 |
| `src/engine/read-range.ts` | 无 I/O 的范围校验、行号/正则定位、片段选择和行号格式化。 |
| `src/utils/file-selection.ts` | 带 `includeIndex` 的有序候选与失败、每条 glob 内排序、过滤与选择阶段策略状态；不执行去重。 |
| `src/utils/file-read.ts` | 二进制检测、20 MiB 保护与完整 UTF-8 文本读取。 |
| `src/utils/bounded-workers.ts` | 有限并发、输入位置结果收集、取消/异常停止调度与 drain。 |
| `test/read/` | 请求覆盖/顺序/限制、范围语义、正文与 shallow 统计、失败隔离和工具结果。 |
| `test/bounded-workers/` | 有限并发、稳定顺序、取消/异常停止调度和已启动任务收尾。 |
| `test/path-safety/`, `test/file-access-policy/` | allowed roots、literal/glob、deny/ignore、symlink 与跨工具隐私边界。 |

`discover_guidelines` 复用文件选择和 worker helper，但自己执行文件去重、Markdown 筛选与有界前缀读取，不复用 `read` 的全文读取、object、范围或 shallow 结果协议，详见[指南发现](discover-guidelines.md)。
