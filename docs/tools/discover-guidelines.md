# discover_guidelines 工具文档

## 概述

`discover_guidelines` 从 Markdown 文件开头的 YAML Front Matter 返回指南名称、用途描述和文件路径，不读取或返回 Markdown 正文。调用方可以先用该工具发现候选指南，再通过环境中的文件读取工具读取需要使用的正文。

工具复用共享文件选择层的 literal / glob、过滤和显示路径语义，安全边界见[路径安全](../PATH-SAFETY.md)。选择层保留带 `includeIndex` 的有序候选与失败，文件去重由工具自身负责；Front Matter 解析与文件 I/O 分离。

## Schema

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|-|-|-|-|-|
| `include` | `string[]` | 是 | — | 非空 literal paths 或 glob patterns；relative 输入基于 primary root，drive-absolute 输入可访问配置的任一 allowed root |
| `exclude` | `string[]` | 否 | `[]` | 只过滤 glob 自动发现结果；literal path 绕过 |
| `use_ignore_files` | `boolean` | 否 | `false` | 是否使用 matched root 的 `ignoreFiles` 过滤 glob 自动发现结果；literal path 绕过，deny 始终生效 |

Input Schema 拒绝未知字段，并保证 `include` 至少包含一个非空字符串、`exclude` 中的每项也是非空字符串；executor 在 schema 校验后只处理文件选择、Front Matter 语义和运行时边界。

`use_ignore_files` 默认关闭，使指南发现能够覆盖被通用源码 ignore 规则隐藏的候选。宽泛 selector 需要应用 workspace 的软过滤时，可以显式设为 `true`。

## Front Matter 契约

目标文件必须使用 `.md` 扩展名，扩展名比较不区分大小写。有效 Front Matter 满足以下条件：

- UTF-8 文件可以带 BOM；
- 去除可选 BOM 后，第一行严格为 `---`；
- closing delimiter 行严格为 `---`；
- 支持 LF 和 CRLF；
- YAML 使用 1.2 core schema、严格解析和唯一 mapping key；
- 顶层值是 mapping；
- `name` 与 `description` 是直接字符串 scalar，不能通过 alias 间接提供；
- 两个字段去除首尾空白后均非空；
- `name` 最多 64 个 Unicode code point；
- `description` 最多 1024 个 Unicode code point。

其它顶层字段允许存在但不转换或返回。工具不会根据文件名或标题补全字段，也不会截断超限字段。无 Front Matter、delimiter 无效、YAML 错误、duplicate key、字段缺失或字段无效的 Markdown 会被安静忽略。

## 有界读取与并发

工具按 `include` 声明顺序选择，每条 glob 内按显示路径排序；按安全检查后的真实文件身份去重，保留首次出现的位置和显示路径，再过滤 Markdown 候选，不执行全局路径排序。单次调用：

- 最多检查前 100 个去重后的 Markdown 文件，失败不从后续候选补位，超限通过 `note` 报告；
- 每个文件最多读取开头 64 KiB；
- 以 4 KiB 块读取，识别 closing delimiter 后不再继续读取后续正文；
- 最多使用 8 个 worker 并发检查；
- 打开前拒绝非 regular file；打开时在平台支持时使用 no-follow 与 non-blocking flags，随后通过 handle/path identity 和 realpath 复核目标未被替换；
- 在正常、无效、失败和取消路径关闭 file handle。

closing delimiter 未在 64 KiB 内完整出现时，该文件不构成有效指南。正文不会传给 YAML parser，也不会进入工具结果。

并发调度使用 `src/utils/bounded-workers.ts` 的 `mapWithWorkers()`，按输入位置收集结果。取消或不可继续的内部异常后停止领取新任务，等待所有已启动任务完成关闭流程后再返回整次错误，不返回可能被误认为完整结果的部分集合。

## 返回值

正常发现直接构造成功的单文本块结果，文本内容是 `JSON.stringify(payload)` 生成的紧凑 JSON：

```json
{"guidelines":[{"name":"release-notes","description":"Generate release notes from repository changes.","file_path":"docs/guidelines/release-notes.md"}]}
```

`guidelines` 始终存在。同名指南保留为多个条目，通过 `file_path` 区分。没有有效指南属于成功结果，必要时增加单个 `note`：

```json
{"guidelines":[],"note":"Markdown files were found, but none contained valid guideline Front Matter."}
```

`note` 只用于人类可读的状态或完整性说明，不是机器状态码。说明按以下顺序组合：

1. 无匹配、无可读文件、无 Markdown 或无有效 Front Matter；
2. 100 个 Markdown 候选上限；
3. mixed deny、mixed ignore；
4. selector-local skipped 或单文件检查失败。

显式文件、glob static base 和 glob 成员的非 deny 选择失败按输入来源隔离，其他 selector 继续。正常完成时，选择失败、单文件检查失败和空发现都返回 `isError: false`，包括仅有显式 deny 的调用；参数错误、取消和不可继续的内部异常返回 `isError: true`。

策略与读取失败说明使用固定通用文本，不泄露调用方没有显式提供的 real path。`exclude` 是调用方显式筛选，不额外生成说明。

## 验证重点

运行 `npm test -- discover-guidelines`，重点验证严格 Front Matter / YAML 边界、同名指南与真实文件去重、100 文件和 64 KiB 上限、closing delimiter 后停止读取，以及并发取消时关闭已打开的 handle。

选择失败与空发现保持成功，参数错误和整次取消返回错误；策略提示不能泄露未显式提供的 realpath。共享选择与 worker 行为分别见[路径安全](../PATH-SAFETY.md)和 [read](read.md#数量调度与取消)，通用测试约定见[测试](../TESTING.md)。

## 维护边界

- 不在工具层读取 workspace 配置或重新实现路径分类、glob、ignore 和 deny。
- `.md` 过滤属于指南发现领域规则，不进入公共文件选择层。
- Front Matter 引擎不执行文件 I/O，也不把 YAML document 整体转换为普通 JavaScript 对象。
- 无效 Markdown 不产生逐文件 linter 诊断；需要排查时通过更窄的 literal selector 和文件读取工具检查源文件。
